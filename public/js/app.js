// My Home Library — application wiring.
import { normalizeIsbn, isValidIsbn10, isValidIsbn13, isbn10To13, isbn13To10, canonicalIsbn } from './isbn.js';
import { lookupBook } from './google-books.js';
import { captureCover, initCoverCapture } from './cover.js';
import { BarcodeScanner, ScannerError } from './scanner.js';
import {
  api,
  ApiError,
  SORT_FIELDS,
  asList,
  collectFacets,
  filterAndSort,
  findByIsbn,
  isRead,
  currentLoan,
  languageName,
  loadPrefs,
  savePrefs,
} from './library.js';
import {
  $,
  el,
  clear,
  toast,
  setupDialog,
  openDialog,
  confirmDialog,
  setBusy,
  renderBookCard,
  renderDetails,
  isCoverSource,
  formatDay,
  PLACEHOLDER_COVER,
} from './ui.js';

const state = {
  books: [],
  loaded: false,
  query: '',
  category: '',
  language: '',
  status: '',
  ...loadPrefs(),
};

// ---------------------------------------------------------------------------
// Library rendering
// ---------------------------------------------------------------------------
const libraryEl = $('#library');

function showSkeleton() {
  libraryEl.className = 'library library--grid';
  libraryEl.setAttribute('aria-busy', 'true');
  clear(libraryEl).append(...Array.from({ length: 8 }, () => el('div', { class: 'skeleton', 'aria-hidden': 'true' })));
  $('#results-summary').textContent = 'Loading your library…';
}

function setSelectOptions(select, allLabel, values, labelFor = (value) => value) {
  const current = select.value;
  clear(select).append(
    el('option', { value: '', text: allLabel }),
    ...values.map((value) => el('option', { value: value, text: labelFor(value) })),
  );
  select.value = values.includes(current) ? current : '';
  return select.value;
}

function updateFacets() {
  const { categories, languages } = collectFacets(state.books);
  state.category = setSelectOptions($('#filter-category'), 'All categories', categories);
  state.language = setSelectOptions($('#filter-language'), 'All languages', languages, languageName);
  $('#filter-category').closest('.select').hidden = categories.length === 0;
  $('#filter-language').closest('.select').hidden = languages.length === 0;
}

function updateSortControls() {
  $('#sort-by').value = state.sortBy;
  const dirBtn = $('#sort-dir');
  const field = SORT_FIELDS[state.sortBy];
  const text = field[state.sortDir];
  dirBtn.dataset.dir = state.sortDir;
  dirBtn.setAttribute('aria-label', `Sort direction: ${text}`);
  dirBtn.title = `${text} (click to reverse)`;
  for (const [id, view] of [['#view-grid', 'grid'], ['#view-list', 'list']]) {
    $(id).setAttribute('aria-pressed', String(state.view === view));
  }
}

function hasActiveFilters() {
  return Boolean(state.query.trim() || state.category || state.language || state.status);
}

function clearFilters() {
  state.query = '';
  state.category = '';
  state.language = '';
  state.status = '';
  $('#filter-status').value = '';
  $('#search').value = '';
  $('#filter-category').value = '';
  $('#filter-language').value = '';
}

function renderEmptyState(kind) {
  const actions = clear($('#empty-actions'));
  if (kind === 'library') {
    $('#empty-title').textContent = 'Your library is empty';
    $('#empty-text').textContent = 'Scan the barcode on the back of a book to add your first one.';
    actions.append(
      el('button', { type: 'button', class: 'btn btn--primary', onclick: openScanner, text: 'Scan ISBN' }),
      el('button', { type: 'button', class: 'btn', onclick: () => openBookForm({ mode: 'add' }), text: 'Add a book manually' }),
    );
  } else {
    $('#empty-title').textContent = 'No matching books';
    $('#empty-text').textContent = 'Try a different search or clear the filters.';
    actions.append(
      el('button', { type: 'button', class: 'btn', onclick: () => { clearFilters(); render(); }, text: 'Clear search and filters' }),
    );
  }
}

