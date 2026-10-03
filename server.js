// Home Library: a tiny dependency-free HTTP server (Node built-ins only).
// Serves the static front end from ./public and a small JSON API backed by data/books.json.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BookStore, StoreError } from './store.js';
import { isValidIsbn, canonicalIsbn, isbn13To10 } from './public/js/isbn.js';
import { isValidId } from './validate.js';
import { lookupOpenLibrary } from './open-library.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const ZXING_FILE = path.join(ROOT, 'node_modules', '@zxing', 'library', 'umd', 'index.min.js');

const MAX_BODY_BYTES = 768 * 1024; // a single book (may carry a ~300 KB cover photo)
const MAX_IMPORT_BYTES = 20 * 1024 * 1024; // a whole-library backup
const LOOKUP_TIMEOUT_MS = 10_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' https: data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    const type = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      reject(new HttpError(415, 'Content-Type must be application/json'));
      request.resume();
      return;
    }
    const declared = Number(request.headers['content-length']);
    if (declared > limit) {
      reject(new HttpError(413, 'Request body is too large'));
      request.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Google Books proxy. Going through the server keeps an optional API key out of the
// browser and sidesteps CORS.
// ---------------------------------------------------------------------------
async function fetchGoogleVolumes(baseUrl, apiKey, isbn) {
  const url = new URL(baseUrl);
  url.searchParams.set('q', `isbn:${isbn}`);
  url.searchParams.set('maxResults', '5');
  if (apiKey) url.searchParams.set('key', apiKey);

  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new HttpError(502, timedOut ? 'Google Books took too long to respond' : 'Could not reach Google Books', {
      code: 'network',
    });
  }
  if (response.status === 429) {
    throw new HttpError(429, 'Google Books rate limit reached. Try again later or configure an API key.', {
      code: 'rate-limit',
    });
  }
  if (!response.ok) {
    throw new HttpError(502, `Google Books returned an error (HTTP ${response.status})`, { code: 'upstream' });
  }
  try {
    return await response.json();
  } catch {
    throw new HttpError(502, 'Google Books returned an unreadable response', { code: 'upstream' });
  }
}

/**
 * Google's `isbn:` search is unreliable: it often returns zero results for books it does
 * have. Its "viewapi" endpoint resolves an ISBN to a volume id far more dependably, so we
 * use it as a second step and then fetch the volume by id. Resolves to a volume or null.
 */
async function lookupViaViewApi(options, isbns, wanted13) {
  if (!options.googleViewApiUrl) return null;
  const url = new URL(options.googleViewApiUrl);
  url.searchParams.set('jscmd', 'viewapi');
  url.searchParams.set('bibkeys', isbns.map((isbn) => `ISBN:${isbn}`).join(','));

  let id = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!response.ok) return null;
    const text = await response.text(); // JavaScript: `var _GBSBookInfo = {...};`
    const info = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    for (const entry of Object.values(info)) {
      const candidate = entry?.info_url ? new URL(entry.info_url).searchParams.get('id') : null;
      if (candidate && /^[\w-]{5,30}$/.test(candidate)) {
        id = candidate;
        break;
      }
    }
  } catch {
    return null; // this step is best effort; the caller carries on without it
  }
  if (!id) return null;

  const volumeUrl = new URL(`${options.googleBooksUrl.replace(/\/$/, '')}/${id}`);
  if (options.googleBooksKey) volumeUrl.searchParams.set('key', options.googleBooksKey);
  let response;
  try {
    response = await fetch(volumeUrl, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), headers: { Accept: 'application/json' } });
  } catch {
    throw new HttpError(502, 'Could not reach Google Books', { code: 'network' });
  }
  if (response.status === 429) {
    throw new HttpError(429, 'Google Books rate limit reached. Try again later or configure an API key.', { code: 'rate-limit' });
  }
  if (!response.ok) return null;
  let volume;
  try {
    volume = await response.json();
  } catch {
    return null;
  }
  // Only accept it if the record really carries this ISBN (viewapi can point at another edition).
  const ids = volume?.volumeInfo?.industryIdentifiers || [];
  return ids.some((x) => canonicalIsbn(x.identifier) === wanted13) ? volume : null;
}

