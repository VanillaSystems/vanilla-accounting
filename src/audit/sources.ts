/**
 * Every read the UI makes, and where it reads it: from the local API, or from a file of the
 * static audit export (npm run build:audit, docs/audit-export.md). The export writes exactly
 * EXPORT_FILES, so each read of the exported app is a file the export holds.
 */
import { issuedPdfUrl, sentPdfUrl } from '../invoices/model.js';
import { inertExt } from '../core/files.js';

/** What names a receipt's file: its id, and its file name, whose extension the export keeps (a CSV report, an image). */
export interface ReceiptFile { id: string; filename: string }

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
  receipt(r: ReceiptFile): string;
  statement(bank: string, filename: string): string;
  /** The invoicing records as GET /api/invoices serves them: customers, invoices with their view, sent documents (#516). */
  invoices(): string;
  /** An issued invoice's or credit note's PDF, exactly as stored when it was issued. */
  invoicePdf(number: string): string;
  /** A sent document's PDF (a reminder, a notice, a resend), exactly as sent. */
  sentPdf(id: string): string;
  /** A logo an invoice is laid out with, by its path in the workspace. */
  invoiceLogo(path: string): string;
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
  receipt: (r) => `/api/receipts/${r.id}`,
  statement: (bank, filename) => `/bank-statements/${bank}/${encodeURIComponent(filename)}`,
  invoices: () => '/api/invoices',
  invoicePdf: issuedPdfUrl,
  sentPdf: sentPdfUrl,
  invoiceLogo: (path) => `/api/invoice-logo?path=${encodeURIComponent(path)}`,
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
  // With its own extension when that is inert, so a static host serves it with its type; an HTML, SVG or XML file, or one of
  // an unknown type, as `.bin`, never a document that runs script on the export's origin (#523). An export made before kept
  // `.pdf` for every receipt.
  receipt: (r) => `receipts/${r.id}.${inertExt(r.filename)}`,
  // The bank's XML (camt) likewise goes out with `.bin` added: shown as text by the UI, never a document of the export's origin.
  statement: (bank, filename) => `bank-statements/${bank}/${filename}${inertExt(filename) === 'bin' ? '.bin' : ''}`,
  invoices: () => 'data/invoices.json',
  invoicePdf: (number) => `invoices/${number}.pdf`,
  sentPdf: (id) => `invoices/sent/${id}.pdf`,
  invoiceLogo: (path) => `invoice-logos/${path}`,
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
  receipt: (r) => encodePath(EXPORT_FILES.receipt(r)),
  statement: (bank, filename) => encodePath(EXPORT_FILES.statement(bank, filename)),
  invoices: () => encodePath(EXPORT_FILES.invoices()),
  invoicePdf: (number) => encodePath(EXPORT_FILES.invoicePdf(number)),
  sentPdf: (id) => encodePath(EXPORT_FILES.sentPdf(id)),
  invoiceLogo: (path) => encodePath(EXPORT_FILES.invoiceLogo(path)),
};

/** What the export's api/status.json adds to the API's status: when and from what it was made. */
export interface AuditSnapshot {
  createdAt: string;
  booksSchema: number;
  appVersion: string;
  /** The books' content version when the snapshot was made (src/handover/versions.ts): «Prüfmodus · nur Lesen · Version 12». */
  version?: { n: number; at: string; checksum: string };
}