function render() {
  const total = state.books.length;
  $('#book-count').textContent = `${total} ${total === 1 ? 'book' : 'books'}`;
  updateSortControls();
  libraryEl.className = `library library--${state.view}`;
  libraryEl.removeAttribute('aria-busy');

  const readCount = state.books.filter(isRead).length;
  const lentCount = state.books.filter((book) => currentLoan(book)).length;
  const visible = filterAndSort(state.books, state);
  clear(libraryEl).append(...visible.map((book) => renderBookCard(book, { onOpen: openDetails })));

  const empty = $('#empty-state');
  empty.hidden = visible.length > 0;
  if (!empty.hidden) renderEmptyState(total === 0 ? 'library' : 'search');

  $('#results-summary').textContent =
    total === 0
      ? ''
      : hasActiveFilters()
        ? `Showing ${visible.length} of ${total} ${total === 1 ? 'book' : 'books'}`
        : `${readCount} read · ${total - readCount} not read yet${lentCount ? ` · ${lentCount} lent out` : ''}`;
}

async function loadBooks() {
  $('#load-error').hidden = true;
  showSkeleton();
  try {
    state.books = await api.list();
    state.loaded = true;
    updateFacets();
    render();
  } catch (err) {
    clear(libraryEl).removeAttribute('aria-busy');
    $('#results-summary').textContent = '';
    $('#load-error-text').textContent = err.message;
    $('#load-error').hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
let searchTimer;
$('#search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = event.target.value;
    render();
  }, 120);
});
$('#filter-category').addEventListener('change', (event) => { state.category = event.target.value; render(); });
$('#filter-language').addEventListener('change', (event) => { state.language = event.target.value; render(); });
$('#filter-status').addEventListener('change', (event) => { state.status = event.target.value; render(); });
$('#sort-by').addEventListener('change', (event) => {
  state.sortBy = event.target.value;
  state.sortDir = SORT_FIELDS[state.sortBy].defaultDir;
  savePrefs(state);
  render();
});
$('#sort-dir').addEventListener('click', () => {
  state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  savePrefs(state);
  render();
});
for (const [id, view] of [['#view-grid', 'grid'], ['#view-list', 'list']]) {
  $(id).addEventListener('click', () => {
    state.view = view;
    savePrefs(state);
    render();
  });
}
$('#btn-retry').addEventListener('click', loadBooks);
$('#btn-scan').addEventListener('click', openScanner);
$('#btn-add').addEventListener('click', () => openBookForm({ mode: 'add', canLookup: true }));

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------
const detailsDialog = $('#details-dialog');
let detailsBook = null;

function showDetails(book) {
  detailsBook = book;
  renderDetails($('#details-body'), book);
  $('#details-toggle-read').textContent = isRead(book) ? 'Mark as not read' : 'Mark as read';
  $('#details-loan').textContent = currentLoan(book) ? 'Mark as returned' : 'Lend this book';
}

function openDetails(book) {
  showDetails(book);
  openDialog(detailsDialog);
}

$('#details-toggle-read').addEventListener('click', async () => {
  const button = $('#details-toggle-read');
  const book = detailsBook;
  setBusy(button, true);
  try {
    const saved = await api.update(book.id, { ...book, read: !isRead(book) });
    state.books = state.books.map((existing) => (existing.id === saved.id ? saved : existing));
    showDetails(saved);
    render();
    toast(isRead(saved) ? `Marked “${saved.title}” as read.` : `Marked “${saved.title}” as not read.`, { type: 'success', timeout: 2500 });
  } catch (err) {
    toast(err.message, { type: 'error', timeout: 7000 });
  } finally {
    setBusy(button, false);
  }
});

// ---------------------------------------------------------------------------
// Lend / return
// ---------------------------------------------------------------------------
const loanDialog = $('#loan-dialog');
const loanForm = $('#loan-form');

