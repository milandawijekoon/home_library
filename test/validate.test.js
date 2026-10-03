import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBook, cleanTimestamp, isValidId } from '../validate.js';
import {
  normalizeIsbn, isValidIsbn, isValidIsbn10, isValidIsbn13, isbn10To13, isbn13To10, canonicalIsbn, bookKey, formatIsbn,
} from '../public/js/isbn.js';
import { normalizePublishDate, openLibraryToVolume, lookupOpenLibrary, OpenLibraryError } from '../open-library.js';

const ISBN13 = '9780140328721';
const ISBN10 = '0140328726';
const sanitized = (extra = {}) => sanitizeBook({ isbn13: ISBN13, title: 'T', ...extra });
const errs = (extra) => sanitized(extra).errors.join('|');
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64');
const dataUrl = (type, bytes) => `data:image/${type};base64,${Buffer.from(bytes).toString('base64')}`;

test('isbn: anchored format checks and checksums', () => {
  assert.equal(normalizeIsbn(1234), '1234');
  assert.equal(normalizeIsbn(' 0-14 03x '), '01403X');
  assert.equal(normalizeIsbn({}), '');
  assert.equal(normalizeIsbn(null), '');
  assert.equal(isValidIsbn10('x' + ISBN10), false);
  assert.equal(isValidIsbn10(ISBN10 + '0'), false);
  assert.equal(isValidIsbn10('0000000000'), true);
  assert.equal(isValidIsbn10('0140328727'), false);
  assert.equal(isValidIsbn13('x' + ISBN13), false);
  assert.equal(isValidIsbn13(ISBN13 + '0'), false);
  assert.equal(isValidIsbn13('9770000000002'), false); // 977 prefix not allowed
  assert.equal(isValidIsbn(ISBN13) && isValidIsbn(ISBN10), true);
  assert.equal(isValidIsbn('nope'), false);
  assert.equal(isbn10To13('bad'), '');
  assert.equal(isbn10To13(ISBN10), ISBN13);
  assert.equal(isbn13To10(ISBN13), ISBN10);
  assert.equal(isbn13To10('9791234567896'), ''); // 979: no ISBN-10
  assert.equal(isbn13To10('x'), '');
  assert.equal(isbn13To10('9780306406157'), '0306406152');
  assert.equal(isbn13To10('9780804429573'), '080442957X'); // check digit X
  assert.equal(canonicalIsbn(ISBN10), ISBN13);
  assert.equal(canonicalIsbn('zzz'), '');
  assert.equal(bookKey({ isbn10: ISBN10 }), ISBN13);
  assert.equal(bookKey({ isbn13: 'bad', isbn10: ISBN10 }), ISBN13);
  assert.equal(bookKey(null), '');
  assert.equal(formatIsbn({ isbn10: ISBN10 }), ISBN10);
  assert.equal(formatIsbn({ isbn13: ISBN13, isbn10: ISBN10 }), ISBN13);
  assert.equal(formatIsbn(null), '');
});

test('sanitizeBook: ISBN handling', () => {
  assert.deepEqual(sanitizeBook(null).errors, ['Book must be a JSON object']);
  assert.deepEqual(sanitizeBook([]).errors, ['Book must be a JSON object']);
  assert.deepEqual(sanitizeBook('x').errors, ['Book must be a JSON object']);
  const book = sanitizeBook({ isbn: ISBN10, title: 'T' }).value;
  assert.equal(book.isbn10, ISBN10);
  assert.equal(book.isbn13, ISBN13);
  assert.equal(sanitizeBook({ isbn: ISBN13, title: 'T' }).value.isbn10, ISBN10);
  assert.match(errs({ isbn13: undefined, isbn: '123' }), /isbn is not a valid ISBN/);
  assert.match(errs({ isbn13: '9780140328722' }), /isbn13 is not a valid/);
  assert.match(errs({ isbn10: '0140328727' }), /isbn10 is not a valid/);
  assert.match(sanitizeBook({ title: 'T' }).errors[0], /valid ISBN-10 or ISBN-13 is required/);
  assert.equal(sanitizeBook({ title: 'T', isbn13: 'bad' }).errors.length, 1);
  assert.equal(sanitizeBook({ isbn10: ISBN10, title: 'T' }).value.isbn13, ISBN13);
  assert.equal(sanitizeBook({ isbn13: '9791234567896', title: 'T' }).value.isbn10, '');
});

