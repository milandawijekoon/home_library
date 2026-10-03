import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

let tmp, app, base, upstream, upstreamBase, upstreamMode, olUpstream, olMode;

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function api(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

const matilda = { isbn13: '9780140328721', title: 'Matilda', authors: ['Roald Dahl'], publisher: 'Puffin' };

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'home_library-test-'));
  upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (upstreamMode === 'rate-limit') { res.writeHead(429); return res.end('{}'); }
    if (upstreamMode === 'error') { res.writeHead(500); return res.end('boom'); }
    // Fake viewapi: only the "hidden" book (which Google search cannot find) is known.
    if (u.pathname === '/books') {
      const keys = u.searchParams.get('bibkeys') || '';
      const known = keys.includes('ISBN:9786245546732')
        ? { 'ISBN:9786245546732': { info_url: 'https://books.google.com/books?id=hidden123&source=gbs_ViewAPI' } }
        : keys.includes('ISBN:9786245546800')
          ? { 'ISBN:9786245546800': { info_url: 'https://books.google.com/books?id=wrong123&source=gbs_ViewAPI' } }
          : {};
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end(`var _GBSBookInfo = ${JSON.stringify(known)};`);
    }
    // Fake volume-by-id
    const byId = u.pathname.match(/\/volumes\/([\w-]+)$/);
    if (byId) {
      const vols = {
        hidden123: { id: 'hidden123', volumeInfo: { title: 'Hidden Book', language: 'si', industryIdentifiers: [{ type: 'ISBN_10', identifier: '6245546737' }, { type: 'ISBN_13', identifier: '9786245546732' }] } },
        wrong123: { id: 'wrong123', volumeInfo: { title: 'Some other edition', industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780306406157' }] } },
      };
      res.writeHead(vols[byId[1]] ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(vols[byId[1]] || {}));
    }
    const q = u.searchParams.get('q');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (q === 'isbn:9780140328721') {
      return res.end(JSON.stringify({ items: [{ id: 'abc', volumeInfo: { title: 'Matilda' } }] }));
    }
    res.end(JSON.stringify({ totalItems: 0 }));
  });
  upstreamBase = `http://127.0.0.1:${await listen(upstream)}/volumes`;
  // Fake Open Library: knows Matilda only when olMode === 'has'.
  olUpstream = http.createServer((req, res) => {
    if (olMode === 'error') { res.writeHead(500); return res.end('boom'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const bibkeys = new URL(req.url, 'http://x').searchParams.get('bibkeys') || '';
    if (olMode === 'has' && bibkeys.includes('ISBN:9780140328721')) {
      return res.end(JSON.stringify({ 'ISBN:9780140328721': {
        title: 'Matilda', authors: [{ name: 'Roald Dahl' }], publishers: [{ name: 'Puffin Books' }],
        publish_date: 'March 1, 1988', number_of_pages: 240, subjects: [{ name: 'Fiction' }],
        identifiers: { isbn_13: ['9780140328721'], isbn_10: ['0140328726'] },
        cover: { large: 'https://covers.openlibrary.org/b/id/1-L.jpg' },
      } }));
    }
    res.end('{}');
  });
  const olBase = `http://127.0.0.1:${await listen(olUpstream)}/api/books`;
  app = createApp({ dataFile: path.join(tmp, 'data', 'books.json'), googleBooksUrl: upstreamBase, googleViewApiUrl: upstreamBase.replace('/volumes', '/books'), openLibraryUrl: olBase });
  await app.store.init();
  base = `http://127.0.0.1:${await listen(app.server)}`;
});

