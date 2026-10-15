/**
 * The changes a person makes to the books by hand, in one place for the routes and the AI sidebar
 * (src/assistant/): each refuses a filed quarter as the write door would, and returns the change
 * that undoes it.
 */
import type { Books } from '../books/store.js';
import type { JournalEntry, Receipt } from '../types/index.js';
import type { BookChange, EntrySet, ReceiptSet } from '../types/assistant.js';
import { assertOpen, receiptDates, refDates, RequestError } from './books.js';

const VAT_FACTS = ['hasSwissVat', 'vatSummary', 'vatId'] as const;

function receiptOf(books: Books, id: string): Receipt {
  const r = books.receipts.find((x) => x.id === id);
  if (!r) throw new RequestError(404, 'Receipt not found');
  return r;
}

function entryOf(books: Books, id: string): JournalEntry {
  const e = books.journalEntries.find((x) => x.id === id);
  if (!e) throw new RequestError(404, 'Journal entry not found');
  return e;
}

export function setReceipt(books: Books, id: string, set: ReceiptSet): BookChange {
  const r = receiptOf(books, id);
  assertOpen(books, receiptDates(books, id), 'editReceipt');
  const before: ReceiptSet = {};
  if ('date' in set) { before.date = r.date ?? null; r.date = set.date ?? undefined; }
  if ('amount' in set) { before.amount = r.amount ?? null; before.currency = r.currency; r.amount = set.amount ?? undefined; }
  if ('currency' in set) { before.currency = r.currency; r.currency = set.currency; }
  if ('description' in set) { before.description = r.description ?? ''; r.description = set.description || undefined; }
  if (set.vat) {
    before.vat = Object.fromEntries(VAT_FACTS.map((k) => [k, r[k]]));
    for (const k of VAT_FACTS) delete r[k];
    Object.assign(r, Object.fromEntries(Object.entries(set.vat).filter(([, v]) => v !== undefined)));
  }
  return { kind: 'receipt', id, set: before };
}

export function link(books: Books, receipt: string, payment: string): BookChange | undefined {
  receiptOf(books, receipt);
  if (!books.transactions.some((t) => t.ref === payment)) throw new RequestError(404, 'Transaction not found');
  assertOpen(books, refDates(books, payment), 'mapping');
  if (books.mappings.some((m) => m.transactionRef === payment && m.receiptId === receipt)) return undefined;
  books.mappings.push({ transactionRef: payment, receiptId: receipt });
  return { kind: 'unlink', receipt, payment };
}

export function unlink(books: Books, receipt: string, payment: string): BookChange | undefined {
  assertOpen(books, refDates(books, payment), 'mapping');
  const had = books.mappings.length;
  books.mappings = books.mappings.filter((m) => !(m.transactionRef === payment && m.receiptId === receipt));
  return books.mappings.length < had ? { kind: 'link', receipt, payment } : undefined;
}

export function setEntry(books: Books, id: string, set: EntrySet): BookChange {
  const e = entryOf(books, id);
  assertOpen(books, [e.date, set.date], 'editEntry');
  if (e.origin === 'year-close') throw new RequestError(400, 'Die Kursdifferenz berechnet der Jahresabschluss: npm run year:close bucht sie neu.', { code: 'yearClose' });
  if (set.amount !== undefined && (!Number.isFinite(set.amount) || set.amount === 0)) throw new RequestError(400, 'amount muss eine Zahl ungleich 0 sein.');
  const before: EntrySet = { origin: e.origin };
  if (set.date !== undefined) { before.date = e.date; e.date = set.date; }
  if (set.accountDebit !== undefined) { before.accountDebit = e.accountDebit; e.accountDebit = set.accountDebit; }
  if (set.accountCredit !== undefined) { before.accountCredit = e.accountCredit; e.accountCredit = set.accountCredit; }
  if (set.vatCode !== undefined) { before.vatCode = e.vatCode ?? ''; e.vatCode = set.vatCode || undefined; }
  if (set.description !== undefined) { before.description = e.description ?? ''; e.description = set.description || undefined; }
  if (set.amount !== undefined) { before.amount = e.amount; e.amount = set.amount; }
  e.origin = set.origin ?? 'manual';
  return { kind: 'entry', id, set: before };
}

/** One change; its undo, or nothing when it changed nothing (a link that was there already). */
export function applyChange(books: Books, c: BookChange): BookChange | undefined {
  switch (c.kind) {
    case 'receipt': return setReceipt(books, c.id, c.set);
    case 'link': return link(books, c.receipt, c.payment);
    case 'unlink': return unlink(books, c.receipt, c.payment);
    case 'entry': return setEntry(books, c.id, c.set);
  }
}
