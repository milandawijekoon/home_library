// Google Books lookup. Requests go through the local server (/api/lookup/:isbn), which
// queries https://www.googleapis.com/books/v1/volumes?q=isbn:{ISBN} and keeps any
// configured API key out of the browser.
import { canonicalIsbn, isbn13To10, isbn10To13, isValidIsbn10, isValidIsbn13, normalizeIsbn } from './isbn.js';

export class LookupError extends Error {
  /** kind: "offline" | "network" | "rate-limit" | "upstream" | "invalid" */
  constructor(message, kind) {
    super(message);
    this.name = 'LookupError';
    this.kind = kind;
  }
}

/** Google descriptions can contain HTML. Convert to plain text via an inert DOM (no scripts run). */
export function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  const withBreaks = html.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  doc.querySelectorAll('script, style, template').forEach((node) => node.remove());
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function httpsUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  return url.replace(/^http:\/\//i, 'https://').replace(/&edge=curl/g, '');
}

function pickVolume(items, isbn) {
  const wanted = canonicalIsbn(isbn);
  const hasIsbn = (item) =>
    (item?.volumeInfo?.industryIdentifiers || []).some((id) => canonicalIsbn(id.identifier) === wanted);
  return items.find(hasIsbn) || items[0];
}

/** Map a Google Books volume to our book shape. Missing fields become empty values. */
export function mapVolume(item, searchedIsbn) {
  const info = item.volumeInfo || {};
  const ids = info.industryIdentifiers || [];
  const fromVolume13 = ids.map((i) => normalizeIsbn(i.identifier)).find(isValidIsbn13) || '';
  const fromVolume10 = ids.map((i) => normalizeIsbn(i.identifier)).find(isValidIsbn10) || '';
  const searched = canonicalIsbn(searchedIsbn);
  const isbn13 = fromVolume13 || (fromVolume10 ? isbn10To13(fromVolume10) : '') || searched;
  const isbn10 = fromVolume10 || isbn13To10(isbn13);
  const links = info.imageLinks || {};
  const asStrings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);

  return {
    isbn13,
    isbn10,
    title: info.title || '',
    subtitle: info.subtitle || '',
    authors: asStrings(info.authors),
    publisher: info.publisher || '',
    publishedDate: info.publishedDate || '',
    description: htmlToText(info.description),
    pageCount: Number.isInteger(info.pageCount) && info.pageCount > 0 ? info.pageCount : null,
    categories: asStrings(info.categories),
    language: info.language || '',
    coverImage: httpsUrl(links.thumbnail || links.smallThumbnail || links.small || links.medium || ''),
    googleBooksId: item.id || '',
  };
}

/**
 * Look up a book by ISBN-10/13. Resolves to a book object, or null when nothing matches.
 * The server asks Google Books first and falls back to Open Library; `source` says which
 * answered ("google" | "openlibrary").
 */
export async function lookupBook(isbn) {
  const normalized = normalizeIsbn(isbn);
  if (!isValidIsbn13(normalized) && !isValidIsbn10(normalized)) {
    throw new LookupError('That is not a valid ISBN.', 'invalid');
  }
  let response;
  try {
    response = await fetch(`/api/lookup/${encodeURIComponent(normalized)}`);
  } catch {
    throw new LookupError('Cannot reach the library server. Is it still running?', 'offline');
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* handled below */
  }
  if (!response.ok) {
    const kind = data?.code || (response.status === 429 ? 'rate-limit' : 'upstream');
    throw new LookupError(data?.error || `Lookup failed (HTTP ${response.status})`, kind);
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  if (items.length === 0) return null;
  return { ...mapVolume(pickVolume(items, normalized), normalized), source: data.source === 'openlibrary' ? 'openlibrary' : 'google' };
}