function todayYmd() {
  const now = new Date();
  const pad = (number) => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function openLoanDialog(book) {
  const loan = currentLoan(book);
  const returning = Boolean(loan);
  $('#loan-title').textContent = returning ? 'Mark as returned' : 'Lend this book';
  $('#loan-summary').textContent = returning
    ? `“${book.title}” is with ${loan.borrower} since ${formatDay(loan.dateBorrowed)}.`
    : `“${book.title}”`;
  $('#loan-borrower-field').hidden = returning;
  $('#loan-borrower').value = '';
  $('#loan-date-label').textContent = returning ? 'Date returned' : 'Date borrowed';
  const date = $('#loan-date');
  date.value = todayYmd();
  date.max = todayYmd();
  date.min = returning ? loan.dateBorrowed : '';
  $('#loan-submit').textContent = returning ? 'Save return' : 'Save loan';
  $('#loan-error').hidden = true;
  openDialog(loanDialog);
  (returning ? date : $('#loan-borrower')).focus();
}

$('#details-loan').addEventListener('click', () => openLoanDialog(detailsBook));

loanForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const book = detailsBook;
  const loan = currentLoan(book);
  const date = $('#loan-date').value;
  const borrower = $('#loan-borrower').value.trim();
  const fail = (message) => {
    $('#loan-error').textContent = message;
    $('#loan-error').hidden = false;
  };
  if (!loan && !borrower) return fail('Enter who is borrowing the book.');
  if (!date) return fail(loan ? 'Pick the date it was returned.' : 'Pick the date it was borrowed.');
  if (date > todayYmd()) return fail('That date is in the future.');
  if (loan && date < loan.dateBorrowed) return fail(`It cannot be returned before it was borrowed (${formatDay(loan.dateBorrowed)}).`);

  const history = Array.isArray(book.loans) ? book.loans : [];
  const loans = loan
    ? [...history.slice(0, -1), { ...loan, dateReturned: date }]
    : [...history, { borrower, dateBorrowed: date, dateReturned: '' }];
  const button = $('#loan-submit');
  setBusy(button, true);
  try {
    const saved = await api.update(book.id, { ...book, loans });
    state.books = state.books.map((existing) => (existing.id === saved.id ? saved : existing));
    loanDialog.close();
    showDetails(saved);
    render();
    toast(loan ? `“${saved.title}” marked as returned.` : `“${saved.title}” lent to ${borrower}.`, { type: 'success', timeout: 3000 });
  } catch (err) {
    fail(err.details?.length ? err.details.join(' ') : err.message);
  } finally {
    setBusy(button, false);
  }
});

$('#details-edit').addEventListener('click', () => {
  const book = detailsBook;
  detailsDialog.close();
  openBookForm({ mode: 'edit', book });
});

$('#details-delete').addEventListener('click', async () => {
  const book = detailsBook;
  const confirmed = await confirmDialog({
    title: 'Delete this book?',
    message: `“${book.title || 'Untitled'}” will be permanently removed from your library. This cannot be undone.`,
    confirmLabel: 'Delete book',
  });
  if (!confirmed) return;
  const button = $('#details-delete');
  setBusy(button, true);
  try {
    await api.remove(book.id);
    state.books = state.books.filter((existing) => existing.id !== book.id);
    detailsDialog.close();
    updateFacets();
    render();
    toast(`Deleted “${book.title || 'Untitled'}”.`, { type: 'success' });
  } catch (err) {
    if (err.status === 404) {
      // Already gone (e.g. deleted from another tab): just resync.
      detailsDialog.close();
      await loadBooks();
    }
    toast(err.message, { type: 'error', timeout: 7000 });
  } finally {
    setBusy(button, false);
  }
});

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------
const bookDialog = $('#book-dialog');
const bookForm = $('#book-form');
const FIELDS = ['isbn13', 'isbn10', 'title', 'subtitle', 'authors', 'publisher', 'publishedDate', 'pageCount', 'language', 'categories', 'coverImage', 'description', 'googleBooksId'];
const field = (name) => $(`#f-${name}`);
let formState = { mode: 'add', id: null };

function splitList(text) {
  return [...new Set(text.split(',').map((part) => part.trim()).filter(Boolean))];
}

/** The cover photo taken in the app (an embedded image). It takes precedence over the link field. */
let coverPhoto = '';

