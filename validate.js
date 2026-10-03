// Server-side validation and normalisation of book records.
import {
  normalizeIsbn,
  isValidIsbn10,
  isValidIsbn13,
  isbn10To13,
  isbn13To10,
} from './public/js/isbn.js';

const LIMITS = {
  title: 300,
  subtitle: 300,
  publisher: 200,
  publishedDate: 32,
  description: 10000,
  author: 200,
  authors: 50,
  category: 100,
  categories: 30,
  coverImage: 2000,
  coverPhoto: 400_000, // characters of a base64 data URL (~300 KB image)
  googleBooksId: 100,
  maxPages: 100000,
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function cleanString(value, max, field, errors, { multiline = false } = {}) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`);
    return '';
  }
  let s = value.replace(CONTROL_CHARS, '').trim();
  if (!multiline) s = s.replace(/\s+/g, ' ');
  if (s.length > max) {
    errors.push(`${field} must be at most ${max} characters`);
    return '';
  }
  return s;
}

function cleanList(value, maxItems, maxLen, field, errors) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings`);
    return [];
  }
  if (value.length > maxItems) {
    errors.push(`${field} may contain at most ${maxItems} entries`);
    return [];
  }
  const out = [];
  for (const item of value) {
    const s = cleanString(item, maxLen, field, errors);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

const PHOTO_DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/** A cover photo taken in the app: a small embedded image. Checks type, size and file signature. */
function cleanCoverPhoto(value, errors) {
  const match = value.length <= LIMITS.coverPhoto ? PHOTO_DATA_URL.exec(value) : null;
  if (!match) {
    errors.push('coverImage photo must be a JPEG, PNG or WebP image under about 300 KB');
    return '';
  }
  const head = Buffer.from(match[2].slice(0, 24), 'base64');
  const type = match[1];
  const ok =
    (type === 'jpeg' && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
    (type === 'png' && head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) ||
    (type === 'webp' && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP');
  if (!ok) {
    errors.push('coverImage photo is not a valid image');
    return '';
  }
  return value;
}

function cleanCoverUrl(value, errors) {
  if (typeof value === 'string' && value.startsWith('data:')) return cleanCoverPhoto(value.trim(), errors);
  const s = cleanString(value, LIMITS.coverImage, 'coverImage', errors);
  if (!s) return '';
  let url;
  try {
    url = new URL(s);
  } catch {
    errors.push('coverImage must be a valid http(s) URL');
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push('coverImage must be a valid http(s) URL');
    return '';
  }
  // Upgrade to https so covers load on pages served over https as well.
  url.protocol = 'https:';
  return url.toString();
}

function cleanPageCount(value, errors) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < 0 || n > LIMITS.maxPages) {
    errors.push(`pageCount must be a whole number between 0 and ${LIMITS.maxPages}`);
    return null;
  }
  return n === 0 ? null : n;
}

function cleanBoolean(value, field, errors) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    errors.push(`${field} must be true or false`);
    return false;
  }
  return value;
}

function cleanLanguage(value, errors) {
  const s = cleanString(value, 16, 'language', errors).toLowerCase();
  if (s && !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(s)) {
    errors.push('language must be a language code such as "en"');
    return '';
  }
  return s;
}

/**
 * Validate and normalise user-supplied book data.
 * Returns { value, errors }. `value` carries only whitelisted fields (never id/dates).
 * An ISBN-10 or ISBN-13 with a valid checksum is required; the missing form is derived.
 */
export function sanitizeBook(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { value: null, errors: ['Book must be a JSON object'] };
  }

  // ISBNs ---------------------------------------------------------------
  let isbn13 = normalizeIsbn(input.isbn13);
  let isbn10 = normalizeIsbn(input.isbn10);
  // Accept a generic "isbn" field and file it under the right form.
  const generic = normalizeIsbn(input.isbn);
  if (generic) {
    if (isValidIsbn13(generic) && !isbn13) isbn13 = generic;
    else if (isValidIsbn10(generic) && !isbn10) isbn10 = generic;
    else if (!isValidIsbn13(generic) && !isValidIsbn10(generic)) errors.push('isbn is not a valid ISBN');
  }
  if (isbn13 && !isValidIsbn13(isbn13)) {
    errors.push('isbn13 is not a valid ISBN-13 (check the digits)');
    isbn13 = '';
  }
  if (isbn10 && !isValidIsbn10(isbn10)) {
    errors.push('isbn10 is not a valid ISBN-10 (check the digits)');
    isbn10 = '';
  }
  if (!isbn13 && isbn10) isbn13 = isbn10To13(isbn10);
  if (isbn13 && !isbn10) isbn10 = isbn13To10(isbn13);
  if (!isbn13 && !errors.some((e) => e.startsWith('isbn'))) {
    errors.push('A valid ISBN-10 or ISBN-13 is required');
  }

  // Everything else -------------------------------------------------------
  const title = cleanString(input.title, LIMITS.title, 'title', errors);
  if (!title && !errors.some((e) => e.startsWith('title'))) errors.push('title is required');

  const value = {
    isbn13,
    isbn10,
    title,
    subtitle: cleanString(input.subtitle, LIMITS.subtitle, 'subtitle', errors),
    authors: cleanList(input.authors, LIMITS.authors, LIMITS.author, 'authors', errors),
    publisher: cleanString(input.publisher, LIMITS.publisher, 'publisher', errors),
    publishedDate: cleanString(input.publishedDate, LIMITS.publishedDate, 'publishedDate', errors),
    description: cleanString(input.description, LIMITS.description, 'description', errors, {
      multiline: true,
    }),
    pageCount: cleanPageCount(input.pageCount, errors),
    categories: cleanList(input.categories, LIMITS.categories, LIMITS.category, 'categories', errors),
    language: cleanLanguage(input.language, errors),
    coverImage: cleanCoverUrl(input.coverImage, errors),
    googleBooksId: cleanString(input.googleBooksId, LIMITS.googleBooksId, 'googleBooksId', errors),
    read: cleanBoolean(input.read, 'read', errors),
  };
  if (value.googleBooksId && !/^[\w-]+$/.test(value.googleBooksId)) {
    errors.push('googleBooksId contains invalid characters');
    value.googleBooksId = '';
  }

  return { value: errors.length ? null : value, errors };
}

/** Accepts only well-formed ISO timestamps; returns a normalised ISO string or "". */
export function cleanTimestamp(value) {
  if (typeof value !== 'string') return '';
  const t = Date.parse(value);
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

/** Ids are opaque tokens; reject anything unusual so they are safe in URLs and logs. */
export function isValidId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
