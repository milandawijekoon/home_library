// UI helpers: safe DOM construction, toasts, dialogs and the book renderers.
// Nothing here uses innerHTML: all book data is inserted as text, so metadata from
// Google Books or an imported file can never inject markup.
import { asList, languageName, isRead, currentLoan } from './library.js';
import { formatIsbn } from './isbn.js';

export const PLACEHOLDER_COVER = 'assets/placeholder-book.svg';

export const $ = (selector, root = document) => root.querySelector(selector);

/** el("div", {class: "x", onclick: fn, "aria-label": "…"}, "text", childNode) */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
export function toast(message, { type = 'info', timeout = 4500 } = {}) {
  const host = $('#toasts');
  const node = el(
    'div',
    { class: `toast toast--${type}`, role: type === 'error' ? 'alert' : 'status' },
    el('span', { text: message }),
    el('button', { type: 'button', 'aria-label': 'Dismiss notification', text: '×', onclick: () => node.remove() }),
  );
  host.append(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  while (host.children.length > 4) host.firstElementChild.remove();
  return node;
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
/** Wire up [data-close] buttons and (optionally) click-outside-to-close for a <dialog>. */
export function setupDialog(dialog, { backdropClose = false } = {}) {
  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) dialog.close();
  });
  if (backdropClose) {
    let pressedOnBackdrop = false;
    dialog.addEventListener('pointerdown', (event) => (pressedOnBackdrop = event.target === dialog));
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog && pressedOnBackdrop) dialog.close();
    });
  }
}

export function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

/** Promise-based confirmation dialog. Resolves true only if the user confirms. */
export function confirmDialog({ title, message, confirmLabel = 'Delete' }) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = message;
  const confirmButton = $('#confirm-ok');
  confirmButton.textContent = confirmLabel;
  confirmButton.classList.add('btn--solid');
  return new Promise((resolve) => {
    const finish = (value) => {
      confirmButton.removeEventListener('click', onConfirm);
      $('#confirm-cancel').removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onEsc);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onConfirm = () => finish(true);
    const onCancel = () => finish(false);
    const onEsc = () => finish(false); // Esc; fires synchronously, unlike the async "close" event
    confirmButton.addEventListener('click', onConfirm);
    $('#confirm-cancel').addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onEsc);
    dialog.showModal();
    $('#confirm-cancel').focus();
  });
}

export function setBusy(button, busy) {
  button.classList.toggle('is-loading', busy);
  button.disabled = busy;
}

// ---------------------------------------------------------------------------
// Book rendering
// ---------------------------------------------------------------------------
/** A cover is a web link or an embedded photo (data URL). Anything else gets the placeholder. */
export function isCoverSource(source) {
  return typeof source === 'string' && /^(https?:\/\/|data:image\/(jpeg|png|webp);base64,)/i.test(source);
}

