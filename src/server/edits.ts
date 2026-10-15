/**
 * The changes a person makes to the books by hand, in one place for the routes and the AI sidebar
 * (src/assistant/): each refuses a filed quarter as the write door would, and returns the change
 * that undoes it.
 */
import { randomBytes } from 'node:crypto';
import { periodLock, type Books } from '../books/store.js';
import { nextManualRef } from '../books/refs.js';
import { isFilingKey, parsePeriod } from '../accounting/periods.js';
import { paymentDates, paymentSides, type PaymentSide } from '../accounting/payment-entries.js';
import { baseCurrency, filing } from '../engines/index.js';
import { heldFacts, setVatFacts } from '../accounting/vat-facts.js';
import { unbookPayments } from '../accounting/classify-force.js';
import type { JournalEntry, Receipt } from '../types/index.js';
import type { BookChange, EntrySet, MadeChange, NewEntry, ReceiptSet } from '../types/assistant.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { offSide, type BookingLine } from '../accounting/manual-booking.js';
import { lookupVatCode } from '../accounting/vat-codes.js';
import { isVatAmountCode } from '../accounting/validate.js';
import { assertOpen, receiptDates, refDates, RequestError } from './books.js';

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
    const { vatBy, ...was } = heldFacts(r);
    before.vat = was;
    if (!vatBy) before.vatBy = null;
    if (setVatFacts(r, set.vat, set.vatBy === null ? null : 'human')) unbookPayments(books, books.mappings.filter((m) => m.receiptId === id).map((m) => m.transactionRef), 'facts');
  }
  return { kind: 'receipt', id, set: before };
}