/**
 * Google Books first (search, then the viewapi route). If it is rate-limited, unreachable or has no record, try Open Library
 * (no key needed). Resolves to { items, source }. If Google failed and Open Library has
 * nothing either, Google's error is reported (we cannot claim "not found" on its behalf).
 */
async function lookupIsbn(options, isbn) {
  const isbn13 = canonicalIsbn(isbn);
  const candidates = [isbn13, isbn13To10(isbn13)].filter(Boolean);

  let googleError = null;
  try {
    for (const candidate of candidates) {
      const data = await fetchGoogleVolumes(options.googleBooksUrl, options.googleBooksKey, candidate);
      if (Array.isArray(data.items) && data.items.length > 0) return { items: data.items, source: 'google' };
    }
    const volume = await lookupViaViewApi(options, candidates, isbn13);
    if (volume) return { items: [volume], source: 'google' };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    googleError = err;
  }

  if (options.openLibraryUrl) {
    try {
      const volume = await lookupOpenLibrary(options.openLibraryUrl, isbn);
      if (volume) return { items: [volume], source: 'openlibrary', googleUnavailable: Boolean(googleError) };
    } catch (err) {
      console.warn(`Open Library lookup failed: ${err.message}`);
    }
  }
  if (googleError) throw googleError;
  return { items: [], source: 'google' };
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
async function serveStatic(request, response, pathname) {
  let file;
  if (pathname === '/vendor/zxing.min.js') {
    file = ZXING_FILE;
  } else {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Bad request path');
    }
    if (decoded.includes('\0')) throw new HttpError(400, 'Bad request path');
    if (decoded.endsWith('/')) decoded += 'index.html';
    const resolved = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize('/' + decoded));
    const relative = path.relative(PUBLIC_DIR, resolved);
    const hidden = relative.split(path.sep).some((part) => part.startsWith('.'));
    if (relative.startsWith('..') || path.isAbsolute(relative) || hidden) {
      throw new HttpError(404, 'Not found');
    }
    file = resolved;
  }

  let data;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new HttpError(404, 'Not found');
    data = await fs.readFile(file);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, 'Not found');
  }
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  response.end(request.method === 'HEAD' ? undefined : data);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'Bad request path');
  }
}

