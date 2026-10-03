// Open Library lookup (no API key needed), used when Google Books is rate-limited,
// unreachable, or has no record. Results are converted to the shape of a Google Books
// "volume" so the browser can use one mapping function for both sources.
import { canonicalIsbn, isbn13To10 } from './public/js/isbn.js';

const LOOKUP_TIMEOUT_MS = 10_000;

export class OpenLibraryError extends Error {}

/** "1988", "March 1, 1988" and "Mar 1988" -> "1988-03-01" / "1988" / "1988". Unknown -> "". */
export function normalizePublishDate(text) {
  if (typeof text !== 'string') return '';
  const s = text.trim();
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return s;
  if (/^[A-Za-z]+\.? \d{1,2}, \d{4}$/.test(s)) {
    const t = Date.parse(`${s} UTC`);
    if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return s.match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1] || '';
}

const names = (list) => (Array.isArray(list) ? list.map((x) => x?.name).filter((n) => typeof n === 'string' && n) : []);

/** Convert one Open Library "data" record into a Google-Books-shaped volume. */
export function openLibraryToVolume(entry, isbn) {
  const ids = entry.identifiers || {};
  const identifiers = [
    ...(ids.isbn_13 || []).map((identifier) => ({ type: 'ISBN_13', identifier })),
    ...(ids.isbn_10 || []).map((identifier) => ({ type: 'ISBN_10', identifier })),
  ];
  // Make sure the searched ISBN is present so the browser can match the record to it.
  const key = canonicalIsbn(isbn);
  if (key && !identifiers.some((i) => canonicalIsbn(i.identifier) === key)) {
    identifiers.push({ type: 'ISBN_13', identifier: key });
  }
  const cover = entry.cover?.large || entry.cover?.medium || entry.cover?.small || '';
  return {
    id: '', // not a Google Books id
    volumeInfo: {
      title: entry.title || '',
      subtitle: entry.subtitle || '',
      authors: names(entry.authors),
      publisher: names(entry.publishers)[0] || '',
      publishedDate: normalizePublishDate(entry.publish_date),
      industryIdentifiers: identifiers,
      pageCount: Number.isInteger(entry.number_of_pages) ? entry.number_of_pages : undefined,
      categories: names(entry.subjects).slice(0, 5),
      imageLinks: cover ? { thumbnail: cover } : undefined,
    },
  };
}

/**
 * Look an ISBN up on Open Library. Resolves to a volume-shaped object, or null if there is
 * no record. Throws OpenLibraryError on network/HTTP problems.
 */
export async function lookupOpenLibrary(baseUrl, isbn) {
  const isbn13 = canonicalIsbn(isbn);
  const keys = [isbn13, isbn13To10(isbn13)].filter(Boolean).map((i) => `ISBN:${i}`);
  const url = new URL(baseUrl);
  url.searchParams.set('bibkeys', keys.join(','));
  url.searchParams.set('format', 'json');
  url.searchParams.set('jscmd', 'data');

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), headers: { Accept: 'application/json' } });
  } catch {
    throw new OpenLibraryError('Could not reach Open Library');
  }
  if (!response.ok) throw new OpenLibraryError(`Open Library returned HTTP ${response.status}`);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new OpenLibraryError('Open Library returned an unreadable response');
  }
  const entry = keys.map((k) => data?.[k]).find((e) => e && typeof e === 'object' && e.title);
  return entry ? openLibraryToVolume(entry, isbn) : null;
}