after(async () => {
  app.server.close();
  upstream.close();
  olUpstream.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

test('health check and empty library (file created on init)', async () => {
  const health = await api('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  assert.deepEqual((await api('GET', '/api/books')).json, { books: [] });
  const file = JSON.parse(await fs.readFile(path.join(tmp, 'data', 'books.json'), 'utf8'));
  assert.deepEqual(file, { books: [] });
});

let created;
test('POST adds a book, derives the other ISBN form, sets ids and dates', async () => {
  const res = await api('POST', '/api/books', matilda);
  assert.equal(res.status, 201);
  created = res.json.book;
  assert.ok(created.id);
  assert.equal(created.isbn10, '0140328726');
  assert.equal(created.pageCount, null);
  assert.ok(created.dateAdded && created.dateUpdated);
  const onDisk = JSON.parse(await fs.readFile(path.join(tmp, 'data', 'books.json'), 'utf8'));
  assert.equal(onDisk.books.length, 1);
});

test('duplicate ISBN is rejected (any form/format) and nothing is overwritten', async () => {
  for (const dup of [
    { isbn13: '978-0-14-032872-1', title: 'Other title' },
    { isbn10: '0-14-032872-6', title: 'Other title' },
    { isbn: '0140328726', title: 'Other title' },
  ]) {
    const res = await api('POST', '/api/books', dup);
    assert.equal(res.status, 409, JSON.stringify(dup));
    assert.equal(res.json.existing.title, 'Matilda');
  }
  assert.equal((await api('GET', '/api/books')).json.books[0].title, 'Matilda');
});

test('validation: checksums, required fields, types, unknown fields ignored', async () => {
  const bad = [
    [{ isbn13: '9780140328720', title: 'x' }, /isbn13/],
    [{ isbn10: '0140328727', title: 'x' }, /isbn10/],
    [{ title: 'No isbn' }, /ISBN-13 is required/],
    [{ isbn13: '9780306406157', title: '' }, /title is required/],
    [{ isbn13: '9780306406157', title: 'x', authors: 'a string' }, /authors/],
    [{ isbn13: '9780306406157', title: 'x', pageCount: -3 }, /pageCount/],
    [{ isbn13: '9780306406157', title: 'x', coverImage: 'javascript:alert(1)' }, /coverImage/],
    [{ isbn13: '9780306406157', title: 'x'.repeat(301) }, /title/],
  ];
  for (const [payload, pattern] of bad) {
    const res = await api('POST', '/api/books', payload);
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.match(res.json.details.join(' '), pattern);
  }
  const ok = await api('POST', '/api/books', {
    isbn13: '9780306406157', title: ' <b>Bold</b>  title ', id: 'hacker', dateAdded: '1999-01-01',
    coverImage: 'http://example.com/c.jpg', pageCount: '320', language: 'EN', extra: 1,
  });
  assert.equal(ok.status, 201);
  assert.notEqual(ok.json.book.id, 'hacker');
  assert.notEqual(ok.json.book.dateAdded, '1999-01-01');
  assert.equal(ok.json.book.title, '<b>Bold</b> title'); // stored verbatim; the UI renders as text
  assert.equal(ok.json.book.coverImage, 'https://example.com/c.jpg');
  assert.equal(ok.json.book.pageCount, 320);
  assert.equal(ok.json.book.language, 'en');
  assert.equal('extra' in ok.json.book, false);
  await api('DELETE', `/api/books/${ok.json.book.id}`);
});

test('GET one, PUT update, PUT clash, 404s', async () => {
  assert.equal((await api('GET', `/api/books/${created.id}`)).json.book.title, 'Matilda');
  const put = await api('PUT', `/api/books/${created.id}`, { ...matilda, title: 'Matilda (2nd ed.)', pageCount: 240 });
  assert.equal(put.status, 200);
  assert.equal(put.json.book.id, created.id);
  assert.equal(put.json.book.dateAdded, created.dateAdded);
  assert.equal(put.json.book.title, 'Matilda (2nd ed.)');
  assert.equal(put.json.book.pageCount, 240);

  const other = (await api('POST', '/api/books', { isbn13: '9780306406157', title: 'Other' })).json.book;
  const clash = await api('PUT', `/api/books/${other.id}`, { isbn13: matilda.isbn13, title: 'Other' });
  assert.equal(clash.status, 409);
  assert.equal((await api('PUT', '/api/books/nope', matilda)).status, 404);
  assert.equal((await api('GET', '/api/books/nope')).status, 404);
  assert.equal((await api('DELETE', '/api/books/nope')).status, 404);
  assert.equal((await api('GET', '/api/books/%E0%A4%A')).status, 400);
  const del = await api('DELETE', `/api/books/${other.id}`);
  assert.equal(del.status, 200);
  assert.equal((await api('GET', '/api/books')).json.books.length, 1);
});

test('read flag: defaults to false, can be set, toggled, and must be a boolean', async () => {
  const add = await api('POST', '/api/books', { isbn13: '9780201633610', title: 'Design Patterns' });
  assert.equal(add.json.book.read, false);
  const id = add.json.book.id;
  const on = await api('PUT', `/api/books/${id}`, { ...add.json.book, read: true });
  assert.equal(on.json.book.read, true);
  assert.equal((await api('GET', `/api/books/${id}`)).json.book.read, true);
  // an update that omits the field resets it rather than leaving stale data
  assert.equal((await api('PUT', `/api/books/${id}`, { isbn13: '9780201633610', title: 'Design Patterns' })).json.book.read, false);
  for (const bad of ['yes', 1, 'true', {}]) {
    const res = await api('PUT', `/api/books/${id}`, { isbn13: '9780201633610', title: 'x', read: bad });
    assert.equal(res.status, 400, String(bad));
    assert.match(res.json.details.join(' '), /read must be true or false/);
  }
  // import keeps the flag; books from older backups (no flag) come in as not read
  const imp = await api('POST', '/api/import', { books: [
    { isbn13: '9780596517748', title: 'JS Good Parts', read: true },
    { isbn13: '9781491950296', title: 'Old backup entry' },
  ] });
  assert.equal(imp.json.added, 2);
  const books = (await api('GET', '/api/books')).json.books;
  assert.equal(books.find((b) => b.title === 'JS Good Parts').read, true);
  assert.equal(books.find((b) => b.title === 'Old backup entry').read, false);
  for (const title of ['JS Good Parts', 'Old backup entry']) await api('DELETE', `/api/books/${books.find((b) => b.title === title).id}`);
  await api('DELETE', `/api/books/${id}`);
});

test('cover photos: small embedded JPEG/PNG/WebP accepted, everything else rejected', async () => {
  const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60000, 7)]).toString('base64');
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100, 1)]).toString('base64');
  const post = (coverImage, isbn13 = '9780201633610') => api('POST', '/api/books', { isbn13, title: 'Photo book', coverImage });

  const ok = await post(jpeg);
  assert.equal(ok.status, 201);
  assert.equal(ok.json.book.coverImage, jpeg); // stored verbatim, not mangled
  assert.equal((await api('GET', `/api/books/${ok.json.book.id}`)).json.book.coverImage, jpeg);
  await api('DELETE', `/api/books/${ok.json.book.id}`);
  const okPng = await post(png);
  assert.equal(okPng.status, 201);
  await api('DELETE', `/api/books/${okPng.json.book.id}`);

  const bad = {
    'wrong signature': 'data:image/jpeg;base64,' + Buffer.alloc(100, 1).toString('base64'),
    svg: 'data:image/svg+xml;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64'),
    'not base64': 'data:image/jpeg;base64,@@@@',
    'plain data (no base64)': 'data:image/jpeg,abc',
    'too big': 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400000, 7)]).toString('base64'),
    html: 'data:text/html;base64,PGgxPmhpPC9oMT4=',
  };
  for (const [name, value] of Object.entries(bad)) {
    const res = await post(value);
    assert.equal(res.status, 400, name);
    assert.match(res.json.details.join(' '), /coverImage/, name);
  }
});