test('sanitizeBook: strings, lists and limits', () => {
  assert.match(sanitizeBook({ isbn13: ISBN13 }).errors[0], /title is required/);
  assert.match(errs({ title: 5 }), /title must be a string/);
  assert.doesNotMatch(errs({ title: 5 }), /required/);
  assert.equal(sanitized({ title: '  a \t\n b\u0000 ' }).value.title, 'a b');
  assert.equal(sanitized({ title: 'x'.repeat(300) }).errors.length, 0);
  assert.match(errs({ title: 'x'.repeat(301) }), /title must be at most 300 characters/);
  assert.equal(sanitized({ description: 'a\n\nb ' }).value.description, 'a\n\nb');
  assert.equal(sanitized({ subtitle: null }).value.subtitle, '');
  assert.deepEqual(sanitized({ authors: ['A', 'A', ' ', 'B'] }).value.authors, ['A', 'B']);
  assert.deepEqual(sanitized({ authors: '' }).value.authors, []);
  assert.match(errs({ authors: 'A' }), /authors must be an array/);
  assert.equal(sanitized({ authors: Array.from({ length: 50 }, (_, index) => 'a' + index) }).errors.length, 0);
  assert.match(errs({ authors: Array(51).fill('a') }), /at most 50 entries/);
  assert.match(errs({ categories: [1] }), /categories must be a string/);
  assert.match(errs({ authors: ['x'.repeat(201)] }), /at most 200/);
});

test('sanitizeBook: page count, language, boolean, google id', () => {
  const withPageCount = (value) => sanitized({ pageCount: value });
  assert.equal(withPageCount('12').value.pageCount, 12);
  assert.equal(withPageCount(0).value.pageCount, null);
  assert.equal(withPageCount('').value.pageCount, null);
  assert.equal(withPageCount(100000).value.pageCount, 100000);
  assert.match(withPageCount(100001).errors[0], /pageCount must be a whole number between 0 and 100000/);
  assert.equal(withPageCount(-1).errors.length, 1);
  assert.equal(withPageCount(1.5).errors.length, 1);
  assert.equal(withPageCount('abc').errors.length, 1);
  assert.equal(withPageCount('  ').errors.length, 1);
  assert.equal(sanitized({ language: 'EN' }).value.language, 'en');
  assert.equal(sanitized({ language: 'pt-br' }).value.language, 'pt-br');
  assert.match(errs({ language: 'english' }), /language code/);
  assert.match(errs({ language: 'e' }), /language code/);
  assert.match(errs({ language: 'en-' }), /language code/);
  assert.equal(sanitized({ read: true }).value.read, true);
  assert.equal(sanitized({}).value.read, false);
  assert.match(errs({ read: 'yes' }), /read must be true or false/);
  assert.equal(sanitized({ googleBooksId: 'a-b_9' }).value.googleBooksId, 'a-b_9');
  assert.match(errs({ googleBooksId: 'a b' }), /googleBooksId contains invalid/);
  assert.match(errs({ googleBooksId: 'a'.repeat(101) }), /googleBooksId must be at most 100/);
});