export function coverImage(source, { alt = '', className = '' } = {}) {
  const image = el('img', { class: className, alt, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  image.addEventListener(
    'error',
    () => {
      if (!image.src.endsWith(PLACEHOLDER_COVER)) image.src = PLACEHOLDER_COVER;
    },
    { once: true },
  );
  image.src = isCoverSource(source) ? source : PLACEHOLDER_COVER;
  return image;
}

export function authorsText(book) {
  return asList(book.authors).join(', ');
}

export function formatDate(isoText) {
  const timestamp = Date.parse(isoText);
  if (Number.isNaN(timestamp)) return '';
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Format a YYYY-MM-DD calendar date in the viewer's locale (parsed as local time, so it never shifts a day). */
export function formatDay(dayText) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayText || '');
  if (!dateMatch) return '';
  return new Date(+dateMatch[1], +dateMatch[2] - 1, +dateMatch[3]).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function renderBookCard(book, { onOpen }) {
  const authors = authorsText(book);
  const isbn = formatIsbn(book);
  const loan = currentLoan(book);
  const label = `${book.title || 'Untitled'}${authors ? ` by ${authors}` : ''}${isRead(book) ? ', read' : ''}${loan ? `, lent to ${loan.borrower}` : ''}. View details`;
  const published = (book.publishedDate || '').slice(0, 4);
  return el(
    'article',
    { class: 'book' },
    el(
      'button',
      { type: 'button', class: 'book__open', 'aria-label': label, onclick: () => onOpen(book) },
      el(
        'span',
        { class: 'book__media' },
        coverImage(book.coverImage, { className: 'book__cover' }),
        loan && el('span', { class: 'lent-badge', text: `Lent to ${loan.borrower}` }),
        isRead(book) && el('span', { class: 'read-badge', title: 'Read', 'aria-hidden': 'true', text: '✓' }),
      ),
      el(
        'span',
        { class: 'book__info' },
        el('span', { class: 'book__title', text: book.title || 'Untitled' }),
        authors && el('span', { class: 'book__author', text: authors }),
        book.publisher && el('span', { class: 'book__meta', text: book.publisher }),
        isbn && el('span', { class: 'book__meta book__isbn', text: `ISBN ${isbn}` }),
        el(
          'span',
          { class: 'book__extra book__meta' },
          [published, book.pageCount ? `${book.pageCount} pages` : '', languageName(book.language)]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
    ),
  );
}

export function renderDetails(container, book) {
  clear(container);
  const authors = asList(book.authors);
  const loan = currentLoan(book);
  const rows = [
    ['ISBN-13', book.isbn13],
    ['ISBN-10', book.isbn10],
    ['Publisher', book.publisher],
    ['Published', book.publishedDate],
    ['Pages', book.pageCount],
    ['Language', languageName(book.language)],
    ['Status', isRead(book) ? 'Read' : 'Not read yet'],
    ['Lent to', loan ? `${loan.borrower}, since ${formatDay(loan.dateBorrowed)}` : ''],
    ['Google Books ID', book.googleBooksId],
    ['Added', formatDate(book.dateAdded)],
    ['Last updated', formatDate(book.dateUpdated)],
  ].filter(([, value]) => value !== '' && value !== null && value !== undefined);

  container.append(
    el(
      'div',
      { class: 'details' },
      coverImage(book.coverImage, { className: 'details__cover', alt: `Cover of ${book.title || 'this book'}` }),
      el(
        'div',
        {},
        el('h2', { class: 'details__title', id: 'details-title', text: book.title || 'Untitled' }),
        book.subtitle && el('p', { class: 'details__subtitle', text: book.subtitle }),
        authors.length > 0 && el('p', { class: 'details__authors', text: `by ${authors.join(', ')}` }),
        el(
          'div',
          { class: 'details__chips' },
          el('span', { class: `chip ${isRead(book) ? 'chip--read' : 'chip--unread'}`, text: isRead(book) ? '✓ Read' : 'Not read yet' }),
          loan && el('span', { class: 'chip chip--lent', text: `Lent to ${loan.borrower}` }),
          asList(book.categories).map((category) => el('span', { class: 'chip', text: category })),
        ),
        book.description && el('p', { class: 'details__desc', text: book.description }),
        el(
          'dl',
          { class: 'meta' },
          rows.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: String(value) })]),
        ),
        renderLoanHistory(book),
      ),
    ),
  );
}

function renderLoanHistory(book) {
  const loans = Array.isArray(book.loans) ? book.loans : [];
  if (!loans.length) return null;
  return el(
    'section',
    { class: 'loans', 'aria-label': 'Lending history' },
    el('h3', { class: 'loans__title', text: 'Lending history' }),
    el(
      'ul',
      { class: 'loans__list' },
      [...loans].reverse().map((loan) =>
        el(
          'li',
          {},
          el('strong', { text: loan.borrower }),
          ` · borrowed ${formatDay(loan.dateBorrowed)} · `,
          loan.dateReturned ? `returned ${formatDay(loan.dateReturned)}` : el('em', { text: 'not returned yet' }),
        ),
      ),
    ),
  );
}
