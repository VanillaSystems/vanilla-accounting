/**
 * The changes a person makes to the books by hand, in one place for the routes and the AI sidebar
 * (src/assistant/): each refuses a filed quarter as the write door would, and returns the change
 * that undoes it.
 */
import { randomBytes } from 'node:crypto';
import { periodLock, type Books } from '../books/store.js';
import { isManualRef, nextManualRef } from '../books/refs.js';
import { isFilingKey, parsePeriod } from '../accounting/periods.js';
import { paymentDates, paymentSides, type PaymentSide } from '../accounting/payment-entries.js';
import { baseCurrency, filing } from '../engines/index.js';
import { heldFacts, setVatFacts } from '../accounting/vat-facts.js';
import { unbookPayments } from '../accounting/classify-force.js';
import { codeOnAccount } from '../accounting/vat-codes.js';
import type { JournalEntry, Receipt } from '../types/index.js';
import type { BookChange, ChangeNote, EntrySet, MadeChange, NewEntry, ReceiptSet } from '../types/assistant.js';
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
  if ('date' in set) { before.date = r.date ?? null; r.date = set.date || undefined; delete r.dateSource; }
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

/** Kinds that take a receipt out of the books' evidence: it pays nothing, so its links go. */
const SET_ASIDE = new Set<Receipt['kind']>(['duplicate', 'noise']);

/**
 * A receipt's kind as a person sets it («ist dasselbe», Belege' kind): a duplicate or noise loses
 * its links, so it never pays a second time nor claims its input tax twice (the payments are
 * booked again, src/server/routes/assistant.ts). The undo puts the kind and the links back.
 */
export function setReceiptKind(books: Books, c: Extract<BookChange, { kind: 'receiptKind' }>): BookChange {
  const r = receiptOf(books, c.id);
  assertOpen(books, receiptDates(books, c.id), 'editReceipt');
  const before: Extract<BookChange, { kind: 'receiptKind' }> = { kind: 'receiptKind', id: c.id, as: r.kind ?? null, by: r.kindBy ?? null, rule: r.kindRule ?? null };
  const by = c.by === undefined ? (c.as ? 'human' : null) : c.by;
  if (c.as) r.kind = c.as; else delete r.kind;
  if (by) r.kindBy = by; else delete r.kindBy;
  if (c.rule) r.kindRule = c.rule; else delete r.kindRule;
  if (c.as && SET_ASIDE.has(c.as)) {
    const links = books.mappings.filter((m) => m.receiptId === c.id).map((m) => m.transactionRef);
    for (const ref of links) assertOpen(books, refDates(books, ref), 'mapping');
    books.mappings = books.mappings.filter((m) => m.receiptId !== c.id);
    if (links.length) before.links = links;
  }
  for (const ref of c.links ?? []) if (books.transactions.some((t) => t.ref === ref)) link(books, c.id, ref);
  return before;
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
  const touched = changes.flatMap((c) => (c.kind === 'link' || c.kind === 'unlink' ? [{ receipt: c.receipt, payments: [c.payment] }]
    : c.kind === 'receiptKind' && c.links?.length ? [{ receipt: c.id, payments: c.links }] : []));
  const payments = touched.length ? unbookPayments(books, touched.flatMap((c) => c.payments), 'links') : [];
  const file = books.receipts.find((r) => touched.some((c) => c.receipt === r.id))?.filename;
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
  // The classifier's reason explains the booking it made; once its accounts, code or amount change, it no longer does.
  if (set.reason !== undefined) { if (set.reason) e.reason = set.reason; else delete e.reason; }
  else if (e.reason && (['accountDebit', 'accountCredit', 'vatCode', 'amount'] as const).some((k) => k in set)) { before.reason = e.reason; delete e.reason; }
  if (!e.accountDebit && !e.accountCredit) throw new RequestError(400, 'Soll- oder Habenkonto fehlt.');
  if (set.receipts !== undefined) {
    const unknown = set.receipts.find((id) => !books.receipts.some((r) => r.id === id));
    if (unknown) throw new RequestError(400, `receipts: Beleg ${unknown} gibt es nicht.`);
    before.receipts = e.receipts;
    e.receipts = set.receipts;
  }
  const origin = set.origin === undefined ? 'manual' : set.origin;
  if (origin) e.origin = origin;
  else delete e.origin;
  return { kind: 'entry', id, set: before };
}


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
    if (!dates.length && !isManualRef(transactionRef)) throw new RequestError(404, 'Transaction not found');
    assertOpen(books, dates, 'newEntry');
  }
  const entry: JournalEntry = { id: id ?? randomBytes(8).toString('hex'), transactionRef: transactionRef ?? nextManualRef(books, date.slice(0, 4)), ...rest };
  books.journalEntries.push(entry);
  return entry;
}