function setCoverPhoto(dataUrl) {
  coverPhoto = dataUrl || '';
  const link = field('coverImage');
  link.disabled = Boolean(coverPhoto);
  if (coverPhoto) link.value = '';
  $('#cover-photo-remove').hidden = !coverPhoto;
  $('#cover-photo-btn').textContent = coverPhoto ? 'Retake cover photo' : 'Add cover photo';
  updatePreview();
}

$('#cover-photo-btn').addEventListener('click', async () => {
  const photo = await captureCover();
  if (photo) setCoverPhoto(photo);
});
$('#cover-photo-remove').addEventListener('click', () => setCoverPhoto(''));

function readForm() {
  const pages = field('pageCount').value.trim();
  return {
    isbn13: normalizeIsbn(field('isbn13').value),
    isbn10: normalizeIsbn(field('isbn10').value),
    title: field('title').value.trim(),
    subtitle: field('subtitle').value.trim(),
    authors: splitList(field('authors').value),
    publisher: field('publisher').value.trim(),
    publishedDate: field('publishedDate').value.trim(),
    pageCount: pages === '' ? null : Number(pages),
    language: field('language').value.trim().toLowerCase(),
    categories: splitList(field('categories').value),
    coverImage: coverPhoto || field('coverImage').value.trim(),
    description: field('description').value.trim(),
    googleBooksId: field('googleBooksId').value.trim(),
    read: field('read').checked,
  };
}

function fillForm(book = {}) {
  field('isbn13').value = book.isbn13 || '';
  field('isbn10').value = book.isbn10 || '';
  field('title').value = book.title || '';
  field('subtitle').value = book.subtitle || '';
  field('authors').value = asList(book.authors).join(', ');
  field('publisher').value = book.publisher || '';
  field('publishedDate').value = book.publishedDate || '';
  field('pageCount').value = book.pageCount ?? '';
  field('language').value = book.language || '';
  field('categories').value = asList(book.categories).join(', ');
  const embedded = typeof book.coverImage === 'string' && book.coverImage.startsWith('data:');
  field('coverImage').value = embedded ? '' : book.coverImage || '';
  setCoverPhoto(embedded ? book.coverImage : '');
  field('description').value = book.description || '';
  field('googleBooksId').value = book.googleBooksId || '';
  field('read').checked = isRead(book);
}

function showFieldError(name, message) {
  const input = field(name);
  const errorEl = $(`#f-${name}-error`);
  input.toggleAttribute('aria-invalid', Boolean(message));
  if (errorEl) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
    if (message) input.setAttribute('aria-describedby', errorEl.id);
    else input.removeAttribute('aria-describedby');
  }
}

function clearFormErrors() {
  FIELDS.forEach((name) => showFieldError(name, ''));
  $('#book-error').hidden = true;
}

function showFormError(messages) {
  const box = clear($('#book-error'));
  const list = [].concat(messages);
  if (list.length === 1) box.textContent = list[0];
  else box.append(el('ul', {}, list.map((message) => el('li', { text: message }))));
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}

/** Returns an object of field errors; empty when the form is valid. */
function validateForm(data) {
  const errors = {};
  if (!data.title) errors.title = 'Enter a title.';
  if (data.isbn13 && !isValidIsbn13(data.isbn13)) errors.isbn13 = 'Not a valid ISBN-13 — check the digits.';
  if (data.isbn10 && !isValidIsbn10(data.isbn10)) errors.isbn10 = 'Not a valid ISBN-10 — check the digits.';
  if (!data.isbn13 && !data.isbn10) errors.isbn13 = 'Enter an ISBN-13 or ISBN-10.';
  if (data.pageCount !== null && (!Number.isInteger(data.pageCount) || data.pageCount < 0)) errors.pageCount = 'Use a whole number.';
  if (data.language && !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(data.language)) errors.language = 'Use a code like "en".';
  if (data.coverImage && !data.coverImage.startsWith('data:image/') && !/^https?:\/\/\S+$/i.test(data.coverImage)) errors.coverImage = 'Use a full http(s) link.';
  return errors;
}

