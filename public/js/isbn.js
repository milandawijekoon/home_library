// ISBN helpers shared by the browser and the Node server (pure functions, no DOM).

/** Strip spaces/hyphens and upper-case a trailing "x". Returns "" for non-strings. */
export function normalizeIsbn(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\s-]/g, '').toUpperCase();
}

export function isValidIsbn10(value) {
  const s = normalizeIsbn(value);
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const digit = s[i] === 'X' ? 10 : Number(s[i]);
    sum += digit * (10 - i);
  }
  return sum % 11 === 0;
}

function isbn13CheckDigit(first12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidIsbn13(value) {
  const s = normalizeIsbn(value);
  if (!/^97[89]\d{10}$/.test(s)) return false;
  return isbn13CheckDigit(s) === Number(s[12]);
}

export function isValidIsbn(value) {
  return isValidIsbn13(value) || isValidIsbn10(value);
}

/** ISBN-10 -> ISBN-13 (978 prefix). Returns "" when the input is not a valid ISBN-10. */
export function isbn10To13(value) {
  const s = normalizeIsbn(value);
  if (!isValidIsbn10(s)) return '';
  const first12 = '978' + s.slice(0, 9);
  return first12 + isbn13CheckDigit(first12);
}

/** ISBN-13 -> ISBN-10. Only 978-prefixed ISBNs have a 10-digit equivalent; otherwise "". */
export function isbn13To10(value) {
  const s = normalizeIsbn(value);
  if (!isValidIsbn13(s) || !s.startsWith('978')) return '';
  const body = s.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return body + (check === 10 ? 'X' : String(check));
}

/**
 * Canonical key for duplicate detection: the ISBN-13 form of any valid ISBN.
 * Returns "" when the value is not a valid ISBN.
 */
export function canonicalIsbn(value) {
  const s = normalizeIsbn(value);
  if (isValidIsbn13(s)) return s;
  if (isValidIsbn10(s)) return isbn10To13(s);
  return '';
}

/** Canonical key for a stored book (prefers isbn13, falls back to isbn10). */
export function bookKey(book) {
  return canonicalIsbn(book?.isbn13) || canonicalIsbn(book?.isbn10);
}

/** Pretty-print for display (no hyphenation rules, just a stable plain form). */
export function formatIsbn(book) {
  return book?.isbn13 || book?.isbn10 || '';
}
