# My Home Library

A small personal web app for cataloguing the books you own. Scan the ISBN barcode on a book (or type the ISBN), let Google Books fill in the details, tweak them if you like, and save. Your collection lives in a single JSON file on your own computer.

* **Plain stack:** HTML, CSS and vanilla JavaScript (ES modules) in the browser; a small Node.js server using only built-in modules.
* **One dependency:** [`@zxing/library`](https://github.com/zxing-js/library), the barcode decoder used when the browser has no built-in one. It is served from your own server, so there is no CDN.
* **Your data stays local:** `data/books.json` is the single source of truth. Nothing is stored in the browser except view preferences (grid/list, sort order).

## Quick start

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open <http://localhost:3000>. Camera access works on `localhost` without any extra setup.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to bind. Keep the default unless you know you need more (see [Using it on your phone](#using-it-on-your-phone)) |
| `BOOKS_FILE` | `data/books.json` | Where to store the library |
| `GOOGLE_BOOKS_API_KEY` | _(none)_ | Optional Google Books API key (see [Google Books quota](#google-books-quota)) |
| `OPEN_LIBRARY` | on | Set to `off` to disable the Open Library fallback |

Example: `PORT=8080 GOOGLE_BOOKS_API_KEY=your-key npm start`

## Using it

1. Click **Scan ISBN** and allow camera access. Point the camera at the barcode on the back cover (the one starting with 978 or 979). It is detected automatically; you can also type the ISBN into the box under the camera.
2. The book is looked up on Google Books and shown in a preview where every field is editable.
3. Click **Add to My Library**. The book appears immediately.

Other things you can do:

* **Add Book** opens an empty form for books Google does not know about, or ones without a barcode. Only an ISBN and a title are required. The **Look up** button there fills in blanks from Google Books without overwriting anything you typed.
* **Cover photo:** many local books have no cover online. In the add/edit form press **Add cover photo**.
  * **Automatic:** hold the book **upright (portrait)** with the front cover facing the camera, ideally against a plain background. The detector only reports upright, portrait-shaped outlines, so a book held on its side is not outlined (use **Choose photo…** and **Adjust outline…** for those). The app outlines the book in green; keep it still for about a second and the photo is taken by itself, with the book straightened into a flat cover (perspective corrected). Untick **Find the book and take the photo automatically** to take photos by hand with the **Take photo** button instead.
  * **From a file:** **Choose photo…** also finds and straightens the book in the picture. On a phone it opens your camera app or photo library, and it works even over plain `http`.
  * **Wrong outline? Fix it.** In the crop step press **Adjust outline…**, drag the four white dots onto the book's real corners (top-left, top-right, bottom-right, bottom-left) and press **Straighten**. This also works when no book was found.
  * **Always adjustable:** the crop step follows every photo. Drag the picture and zoom (pinch, mouse wheel, arrow keys or the slider) until the white book-shaped frame lines up with the cover's edges. **Rotate** fixes sideways photos, and **Use original photo instead** undoes the straightening if the outline was wrong. **Remove photo** goes back to a web link or the placeholder.
* **Search** by title, author, ISBN (hyphens optional), publisher or category; **filter** by category and language; **sort** by title, author, publication date or date added; switch between **grid** and **list** views.
* Click a book for its full details, then **Edit** or **Delete** (deleting asks for confirmation).
* Track what you have read: tick **I have read this book** when adding or editing, or press **Mark as read** in a book's details. Read books show a green tick on their cover, the **Status** filter shows only read or unread books, and the line under the toolbar shows your totals. Books saved before this feature existed count as not read.
* **Export** downloads the whole library as a JSON file. **Import** reads such a file and shows a summary first, then lets you either **add** the new books (existing ISBNs are never overwritten) or **restore**, which replaces the library with the backup. A restore keeps the previous file as `data/books.json.bak`.

Scanning a book you already own opens its existing entry instead of adding a duplicate. Duplicates are detected by ISBN whatever the form (ISBN-10 or ISBN-13, with or without hyphens), and ISBN checksums are validated.

### How book detection works, and where it struggles

Detection runs entirely in your browser, with no extra library: it finds edges, then long straight lines, then the best four-sided outline around the middle of the picture. It is a good first guess, not magic. In my tests (synthetic scenes plus real cover artwork pasted onto a real wooden-table photo; no real camera was available) it found books on plain or wooden tables almost every time, usually within a few percent of the true edges. It is less reliable when:

* the cover's outer edge is nearly the same colour as the table (white or cream covers on a light table). It may outline the printed area inside instead,
* the background is cluttered or has strong lines (a patterned tablecloth, a keyboard, other books),
* the book is held at a steep angle, or is partly outside the view.

When no book is found nothing happens: you just get the normal manual crop. When the outline is found but is wrong (for example, too tall or too short), use **Adjust outline…**. Detection never saves anything by itself.

## Barcode scanning and browsers

The scanner uses the browser's built-in `BarcodeDetector` where it supports EAN-13 (Chrome and Edge on Android, Chrome on macOS and ChromeOS) and otherwise falls back to ZXing, which works in Safari, Firefox and others. It asks for the rear camera by default on phones.

Browsers only allow camera access on **HTTPS or `localhost`**. If the camera is blocked or unavailable you will see a message, and typing the ISBN still works.

### Using it on your phone

A phone cannot reach `localhost` on your computer, and browsers will not give a plain `http://192.168.x.x` page camera access. Options:

* **Easiest:** open the app on the computer and scan there (a laptop webcam works, or a phone webcam app).
* **Phone camera:** serve the app over HTTPS, for example with a private tunnel such as `tailscale serve` or a Cloudflare Tunnel pointing at `http://localhost:3000`. The server needs no changes for that.
* **Without the camera:** over plain `http`, the manual ISBN box and everything else still works. Start the server with `HOST=0.0.0.0 npm start` and open `http://<your-computer's-ip>:3000`.

> The app has **no login**. Only bind to `0.0.0.0` on a network you trust.

## Book lookups: Google Books, with an Open Library fallback

Lookups are made **by the server**, so an API key (if you configure one) never reaches the browser.

1. Google Books is asked first, in two steps. The standard search (`https://www.googleapis.com/books/v1/volumes?q=isbn:{ISBN}`) is tried first. Google's `isbn:` search often returns nothing for books it does have (this affects many non-English and local titles), so if it finds nothing the server resolves the ISBN to a Google volume id through Google's `viewapi` endpoint and fetches that volume. The record is only used if it carries the ISBN you looked up.
2. If Google is rate-limited, unreachable or has no record, the server asks [Open Library](https://openlibrary.org/dev/docs/api/books), which needs no key. The preview tells you which one answered. Open Library records are sometimes sparser (no description or language), and its categories can be a long list of subjects, so check them before saving.
3. If neither can answer, you are offered manual entry. You are only told "no book found" when a service actually said so; if Google was down and Open Library had nothing, you see Google's error instead.

Set `OPEN_LIBRARY=off` to disable the fallback.

### Google Books quota

Without a key, Google applies a shared anonymous quota that is sometimes exhausted (HTTP 429), which is when the fallback kicks in. A free key makes Google answer reliably:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Books API**.
2. Create an API key and start the app with `GOOGLE_BOOKS_API_KEY=...`.

## Data file

`data/books.json` looks like this (a sample entry is included):

```json
{
  "books": [
    {
      "id": "unique-id",
      "isbn13": "9780140328721",
      "isbn10": "0140328726",
      "title": "Fantastic Mr. Fox",
      "subtitle": "",
      "authors": ["Roald Dahl"],
      "publisher": "Puffin",
      "publishedDate": "1988",
      "description": "",
      "pageCount": 96,
      "categories": ["Juvenile fiction"],
      "language": "en",
      "coverImage": "",
      "googleBooksId": "",
      "read": false,
      "dateAdded": "2026-10-02T10:00:00.000Z",
      "dateUpdated": "2026-10-02T10:00:00.000Z"
    }
  ]
}
```

* Writes are **atomic**: data goes to a temp file, is flushed, then renamed over `books.json`, and the previous version is kept as `books.json.bak`. Requests are queued so simultaneous writes cannot interleave.
* A **missing** file is treated as an empty library and created on first start.
* An **invalid** file (broken JSON, no `books` list) is never overwritten. The server refuses to start, or answers with a clear error, until you fix or delete the file or copy `books.json.bak` over it.
* You can edit the file by hand while the server is stopped.
* **Cover photos live inside `books.json`** as small embedded JPEGs (at most 400 x 600 pixels, usually 10 to 60 KB each), so export, import and restore keep them with no extra files. A library with hundreds of photographed covers will make the file a few megabytes; that is fine for a personal collection.

## API

All endpoints speak JSON. Request bodies must be sent as `Content-Type: application/json`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Health check: `{ "status": "ok", "books": 12, ... }` |
| `GET` | `/api/books` | List all books: `{ "books": [...] }` |
| `POST` | `/api/books` | Add a book. `201` with the book; `400` invalid; `409` ISBN already present (response includes `existing`) |
| `GET` | `/api/books/:id` | One book, or `404` |
| `PUT` | `/api/books/:id` | Replace a book's metadata (`id` and `dateAdded` are kept). `400`, `404`, or `409` if the ISBN belongs to another book |
| `DELETE` | `/api/books/:id` | Delete a book, or `404` |
| `GET` | `/api/export` | The library as a downloadable backup file |
| `POST` | `/api/import` | `{ "books": [...], "mode": "merge" \| "replace", "dryRun": false }`. Returns counts of added, duplicate and invalid entries |
| `GET` | `/api/lookup/:isbn` | Book lookup used by the UI (Google Books, then Open Library): `{ items, source }`. `429` / `502` when no source could answer |

Server-side validation requires a title and a valid ISBN-10 or ISBN-13 (checksum verified; the other form is derived when possible), caps field lengths, accepts only `http(s)` cover links or small embedded JPEG/PNG/WebP photos (type, size and file signature are checked), and ignores unknown fields.

## Security notes

* The server binds to `127.0.0.1` by default and rejects requests whose `Host` header is not `localhost`/`127.0.0.1` (protects against DNS-rebinding), and cross-origin requests (`Origin` mismatch).
* Mutating requests must be `application/json` and are size-limited (768 KB per book, 20 MB for a backup).
* Static files are served only from `public/` (path traversal and dotfiles are rejected), plus the single ZXing bundle. `data/` is never served over HTTP.
* A strict Content-Security-Policy is sent (`script-src 'self'`, no inline scripts or styles). All book data is rendered with `textContent`, never as HTML, and Google descriptions are reduced to plain text.

## Project layout

```
home_library/
├── server.js            HTTP server, routing, static files, Google Books proxy
├── store.js             books.json storage: atomic writes, write queue, import
├── validate.js          server-side validation and sanitising of book data
├── open-library.js      Open Library lookup (fallback) and conversion
├── data/books.json      your library (sample included)
├── public/
│   ├── index.html
│   ├── css/styles.css
│   ├── js/
│   │   ├── app.js           wiring: toolbar, dialogs, forms, scanner and import flows
│   │   ├── scanner.js       camera + barcode detection (BarcodeDetector / ZXing)
│   │   ├── cover.js         cover photo dialog: camera or file, auto-capture, then crop
│   │   ├── detect.js        book outline detection and perspective correction (no DOM)
│   │   ├── cropper.js       the crop engine (fixed 2:3 frame, drag / pinch / zoom)
│   │   ├── google-books.js  lookup and mapping of Google Books data
│   │   ├── library.js       API client, search / filter / sort
│   │   ├── ui.js            DOM helpers, toasts, dialogs, card and detail rendering
│   │   └── isbn.js          ISBN validation/conversion (shared with the server)
│   └── assets/placeholder-book.svg
└── test/                API and ISBN tests
```

## Tests

```bash
npm test
```

Runs the built-in Node test runner against the API (CRUD, validation, duplicates, import/restore, concurrency, security checks, Google Books and Open Library lookups and fallback with fake upstreams, corrupted-file handling) the ISBN helpers, and the book detector (on generated pictures, with known right answers). No network access is needed.