test('sanitizeBook: cover images', () => {
  const withCover = (value) => sanitized({ coverImage: value });
  const notValid = (value) => assert.match(withCover(value).errors[0], /not a valid image/);
  assert.equal(withCover('http://example.com/a.jpg').value.coverImage, 'https://example.com/a.jpg');
  assert.equal(withCover('').value.coverImage, '');
  assert.match(withCover('not a url').errors[0], /valid http\(s\) URL/);
  assert.match(withCover('ftp://example.com/a').errors[0], /valid http\(s\) URL/);
  assert.match(withCover('https://e.com/' + 'a'.repeat(2000)).errors[0], /at most 2000/);
  assert.equal(withCover(PNG).value.coverImage, PNG);
  assert.equal(withCover(PNG + '  ').value.coverImage, PNG);
  assert.match(withCover('data:image/gif;base64,AAAA').errors[0], /JPEG, PNG or WebP/);
  assert.match(withCover(PNG + '!').errors[0], /JPEG, PNG or WebP/);
  assert.match(withCover('data:image/png;base64,' + 'A'.repeat(400_000)).errors[0], /under about 300 KB/);
  notValid('data:image/png;base64,AAAAAAAAAAAA');
  const jpeg = dataUrl('jpeg', [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  assert.equal(withCover(jpeg).value.coverImage, jpeg);
  notValid(jpeg.replace('jpeg', 'png'));
  notValid(dataUrl('jpeg', [0xff, 0xd8, 0x00, 0, 0, 0, 0, 0]));
  notValid(dataUrl('jpeg', [0xff, 0x00, 0xff, 0, 0, 0, 0, 0]));
  notValid(dataUrl('jpeg', [0x00, 0xd8, 0xff, 0, 0, 0, 0, 0]));
  const riff = (first, second) => Buffer.concat([Buffer.from(first), Buffer.alloc(4), Buffer.from(second)]);
  const webp = dataUrl('webp', riff('RIFF', 'WEBP'));
  assert.equal(withCover(webp).value.coverImage, webp);
  notValid(dataUrl('webp', riff('RIFF', 'WEBX')));
  notValid(dataUrl('webp', riff('RIFX', 'WEBP')));
});

test('sanitizeBook: loans', () => {
  const withLoans = (loans) => sanitized({ loans });
  const loan = { borrower: ' Bob ', dateBorrowed: '2026-03-31', dateReturned: '2026-04-01' };
  const badDate = ['dateBorrowed must be a date like 2026-03-31'];
  assert.equal(sanitized({}).value.loans, undefined);
  assert.deepEqual(withLoans([loan]).value.loans, [{ borrower: 'Bob', dateBorrowed: '2026-03-31', dateReturned: '2026-04-01' }]);
  assert.deepEqual(withLoans([]).value.loans, []);
  assert.match(withLoans('x').errors[0], /loans must be an array/);
  assert.match(withLoans(Array(201).fill(loan)).errors[0], /at most 200 entries/);
  assert.match(withLoans([null]).errors[0], /each loan must be an object/);
  assert.match(withLoans([[]]).errors[0], /each loan must be an object/);
  assert.match(withLoans(['x']).errors[0], /each loan must be an object/);
  assert.deepEqual(withLoans([{ dateBorrowed: '2026-01-01' }]).errors, ['borrower is required']);
  assert.deepEqual(withLoans([{ borrower: 'B' }]).errors, ['dateBorrowed is required']);
  assert.deepEqual(withLoans([{ borrower: 5, dateBorrowed: '2026-01-01' }]).errors, ['borrower must be a string']);
  assert.deepEqual(withLoans([{ borrower: 'B', dateBorrowed: 'x' }]).errors, badDate);
  assert.deepEqual(withLoans([{ borrower: 'B', dateBorrowed: '2026-02-30' }]).errors, badDate);
  assert.deepEqual(withLoans([{ borrower: 'B', dateBorrowed: '2026-13-01' }]).errors, badDate);
  assert.deepEqual(withLoans([{ borrower: 'B', dateBorrowed: '2025-02-29' }]).errors, badDate);
  assert.deepEqual(withLoans([{ borrower: 'B', dateBorrowed: 20260101 }]).errors, badDate);
  assert.deepEqual(
    withLoans([{ borrower: 'B', dateBorrowed: '2026-01-02', dateReturned: '2026-01-01' }]).errors,
    ['dateReturned cannot be before dateBorrowed'],
  );
  assert.equal(withLoans([{ borrower: 'B', dateBorrowed: '2026-01-02', dateReturned: '2026-01-02' }]).errors.length, 0);
  assert.deepEqual(
    withLoans([{ borrower: 'B', dateBorrowed: '2026-01-01' }, { borrower: 'C', dateBorrowed: '2026-01-05' }]).errors,
    ['only the most recent loan can be unreturned'],
  );
  assert.equal(withLoans([{ borrower: 'B', dateBorrowed: '2026-01-01' }]).errors.length, 0);
  assert.equal(withLoans(Array(200).fill(loan)).errors.length, 0);
  assert.equal(withLoans([{ borrower: 'x'.repeat(100), dateBorrowed: '2026-01-01' }]).errors.length, 0);
  assert.equal(withLoans([{ borrower: 'x'.repeat(101), dateBorrowed: '2026-01-01' }]).errors.length, 1);
});

test('cleanTimestamp and isValidId', () => {
  assert.equal(cleanTimestamp('2026-03-31T10:00:00Z'), '2026-03-31T10:00:00.000Z');
  assert.equal(cleanTimestamp('nope'), '');
  assert.equal(cleanTimestamp(5), '');
  assert.equal(isValidId('abc-DEF_123'), true);
  assert.equal(isValidId('a'.repeat(64)), true);
  assert.equal(isValidId('a'.repeat(65)), false);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('a/b'), false);
  assert.equal(isValidId('xa b'), false);
  assert.equal(isValidId(5), false);
});

test('open library: dates, conversion and lookup', async (testContext) => {
  assert.equal(normalizePublishDate('2008-08-15'), '2008-08-15');
  assert.equal(normalizePublishDate(' 2008 '), '2008');
  assert.equal(normalizePublishDate('x2008-08'), '');
  assert.equal(normalizePublishDate('2008-08-15x'), '2008');
  assert.equal(normalizePublishDate('Sept. 3, 1999'), '1999-09-03');
  assert.equal(normalizePublishDate('March 1, 1988'), '1988-03-01');
  assert.equal(normalizePublishDate('in 1499'), '');
  assert.equal(normalizePublishDate('in 2100'), '');
  assert.equal(normalizePublishDate('1500'), '1500');
  assert.equal(normalizePublishDate('2099'), '2099');
  assert.equal(normalizePublishDate('Foo 40, 1999'), '1999');

  const volume = openLibraryToVolume({
    title: 'T', subtitle: 'S', authors: [{ name: 'A' }, { name: '' }, {}, null],
    publishers: [{ name: 'P' }, { name: 'Q' }], publish_date: '1999', number_of_pages: 12,
    subjects: Array.from({ length: 8 }, (_, index) => ({ name: 's' + index })),
    cover: { small: 's', medium: 'm', large: 'l' },
    identifiers: { isbn_13: [ISBN13], isbn_10: [ISBN10] },
  }, ISBN13);
  assert.deepEqual(volume.volumeInfo.authors, ['A']);
  assert.equal(volume.volumeInfo.publisher, 'P');
  assert.equal(volume.volumeInfo.subtitle, 'S');
  assert.equal(volume.volumeInfo.pageCount, 12);
  assert.equal(volume.volumeInfo.categories.length, 5);
  assert.equal(volume.volumeInfo.imageLinks.thumbnail, 'l');
  assert.deepEqual(volume.volumeInfo.industryIdentifiers, [
    { type: 'ISBN_13', identifier: ISBN13 }, { type: 'ISBN_10', identifier: ISBN10 },
  ]);
  assert.equal(volume.id, '');
  assert.equal(openLibraryToVolume({ title: 'x', cover: { small: 's', medium: 'm' } }, ISBN13).volumeInfo.imageLinks.thumbnail, 'm');
  assert.equal(openLibraryToVolume({ title: 'x', cover: { small: 's' } }, ISBN13).volumeInfo.imageLinks.thumbnail, 's');
  assert.equal(openLibraryToVolume({ title: 'x', number_of_pages: 1.5 }, ISBN13).volumeInfo.pageCount, undefined);
  assert.equal(openLibraryToVolume({}, 'bad').volumeInfo.industryIdentifiers.length, 0);

  const orig = globalThis.fetch;
  testContext.after(() => { globalThis.fetch = orig; });
  let seen;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), opts };
    return { ok: true, json: async () => ({ [`ISBN:${ISBN10}`]: { title: 'Found' } }) };
  };
  const hit = await lookupOpenLibrary('https://ol.test/api/books', ISBN10);
  assert.equal(hit.volumeInfo.title, 'Found');
  const requestUrl = new URL(seen.url);
  assert.equal(requestUrl.searchParams.get('bibkeys'), `ISBN:${ISBN13},ISBN:${ISBN10}`);
  assert.equal(requestUrl.searchParams.get('format'), 'json');
  assert.equal(requestUrl.searchParams.get('jscmd'), 'data');
  assert.equal(seen.opts.headers.Accept, 'application/json');
  assert.ok(seen.opts.signal);

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ [`ISBN:${ISBN13}`]: {} }) });
  assert.equal(await lookupOpenLibrary('https://ol.test/', ISBN13), null);
  globalThis.fetch = async () => ({ ok: true, json: async () => null });
  assert.equal(await lookupOpenLibrary('https://ol.test/', ISBN13), null);
  globalThis.fetch = async () => { throw new Error('x'); };
  await assert.rejects(lookupOpenLibrary('https://ol.test/', ISBN13), (error) => error instanceof OpenLibraryError && /Could not reach/.test(error.message));
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(lookupOpenLibrary('https://ol.test/', ISBN13), /HTTP 503/);
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error('x'); } });
  await assert.rejects(lookupOpenLibrary('https://ol.test/', ISBN13), /unreadable/);
});
