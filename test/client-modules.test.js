import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapVolume, lookupBook, LookupError } from '../public/js/google-books.js';
import {
  api, ApiError, asList, findByIsbn, filterAndSort, collectFacets, currentLoan, isLent, isRead,
  loadPrefs, savePrefs,
} from '../public/js/library.js';

function stubFetch(testContext, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  testContext.after(() => { globalThis.fetch = original; });
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('mapVolume maps a full Google volume and upgrades http covers', () => {
  const book = mapVolume({
    id: 'abc',
    volumeInfo: {
      title: 'T', subtitle: 'S', authors: ['A', 7], publisher: 'P', publishedDate: '2001',
      pageCount: 320, categories: ['C'], language: 'en',
      industryIdentifiers: [{ identifier: '0-14-032872-6' }, { identifier: '9780140328721' }],
      imageLinks: { thumbnail: 'http://x/y?a=1&edge=curl' },
    },
  }, '9780140328721');
  assert.deepEqual(book, {
    isbn13: '9780140328721', isbn10: '0140328726', title: 'T', subtitle: 'S', authors: ['A'],
    publisher: 'P', publishedDate: '2001', description: '', pageCount: 320, categories: ['C'],
    language: 'en', coverImage: 'https://x/y?a=1', googleBooksId: 'abc',
  });
});

test('mapVolume copes with empty volumes and falls back to the searched ISBN', () => {
  const book = mapVolume({}, '0140328726');
  assert.equal(book.isbn13, '9780140328721');
  assert.equal(book.isbn10, '0140328726');
  assert.equal(book.title, '');
  assert.deepEqual(book.authors, []);
  assert.equal(book.pageCount, null);
  assert.equal(book.coverImage, '');
  assert.equal(mapVolume({ volumeInfo: { pageCount: -3 } }, '0140328726').pageCount, null);
  // only an ISBN-10 in the record: the 13 is derived from it
  const only10 = mapVolume({ volumeInfo: { industryIdentifiers: [{ identifier: '0140328726' }] } }, '');
  assert.equal(only10.isbn13, '9780140328721');
});

test('lookupBook: invalid ISBN, offline, HTTP errors, no match, picking by ISBN, source', async (testContext) => {
  await assert.rejects(lookupBook('123'), (error) => error instanceof LookupError && error.kind === 'invalid');

  stubFetch(testContext, async () => { throw new Error('down'); });
  await assert.rejects(lookupBook('9780140328721'), (error) => error.kind === 'offline');

  stubFetch(testContext, async () => json(429, null));
  await assert.rejects(lookupBook('9780140328721'), (error) => error.kind === 'rate-limit');
  stubFetch(testContext, async () => json(500, { error: 'boom', code: 'upstream' }));
  await assert.rejects(lookupBook('9780140328721'), (error) => error.kind === 'upstream' && error.message === 'boom');
  stubFetch(testContext, async () => json(502, {}));
  await assert.rejects(lookupBook('9780140328721'), (error) => error.kind === 'upstream' && /HTTP 502/.test(error.message));

  stubFetch(testContext, async () => json(200, { items: [] }));
  assert.equal(await lookupBook('9780140328721'), null);

  let requested;
  stubFetch(testContext, async (url) => {
    requested = url;
    return json(200, {
      source: 'openlibrary',
      items: [
        { id: 'wrong', volumeInfo: { title: 'Other', industryIdentifiers: [{ identifier: '9780306406157' }] } },
        { id: 'right', volumeInfo: { title: 'Mine', industryIdentifiers: [{ identifier: '9780140328721' }] } },
      ],
    });
  });
  const hit = await lookupBook('978-0-14-032872-1');
  assert.equal(requested, '/api/lookup/9780140328721');
  assert.equal(hit.title, 'Mine');
  assert.equal(hit.source, 'openlibrary');

  stubFetch(testContext, async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
  assert.equal(await lookupBook('9780140328721'), null);
});

test('api wrapper sends the right requests and surfaces errors', async (testContext) => {
  const calls = [];
  stubFetch(testContext, async (url, opts) => {
    calls.push([opts.method, url, opts.headers, opts.body]);
    return json(200, { books: [1], book: { id: 'x' } });
  });
  assert.deepEqual(await api.list(), [1]);
  assert.deepEqual(await api.add({ title: 'a' }), { id: 'x' });
  await api.update('a/b', { title: 'a' });
  await api.remove('a b');
  assert.deepEqual(calls[0], ['GET', '/api/books', undefined, undefined]);
  assert.deepEqual(calls[1], ['POST', '/api/books', { 'Content-Type': 'application/json' }, '{"title":"a"}']);
  assert.equal(calls[2][1], '/api/books/a%2Fb');
  assert.deepEqual(calls[3].slice(0, 2), ['DELETE', '/api/books/a%20b']);

  stubFetch(testContext, async () => json(409, { error: 'dup', code: 'conflict', details: ['d'], existing: { id: 'e' } }));
  await assert.rejects(api.add({}), (error) =>
    error instanceof ApiError && error.status === 409 && error.code === 'conflict' && error.message === 'dup'
    && error.details[0] === 'd' && error.existing.id === 'e');
  stubFetch(testContext, async () => ({ ok: false, status: 500, json: async () => { throw new Error('x'); } }));
  await assert.rejects(api.list(), (error) => error.status === 500 && error.code === '' && /HTTP 500/.test(error.message));
  stubFetch(testContext, async () => { throw new Error('net'); });
  await assert.rejects(api.list(), (error) => error.code === 'offline');
});

const books = [
  { id: '1', title: 'Beta', authors: ['Zed Author'], isbn13: '9780140328721', categories: ['Fiction'], language: 'en', dateAdded: '2024-01-02', publishedDate: '1999', read: true },
  { id: '2', title: 'alpha 10', authors: ['Amy'], isbn13: '9780306406157', categories: ['Science'], language: 'fr', dateAdded: '2024-03-01', publishedDate: '2005', loans: [{ to: 'Bob', dateReturned: '' }] },
  { id: '3', title: 'alpha 2', authors: [], isbn13: '', categories: [], language: '', dateAdded: '2023-01-01', publishedDate: '' },
];
const ids = (list) => list.map((book) => book.id).join('');

test('filterAndSort: search, filters, status and sorting', () => {
  const idsFor = (opts) => ids(filterAndSort(books, opts));
  assert.equal(idsFor({ query: 'amy' }), '2');
  assert.equal(idsFor({ query: '978-0-14-032872-1' }), '1');
  assert.equal(idsFor({ query: 'alpha science' }), '2');
  assert.equal(idsFor({ query: 'zzz' }), '');
  assert.equal(idsFor({ category: 'Fiction' }), '1');
  assert.equal(idsFor({ language: 'fr' }), '2');
  assert.equal(idsFor({ status: 'read' }), '1');
  assert.equal(idsFor({ status: 'lent' }), '2');
  assert.equal(idsFor({ status: 'unread' }).split('').sort().join(''), '23');
  assert.equal(idsFor({}), '213'); // newest added first
  assert.equal(idsFor({ sortDir: 'asc' }), '312');
  assert.equal(idsFor({ sortBy: 'title', sortDir: 'asc' }), '321'); // numeric-aware: "alpha 2" < "alpha 10"
  assert.equal(idsFor({ sortBy: 'title', sortDir: 'desc' }), '123');
  assert.equal(idsFor({ sortBy: 'author', sortDir: 'asc' }), '21' + '3'); // missing author last
  assert.equal(idsFor({ sortBy: 'author', sortDir: 'desc' }), '123');
  assert.equal(idsFor({ sortBy: 'publishedDate', sortDir: 'asc' }), '123'); // missing date last either way
  assert.equal(idsFor({ sortBy: 'publishedDate', sortDir: 'desc' }), '213');
});

test('helpers: asList, findByIsbn, facets, loans, read flag', () => {
  assert.deepEqual(asList([' a ', '', 3, 'b']), ['a', 'b']);
  assert.deepEqual(asList(' x '), ['x']);
  assert.deepEqual(asList(null), []);
  assert.equal(findByIsbn(books, '0-14-032872-6').id, '1');
  assert.equal(findByIsbn(books, 'garbage'), null);
  assert.deepEqual(collectFacets(books), { categories: ['Fiction', 'Science'], languages: ['en', 'fr'].sort() });
  assert.equal(currentLoan(books[1]).to, 'Bob');
  assert.equal(currentLoan({ loans: [{ dateReturned: '2024-01-01' }] }), null);
  assert.equal(currentLoan({}), null);
  assert.equal(isLent(books[1]), true);
  assert.equal(isRead(books[0]), true);
  assert.equal(isRead({ read: 'yes' }), false);
});

test('view preferences round-trip and fall back safely', (testContext) => {
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  testContext.after(() => { delete globalThis.localStorage; });
  assert.deepEqual(loadPrefs(), { view: 'grid', sortBy: 'dateAdded', sortDir: 'desc' });
  savePrefs({ view: 'list', sortBy: 'title', sortDir: 'asc' });
  assert.deepEqual(loadPrefs(), { view: 'list', sortBy: 'title', sortDir: 'asc' });
  savePrefs({ view: 'x', sortBy: 'nope', sortDir: 'sideways' });
  assert.deepEqual(loadPrefs(), { view: 'grid', sortBy: 'dateAdded', sortDir: 'desc' });
  store.set('home-library:prefs', '{bad json');
  assert.equal(loadPrefs().view, 'grid');
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => savePrefs({}));
  assert.equal(loadPrefs().sortBy, 'dateAdded');
});