async function handleApi(request, response, pathname, searchParams, context) {
  const { store, options } = context;
  const method = request.method;
  const allow = (...methods) => {
    if (!methods.includes(method)) {
      throw new HttpError(405, 'Method not allowed', { headers: { Allow: methods.join(', ') } });
    }
  };

  if (pathname === '/api/health') {
    allow('GET');
    const count = (await store.list()).length;
    return sendJson(response, 200, { status: 'ok', books: count, lookupKeyConfigured: Boolean(options.googleBooksKey) });
  }

  if (pathname === '/api/books') {
    allow('GET', 'POST');
    if (method === 'GET') return sendJson(response, 200, { books: await store.list() });
    const book = await store.add(await readJsonBody(request, MAX_BODY_BYTES));
    return sendJson(response, 201, { book }, { Location: `/api/books/${book.id}` });
  }

  const bookMatch = pathname.match(/^\/api\/books\/([^/]+)$/);
  if (bookMatch) {
    allow('GET', 'PUT', 'DELETE');
    const id = safeDecode(bookMatch[1]);
    if (!isValidId(id)) throw new HttpError(404, 'Book not found');
    if (method === 'GET') return sendJson(response, 200, { book: await store.get(id) });
    if (method === 'PUT') {
      return sendJson(response, 200, { book: await store.update(id, await readJsonBody(request, MAX_BODY_BYTES)) });
    }
    return sendJson(response, 200, { deleted: await store.remove(id) });
  }

  if (pathname === '/api/export') {
    allow('GET');
    const books = await store.list();
    const stamp = new Date().toISOString().slice(0, 10);
    return sendJson(
      response,
      200,
      { app: 'home_library', version: 1, exportedAt: new Date().toISOString(), books },
      { 'Content-Disposition': `attachment; filename="home_library-${stamp}.json"` },
    );
  }

  if (pathname === '/api/import') {
    allow('POST');
    const body = await readJsonBody(request, MAX_IMPORT_BYTES);
    const rawBooks = Array.isArray(body) ? body : body?.books;
    const result = await store.importBooks(rawBooks, {
      mode: body?.mode === undefined || Array.isArray(body) ? 'merge' : body.mode,
      dryRun: body?.dryRun === true,
    });
    return sendJson(response, 200, result);
  }

  const lookupMatch = pathname.match(/^\/api\/lookup\/([^/]+)$/);
  if (lookupMatch) {
    allow('GET');
    const isbn = safeDecode(lookupMatch[1]);
    if (!isValidIsbn(isbn)) throw new HttpError(400, 'Not a valid ISBN-10 or ISBN-13');
    return sendJson(response, 200, await lookupIsbn(options, isbn));
  }

  throw new HttpError(404, 'Unknown API endpoint');
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// *.localhost always resolves to loopback, so it is as safe as localhost itself.
function isLoopbackHost(hostname) {
  return LOOPBACK.has(hostname) || hostname.endsWith('.localhost');
}

function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function createApp(config = {}) {
  const options = {
    host: config.host ?? '127.0.0.1',
    dataFile: config.dataFile ?? path.join(ROOT, 'data', 'books.json'),
    googleBooksUrl: config.googleBooksUrl ?? 'https://www.googleapis.com/books/v1/volumes',
    googleBooksKey: config.googleBooksKey ?? '',
    googleViewApiUrl: config.googleViewApiUrl === undefined ? 'https://books.google.com/books' : config.googleViewApiUrl,
    // Pass false to turn the Open Library fallback off.
    openLibraryUrl: config.openLibraryUrl === undefined ? 'https://openlibrary.org/api/books' : config.openLibraryUrl,
  };
  const store = new BookStore(options.dataFile);
  // When bound to loopback only, reject unexpected Host headers (DNS-rebinding defence).
  const checkHost = LOOPBACK.has(options.host) || options.host === '::1';
  const context = { store, options };

  const server = http.createServer(async (request, response) => {
    try {
      if (checkHost && !isLoopbackHost(hostnameOf(request.headers.host))) {
        throw new HttpError(403, 'Unexpected Host header');
      }
      const origin = request.headers.origin;
      if (origin && origin !== 'null' && new URL(origin).host !== request.headers.host) {
        throw new HttpError(403, 'Cross-origin requests are not allowed');
      }
      if (origin === 'null') throw new HttpError(403, 'Cross-origin requests are not allowed');

      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url.pathname, url.searchParams, context);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed', { headers: { Allow: 'GET, HEAD' } });
      }
      await serveStatic(request, response, url.pathname);
    } catch (err) {
      let status = 500;
      let message = 'Internal server error';
      let extra = {};
      if (err instanceof HttpError || err instanceof StoreError) {
        status = err.status;
        message = err.message;
        extra = err.extra || {};
      } else {
        console.error('Unexpected error:', err);
      }
      if (response.headersSent) return response.destroy();
      const { headers, ...body } = extra;
      sendJson(response, status, { error: message, ...body }, headers);
    }
  });
  // A bad client must not be able to hold sockets open forever.
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;

  return { server, store, options };
}

// ---------------------------------------------------------------------------
// Start (only when run directly: `node server.js`)
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const dataFile = process.env.BOOKS_FILE ? path.resolve(process.env.BOOKS_FILE) : undefined;
  const { server, store, options } = createApp({
    host,
    dataFile,
    googleBooksKey: process.env.GOOGLE_BOOKS_API_KEY || '',
    googleBooksUrl: process.env.GOOGLE_BOOKS_URL || undefined,
    googleViewApiUrl: process.env.GOOGLE_VIEWAPI_URL || undefined,
    openLibraryUrl: process.env.OPEN_LIBRARY === 'off' ? false : process.env.OPEN_LIBRARY_URL || undefined,
  });

  try {
    const count = await store.init();
    console.log(`Library file: ${options.dataFile} (${count} book${count === 1 ? '' : 's'})`);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Try: PORT=3001 npm start`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' || host === '127.0.0.1' ? 'localhost' : host;
    console.log(`My Home Library is running at http://${shown}:${port}`);
    if (!LOOPBACK.has(host)) {
      console.log('Warning: the server is reachable from other devices on your network and has no login.');
    }
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