/**
 * A payment booked by hand (src/accounting/manual-booking.ts): its lines as a person's entries,
 * each dated on the payment (cash basis), at the official rate of that day when it is foreign, with
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
    if (l.vatCode && !lookupVatCode(l.vatCode)) throw new RequestError(400, `Den Steuercode ${l.vatCode} gibt es nicht.`);
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

/**
 * A person's booking typed without its payment (Buchungen › N, ref M2026-004) tied to the payment
 * it books (manual-booking.ts unattachedFor): its entries take the payment's ref and date (cash
 * basis) and record the receipts linked now, so the payment counts as booked and no run books it
 * again. Refused when the payment is booked already, the ref is no such booking, or its entries do
 * not add up to what the bank paid. Returns the entries as they were, for the undo.
 */
export function attachEntries(books: Books, ref: string, own: string, accounts: readonly LedgerBankAccount[]): JournalEntry[] {
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx) throw new RequestError(404, 'Transaction not found');
  assertOpen(books, refDates(books, ref), 'newEntry');
  if (books.journalEntries.some((e) => e.transactionRef === ref)) throw new RequestError(409, 'Die Zahlung ist gebucht: zuerst ihre Buchung in Buchungen löschen.', { code: 'hasEntries' });
  const entries = books.journalEntries.filter((e) => e.transactionRef === own);
  if (!isManualRef(own) || !entries.length || books.transactions.some((t) => t.ref === own) || books.mappings.some((m) => m.transactionRef === own)) throw new RequestError(404, `${own} ist keine Buchung ohne Zahlung.`);
  assertOpen(books, entries.map((e) => e.date), 'editEntry');
  const off = paymentSides({ transactions: books.transactions, journalEntries: entries.map((e) => ({ ...e, transactionRef: ref })) }, ref, accounts).find((s) => s.booked !== s.paid);
  if (off) throw unbalanced(off);
  const before = entries.map((e) => ({ ...e }));
  const receipts = [...new Set(books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId))].sort();
  for (const e of entries) Object.assign(e, { transactionRef: ref, date: tx.date, receipts, origin: 'manual' });
  return before;
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
    case 'receiptKind': return setReceiptKind(books, c);
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

/** What an answer's changes are checked against beside the books. */
export interface AnswerContext {
  bankAccounts: readonly LedgerBankAccount[];
  /** The chart's account numbers; empty: the workspace keeps no chart, nothing to check. */
  chart: ReadonlySet<string>;
  /** The changes earlier answers of the conversation made and that stand. */
  earlier: readonly MadeChange[];
}

/** The fields a change sets, without who set them. */
const fields = (set: EntrySet) => Object.entries(set).filter(([k]) => k !== 'origin');

/** An earlier change of the conversation that `c` takes back: its undo is what `c` asks for. */
function takesBack(c: BookChange, earlier: readonly MadeChange[]): MadeChange | undefined {
  return earlier.find((m) => {
    const u = m.undo;
    if (!u || m.undone || u.kind !== c.kind) return false;
    if (c.kind === 'link' || c.kind === 'unlink') return u.kind === c.kind && u.receipt === c.receipt && u.payment === c.payment;
    if (c.kind === 'receiptKind') return u.kind === 'receiptKind' && u.id === c.id && (u.as ?? null) === c.as;
    if (c.kind === 'entry' && u.kind === 'entry' && u.id === c.id) {
      const asked = fields(c.set);
      return asked.length > 0 && asked.every(([k, v]) => k in u.set && (u.set as Record<string, unknown>)[k] === v);
    }
    return false;
  });
}

/**
 * An answer of the AI sidebar (src/server/routes/assistant.ts): its changes as a person's, all or
 * none, and refusals more than a person's edits get. A booking of a payment it dates keeps the
 * payment's date (cash basis, src/accounting/payment-entries.ts), and a payment whose bank-side
 * sum it changes still adds up to what the bank paid. A booking goes only on an account of the
 * chart (one the same answer adds counts: it is added first). A purchase code follows the
 * account it lands on (codeOnAccount), and the card says so. It never takes back a change an
 * earlier answer made (that change's «Rückgängig» does), nor links a receipt a person set aside
 * as a duplicate or noise. A person's hand edits keep their freedom: a split by hand is two edits
 * with a gap between them, and a correction may hang on a payment with a date of its own.
 */
