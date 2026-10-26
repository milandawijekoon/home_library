// End-to-end tests of the browser app: the real index.html and ES modules run in jsdom against a
// real server (with a fake Google Books behind it). Every user-facing flow is driven through the DOM.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { installDom, waitFor, sleep } from './support/dom.js';

const { version } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));

const isbn13 = (serial) => {
  const first12 = `978${String(serial).padStart(9, '0')}`;
  const sum = [...first12].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return first12 + ((10 - (sum % 10)) % 10);
};
const MATILDA = '9780140328721';
const NOT_ON_GOOGLE = isbn13(777);

let scratch, appServer, upstream, base, window, offline = false;
const $ = (selector) => window.document.querySelector(selector);
const $$ = (selector) => [...window.document.querySelectorAll(selector)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const fill = (selector, value, type = 'input') => {
  const node = $(selector);
  node.value = value;
  node.dispatchEvent(new window.Event(type, { bubbles: true }));
};
const submit = (selector) => $(selector).requestSubmit();
const titles = () => $$('#library .book__title').map((node) => node.textContent);
const toasts = () => $$('#toasts .toast span').map((node) => node.textContent).join(' | ');
const openDialogs = () => $$('dialog[open]').map((node) => node.id);

async function serverBooks() {
  return (await (await fetch(`${base}/api/books`)).json()).books;
}

async function seed(books = []) {
  for (const book of await serverBooks()) await fetch(`${base}/api/books/${book.id}`, { method: 'DELETE' });
  for (const book of books) {
    const response = await fetch(`${base}/api/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(book) });
    assert.equal(response.status, 201, await response.clone().text());
  }
  for (const dialog of $$('dialog[open]')) dialog.close();
  $('#toasts').replaceChildren();
  // Reset the toolbar, then reload through the "Try again" handler.
  fill('#search', '');
  for (const id of ['#filter-status', '#filter-category', '#filter-language']) $(id).value = '';
  for (const id of ['#filter-status', '#filter-category', '#filter-language']) $(id).dispatchEvent(new window.Event('change'));
  click($('#btn-retry'));
  await waitFor(() => !$('#library').hasAttribute('aria-busy'), 'library to load');
  await sleep(150); // the search box is debounced
}

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'home_library-ui-'));
  upstream = http.createServer((request, response) => {
    const query = new URL(request.url, 'http://x').searchParams.get('q');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (query === `isbn:${MATILDA}`) {
      return response.end(JSON.stringify({
        items: [{ id: 'abc123', volumeInfo: {
          title: 'Matilda', authors: ['Roald Dahl'], publisher: 'Puffin', publishedDate: '1988', language: 'en', pageCount: 240,
          description: '<p>A <b>gifted</b> girl.<script>alert(1)</script></p>', categories: ['Fiction'],
          industryIdentifiers: [{ type: 'ISBN_13', identifier: MATILDA }],
        } }],
      }));
    }
    response.end(JSON.stringify({ totalItems: 0 }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const created = createApp({
    dataFile: path.join(scratch, 'books.json'),
    googleBooksUrl: `${upstreamBase}/volumes`,
    googleViewApiUrl: false,
    openLibraryUrl: false,
  });
  appServer = created.server;
  await created.store.init();
  await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${appServer.address().port}`;

  window = installDom({ baseUrl: base, failFetch: () => offline });
  await import('../public/js/theme.js'); // a classic script in the page
  // jsdom fires DOMContentLoaded while the module loads; replay it so theme.js wires its button as in a browser.
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await import('../public/js/app.js');
});

after(async () => {
  window?.close();
  appServer?.closeAllConnections();
  upstream?.closeAllConnections();
  await Promise.all([new Promise((resolve) => appServer.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
  await fs.rm(scratch, { recursive: true, force: true });
});

test('start-up: empty library shows its empty state, the version and the add actions', async () => {
  await waitFor(() => !$('#empty-state').hidden, 'empty state');
  assert.equal($('#empty-title').textContent, 'Your library is empty');
  assert.deepEqual($$('#empty-actions button').map((node) => node.textContent), ['Scan ISBN', 'Add a book manually']);
  assert.equal($('#book-count').textContent, '0 books');
  await waitFor(() => !$('#app-version').hidden, 'version tag');
  assert.equal($('#app-version').textContent, `v${version}`);
});

test('adding a book by hand: validation, derived ISBN, success, duplicate refusal', async () => {
  click($('#btn-add'));
  assert.ok($('#book-dialog').open);
  assert.equal($('#book-dialog-title').textContent, 'Add book');

  submit('#book-form'); // nothing filled in
  assert.equal($('#f-title-error').textContent, 'Enter a title.');
  assert.equal($('#f-isbn13-error').textContent, 'Enter an ISBN-13 or ISBN-10.');
  assert.equal($('#f-title').getAttribute('aria-invalid'), '');
  assert.ok($('#book-dialog').open);

  fill('#f-isbn13', '978-0-14-032872-2'); // bad check digit
  fill('#f-title', 'Matilda');
  fill('#f-pageCount', '-4');
  fill('#f-language', 'english');
  fill('#f-coverImage', 'javascript:alert(1)');
  submit('#book-form');
  assert.match($('#f-isbn13-error').textContent, /Not a valid ISBN-13/);
  assert.match($('#f-pageCount-error').textContent, /whole number/);
  assert.match($('#f-language-error').textContent, /code like/);
  assert.match($('#f-coverImage-error').textContent, /http\(s\)/);
  assert.equal((await serverBooks()).length, 0);

  fill('#f-isbn13', '978-0-14-032872-1', 'change'); // the real checksum; hyphens are stripped
  assert.equal($('#f-isbn13').value, MATILDA);
  assert.equal($('#f-isbn10').value, '0140328726'); // other form filled in automatically
  fill('#f-pageCount', '240');
  fill('#f-language', 'EN');
  fill('#f-coverImage', '');
  fill('#f-authors', 'Roald Dahl, Quentin Blake, Roald Dahl');
  fill('#f-categories', 'Fiction, Children');
  $('#f-read').checked = true;
  assert.equal($('#preview-title').textContent, 'Matilda');
  assert.equal($('#preview-authors').textContent, 'Roald Dahl, Quentin Blake');

  submit('#book-form');
  await waitFor(() => !$('#book-dialog').open, 'dialog to close');
  assert.match(toasts(), /Added “Matilda”/);
  assert.deepEqual(titles(), ['Matilda']);
  assert.equal($('#book-count').textContent, '1 book');
  assert.ok($('#library .read-badge'));
  const [stored] = await serverBooks();
  assert.deepEqual([stored.language, stored.pageCount, stored.read, stored.authors], ['en', 240, true, ['Roald Dahl', 'Quentin Blake']]);
  assert.ok($('#filter-category').innerHTML.includes('Children'));

  click($('#btn-add')); // the same book again, typed in as an ISBN-10
  fill('#f-isbn10', '0140328726', 'change');
  fill('#f-title', 'Matilda again');
  submit('#book-form');
  assert.match($('#book-error').textContent, /already in your library/);
  assert.equal((await serverBooks()).length, 1);
  click($('#book-cancel'));
  assert.ok(!$('#book-dialog').open);
});

test('add form: look up details online fills blanks only, and refuses owned or invalid ISBNs', async () => {
  await seed([{ isbn13: isbn13(5), title: 'Owned' }]);
  click($('#btn-add'));
  click($('#book-lookup'));
  assert.match($('#f-isbn13-error').textContent, /valid ISBN first/);

  fill('#f-isbn13', isbn13(5), 'change');
  click($('#book-lookup'));
  assert.match($('#book-error').textContent, /“Owned”.*already in your library/);

  fill('#f-isbn13', MATILDA, 'change');
  fill('#f-title', 'My own title');
  click($('#book-lookup'));
  await waitFor(() => /Filled in/.test($('#book-lookup-status').textContent), 'lookup result');
  assert.equal($('#f-title').value, 'My own title'); // typed text is never overwritten
  assert.equal($('#f-publisher').value, 'Puffin');
  assert.equal($('#f-description').value, 'A gifted girl.'); // markup and scripts stripped
  assert.match($('#book-lookup-status').textContent, /Google Books/);

  fill('#f-isbn13', NOT_ON_GOOGLE, 'change');
  fill('#f-isbn10', '');
  click($('#book-lookup'));
  await waitFor(() => /No match found/.test($('#book-lookup-status').textContent), 'no match message');
  click($('#book-cancel'));
});

test('scanner dialog: no camera falls back to typing the ISBN; invalid, found, unknown and owned ISBNs', async () => {
  await seed();
  click($('#btn-scan'));
  assert.ok($('#scanner-dialog').open);
  await waitFor(() => !$('#scanner-error').hidden, 'camera error');
  assert.match($('#scanner-error').textContent, /camera|secure connection/i);
  assert.equal($('#scanner-toggle').textContent, 'Start camera');

  submit('#manual-isbn-form');
  assert.equal($('#scanner-error').textContent, 'Type an ISBN first.');
  fill('#manual-isbn', '1234567890');
  submit('#manual-isbn-form');
  assert.match($('#scanner-error').textContent, /not valid/);

  fill('#manual-isbn', MATILDA);
  submit('#manual-isbn-form');
  await waitFor(() => $('#book-dialog').open, 'book form');
  assert.ok(!$('#scanner-dialog').open);
  assert.equal($('#f-title').value, 'Matilda');
  assert.equal($('#f-authors').value, 'Roald Dahl');
  assert.match($('#book-source-note').textContent, /Google Books/);
  assert.equal($('#book-submit').textContent, 'Add to My Library');
  submit('#book-form');
  await waitFor(() => !$('#book-dialog').open, 'save');
  assert.deepEqual(titles(), ['Matilda']);

  click($('#btn-scan')); // scanning a book that is already owned opens it instead
  fill('#manual-isbn', '0140328726');
  submit('#manual-isbn-form');
  await waitFor(() => $('#details-dialog').open, 'details of the owned book');
  assert.ok(!$('#scanner-dialog').open);
  assert.match(toasts(), /already in your library/);
  $('#details-dialog').close();

  click($('#btn-scan')); // an ISBN no catalogue knows: offer manual entry with the ISBN carried over
  fill('#manual-isbn', NOT_ON_GOOGLE);
  submit('#manual-isbn-form');
  await waitFor(() => !$('#scanner-notfound').hidden, 'not-found banner');
  assert.match($('#scanner-notfound-text').textContent, /No book was found/);
  click($('#scanner-manual-entry'));
  assert.ok($('#book-dialog').open && !$('#scanner-dialog').open);
  assert.equal($('#f-isbn13').value, NOT_ON_GOOGLE);
  assert.ok($('#lookup-row') && !$('#lookup-row').hidden);
  click($('#book-cancel'));
});

test('scanner dialog: Close and Esc both release the camera and reset the dialog', async () => {
  click($('#btn-scan'));
  await waitFor(() => !$('#scanner-error').hidden, 'camera error');
  click($('#scanner-dialog [data-close]'));
  assert.ok(!$('#scanner-dialog').open);
  assert.ok($('#scanner-error').hidden);

  click($('#btn-scan'));
  $('#scanner-dialog').dispatchEvent(new window.Event('cancel'));
  $('#scanner-dialog').close();
  assert.ok(!$('#scanner-dialog').open);
});

test('search, filters, sorting and view mode', async () => {
  await seed([
    { isbn13: isbn13(1), title: 'Zebra Tales', authors: ['Ann Author'], categories: ['Fiction'], language: 'en', publishedDate: '2001', read: true },
    { isbn13: isbn13(2), title: 'apple pie', authors: ['Bob Baker'], categories: ['Cooking'], language: 'fr', publishedDate: '2015' },
    { isbn13: isbn13(3), title: 'Mango Guide', authors: ['Cy Cook'], categories: ['Cooking', 'Fiction'], language: 'en', loans: [{ borrower: 'Sam', dateBorrowed: '2026-01-02', dateReturned: '' }] },
  ]);
  assert.equal($('#results-summary').textContent, '1 read · 2 not read yet · 1 lent out');
  assert.equal($('#book-count').textContent, '3 books');

  click($('#sort-dir'));
  const dateOrder = titles();
  click($('#sort-dir'));
  assert.deepEqual(titles(), [...dateOrder].reverse());

  fill('#sort-by', 'title', 'change');
  assert.deepEqual(titles(), ['apple pie', 'Mango Guide', 'Zebra Tales']);
  click($('#sort-dir'));
  assert.deepEqual(titles(), ['Zebra Tales', 'Mango Guide', 'apple pie']);
  fill('#sort-by', 'publishedDate', 'change');
  assert.equal(titles()[0], 'apple pie'); // newest first by default; the book with no date goes last
  assert.equal(titles().at(-1), 'Mango Guide');
  fill('#sort-by', 'author', 'change');
  assert.deepEqual(titles(), ['Zebra Tales', 'apple pie', 'Mango Guide']);
  assert.deepEqual(JSON.parse(window.localStorage.getItem('home-library:prefs')), { view: 'grid', sortBy: 'author', sortDir: 'asc' });

  click($('#view-list'));
  assert.ok($('#library').classList.contains('library--list'));
  assert.equal($('#view-list').getAttribute('aria-pressed'), 'true');
  click($('#view-grid'));
  assert.ok($('#library').classList.contains('library--grid'));

  fill('#search', 'cook');
  await waitFor(() => titles().length === 2, 'search to apply');
  assert.deepEqual(titles().sort(), ['Mango Guide', 'apple pie']); // publisher-less: matched on author/category
  assert.equal($('#results-summary').textContent, 'Showing 2 of 3 books');
  fill('#filter-status', 'lent', 'change');
  assert.deepEqual(titles(), ['Mango Guide']);
  fill('#filter-status', 'read', 'change');
  assert.deepEqual(titles(), []);
  assert.ok(!$('#empty-state').hidden);
  assert.equal($('#empty-title').textContent, 'No matching books');
  click($('#empty-actions button'));
  assert.equal(titles().length, 3);
  assert.equal($('#search').value, '');

  assert.deepEqual($$('#filter-category option').map((node) => node.value), ['', 'Cooking', 'Fiction']);
  fill('#filter-category', 'Fiction', 'change');
  assert.deepEqual(titles().sort(), ['Mango Guide', 'Zebra Tales']);
  fill('#filter-language', 'fr', 'change');
  assert.deepEqual(titles(), []);
  fill('#filter-language', '', 'change');
  fill('#filter-category', '', 'change');
  fill('#filter-status', 'unread', 'change');
  assert.equal(titles().length, 2);

  fill('#filter-status', '', 'change');
  fill('#search', '978-0-00');
  await waitFor(() => titles().length === 3, 'ISBN search with hyphens');
});

test('details: mark read, lend, return, edit and delete (with cancel)', async () => {
  await seed([{ isbn13: isbn13(10), title: 'First', authors: ['Ann'], publisher: 'Pub', pageCount: 10, language: 'en' }]);
  click($('#library .book__open'));
  assert.ok($('#details-dialog').open);
  assert.equal($('#details-title').textContent, 'First');
  assert.match($('#details-body').textContent, /Publisher\s*Pub/);
  assert.equal($('#details-toggle-read').textContent, 'Mark as read');

  click($('#details-toggle-read'));
  await waitFor(() => $('#details-toggle-read').textContent === 'Mark as not read', 'read toggle');
  assert.match(toasts(), /Marked “First” as read/);
  assert.equal((await serverBooks())[0].read, true);
  click($('#details-toggle-read'));
  await waitFor(() => $('#details-toggle-read').textContent === 'Mark as read', 'unread toggle');

  click($('#details-loan'));
  assert.equal($('#loan-title').textContent, 'Lend this book');
  submit('#loan-form');
  assert.equal($('#loan-error').textContent, 'Enter who is borrowing the book.');
  fill('#loan-borrower', 'Sam');
  fill('#loan-date', '2999-01-01');
  submit('#loan-form');
  assert.match($('#loan-error').textContent, /future/);
  fill('#loan-date', '2026-01-02');
  submit('#loan-form');
  await waitFor(() => !$('#loan-dialog').open, 'loan saved');
  assert.match(toasts(), /lent to Sam/);
  assert.equal($('#details-loan').textContent, 'Mark as returned');
  assert.match($('#details-body').textContent, /Lent to\s*Sam/);
  assert.ok($('#library .lent-badge'));
  assert.equal((await serverBooks())[0].loans.length, 1);

  click($('#details-loan'));
  assert.equal($('#loan-title').textContent, 'Mark as returned');
  assert.ok($('#loan-borrower-field').hidden);
  fill('#loan-date', '2025-12-31');
  submit('#loan-form');
  assert.match($('#loan-error').textContent, /cannot be returned before/);
  fill('#loan-date', '2026-01-05');
  submit('#loan-form');
  await waitFor(() => !$('#loan-dialog').open, 'return saved');
  assert.match(toasts(), /marked as returned/);
  assert.ok(!$('#library .lent-badge'));
  assert.match($('#details-body').textContent, /returned/);

  click($('#details-edit'));
  assert.ok(!$('#details-dialog').open && $('#book-dialog').open);
  assert.equal($('#book-dialog-title').textContent, 'Edit book');
  assert.equal($('#f-title').value, 'First');
  fill('#f-title', 'Second');
  submit('#book-form');
  await waitFor(() => !$('#book-dialog').open, 'edit saved');
  assert.deepEqual(titles(), ['Second']);
  assert.equal((await serverBooks())[0].loans.length, 1); // the lending history survives an edit

  click($('#library .book__open'));
  click($('#details-delete'));
  assert.ok($('#confirm-dialog').open);
  click($('#confirm-cancel'));
  await sleep(20);
  assert.equal((await serverBooks()).length, 1);
  click($('#details-delete'));
  click($('#confirm-ok'));
  await waitFor(() => titles().length === 0, 'book to disappear');
  assert.match(toasts(), /Deleted “Second”/);
  assert.equal((await serverBooks()).length, 0);
  assert.ok(!$('#details-dialog').open);
});

test('deleting a book that is already gone resyncs instead of failing silently', async () => {
  await seed([{ isbn13: isbn13(11), title: 'Ghost' }]);
  click($('#library .book__open'));
  const [stored] = await serverBooks();
  await fetch(`${base}/api/books/${stored.id}`, { method: 'DELETE' }); // deleted elsewhere
  click($('#details-delete'));
  click($('#confirm-ok'));
  await waitFor(() => titles().length === 0, 'resync');
  assert.match(toasts(), /not found/i);
});

test('book data is rendered as text, never as markup', async () => {
  const hostile = '<img src="x" onerror="window.__pwned = 1">';
  await seed([{ isbn13: isbn13(12), title: hostile, authors: [hostile], description: `<script>window.__pwned = 2</script>${hostile}`, categories: [hostile] }]);
  assert.equal(titles()[0], hostile);
  click($('#library .book__open'));
  assert.equal($('#details-title').textContent, hostile);
  assert.ok(!$('#details-body img[src="x"]') && !$('#library img[src="x"]'));
  assert.ok(!$('#details-body script'));
  assert.equal(window.__pwned, undefined);
  $('#details-dialog').close();
});

test('cover images: only web links and embedded photos are shown, and they never send a referrer', async () => {
  await seed([{ isbn13: isbn13(13), title: 'Covered', coverImage: 'https://example.com/cover.jpg' }]);
  const image = $('#library img.book__cover');
  assert.equal(image.getAttribute('src'), 'https://example.com/cover.jpg');
  assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
  image.dispatchEvent(new window.Event('error')); // a broken link falls back to the placeholder
  assert.match(image.getAttribute('src'), /placeholder-book\.svg$/);
});

test('theme toggle switches and remembers light/dark', () => {
  const root = window.document.documentElement;
  click($('#btn-theme'));
  assert.equal(window.localStorage.getItem('shelfie-theme'), 'dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.match($('#btn-theme').getAttribute('aria-label'), /light/);
  click($('#btn-theme'));
  assert.equal(window.localStorage.getItem('shelfie-theme'), 'light');
  assert.equal(root.dataset.theme, 'light');
});

test('server unreachable: a clear error with a working retry', async () => {
  await seed([{ isbn13: isbn13(14), title: 'Survivor' }]);
  offline = true;
  click($('#btn-retry'));
  await waitFor(() => !$('#load-error').hidden, 'load error');
  assert.match($('#load-error-text').textContent, /Cannot reach the library server/);
  offline = false;
  click($('#btn-retry'));
  await waitFor(() => $('#load-error').hidden && titles().length === 1, 'recovery');
  assert.deepEqual(openDialogs(), []);
});
