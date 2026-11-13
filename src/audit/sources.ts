/**
 * Every read the UI makes, and where it reads it: from the local API, or from a file of the
 * static audit export (npm run build:audit, docs/audit-export.md). The export writes exactly
 * EXPORT_FILES, so each read of the exported app is a file the export holds.
 */
export interface Sources {
  books(): string;
  /** The workspace's jurisdiction as the engines use it (modules/ch with its overlay). */
  modules(): string;
  status(): string;
  accounts(): string;
  workspace(): string;
  filedReturns(year: string): string;
  /** The ESTV daily sell rates (reference/estv-daily-rates-*.json) the UI checks each foreign entry against. */
  fxRates(): string;
  /** The order pages of the provider way by receipt id (src/workspace/reads.ts orderPagesIn, #253): the business files decide them, which the UI does not read. */
  orderPages(): string;
  /** The bills that prove a VAT-only correction by receipt id (src/booking/vat-corrections.ts, #190): the business files decide them too. */
  vatCorrections(): string;
  /** What a payment provider's reports leave open (src/booking/provider-issues.ts, #405): held orders, months without the provider's bill. */
  providerIssues(): string;
  receipt(id: string): string;
  statement(bank: string, filename: string): string;
}

export const API_SOURCES: Sources = {
  books: () => '/books.json',
  modules: () => '/modules.json',
  status: () => '/api/status',
  accounts: () => '/api/accounts',
  workspace: () => '/api/workspace',
  filedReturns: (year) => `/api/vat/filed?year=${year}`,
  fxRates: () => '/api/fx-rates',
  orderPages: () => '/api/receipts/order-pages',
  vatCorrections: () => '/api/receipts/vat-corrections',
  providerIssues: () => '/api/receipts/provider-issues',
  receipt: (id) => `/api/receipts/${id}`,
  statement: (bank, filename) => `/bank-statements/${bank}/${encodeURIComponent(filename)}`,
};

/** Paths relative to the export's index.html, so it runs under any base path and from a zip. */
export const EXPORT_FILES: Sources = {
  books: () => 'books.json',
  modules: () => 'modules.json',
  status: () => 'data/status.json',
  accounts: () => 'data/accounts.json',
  workspace: () => 'data/workspace.json',
  filedReturns: (year) => `data/vat-filed-${year}.json`,
  fxRates: () => 'data/fx-rates.json',
  orderPages: () => 'data/order-pages.json',
  vatCorrections: () => 'data/vat-corrections.json',
  providerIssues: () => 'data/provider-issues.json',
  receipt: (id) => `receipts/${id}.pdf`,
  statement: (bank, filename) => `bank-statements/${bank}/${filename}`,
};

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** EXPORT_FILES as URLs: a file name with a space or a '#' still loads. */
export const EXPORT_SOURCES: Sources = {
  books: () => encodePath(EXPORT_FILES.books()),
  modules: () => encodePath(EXPORT_FILES.modules()),
  status: () => encodePath(EXPORT_FILES.status()),
  accounts: () => encodePath(EXPORT_FILES.accounts()),
  workspace: () => encodePath(EXPORT_FILES.workspace()),
  filedReturns: (year) => encodePath(EXPORT_FILES.filedReturns(year)),
  fxRates: () => encodePath(EXPORT_FILES.fxRates()),
  orderPages: () => encodePath(EXPORT_FILES.orderPages()),
  vatCorrections: () => encodePath(EXPORT_FILES.vatCorrections()),
  providerIssues: () => encodePath(EXPORT_FILES.providerIssues()),
  receipt: (id) => encodePath(EXPORT_FILES.receipt(id)),
  statement: (bank, filename) => encodePath(EXPORT_FILES.statement(bank, filename)),
};

/** What the export's api/status.json adds to the API's status: when and from what it was made. */
export interface AuditSnapshot {
  createdAt: string;
  booksSchema: number;
  appVersion: string;
}
