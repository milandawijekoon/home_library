import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BookStore, StoreError } from '../store.js';

const BOOK_A = { isbn13: '9780140328721', title: 'A' };
const BOOK_B = { isbn13: '9780306406157', title: 'B' };

async function tmpStore(testContext) {
  const direction = await fs.mkdtemp(path.join(os.tmpdir(), 'store-test-'));
  testContext.after(() => fs.rm(direction, { recursive: true, force: true }));
  const file = path.join(direction, 'sub', 'books.json');
  return { dir: direction, file, store: new BookStore(file) };
}
const status = (promise) => promise.then(() => null, (error) => (error instanceof StoreError ? error : Promise.reject(error)));

test('reading: missing, empty, whole-array and junk entries', async (testContext) => {
  const { file, store } = await tmpStore(testContext);
  assert.deepEqual(await store.list(), []);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '  \n');
  assert.deepEqual(await store.list(), []);
  await fs.writeFile(file, JSON.stringify([{ id: 'x' }, null, 5, [], 'str']));
  assert.deepEqual(await store.list(), [{ id: 'x' }]);
  await fs.writeFile(file, JSON.stringify({ books: [{ id: 'y' }, null] }));
  assert.deepEqual(await store.list(), [{ id: 'y' }]);
  await fs.writeFile(file, 'null');
  const corruptError = await status(store.list());
  assert.equal(corruptError.status, 500);
  assert.equal(corruptError.extra.code, 'corrupt-store');
  assert.match(corruptError.message, /no "books" array/);
  await fs.writeFile(file, '{oops');
  assert.match((await status(store.list())).message, /not valid JSON/);
  await fs.writeFile(file, '{"books": 3}');
  assert.equal((await status(store.list())).extra.code, 'corrupt-store');
});

test('unreadable file (a directory) is a 500, not an empty library', async (testContext) => {
  const { dir: direction } = await tmpStore(testContext);
  const store = new BookStore(direction);
  const error = await status(store.list());
  assert.equal(error.status, 500);
  assert.match(error.message, /Could not read/);
});