export function applyAnswer(books: Books, changes: BookChange[], ctx: AnswerContext): Array<Omit<MadeChange, 'id'>> {
  const payments = new Map<string, string>();
  const dated: string[] = [];
  const accounts = new Set<string>();
  const made = changes.flatMap((asked): Array<Omit<MadeChange, 'id'>> => {
    const back = takesBack(asked, ctx.earlier);
    if (back) throw new RequestError(400, 'Das nähme eine frühere Änderung dieses Gesprächs zurück: dafür gibt es bei ihr «Rückgängig».', { code: 'takesBack' });
    if (asked.kind === 'link') {
      const r = books.receipts.find((x) => x.id === asked.receipt);
      if (r?.kindBy === 'human' && SET_ASIDE.has(r.kind)) throw new RequestError(400, `${r.description || r.filename} ist als ${r.kind === 'duplicate' ? 'Doppel' : 'kein Beleg'} beiseitegelegt und wird nicht verknüpft.`, { code: 'setAside', params: { receipt: r.description || r.filename } });
    }
    const payment = paymentOf(books, asked);
    if (payment && !payments.has(payment)) payments.set(payment, JSON.stringify(paymentSides(books, payment, ctx.bankAccounts).map((s) => s.booked)));
    let note: ChangeNote | undefined;
    let change: BookChange = asked;
    if (asked.kind === 'newEntry') {
      const entry = withRate(books, asked.entry);
      const to = codeOnAccount(entry.vatCode, entry.accountDebit, entry.accountCredit);
      if (to && to !== entry.vatCode) note = { vatFollowed: { from: entry.vatCode!, to } };
      change = { ...asked, entry: { ...entry, ...(to ? { vatCode: to } : {}) } };
    }
    const was = asked.kind === 'entry' ? books.journalEntries.find((e) => e.id === asked.id)?.vatCode ?? '' : undefined;
    const undo = applyChange(books, change);
    if (asked.kind === 'entry' && undo?.kind === 'entry' && ['accountDebit', 'accountCredit', 'vatCode'].some((k) => k in asked.set)) {
      const e = entryOf(books, asked.id);
      const to = codeOnAccount(e.vatCode, e.accountDebit, e.accountCredit);
      if (to && to !== e.vatCode) {
        note = { vatFollowed: { from: e.vatCode!, to } };
        e.vatCode = to;
        change = { ...asked, set: { ...asked.set, vatCode: to } };
        if (!('vatCode' in undo.set)) undo.set.vatCode = was;
      }
    }
    // A side left empty is for a VAT entry alone (M81-2); a VAT-only correction keeps both sides on the same account.
    const shaped = change.kind === 'newEntry' ? change.entry : change.kind === 'entry' ? entryOf(books, change.id) : undefined;
    if (shaped && !shaped.accountDebit !== !shaped.accountCredit && !isVatAmountCode(shaped.vatCode)) {
      const own = shaped.accountDebit || shaped.accountCredit;
      throw new RequestError(400, `Soll und Haben gehören beide hin. Nur die Steuer korrigieren: ${own} auf beiden Seiten (${own}/${own} mit dem umgekehrten Code), die Bank bleibt.`, { code: 'oneSided', params: { account: own } });
    }
    if (undo?.kind === 'deleteEntry') dated.push(undo.id);
    if (change.kind === 'entry' && change.set.date) dated.push(change.id);
    const set = change.kind === 'newEntry' ? change.entry : change.kind === 'entry' ? change.set : {};
    for (const a of [set.accountDebit, set.accountCredit]) if (a) accounts.add(a);
    return undo ? [{ change, undo, ...(payment ? { payment } : {}), ...(note ? { note } : {}) }] : [];
  });
  const unknown = ctx.chart.size ? [...accounts].find((a) => !ctx.chart.has(a)) : undefined;
  if (unknown) throw new RequestError(400, `Konto ${unknown} gibt es im Kontenplan nicht: zuerst das Konto anlegen, in derselben Antwort.`, { code: 'unknownAccount', params: { account: unknown } });
  for (const e of books.journalEntries.filter((x) => dated.includes(x.id) && !x.corrects)) {
    const dates = paymentDates(books, e);
    if (dates.length && !dates.includes(e.date)) {
      throw new RequestError(400, `Die Buchung einer Zahlung trägt das Datum der Zahlung (${day(dates[0])}): die Steuer wird nach vereinnahmtem Entgelt abgerechnet, sie gehört ins Quartal der Zahlung.`, { code: 'paymentDate', params: { date: dates[0] } });
    }
  }
  for (const [ref, before] of payments) {
    const sides = paymentSides(books, ref, ctx.bankAccounts);
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