function updatePreview() {
  const data = readForm();
  const image = $('#preview-cover');
  const source = isCoverSource(data.coverImage) ? data.coverImage : PLACEHOLDER_COVER;
  if (image.dataset.src !== source) {
    image.dataset.src = source;
    image.onerror = () => { image.onerror = null; image.src = PLACEHOLDER_COVER; };
    image.referrerPolicy = 'no-referrer';
    image.src = source;
  }
  $('#preview-title').textContent = data.title || 'Untitled book';
  $('#preview-authors').textContent = data.authors.join(', ');
  $('#preview-publisher').textContent = data.publisher;
  $('#preview-isbn').textContent = data.isbn13 || data.isbn10 ? `ISBN ${data.isbn13 || data.isbn10}` : '';
}

function openBookForm({ mode, book = {}, note = '', canLookup = false }) {
  formState = { mode, id: mode === 'edit' ? book.id : null };
  clearFormErrors();
  fillForm(book);
  $('#book-dialog-title').textContent = mode === 'edit' ? 'Edit book' : 'Add book';
  $('#book-submit').textContent = mode === 'edit' ? 'Save changes' : 'Add to My Library';
  const noteEl = $('#book-source-note');
  noteEl.textContent = note;
  noteEl.hidden = !note;
  $('#lookup-row').hidden = !canLookup;
  $('#book-lookup-status').textContent = '';
  updatePreview();
  openDialog(bookDialog);
  bookDialog.querySelector('.dialog__body').scrollTop = 0;
  (book.title ? field('title') : field(book.isbn13 || book.isbn10 ? 'title' : 'isbn13')).focus();
}

bookForm.addEventListener('input', updatePreview);

// Fill in the other ISBN form automatically once one of them is valid.
field('isbn13').addEventListener('change', () => {
  const normalized = normalizeIsbn(field('isbn13').value);
  field('isbn13').value = normalized;
  if (isValidIsbn13(normalized) && !field('isbn10').value.trim()) field('isbn10').value = isbn13To10(normalized);
});
field('isbn10').addEventListener('change', () => {
  const normalized = normalizeIsbn(field('isbn10').value);
  field('isbn10').value = normalized;
  if (isValidIsbn10(normalized) && !field('isbn13').value.trim()) field('isbn13').value = isbn10To13(normalized);
});

$('#book-lookup').addEventListener('click', async () => {
  const button = $('#book-lookup');
  const status = $('#book-lookup-status');
  const isbn = [field('isbn13').value, field('isbn10').value].map(normalizeIsbn).find((candidate) => isValidIsbn13(candidate) || isValidIsbn10(candidate));
  if (!isbn) {
    showFieldError('isbn13', 'Enter a valid ISBN first.');
    field('isbn13').focus();
    return;
  }
  const existing = findByIsbn(state.books, isbn);
  if (existing) {
    status.textContent = '';
    showFormError(`“${existing.title}” with this ISBN is already in your library.`);
    return;
  }
  setBusy(button, true);
  status.textContent = 'Looking up…';
  try {
    const found = await lookupBook(isbn);
    if (!found) {
      status.textContent = 'No match found. Fill in the details yourself.';
      return;
    }
    // Only fill blanks: never overwrite what has been typed.
    let filled = 0;
    const current = readForm();
    for (const name of FIELDS) {
      const incoming = found[name];
      const empty = Array.isArray(current[name]) ? current[name].length === 0 : current[name] === '' || current[name] === null;
      const has = Array.isArray(incoming) ? incoming.length > 0 : incoming !== '' && incoming !== null && incoming !== undefined;
      if (empty && has) {
        field(name).value = Array.isArray(incoming) ? incoming.join(', ') : incoming;
        filled++;
      }
    }
    updatePreview();
    status.textContent = filled ? `Filled in ${filled} field${filled === 1 ? '' : 's'} from ${found.source === 'openlibrary' ? 'Open Library' : 'Google Books'}.` : 'Nothing new to fill in.';
  } catch (err) {
    status.textContent = err.message;
  } finally {
    setBusy(button, false);
  }
});

bookForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearFormErrors();
  const data = readForm();
  // Fill in the other ISBN form if it was left blank.
  if (isValidIsbn13(data.isbn13) && !data.isbn10) data.isbn10 = isbn13To10(data.isbn13);
  if (isValidIsbn10(data.isbn10) && !data.isbn13) data.isbn13 = isbn10To13(data.isbn10);

  const errors = validateForm(data);
  const names = Object.keys(errors);
  if (names.length) {
    names.forEach((name) => showFieldError(name, errors[name]));
    field(names[0]).focus();
    return;
  }

  if (formState.mode === 'add') {
    const existing = findByIsbn(state.books, data.isbn13);
    if (existing) {
      showFormError(`“${existing.title}” (same ISBN) is already in your library, so nothing was added.`);
      return;
    }
  }

  const button = $('#book-submit');
  setBusy(button, true);
  try {
    if (formState.mode === 'edit') {
      const saved = await api.update(formState.id, data);
      state.books = state.books.map((existing) => (existing.id === saved.id ? saved : existing));
      bookDialog.close();
      updateFacets();
      render();
      toast(`Saved changes to “${saved.title}”.`, { type: 'success' });
    } else {
      const saved = await api.add(data);
      state.books = [...state.books, saved];
      bookDialog.close();
      updateFacets();
      const hidden = filterAndSort(state.books, state).every((existing) => existing.id !== saved.id);
      if (hidden) clearFilters();
      render();
      toast(`Added “${saved.title}” to your library.`, { type: 'success' });
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      showFormError(err.message + (err.existing?.title ? ` (“${err.existing.title}”).` : '.'));
    } else if (err instanceof ApiError && err.status === 400 && err.details.length) {
      showFormError(err.details);
    } else {
      showFormError(err.message);
    }
  } finally {
    setBusy(button, false);
  }
});

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
const scannerDialog = $('#scanner-dialog');
const scannerView = $('#scanner-view');
const scannerStatus = $('#scanner-status');
const scannerToggle = $('#scanner-toggle');
let lookupBusy = false;
let scannerSession = 0;

const scanner = new BarcodeScanner($('#scanner-video'), {
  onDetect: (isbn) => handleIsbn(isbn, 'scan'),
  onNotIsbn: () => setScannerStatus('That barcode is not an ISBN. Look for the one starting with 978 or 979.'),
});

function setScannerStatus(text) {
  scannerStatus.textContent = text;
}

function setOverlay(text) {
  $('#scanner-overlay').hidden = !text;
  $('#scanner-overlay-text').textContent = text || '';
}

function clearScannerMessages() {
  $('#scanner-error').hidden = true;
  $('#scanner-notfound').hidden = true;
}

function showScannerError(message) {
  const box = $('#scanner-error');
  box.textContent = message;
  box.hidden = false;
}

function showLookupProblem(message, isbn) {
  $('#scanner-notfound-text').textContent = message;
  $('#scanner-notfound').hidden = false;
  $('#scanner-manual-entry').dataset.isbn = isbn;
}

async function startCamera() {
  const mySession = scannerSession;
  clearScannerMessages();
  setOverlay('');
  setScannerStatus('Starting camera…');
  scannerToggle.disabled = true;
  try {
    const engine = await scanner.start();
    if (mySession !== scannerSession) return;
    scannerView.classList.add('is-scanning');
    scannerToggle.textContent = 'Stop camera';
    setScannerStatus('Scanning… point the camera at the barcode.');
    scannerView.dataset.engine = engine;
  } catch (err) {
    if (err instanceof ScannerError && err.code === 'cancelled') return;
    if (mySession !== scannerSession) return;
    scannerView.classList.remove('is-scanning');
    scannerToggle.textContent = 'Start camera';
    setScannerStatus('Camera is off.');
    setOverlay('Camera unavailable');
    showScannerError(err.message);
  } finally {
    if (mySession === scannerSession) scannerToggle.disabled = false;
  }
}

function stopCamera(message = 'Camera stopped.') {
  scanner.stop();
  scannerView.classList.remove('is-scanning');
  scannerToggle.textContent = 'Start camera';
  setScannerStatus(message);
}

function openScanner() {
  scannerSession++;
  lookupBusy = false;
  $('#manual-isbn').value = '';
  setBusy($('#manual-isbn-submit'), false);
  openDialog(scannerDialog);
  startCamera();
}

