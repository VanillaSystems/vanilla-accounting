/**
 * A file listed as «keine Belege» that a person deletes for good (#228): what makes a receipt such
 * a file, and what in the books still refers to it. Only a file nothing refers to leaves the books;
 * the route (src/server/routes/receipts.ts discard) refuses the rest and names what refers to it.
 */
import type { Index, Receipt } from '../types/index.js';

/** The kinds of document that are not a receipt of their own. */
const NON_RECEIPT_KINDS: ReadonlyArray<Receipt['kind']> = ['supporting', 'statement', 'noise', 'duplicate'];

/** Needs no payment: typed as no receipt, or worth exactly 0 with no VAT and no payment linked (`links`: how many). */
export const isNoReceipt = (r: Receipt, links: number): boolean =>
  NON_RECEIPT_KINDS.includes(r.kind) || (r.amount === 0 && !(r.vatSummary ?? []).some((g) => g.vat > 0) && links === 0);

/** What refers to a receipt: the payments it is linked or pointed to, the bookings that name it, the statements read from its file. */
export interface FileRefs { payments: string[]; entries: string[]; statements: number }

export function refsOf(books: Index, r: Receipt): FileRefs {
  const payments = [...new Set([...books.mappings.filter((m) => m.receiptId === r.id).map((m) => m.transactionRef), ...(r.filedPayment ? [r.filedPayment] : [])])];
  const entries = (books.journalEntries ?? []).filter((e) => e.receipts?.includes(r.id) || e.id === r.importVatDeduction).map((e) => e.id);
  const statements = books.bankStatements.filter((s) => s.filename === r.filename).length
    + (books.statementBalances ?? []).filter((b) => b.sourceFile === r.filename).length;
  return { payments, entries, statements };
}

export const referenced = (refs: FileRefs): boolean => refs.payments.length > 0 || refs.entries.length > 0 || refs.statements > 0;