/** The open payments of these receipts without a booking (new VAT facts took theirs away): the inbox run books them. */
export function unbookedPayments(books: Books, receipts: readonly string[]): string[] {
  const lock = periodLock(books);
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const refs = new Set(books.mappings.filter((m) => receipts.includes(m.receiptId)).map((m) => m.transactionRef));
  return books.transactions.filter((t) => refs.has(t.ref) && !booked.has(t.ref) && !lock.isClosed(t.date)).map((t) => t.ref);
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

/**
 * After links changed by hand (the dialog, the AI sidebar, an undo): the automatic bookings of
 * their payments go, to be booked again from what is linked now (unbookPayments).
 * Returns the payments to book again and a receipt's file to name the run by.
 */
export function relinked(books: Books, changes: readonly BookChange[]): { payments: string[]; file?: string } {
  const links = changes.filter((c): c is Extract<BookChange, { kind: 'link' | 'unlink' }> => c.kind === 'link' || c.kind === 'unlink');
  const payments = links.length ? unbookPayments(books, links.map((c) => c.payment), 'links') : [];
  const file = books.receipts.find((r) => links.some((c) => c.receipt === r.id))?.filename;
  return { payments, ...(file ? { file } : {}) };
}

export function setEntry(books: Books, id: string, set: EntrySet): BookChange {
  const e = entryOf(books, id);
  assertOpen(books, [e.date, set.date], 'editEntry');
  if (e.origin === 'year-close') throw new RequestError(400, 'Die Kursdifferenz berechnet der Jahresabschluss: npm run year:close bucht sie neu.', { code: 'yearClose' });
  if (set.amount !== undefined && (!Number.isFinite(set.amount) || set.amount === 0)) throw new RequestError(400, 'amount muss eine Zahl ungleich 0 sein.');
  const before: EntrySet = { origin: e.origin ?? null };
  if (set.date !== undefined) { before.date = e.date; e.date = set.date; }
  if (set.accountDebit !== undefined) { before.accountDebit = e.accountDebit; e.accountDebit = set.accountDebit; }
  if (set.accountCredit !== undefined) { before.accountCredit = e.accountCredit; e.accountCredit = set.accountCredit; }
  if (set.vatCode !== undefined) { before.vatCode = e.vatCode ?? ''; e.vatCode = set.vatCode || undefined; }
  if (set.description !== undefined) { before.description = e.description ?? ''; e.description = set.description || undefined; }
  if (set.amount !== undefined) { before.amount = e.amount; e.amount = set.amount; }
  const origin = set.origin === undefined ? 'manual' : set.origin;
  if (origin) e.origin = origin;
  else delete e.origin;
  return { kind: 'entry', id, set: before };
}

/** A ref of its own (M2026-004) needs no transaction: a manual entry stands alone. */
const MANUAL_REF = /^M\d{4}-\d{3,}$/;

/**
 * A new booking, dated in the open period. Without `transactionRef` it gets the next free
 * M<year>-NNN; with one it joins that payment's bookings, which must be open too. `corrects` names
 * the filed quarter whose Korrekturabrechnung declares it.
 */
export function addEntry(books: Books, input: NewEntry): JournalEntry {
  const { id, transactionRef, ...rest } = input;
  const { corrects, date } = rest;
  if (corrects && !isFilingKey(corrects, filing().length)) throw new RequestError(400, 'corrects: YYYY-Qn.');
  assertOpen(books, [date], 'newEntry');
  const closed = books.config.closedThrough;
  if (corrects && !(closed && parsePeriod(corrects, date)!.to <= closed)) throw new RequestError(400, `corrects: ${corrects} ist nicht eingereicht.`);
  if (id && books.journalEntries.some((je) => je.id === id)) throw new RequestError(409, `Buchung ${id} gibt es schon.`);
  if (transactionRef) {
    const dates = refDates(books, transactionRef);
    if (!dates.length && !MANUAL_REF.test(transactionRef)) throw new RequestError(404, 'Transaction not found');
    assertOpen(books, dates, 'newEntry');
  }
  const entry: JournalEntry = { id: id ?? randomBytes(8).toString('hex'), transactionRef: transactionRef ?? nextManualRef(books, date.slice(0, 4)), ...rest };
  books.journalEntries.push(entry);
  return entry;
}

/**
 * A payment booked by hand (src/accounting/manual-booking.ts): its lines as a person's entries,
 * each dated on the payment (cash basis), at the ESTV rate of that day when it is foreign, with
 * the receipts linked now, so a later run sees nothing new and keeps them. Refused when the
 * payment is booked already or the lines do not add up to what the bank paid.
 */
export function bookPayment(books: Books, ref: string, lines: readonly BookingLine[], accounts: readonly LedgerBankAccount[], fx: FxResolver): JournalEntry[] {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx) throw new RequestError(404, 'Transaction not found');
  assertOpen(books, refDates(books, ref), 'newEntry');
  if (books.journalEntries.some((e) => e.transactionRef === ref)) throw new RequestError(409, 'Die Zahlung ist gebucht: zuerst ihre Buchung in Buchungen löschen.', { code: 'hasEntries' });
  if (!lines.length) throw new RequestError(400, 'lines: mindestens eine Zeile.');
  for (const l of lines) {
    if (!Number.isFinite(l.amount) || l.amount === 0) throw new RequestError(400, 'amount muss eine Zahl ungleich 0 sein.');
    if (!l.description.trim()) throw new RequestError(400, 'description darf nicht leer sein.');
    if (l.vatCode && !lookupVatCode(l.vatCode)) throw new RequestError(400, `MWST-Code ${l.vatCode} gibt es nicht.`);
    if (!l.accountDebit !== !l.accountCredit ? !isVatAmountCode(l.vatCode) : !l.accountDebit) throw new RequestError(400, 'Soll- oder Habenkonto fehlt.');
  }
  const off = offSide(books, ref, lines, accounts);
  if (off) throw unbalanced(off);
  const rate = tx.currency === baseCurrency() ? {} : { exchangeCurrency: tx.currency, exchangeRate: fx.daily(tx.currency, tx.date) ?? fx.flat(tx.currency) ?? 1 };
  const receipts = [...new Set(books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId))].sort();
  const entries = lines.map((l): JournalEntry => ({
    id: randomBytes(8).toString('hex'), transactionRef: ref, date: tx.date,
    accountDebit: l.accountDebit, accountCredit: l.accountCredit, amount: l.amount,
    ...(l.vatCode && { vatCode: l.vatCode }), description: l.description.trim(), ...rate, origin: 'manual', receipts,
  }));
  books.journalEntries.push(...entries);
  return entries;
}

/** Deletes a booking of the open period; returns it as it was. */
export function deleteEntry(books: Books, id: string): JournalEntry {
  const entry = entryOf(books, id);
  assertOpen(books, [entry.date], 'deleteEntry');
  books.journalEntries = books.journalEntries.filter((je) => je.id !== id);
  return entry;
}