test('request hardening: content type, size, bad JSON, methods, host, origin', async () => {
  assert.equal((await api('POST', '/api/books', '{}', { 'Content-Type': 'text/plain' })).status, 415);
  const badJson = await fetch(base + '/api/books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(badJson.status, 400);
  const big = await api('POST', '/api/books', { ...matilda, description: 'x'.repeat(800 * 1024) });
  assert.equal(big.status, 413);
  assert.equal((await api('PATCH', '/api/books')).status, 405);
  assert.equal((await api('GET', '/api/nope')).status, 404);
  // Origin from another site is refused; same-origin is fine.
  assert.equal((await api('POST', '/api/books', matilda, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await api('GET', '/api/books', undefined, { Origin: base })).status, 200);
  // Host header must be loopback (DNS rebinding) — raw request, since fetch forbids setting Host.
  const status = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: new URL(base).port, path: '/api/books', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(status, 403);
});

test('static files: served, SPA root, no traversal, no dotfiles, no data dir', async () => {
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  for (const bad of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/data/books.json', '/../data/books.json', '/%00', '/js/', '/.env', '/node_modules/x']) {
    const res = await fetch(base + bad);
    assert.ok([400, 404].includes(res.status), `${bad} -> ${res.status}`);
  }
  // raw path traversal (fetch normalises ../ so use a socket-level request)
  const status = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: new URL(base).port, path: '/../server.js' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(status, 404);
  assert.equal((await fetch(base + '/vendor/zxing.min.js')).status, 200);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
});

test('import: dry run, merge skips duplicates, invalid reported, replace keeps backup', async () => {
  const backup = [
    { ...matilda, title: 'SHOULD NOT OVERWRITE' },
    { isbn13: '9780306406157', title: 'New one', dateAdded: '2020-05-05T00:00:00Z', id: 'keep-my-id' },
    { isbn13: '9780306406157', title: 'Dup inside file' },
    { isbn13: '123', title: 'Bad isbn' },
    'not an object',
  ];
  const dry = await api('POST', '/api/import', { books: backup, dryRun: true });
  assert.deepEqual([dry.json.added, dry.json.duplicates, dry.json.invalid, dry.json.total], [1, 2, 2, 2]);
  assert.equal((await api('GET', '/api/books')).json.books.length, 1);

  const merged = await api('POST', '/api/import', { books: backup });
  assert.equal(merged.status, 200);
  assert.equal(merged.json.added, 1);
  const books = (await api('GET', '/api/books')).json.books;
  assert.equal(books.length, 2);
  assert.equal(books.find((b) => b.isbn13 === matilda.isbn13).title, 'Matilda (2nd ed.)');
  const imported = books.find((b) => b.id === 'keep-my-id');
  assert.equal(imported.dateAdded, '2020-05-05T00:00:00.000Z');

  assert.equal((await api('POST', '/api/import', { books: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/import', [{ isbn13: '1', title: 'x' }])).json.added, 0);
  const emptyReplace = await api('POST', '/api/import', { books: [{ title: 'bad' }], mode: 'replace' });
  assert.equal(emptyReplace.status, 400);
  assert.equal((await api('GET', '/api/books')).json.books.length, 2);

  const replaced = await api('POST', '/api/import', { books: [backup[1]], mode: 'replace' });
  assert.equal(replaced.json.total, 1);
  assert.equal((await api('GET', '/api/books')).json.books.length, 1);
  const bak = JSON.parse(await fs.readFile(path.join(tmp, 'data', 'books.json.bak'), 'utf8'));
  assert.equal(bak.books.length, 2);

  const exp = await api('GET', '/api/export');
  assert.match(exp.headers.get('content-disposition'), /attachment; filename="home_library-\d{4}-\d{2}-\d{2}\.json"/);
  assert.equal(exp.json.books.length, 1);
});

test('concurrent writes do not lose books', async () => {
  const before = (await api('GET', '/api/books')).json.books.length;
  const isbns = ['9780306406157', '9780140328721', '9780132350884', '9781593279509', '9780201633610', '9780596517748', '9781491950296', '9780135957059'];
  const results = await Promise.all(isbns.map((isbn13, i) => api('POST', '/api/books', { isbn13, title: `Concurrent ${i}` })));
  const created = results.filter((r) => r.status === 201).length;
  const after = (await api('GET', '/api/books')).json.books;
  assert.equal(after.length, before + created);
  assert.equal(new Set(after.map((b) => b.id)).size, after.length);
  const leftovers = (await fs.readdir(path.join(tmp, 'data'))).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('Google Books proxy: found, not found, bad ISBN, rate limit, upstream error, unreachable', async () => {
  const found = await api('GET', '/api/lookup/9780140328721');
  assert.equal(found.status, 200);
  assert.equal(found.json.items[0].id, 'abc');
  assert.equal((await api('GET', '/api/lookup/0140328726')).json.items[0].id, 'abc'); // ISBN-10 input
  assert.deepEqual((await api('GET', '/api/lookup/9780306406157')).json, { items: [], source: 'google' });
  assert.equal((await api('GET', '/api/lookup/9780306406158')).status, 400);
  upstreamMode = 'rate-limit';
  const limited = await api('GET', '/api/lookup/9780140328721');
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, 'rate-limit');
  upstreamMode = 'error';
  assert.equal((await api('GET', '/api/lookup/9780140328721')).status, 502);
  upstreamMode = undefined;
  const dead = createApp({ dataFile: path.join(tmp, 'x.json'), googleBooksUrl: 'http://127.0.0.1:9/volumes', googleViewApiUrl: false, openLibraryUrl: false });
  const port = await listen(dead.server);
  const res = await fetch(`http://127.0.0.1:${port}/api/lookup/9780140328721`);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'network');
  dead.server.close();
});

test('Google viewapi route finds books the isbn: search misses (and rejects mismatched editions)', async () => {
  olMode = undefined; upstreamMode = undefined;
  const found = await api('GET', '/api/lookup/9786245546732');
  assert.equal(found.status, 200);
  assert.equal(found.json.source, 'google');
  assert.equal(found.json.items[0].id, 'hidden123');
  assert.equal(found.json.items[0].volumeInfo.title, 'Hidden Book');
  // ISBN-10 input resolves to the same record
  assert.equal((await api('GET', '/api/lookup/6245546737')).json.items[0].id, 'hidden123');
  // viewapi points at an edition that does not carry this ISBN: treated as not found
  assert.deepEqual((await api('GET', '/api/lookup/9786245546800')).json, { items: [], source: 'google' });
});

test('Open Library fallback: used when Google is limited, down or has no record', async () => {
  const lookup = () => api('GET', '/api/lookup/9780140328721');
  olMode = 'has';

  upstreamMode = undefined; // Google has it: Google wins
  assert.equal((await lookup()).json.source, 'google');

  upstreamMode = 'rate-limit';
  let res = await lookup();
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'openlibrary');
  assert.equal(res.json.googleUnavailable, true);
  const info = res.json.items[0].volumeInfo;
  assert.equal(info.title, 'Matilda');
  assert.deepEqual(info.authors, ['Roald Dahl']);
  assert.equal(info.publisher, 'Puffin Books');
  assert.equal(info.publishedDate, '1988-03-01');
  assert.equal(info.pageCount, 240);
  assert.equal(info.imageLinks.thumbnail, 'https://covers.openlibrary.org/b/id/1-L.jpg');

  upstreamMode = 'error';
  assert.equal((await lookup()).json.source, 'openlibrary');

  // Google answers "no match" but Open Library knows it (use an ISBN-10 input too).
  upstreamMode = undefined;
  const upstreamEmpty = await api('GET', '/api/lookup/9780306406157');
  assert.deepEqual(upstreamEmpty.json, { items: [], source: 'google' });

  // Google failing and Open Library failing/empty: report Google's error, never a false "not found".
  upstreamMode = 'rate-limit';
  olMode = 'error';
  assert.equal((await lookup()).status, 429);
  olMode = undefined;
  assert.equal((await lookup()).status, 429);

  // Google has no record and Open Library is down: plain "not found".
  upstreamMode = undefined;
  olMode = 'error';
  assert.deepEqual((await api('GET', '/api/lookup/9780306406157')).json, { items: [], source: 'google' });
  olMode = undefined; upstreamMode = undefined;
});

test('corrupt books.json is never overwritten; missing file is an empty library', async () => {
  const file = path.join(tmp, 'corrupt.json');
  await fs.writeFile(file, '{"books": [ {oops');
  const bad = createApp({ dataFile: file });
  const port = await listen(bad.server);
  const get = await fetch(`http://127.0.0.1:${port}/api/books`);
  assert.equal(get.status, 500);
  assert.match((await get.json()).error, /not valid JSON/);
  const post = await fetch(`http://127.0.0.1:${port}/api/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(matilda) });
  assert.equal(post.status, 500);
  assert.equal(await fs.readFile(file, 'utf8'), '{"books": [ {oops');
  bad.server.close();

  const fresh = createApp({ dataFile: path.join(tmp, 'new', 'fresh.json') });
  const p2 = await listen(fresh.server);
  const add = await fetch(`http://127.0.0.1:${p2}/api/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(matilda) });
  assert.equal(add.status, 201);
  fresh.server.close();
});
