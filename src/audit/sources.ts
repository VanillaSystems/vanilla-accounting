/**
 * Every read the UI makes, and where it reads it: from the local API, or from a file of the
 * static audit export (npm run build:audit, docs/audit-export.md). The export writes exactly
 * EXPORT_FILES, so each read of the exported app is a file the export holds.
 */
export interface Sources {
  books(): string;
  status(): string;
  accounts(): string;
  workspace(): string;
  filedReturns(year: string): string;
  receipt(id: string): string;
  statement(bank: string, filename: string): string;
  /** The books' change log (src/books/history.ts). */
  log(): string;
  /** The review package's own files: the chart offered beside accounts.json, and the owner's earlier decisions. */
  chart(): string;
  reviewDecisions(): string;
  manifest(): string;
}

export const API_SOURCES: Sources = {
  books: () => '/books.json',
  status: () => '/api/status',
  accounts: () => '/api/accounts',
  workspace: () => '/api/workspace',
  filedReturns: (year) => `/api/vat/filed?year=${year}`,
  receipt: (id) => `/api/receipts/${id}`,
  statement: (bank, filename) => `/bank-statements/${bank}/${encodeURIComponent(filename)}`,
  log: () => '/api/log',
  chart: () => '/api/chart',
  reviewDecisions: () => '/api/reviews/decisions',
  manifest: () => '/manifest.json',
};

/** Paths relative to the export's index.html, so it runs under any base path and from a zip. */
export const EXPORT_FILES: Sources = {
  books: () => 'books.json',
  status: () => 'data/status.json',
  accounts: () => 'data/accounts.json',
  workspace: () => 'data/workspace.json',
  filedReturns: (year) => `data/vat-filed-${year}.json`,
  receipt: (id) => `receipts/${id}.pdf`,
  statement: (bank, filename) => `bank-statements/${bank}/${filename}`,
  log: () => 'data/log.json',
  chart: () => 'data/chart.json',
  reviewDecisions: () => 'data/review-decisions.json',
  manifest: () => 'manifest.json',
};

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** EXPORT_FILES as URLs: a file name with a space or a '#' still loads. */
export const EXPORT_SOURCES: Sources = {
  books: () => encodePath(EXPORT_FILES.books()),
  status: () => encodePath(EXPORT_FILES.status()),
  accounts: () => encodePath(EXPORT_FILES.accounts()),
  workspace: () => encodePath(EXPORT_FILES.workspace()),
  filedReturns: (year) => encodePath(EXPORT_FILES.filedReturns(year)),
  receipt: (id) => encodePath(EXPORT_FILES.receipt(id)),
  statement: (bank, filename) => encodePath(EXPORT_FILES.statement(bank, filename)),
  log: () => encodePath(EXPORT_FILES.log()),
  chart: () => encodePath(EXPORT_FILES.chart()),
  reviewDecisions: () => encodePath(EXPORT_FILES.reviewDecisions()),
  manifest: () => encodePath(EXPORT_FILES.manifest()),
};

/** What the export's api/status.json adds to the API's status: when and from what it was made. */
export interface AuditSnapshot {
  createdAt: string;
  booksSchema: number;
  appVersion: string;
  /** A review package (npm run review): the UI edits a copy of the books and records corrections. */
  review?: {
    reviewer: { name: string; email?: string };
    /** The period the owner asks to review, e.g. 2026-Q3. */
    period: string;
    /** The workspace's git commit the package was built from. */
    commit?: string;
  };
}