/** One change; its undo, or nothing when it changed nothing (a link that was there already). */
export function applyChange(books: Books, c: BookChange): BookChange | undefined {
  switch (c.kind) {
    case 'receipt': return setReceipt(books, c.id, c.set);
    case 'link': return link(books, c.receipt, c.payment);
    case 'unlink': return unlink(books, c.receipt, c.payment);
    case 'entry': return setEntry(books, c.id, c.set);
    case 'newEntry': return { kind: 'deleteEntry', id: addEntry(books, c.entry).id };
    case 'deleteEntry': return { kind: 'newEntry', entry: deleteEntry(books, c.id) };
  }
}

/** The payment whose bookings a change touches, read before it is applied. */
function paymentOf(books: Books, c: BookChange): string | undefined {
  const ref = c.kind === 'newEntry' ? c.entry.transactionRef
    : c.kind === 'entry' || c.kind === 'deleteEntry' ? books.journalEntries.find((e) => e.id === c.id)?.transactionRef
      : undefined;
  return ref && books.transactions.some((t) => t.ref === ref) ? ref : undefined;
}

const day = (iso: string) => iso.split('-').reverse().join('.');

/** The refusal of bookings that leave a bank side off what the bank paid. */
function unbalanced(off: PaymentSide): RequestError {
  const sign = off.paid < 0 ? -1 : 1;
  const params = { date: off.date, currency: off.currency, paid: Math.abs(off.paid), booked: sign * off.booked };
  return new RequestError(400, `Die Buchungen der Zahlung vom ${day(off.date)} über ${off.currency} ${params.paid.toFixed(2)} ergäben zusammen ${off.currency} ${params.booked.toFixed(2)}: alle Teile müssen zusammen die Zahlung ergeben.`, { code: 'paymentBalance', params });
}

/**
 * An answer of the AI sidebar (src/server/routes/assistant.ts): its changes as a person's, all or
 * none, and two refusals more. A booking of a payment it dates keeps the payment's date (cash basis,
 * src/accounting/payment-entries.ts), and a payment whose bank-side sum it changes still adds up
 * to what the bank paid. A person's hand edits keep their freedom: a split by hand is two edits
 * with a gap between them, and a correction may hang on a payment with a date of its own.
 */
export function applyAnswer(books: Books, changes: BookChange[], accounts: readonly LedgerBankAccount[]): Array<Omit<MadeChange, 'id'>> {
  const payments = new Map<string, string>();
  const dated: string[] = [];
  const made = changes.flatMap((asked): Array<Omit<MadeChange, 'id'>> => {
    const payment = paymentOf(books, asked);
    if (payment && !payments.has(payment)) payments.set(payment, JSON.stringify(paymentSides(books, payment, accounts).map((s) => s.booked)));
    const change = asked.kind === 'newEntry' ? { ...asked, entry: withRate(books, asked.entry) } : asked;
    const undo = applyChange(books, change);
    if (undo?.kind === 'deleteEntry') dated.push(undo.id);
    if (change.kind === 'entry' && change.set.date) dated.push(change.id);
    return undo ? [{ change, undo, ...(payment ? { payment } : {}) }] : [];
  });
  for (const e of books.journalEntries.filter((x) => dated.includes(x.id) && !x.corrects)) {
    const dates = paymentDates(books, e);
    if (dates.length && !dates.includes(e.date)) {
      throw new RequestError(400, `Die Buchung einer Zahlung trägt das Datum der Zahlung (${day(dates[0])}): die Steuer wird nach vereinnahmtem Entgelt abgerechnet, sie gehört ins Quartal der Zahlung.`, { code: 'paymentDate', params: { date: dates[0] } });
    }
  }
  for (const [ref, before] of payments) {
    const sides = paymentSides(books, ref, accounts);
    const off = sides.find((s) => s.booked !== s.paid);
    if (off && JSON.stringify(sides.map((s) => s.booked)) !== before) throw unbalanced(off);
  }
  return made;
}

/** A new booking of a foreign payment takes the exchange rate its other bookings carry. */
function withRate(books: Books, entry: NewEntry): NewEntry {
  const tx = books.transactions.find((t) => t.ref === entry.transactionRef);
  if (!tx || tx.currency === baseCurrency() || entry.exchangeCurrency) return entry;
  const sibling = books.journalEntries.find((e) => e.transactionRef === tx.ref && e.exchangeCurrency);
  return sibling ? { ...entry, exchangeCurrency: sibling.exchangeCurrency, exchangeRate: sibling.exchangeRate } : entry;
}
