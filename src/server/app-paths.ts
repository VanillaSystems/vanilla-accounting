/**
 * Which requests are the app and which are data. Every app path (/journal/M2026-001,
 * /receipts/<id>) answers with index.html; the API, the books and every file go to the API.
 * /receipts/<id> and the file /receipts/<name>.pdf share a prefix (so do /invoices/<number> and its PDF): a file has an extension.
 */
const API_PREFIXES = ['/api', '/scan', '/books.json', '/modules.json'];
const FILE = /\.[A-Za-z0-9]+$/;
/** A file of the books: a receipt, a statement, an invoice PDF. */
const BOOKS_FILE = '^/(receipts|bank-statements|invoices)/[^?]*\\.[A-Za-z0-9]+(\\?|$)';

export function isAppPath(path: string): boolean {
  return !API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) && !FILE.test(path);
}

/** What the API answers: its prefixes and the books' files. Everything else is the UI's (desktop:dev sends it to Vite). */
export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) || new RegExp(BOOKS_FILE).test(path);
}

/** Vite's dev proxy to the API at `target`: the same rule, as Vite matches it on the URL with its query. */
export function devProxy(target: string): Record<string, string> {
  return Object.fromEntries(
    [...API_PREFIXES, BOOKS_FILE].map((p) => [p, target]),
  );
}