test('init creates the file only when missing; writes keep a .bak', async (testContext) => {
  const { file, store } = await tmpStore(testContext);
  assert.equal(await store.init(), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { books: [] });
  const first = await store.add(BOOK_A);
  await fs.access(`${file}.bak`);
  assert.deepEqual(JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')), { books: [] });
  assert.equal(await store.init(), 1);
  assert.equal((await store.get(first.id)).title, 'A');
  const leftovers = (await fs.readdir(path.dirname(file))).filter((fileName) => fileName.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('failed writes surface as 500 and clean up the temp file', async (testContext) => {
  const { dir: direction } = await tmpStore(testContext);
  // The "file" is a directory: copyFile of the old version fails with EISDIR, not ENOENT.
  const target = path.join(direction, 'books.json');
  await fs.mkdir(target);
  const store = new BookStore(target);
  const error = await status(store.add(BOOK_A));
  assert.ok(error);
  assert.equal(error.status, 500);
  assert.deepEqual((await fs.readdir(direction)).filter((fileName) => fileName.endsWith('.tmp')), []);
});

test('add / update / remove: errors, conflicts, ids and history', async (testContext) => {
  const { store } = await tmpStore(testContext);
  assert.equal((await status(store.add({ title: 'no isbn' }))).status, 400);
  const bookA = await store.add(BOOK_A);
  const bookB = await store.add(BOOK_B);
  assert.notEqual(bookA.id, bookB.id);
  assert.deepEqual(bookA.loans, []);
  assert.equal(bookA.dateAdded, bookA.dateUpdated);
  const isDuplicate = await status(store.add({ ...BOOK_A, title: 'again' }));
  assert.equal(isDuplicate.status, 409);
  assert.equal(isDuplicate.extra.existing.id, bookA.id);

  assert.equal((await status(store.update(bookA.id, { title: 'x' }))).status, 400);
  assert.equal((await status(store.update('nope', BOOK_A))).status, 404);
  const clash = await status(store.update(bookA.id, { ...BOOK_B, title: 'clash' }));
  assert.equal(clash.status, 409);
  assert.equal(clash.extra.existing.id, bookB.id);

  const loans = [{ borrower: 'Bob', dateBorrowed: '2026-01-01', dateReturned: '' }];
  await store.update(bookA.id, { ...BOOK_A, loans });
  const kept = await store.update(bookA.id, { ...BOOK_A, title: 'A2' });
  assert.deepEqual(kept.loans.map((loan) => loan.borrower), ['Bob']); // omitted loans keep history
  assert.equal(kept.id, bookA.id);
  assert.equal(kept.dateAdded, bookA.dateAdded);
  assert.equal((await store.update(bookA.id, { ...BOOK_A, loans: [] })).loans.length, 0);
  assert.equal((await store.list()).length, 2);

  assert.equal((await store.remove(bookA.id)).id, bookA.id);
  assert.equal((await status(store.remove(bookA.id))).status, 404);
  assert.equal((await status(store.get(bookA.id))).status, 404);
  assert.deepEqual((await store.list()).map((x) => x.id), [bookB.id]);
});

test('update repairs a hand-edited record (bad dateAdded, non-array loans)', async (testContext) => {
  const { file, store } = await tmpStore(testContext);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ books: [{ id: 'k1', ...BOOK_A, dateAdded: 'garbage', loans: 'x' }] }));
  const updated = await store.update('k1', BOOK_A);
  assert.deepEqual(updated.loans, []);
  assert.ok(!Number.isNaN(Date.parse(updated.dateAdded)));
  assert.equal(new Date(updated.dateAdded).toISOString(), updated.dateAdded);
});

test('concurrent adds never lose data', async (testContext) => {
  const { store } = await tmpStore(testContext);
  const isbns = ['9780140328721', '9780306406157', '9781402894626', '9780747532699'];
  await Promise.all(isbns.map((isbn13, index) => store.add({ isbn13, title: 'T' + index })));
  assert.equal((await store.list()).length, 4);
});

test('importBooks: validation, merge, replace and dry run', async (testContext) => {
  const { store } = await tmpStore(testContext);
  assert.equal((await status(store.importBooks('x'))).status, 400);
  assert.equal((await status(store.importBooks(new Array(20001).fill(BOOK_A)))).status, 400);
  assert.equal((await status(store.importBooks([], { mode: 'bogus' }))).status, 400);
  assert.equal((await status(store.importBooks(new Array(20000).fill({}), { mode: 'bogus' }))).message, 'mode must be "merge" or "replace"');

  await store.add(BOOK_A);
  const raw = [
    { ...BOOK_A, title: 'dup' },
    { ...BOOK_B, id: 'my-id', dateAdded: '2020-01-01T00:00:00Z', dateUpdated: '2021-01-01T00:00:00Z' },
    { title: 'bad' },
    { ...BOOK_B, title: 'dup within file' },
  ];

  const dry = await store.importBooks(raw, { dryRun: true });
  assert.deepEqual(
    { added: dry.added, duplicates: dry.duplicates, invalid: dry.invalid, total: dry.total, dryRun: dry.dryRun, mode: dry.mode, previousCount: dry.previousCount },
    { added: 1, duplicates: 2, invalid: 1, total: 2, dryRun: true, mode: 'merge', previousCount: 1 },
  );
  assert.equal((await store.list()).length, 1);
  assert.equal(dry.invalidDetails[0].index, 2);

  const defaults = await store.importBooks(raw); // default is a real merge, not a dry run
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.total, 2);
  const imported = (await store.list()).find((bookB) => bookB.id === 'my-id');
  assert.equal(imported.dateAdded, '2020-01-01T00:00:00.000Z');
  assert.equal(imported.dateUpdated, '2021-01-01T00:00:00.000Z');
  assert.deepEqual(imported.loans, []);

  const again = await store.importBooks(raw);
  assert.equal(again.added, 0);
  assert.equal((await store.list()).length, 2);

  // id collisions get a fresh id
  const clashing = await store.importBooks([{ isbn13: '9781402894626', title: 'C', id: 'my-id' }]);
  assert.equal(clashing.added, 1);
  const ids = (await store.list()).map((bookB) => bookB.id);
  assert.equal(new Set(ids).size, 3);

  const rep = await store.importBooks([BOOK_B], { mode: 'replace' });
  assert.equal(rep.total, 1);
  assert.equal(rep.previousCount, 3);
  assert.deepEqual((await store.list()).map((bookB) => bookB.title), ['B']);

  const none = await status(store.importBooks([{ title: 'bad' }], { mode: 'replace' }));
  assert.equal(none.status, 400);
  assert.ok(none.extra.details.length > 0);
  assert.equal((await store.list()).length, 1);
});

test('importBooks: invalid entries report a title only when it is a string', async (testContext) => {
  const { store } = await tmpStore(testContext);
  const result = await store.importBooks([{ title: 'T' }, { title: 5 }, null]);
  assert.deepEqual(result.invalidDetails.map((x) => x.title), ['T', '', '']);
  assert.equal(result.total, 0);
});
