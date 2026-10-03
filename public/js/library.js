// Library data layer: talks to the local server (books.json is the source of truth)
// and provides the pure search / filter / sort helpers used by the UI.
import { bookKey, canonicalIsbn, normalizeIsbn } from './isbn.js';

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', details = [], existing = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.existing = existing;
  }
}

async function request(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the library server. Is it still running?', { code: 'offline' });
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* non-JSON body */
  }
  if (!response.ok) {
    throw new ApiError(data?.error || `Request failed (HTTP ${response.status})`, {
      status: response.status,
      code: data?.code || '',
      details: data?.details || [],
      existing: data?.existing || null,
    });
  }
  return data;
}

export const api = {
  async list() {
    return (await request('GET', '/api/books')).books;
  },
  async add(book) {
    return (await request('POST', '/api/books', book)).book;
  },
  async update(id, book) {
    return (await request('PUT', `/api/books/${encodeURIComponent(id)}`, book)).book;
  },
  async remove(id) {
    await request('DELETE', `/api/books/${encodeURIComponent(id)}`);
  },
  importBooks(books, { mode, dryRun }) {
    return request('POST', '/api/import', { books, mode, dryRun });
  },
};

// ---------------------------------------------------------------------------
// Display helpers (tolerant of hand-edited books.json)
// ---------------------------------------------------------------------------
export function asList(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function findByIsbn(books, isbn) {
  const key = canonicalIsbn(isbn);
  return key ? books.find((b) => bookKey(b) === key) || null : null;
}

const languageNames = (() => {
  try {
    return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
  } catch {
    return null;
  }
})();

export function languageName(code) {
  if (!code) return '';
  try {
    return languageNames?.of(code) || code;
  } catch {
    return code;
  }
}

// ---------------------------------------------------------------------------
// Search, filter, sort
// ---------------------------------------------------------------------------
export const SORT_FIELDS = {
  dateAdded: { label: 'Date added', defaultDir: 'desc', asc: 'Oldest first', desc: 'Newest first' },
  title: { label: 'Title', defaultDir: 'asc', asc: 'A to Z', desc: 'Z to A' },
  author: { label: 'Author', defaultDir: 'asc', asc: 'A to Z', desc: 'Z to A' },
  publishedDate: { label: 'Publication date', defaultDir: 'desc', asc: 'Oldest first', desc: 'Newest first' },
};

function searchText(book) {
  return [
    book.title,
    book.subtitle,
    ...asList(book.authors),
    book.publisher,
    book.isbn13,
    book.isbn10,
    ...asList(book.categories),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matchesQuery(book, tokens) {
  if (!tokens.length) return true;
  const text = searchText(book);
  return tokens.every((token) => {
    if (text.includes(token)) return true;
    // "978-0-14-…" typed with hyphens still matches the stored plain digits.
    const plain = normalizeIsbn(token).toLowerCase();
    return plain.length >= 3 && /^[\dx]+$/.test(plain) && text.includes(plain);
  });
}

function sortValue(book, field) {
  switch (field) {
    case 'title':
      return (book.title || '').trim();
    case 'author':
      return asList(book.authors)[0] || '';
    case 'publishedDate':
      return (book.publishedDate || '').trim();
    default:
      return book.dateAdded || '';
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const isRead = (book) => book?.read === true;

export function filterAndSort(books, { query = '', category = '', language = '', status = '', sortBy = 'dateAdded', sortDir = 'desc' }) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const dir = sortDir === 'asc' ? 1 : -1;
  return books
    .filter((b) => matchesQuery(b, tokens))
    .filter((b) => !category || asList(b.categories).includes(category))
    .filter((b) => !language || (b.language || '') === language)
    .filter((b) => !status || (status === 'read') === isRead(b))
    .sort((a, b) => {
      const av = sortValue(a, sortBy);
      const bv = sortValue(b, sortBy);
      // Books missing the sort value always go last, whichever direction is chosen.
      if (!av !== !bv) return av ? -1 : 1;
      const cmp = sortBy === 'dateAdded' || sortBy === 'publishedDate' ? (av < bv ? -1 : av > bv ? 1 : 0) : collator.compare(av, bv);
      return cmp * dir || collator.compare(a.title || '', b.title || '');
    });
}

export function collectFacets(books) {
  const categories = new Set();
  const languages = new Set();
  for (const b of books) {
    asList(b.categories).forEach((c) => categories.add(c));
    if (b.language) languages.add(b.language);
  }
  return {
    categories: [...categories].sort(collator.compare),
    languages: [...languages].sort((a, b) => collator.compare(languageName(a), languageName(b))),
  };
}

// ---------------------------------------------------------------------------
// View preferences (per-browser convenience only; the books themselves live in books.json)
// ---------------------------------------------------------------------------
const PREFS_KEY = 'home-library:prefs';

export function loadPrefs() {
  const defaults = { view: 'grid', sortBy: 'dateAdded', sortDir: 'desc' };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      view: saved.view === 'list' ? 'list' : 'grid',
      sortBy: saved.sortBy in SORT_FIELDS ? saved.sortBy : defaults.sortBy,
      sortDir: saved.sortDir === 'asc' || saved.sortDir === 'desc' ? saved.sortDir : defaults.sortDir,
    };
  } catch {
    return defaults;
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: preferences just won't persist */
  }
}
