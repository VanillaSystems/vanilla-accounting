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
  /** The ESTV daily sell rates (reference/estv-daily-rates-*.json) the UI checks each foreign entry against. */
  fxRates(): string;
  receipt(id: string): string;
  statement(bank: string, filename: string): string;
}

export const API_SOURCES: Sources = {
  books: () => '/books.json',
  status: () => '/api/status',
  accounts: () => '/api/accounts',
  workspace: () => '/api/workspace',
  filedReturns: (year) => `/api/vat/filed?year=${year}`,
  fxRates: () => '/api/fx-rates',
  receipt: (id) => `/api/receipts/${id}`,
  statement: (bank, filename) => `/bank-statements/${bank}/${encodeURIComponent(filename)}`,
};

/** Paths relative to the export's index.html, so it runs under any base path and from a zip. */
export const EXPORT_FILES: Sources = {
  books: () => 'books.json',
  status: () => 'data/status.json',
  accounts: () => 'data/accounts.json',
  workspace: () => 'data/workspace.json',
  filedReturns: (year) => `data/vat-filed-${year}.json`,
  fxRates: () => 'data/fx-rates.json',
  receipt: (id) => `receipts/${id}.pdf`,
  statement: (bank, filename) => `bank-statements/${bank}/${filename}`,
};

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** EXPORT_FILES as URLs: a file name with a space or a '#' still loads. */
export const EXPORT_SOURCES: Sources = {
  books: () => encodePath(EXPORT_FILES.books()),
  status: () => encodePath(EXPORT_FILES.status()),
  accounts: () => encodePath(EXPORT_FILES.accounts()),
  workspace: () => encodePath(EXPORT_FILES.workspace()),
  filedReturns: (year) => encodePath(EXPORT_FILES.filedReturns(year)),
  fxRates: () => encodePath(EXPORT_FILES.fxRates()),
  receipt: (id) => encodePath(EXPORT_FILES.receipt(id)),
  statement: (bank, filename) => encodePath(EXPORT_FILES.statement(bank, filename)),
};

/** An export for an auditor, or the public read-only demo of a made-up company (--demo). */
export type ExportPurpose = 'audit' | 'demo';

/** What the export's api/status.json adds to the API's status: when, from what and for whom it was made. */
export interface AuditSnapshot {
  purpose: ExportPurpose;
  createdAt: string;
  booksSchema: number;
  appVersion: string;
}
