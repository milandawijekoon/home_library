// books.json persistence: the file is the single source of truth.
//
// * Every operation (reads included) runs through a promise queue, so concurrent
//   requests never interleave a read-modify-write cycle.
// * Writes go to a temp file, are fsync'd, then renamed over books.json, so a crash
//   mid-write can never leave a half-written file. The previous version is kept as
//   books.json.bak.
// * A missing file means an empty library. An unreadable/invalid file is never
//   overwritten: operations fail with a clear error until the file is fixed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bookKey } from './public/js/isbn.js';
import { sanitizeBook, cleanTimestamp, isValidId } from './validate.js';

export class StoreError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export class BookStore {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  #locked(operation) {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => {});
    return run;
  }

  async #read() {
    let text;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { books: [] };
      throw new StoreError(500, `Could not read ${path.basename(this.file)}: ${err.message}`);
    }
    if (text.trim() === '') return { books: [] };
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw this.#corrupt('it is not valid JSON');
    }
    const books = Array.isArray(data) ? data : data?.books;
    if (!Array.isArray(books)) throw this.#corrupt('it has no "books" array');
    return { books: books.filter((storedBook) => storedBook && typeof storedBook === 'object' && !Array.isArray(storedBook)) };
  }

  #corrupt(reason) {
    const name = path.basename(this.file);
    return new StoreError(
      500,
      `${name} cannot be used because ${reason}. Nothing was changed. Fix or delete the file, ` +
        `or restore ${name}.bak, then reload.`,
      { code: 'corrupt-store' },
    );
  }

  async #write(books) {
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true });
    const scratch = path.join(directory, `.${path.basename(this.file)}.${process.pid}.${randomUUID()}.tmp`);
    const json = JSON.stringify({ books }, null, 2) + '\n';
    try {
      const handle = await fs.open(scratch, 'w', 0o600);
      try {
        await handle.writeFile(json, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.copyFile(this.file, `${this.file}.bak`).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
      await fs.rename(scratch, this.file);
    } catch (err) {
      await fs.rm(scratch, { force: true }).catch(() => {});
      throw new StoreError(500, `Could not save ${path.basename(this.file)}: ${err.message}`);
    }
  }

  /** Create an empty books.json if none exists, and verify the existing one is usable. */
  init() {
    return this.#locked(async () => {
      const { books } = await this.#read();
      try {
        await fs.access(this.file);
      } catch {
        await this.#write(books);
      }
      return books.length;
    });
  }

  list() {
    return this.#locked(async () => (await this.#read()).books);
  }

  get(id) {
    return this.#locked(async () => {
      const book = (await this.#read()).books.find((storedBook) => storedBook.id === id);
      if (!book) throw new StoreError(404, 'Book not found');
      return book;
    });
  }

  /** Sanitise `input`, then run `fn(value)` under the write lock. Invalid input rejects with a 400. */
  #validated(input, operation) {
    const { value, errors } = sanitizeBook(input);
    if (errors.length) return Promise.reject(new StoreError(400, 'Invalid book', { details: errors }));
    return this.#locked(() => operation(value));
  }

  add(input) {
    return this.#validated(input, async (value) => {
      const { books } = await this.#read();
      const key = bookKey(value);
      const existing = books.find((storedBook) => bookKey(storedBook) === key);
      if (existing) {
        throw new StoreError(409, 'A book with this ISBN is already in your library', { existing });
      }
      const now = new Date().toISOString();
      const ids = new Set(books.map((storedBook) => storedBook.id));
      let id = randomUUID();
      while (ids.has(id)) id = randomUUID();
      const book = { id, ...value, loans: value.loans ?? [], dateAdded: now, dateUpdated: now };
      await this.#write([...books, book]);
      return book;
    });
  }

  update(id, input) {
    return this.#validated(input, async (value) => {
      const { books } = await this.#read();
      const index = books.findIndex((storedBook) => storedBook.id === id);
      if (index === -1) throw new StoreError(404, 'Book not found');
      const key = bookKey(value);
      const clash = books.find((storedBook, otherIndex) => otherIndex !== index && bookKey(storedBook) === key);
      if (clash) {
        throw new StoreError(409, 'Another book in your library already has this ISBN', { existing: clash });
      }
      const old = books[index];
      const updated = {
        id: old.id,
        ...value,
        // Callers that don't send `loans` (e.g. the edit form) keep the existing history.
        loans: value.loans ?? (Array.isArray(old.loans) ? old.loans : []),
        dateAdded: cleanTimestamp(old.dateAdded) || new Date().toISOString(),
        dateUpdated: new Date().toISOString(),
      };
      const next = books.slice();
      next[index] = updated;
      await this.#write(next);
      return updated;
    });
  }

  remove(id) {
    return this.#locked(async () => {
      const { books } = await this.#read();
      const index = books.findIndex((storedBook) => storedBook.id === id);
      if (index === -1) throw new StoreError(404, 'Book not found');
      const [removed] = books.splice(index, 1);
      await this.#write(books);
      return removed;
    });
  }

  /**
   * Import books from a backup. mode "merge" adds books whose ISBN is not yet present;
   * mode "replace" swaps the whole library for the valid books in the file.
   * With dryRun the result is computed but nothing is written.
   */
  importBooks(rawBooks, { mode = 'merge', dryRun = false } = {}) {
    if (!Array.isArray(rawBooks)) {
      return Promise.reject(new StoreError(400, 'Backup must contain a "books" array'));
    }
    if (rawBooks.length > 20000) {
      return Promise.reject(new StoreError(400, 'Backup contains too many books'));
    }
    if (mode !== 'merge' && mode !== 'replace') {
      return Promise.reject(new StoreError(400, 'mode must be "merge" or "replace"'));
    }
    return this.#locked(async () => {
      const { books: current } = await this.#read();
      const base = mode === 'replace' ? [] : current;
      const keys = new Set(base.map(bookKey).filter(Boolean));
      const ids = new Set(base.map((storedBook) => storedBook.id));
      const accepted = [];
      const invalid = [];
      let duplicates = 0;

      rawBooks.forEach((raw, index) => {
        const { value, errors } = sanitizeBook(raw);
        if (errors.length) {
          invalid.push({ index: index, title: typeof raw?.title === 'string' ? raw.title : '', errors });
          return;
        }
        const key = bookKey(value);
        if (keys.has(key)) {
          duplicates++;
          return;
        }
        keys.add(key);
        const now = new Date().toISOString();
        let id = isValidId(raw.id) && !ids.has(raw.id) ? raw.id : randomUUID();
        while (ids.has(id)) id = randomUUID();
        ids.add(id);
        const dateAdded = cleanTimestamp(raw.dateAdded) || now;
        accepted.push({
          id,
          ...value,
          loans: value.loans ?? [],
          dateAdded,
          dateUpdated: cleanTimestamp(raw.dateUpdated) || dateAdded,
        });
      });

      if (mode === 'replace' && accepted.length === 0) {
        throw new StoreError(400, 'The backup contains no valid books, so your library was left unchanged', {
          details: invalid.slice(0, 5).flatMap((x) => x.errors),
        });
      }

      const result = {
        mode,
        dryRun,
        added: accepted.length,
        duplicates,
        invalid: invalid.length,
        invalidDetails: invalid.slice(0, 10),
        previousCount: current.length,
      };
      if (dryRun) return { ...result, total: base.length + accepted.length };

      const next = [...base, ...accepted];
      if (accepted.length > 0 || mode === 'replace') await this.#write(next);
      return { ...result, total: next.length };
    });
  }
}
