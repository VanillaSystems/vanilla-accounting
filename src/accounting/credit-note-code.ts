/**
 * A supplier's credit note that comes without its own document but names an invoice already booked
 * takes that invoice's code with the minus (owner's decision 16.10.2026): «Gutschrift GS-1207 zu
 * FM-78230» on an M81 invoice is -M81, so the input tax claimed on the invoice goes back. The receipt
 * rule (no document: the zero code) stays for a credit note that names nothing booked.
 */
import { chart } from '../engines/index.js';
import type { BankTransaction, JournalEntry, Receipt } from '../types/index.js';
import { numbersIn, squash } from './document-numbers.js';

export interface CreditNoteCode {
  /** The invoice's code with the minus: -M81, -I81. */
  code: string;
  /** The invoice's own code, as it was booked. */
  invoiceCode: string;
  /** The invoice number as the payment's text names it. */
  invoice: string;
  receipt: string;
}

type Booked = { receipts: readonly Receipt[]; mappings: ReadonlyArray<{ transactionRef: string; receiptId: string }>; journalEntries: readonly JournalEntry[] };

const PURCHASE = /^[MI]\d+$/;

/**
 * The code of `e`, a line of the money-back payment `tx` that credits an expense with a purchase
 * code, when `tx` has no document of its own and its text names the number of exactly one purchase
 * invoice, booked with one purchase code. Undefined otherwise: the line keeps its code.
 */
export function creditNoteCodeOf(e: Pick<JournalEntry, 'vatCode' | 'accountDebit' | 'accountCredit'>, tx: BankTransaction, documents: readonly Receipt[], books: Booked): CreditNoteCode | undefined {
  if (tx.direction !== 'CRDT' || documents.length || !/^-?[MI]\d+$/.test(e.vatCode ?? '')) return undefined;
  if (chart().typeOf(e.accountCredit) !== 'expense' || chart().typeOf(e.accountDebit) === 'expense') return undefined;
  const text = [tx.description, tx.reference ?? '', tx.remarks ?? '', ...(tx.parts ?? []).map((p) => p.reference ?? '')].join(' ');
  for (const n of numbersIn(text)) {
    const carriers = books.receipts.filter((r) => (r.kind === undefined || r.kind === 'invoice') && numbersIn(r.extractedText ?? '').includes(n));
    if (carriers.length !== 1) continue;
    const [r] = carriers;
    const paid = new Set(books.mappings.filter((m) => m.receiptId === r.id).map((m) => m.transactionRef));
    const codes = new Set(books.journalEntries
      .filter((j) => (paid.has(j.transactionRef) || j.receipts?.includes(r.id)) && PURCHASE.test(j.vatCode ?? '') && chart().typeOf(j.accountDebit) === 'expense')
      .map((j) => j.vatCode!));
    if (codes.size !== 1) continue;
    const [invoiceCode] = codes;
    const invoice = text.split(/[\s,;:()[\]«»"']+/).find((w) => squash(w.replace(/^[-/#]+|[-/#.]+$/g, '')) === n) ?? n;
    return { code: `-${invoiceCode}`, invoiceCode, invoice, receipt: r.id };
  }
  return undefined;
}