scannerToggle.addEventListener('click', () => {
  if (scanner.active) {
    setOverlay('Camera stopped');
    stopCamera();
  } else {
    startCamera();
  }
});

/** Release the camera, invalidate any in-flight lookup and reset the dialog. Idempotent. */
function teardownScanner() {
  scannerSession++;
  lookupBusy = false;
  stopCamera('');
  setOverlay('');
  clearScannerMessages();
}

/** Close the scanner from code. Teardown is synchronous so nothing can scan after this returns. */
function closeScanner() {
  teardownScanner();
  if (scannerDialog.open) scannerDialog.close();
}

// Closing via the X / Close buttons or Esc must release the camera as well.
scannerDialog.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) teardownScanner();
});
scannerDialog.addEventListener('cancel', teardownScanner); // Esc
scannerDialog.addEventListener('close', () => {
  if (!scannerDialog.open) teardownScanner(); // backstop for any other way the dialog closes
});

window.addEventListener('pagehide', () => scanner.stop());

async function handleIsbn(raw, source) {
  if (lookupBusy) return; // a lookup is already running: ignore repeat scans
  clearScannerMessages();
  const isbn = normalizeIsbn(raw);
  if (!isValidIsbn13(isbn) && !isValidIsbn10(isbn)) {
    showScannerError(
      source === 'manual'
        ? 'That ISBN is not valid. Check the digits (10 or 13 digits; the last one is a check digit).'
        : 'The barcode was read incorrectly. Hold steady and try again.',
    );
    scanner.resume();
    return;
  }

  const existing = findByIsbn(state.books, isbn);
  if (existing) {
    closeScanner();
    toast(`“${existing.title}” is already in your library.`, { type: 'info' });
    openDetails(existing);
    return;
  }

  const mySession = scannerSession;
  lookupBusy = true;
  scanner.pause();
  setBusy($('#manual-isbn-submit'), true);
  setScannerStatus(`Found ISBN ${canonicalIsbn(isbn)}. Looking up book details…`);
  setOverlay(scanner.active ? 'Looking up book…' : '');
  try {
    const book = await lookupBook(isbn);
    if (mySession !== scannerSession) return; // scanner closed while waiting
    if (book) {
      closeScanner();
      const from = book.source === 'openlibrary' ? 'Open Library' : 'Google Books';
      openBookForm({ mode: 'add', book, note: `Details found on ${from}. Check them, edit anything you like, then add the book.` });
      return;
    }
    showLookupProblem(`No book was found for ISBN ${canonicalIsbn(isbn)}. You can enter the details yourself.`, isbn);
  } catch (err) {
    if (mySession !== scannerSession) return;
    showLookupProblem(`${err.message} You can try again or enter the details yourself.`, isbn);
  } finally {
    if (mySession === scannerSession) {
      lookupBusy = false;
      setBusy($('#manual-isbn-submit'), false);
      setOverlay('');
      setScannerStatus(scanner.active ? 'Scanning… point the camera at the barcode.' : 'Camera is off.');
      scanner.resume();
    }
  }
}

$('#manual-isbn-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('#manual-isbn').value.trim();
  if (!value) {
    clearScannerMessages();
    showScannerError('Type an ISBN first.');
    $('#manual-isbn').focus();
    return;
  }
  handleIsbn(value, 'manual');
});

$('#scanner-manual-entry').addEventListener('click', (event) => {
  const isbn = normalizeIsbn(event.currentTarget.dataset.isbn);
  closeScanner();
  openBookForm({
    mode: 'add',
    canLookup: true,
    book: { isbn13: isbn.length === 13 ? isbn : isbn10To13(isbn), isbn10: isbn.length === 10 ? isbn : isbn13To10(isbn) },
    note: 'Enter what you know. Only a title is required — you can edit the rest later.',
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
setupDialog(scannerDialog, { backdropClose: false });
setupDialog(bookDialog);
setupDialog(loanDialog);
setupDialog(detailsDialog, { backdropClose: true });
setupDialog($('#confirm-dialog'));
initCoverCapture();

loadBooks();
