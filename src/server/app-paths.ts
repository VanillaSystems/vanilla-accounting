/**
 * Which requests are the app and which are data. Every app path (/journal/M2026-001,
 * /receipts/<id>) answers with index.html; the API, the books and every file go to the API.
 * /receipts/<id> and the file /receipts/<name>.pdf share a prefix: a file has an extension.
 */
const API_PREFIXES = ['/api', '/scan', '/books.json'];
const FILE = /\.[A-Za-z0-9]+$/;

export function isAppPath(path: string): boolean {
  return !API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) && !FILE.test(path);
}

/** Vite's dev proxy to the API at `target`: the same rule, as Vite matches it on the URL with its query. */
export function devProxy(target: string): Record<string, string> {
  return Object.fromEntries(
    [...API_PREFIXES, '^/(receipts|bank-statements)/[^?]*\\.[A-Za-z0-9]+(\\?|$)'].map((p) => [p, target]),
  );
}
