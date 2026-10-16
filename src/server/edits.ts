/**
 * The changes a person makes to the books by hand, in one place for the routes and the AI sidebar
 * (src/assistant/): each refuses a filed quarter as the write door would, and returns the change
 * that undoes it. Who made it (Author) is what the booking records as its `by`.
 */
import { randomBytes } from 'node:crypto';
import { periodLock, type Books } from '../books/store.js';
import { isManualRef, nextManualRef } from '../books/refs.js';
import { isFilingKey, parsePeriod } from '../accounting/periods.js';
import { paymentDates, paymentSides, type PaymentSide } from '../accounting/payment-entries.js';
import { baseCurrency, chart, filing } from '../engines/index.js';
import { heldFacts, setVatFacts } from '../accounting/vat-facts.js';
import { unbookPayments } from '../accounting/classify-force.js';
import { codeOnAccount, formTakes, lookupVatCode } from '../accounting/vat-codes.js';
import { withoutInputTax } from '../engines/index.js';
import type { BookedBy, BookingFields, JournalEntry, Receipt } from '../types/index.js';
import type { BookChange, ChangeNote, EntrySet, MadeChange, NewEntry, ReceiptSet } from '../types/assistant.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { offSide, type BookingLine } from '../accounting/manual-booking.js';
import { isVatAmountCode } from '../accounting/validate.js';
import { assertOpen, receiptDates, refDates, RequestError } from './books.js';
import { outsideStatements } from '../accounting/placed-account.js';

function receiptOf(books: Books, id: string): Receipt {
  const r = books.receipts.find((x) => x.id === id);
  if (!r) throw new RequestError(404, 'Receipt not found', { code: 'gone', params: { what: 'receipt' } });
  return r;
}

function entryOf(books: Books, id: string): JournalEntry {
  const e = books.journalEntries.find((x) => x.id === id);
  if (!e) throw new RequestError(404, 'Journal entry not found', { code: 'gone', params: { what: 'entry' } });
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
  if (!books.transactions.some((t) => t.ref === payment)) throw new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
  assertOpen(books, refDates(books, payment), 'mapping');
  if (books.mappings.some((m) => m.transactionRef === payment && m.receiptId === receipt)) return undefined;
  // A link by hand (or by the AI sidebar on the person's wish) says so: Änderungen lists it (r8k-7).
  books.mappings.push({ transactionRef: payment, receiptId: receipt, by: 'human' });
  return { kind: 'unlink', receipt, payment };
}

/**
 * «Privat oder bar bezahlt»: the owner's payment of the receipt, on its date and amount, linked to
 * it, in one write. A receipt a payment already pays (the bank's, or an earlier private one) is
 * refused: a second payment would book the expense and its input tax twice (r7h-23). Returns the
 * new payment's ref; deleting that payment is the whole undo.
 */
export function privatePayment(books: Books, receiptId: string): string {
  const r = receiptOf(books, receiptId);
  const paid = books.mappings.find((m) => m.receiptId === receiptId);
  if (paid) throw new RequestError(409, `Der Beleg ist schon bezahlt: die Zahlung ${paid.transactionRef} ist mit ihm verknüpft. Eine private Auslage dazu würde den Aufwand und die Vorsteuer doppelt buchen.`, { code: 'receiptPaid', params: { receipt: receiptId, payment: paid.transactionRef } });
  if (!r.date || r.amount == null) throw new RequestError(400, 'Für eine Auslage braucht der Beleg Datum und Betrag.');
  assertOpen(books, [r.date], 'newTransaction');
  const ref = nextManualRef(books, r.date.slice(0, 4));
  books.transactions.push({ ref, bank: 'manual', source: 'manual', date: r.date, amount: Math.abs(r.amount), currency: r.currency || baseCurrency(), direction: 'DBIT', description: r.description || r.filename });
  books.mappings.push({ transactionRef: ref, receiptId });
  return ref;
}

export function unlink(books: Books, receipt: string, payment: string): BookChange | undefined {
  assertOpen(books, refDates(books, payment), 'mapping');
  const had = books.mappings.length;
  books.mappings = books.mappings.filter((m) => !(m.transactionRef === payment && m.receiptId === receipt));
  return books.mappings.length < had ? { kind: 'link', receipt, payment } : undefined;
}

/**
 * After links changed by hand (the dialog, the AI sidebar, an undo): the automatic bookings of
 * their payments go, to be booked again from what is linked now (unbookPayments). Returns every
 * touched open payment left without any entry (one that had none before too: a run without a
 * model may have left it so), to book again, and a receipt's file to name the run by.
 */
export function relinked(books: Books, changes: readonly BookChange[]): { payments: string[]; file?: string } {
  const touched = changes.flatMap((c) => (c.kind === 'link' || c.kind === 'unlink' ? [{ receipt: c.receipt, payments: [c.payment] }]
    : c.kind === 'receiptKind' && c.links?.length ? [{ receipt: c.id, payments: c.links }] : []));
  const refs = new Set(touched.flatMap((c) => c.payments));
  if (refs.size) unbookPayments(books, refs, 'links');
  const lock = periodLock(books);
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const payments = books.transactions.filter((t) => refs.has(t.ref) && !booked.has(t.ref) && !lock.isClosed(t.date)).map((t) => t.ref);
  const file = books.receipts.find((r) => touched.some((c) => c.receipt === r.id))?.filename;
  return { payments, ...(file ? { file } : {}) };
}

/** The fields that make a booking what it is: a person who changes one of them decided it (JournalEntry.by). */
const BOOKING_FIELDS = ['accountDebit', 'accountCredit', 'vatCode', 'amount'] as const;

/**
 * Who makes a change to the books: a person by hand, or the AI sidebar on a person's wish, in one
 * of its conversations. Decided where the sidebar's changes are applied (applyAnswer); every
 * other caller is a person.
 */
export type Author = { kind: 'person' } | { kind: 'assistant'; conversation: string };
export const BY_HAND: Author = { kind: 'person' };

/**
 * The `by` a change by `author` gives a booking. The AI changing what the AI changed before keeps
 * the fields as they were before the AI touched them: the booking's `was` stays the decision of
 * whoever booked it first (the rule card judges a draft against it, src/booking/rule-preview.ts).
 */
export function byOf(author: Author, was: BookingFields | undefined, prior: BookedBy | undefined, at = new Date().toISOString()): BookedBy {
  if (author.kind === 'person') return { kind: 'person', at, ...(was ? { was } : {}) };
  const kept = prior?.kind === 'assistant' && prior.was ? { ...was, ...prior.was } : was;
  return { kind: 'assistant', at, conversation: author.conversation, ...(kept && Object.keys(kept).length ? { was: kept } : {}) };
}

/** A booking goes only on accounts the Bilanz or the Erfolgsrechnung shows (x07): 400 in plain words otherwise. */
export function assertPlaced(...accounts: Array<string | undefined>): void {
  for (const a of accounts) {
    const refused = a ? outsideStatements(a) : undefined;
    if (refused) throw new RequestError(400, refused.message, refused.refusal);
  }
}

/**
 * A VAT code a person types, from the UI, the sidebar or a script, is one the firm's form takes
 * (formTakes): a firm not registered books without codes, one on the net tax rate method claims no
 * input tax. 400 in plain words otherwise (r5f-5, r5f-17); the UI says it in the user's language.
 */
export function assertCodeTaken(code: string | undefined): void {
  if (!code || formTakes(code)) return;
  const method = withoutInputTax()!;
  const why = method === 'none'
    ? `Den Steuercode ${code} gibt es in dieser Firma nicht: sie ist nicht steuerpflichtig eingetragen und bucht brutto, ohne Codes.`
    : `Den Steuercode ${code} nimmt das Formular dieser Firma nicht: Einkäufe ohne Code, Verkäufe mit dem Code ihres bewilligten Satzes.`;
  throw new RequestError(400, why, { code: 'codeNotTaken', params: { code, method } });
}

/**
 * The sign a code must carry on this line, when the accounts say so (r7h-22): a purchase code (M,
 * I) on a line that credits an expense is a refund or a supplier's credit note and carries the
 * minus (-M81); a sales code (V) on a line that debits revenue is a customer refund (-V81). The
 * plain code there would claim input tax on money received, or declare turnover on money paid out.
 * Undefined when the accounts give no direction: a correction on one account, a VAT-only leg
 * (M81-2), Bezugsteuer, an export code, two balance-sheet accounts.
 */
export function codeSignFor(code: string | undefined, accountDebit: string | undefined, accountCredit: string | undefined): string | undefined {
  const m = /^(-?)([MIV])(\d+)$/.exec(code ?? '');
  if (!m || !accountDebit || !accountCredit || accountDebit === accountCredit) return undefined;
  const side = m[2] === 'V' ? 'revenue' : 'expense';
  const debit = chart().typeOf(accountDebit) === side;
  const credit = chart().typeOf(accountCredit) === side;
  if (debit === credit) return undefined;
  const back = m[2] === 'V' ? debit : credit;
  return `${back ? '-' : ''}${m[2]}${m[3]}`;
}

export function assertCodeSign(code: string | undefined, accountDebit: string | undefined, accountCredit: string | undefined): void {
  const expected = codeSignFor(code, accountDebit, accountCredit);
  if (!expected || expected === code) return;
  const back = expected.startsWith('-');
  const why = back
    ? `Der Code ${code} passt nicht zu dieser Buchung: hier kommt Geld zurück (eine Gutschrift, eine Rückerstattung), der Code trägt das Minus: ${expected}. Mit ${code} würde die Steuer dazugezählt statt abgezogen.`
    : `Der Code ${code} passt nicht zu dieser Buchung: hier geht Geld hinaus (ein Einkauf) oder kommt Umsatz herein (ein Verkauf), der Code steht ohne Minus: ${expected}.`;
  throw new RequestError(400, why, { code: 'codeSign', params: { code: code!, expected } });
}

/**
 * Soll and Haben on the same account without a VAT code move nothing: refused (r8k-8). With a code
 * it is a VAT-only correction (src/accounting/correction.ts), which keeps both sides on one account.
 */
export function assertTwoSides(accountDebit: string | undefined, accountCredit: string | undefined, vatCode: string | undefined): void {
  if (!accountDebit || accountDebit !== accountCredit || vatCode) return;
  throw new RequestError(400, `Soll und Haben sind dasselbe Konto ${accountDebit}: die Buchung bewegt nichts. Ein Verkauf wird Kasse oder Bank / Umsatz gebucht, ein Einkauf Aufwand / Kasse oder Bank.`, { code: 'sameAccount', params: { account: accountDebit } });
}

export function setEntry(books: Books, id: string, set: EntrySet, author: Author = BY_HAND): BookChange {
  // An undo (it carries `origin`) puts back what was booked; a change goes on placed accounts only, with a code the form takes.
  // The firm's rule comes before the entry's lookup: a block that first changed the receipt's facts has unbooked the entry
  // already, and the person must hear that the code is not the firm's, not that the entry is gone (r6f-8).
  if (set.origin === undefined) { assertPlaced(set.accountDebit, set.accountCredit); assertCodeTaken(set.vatCode); }
  const e = entryOf(books, id);
  assertOpen(books, [e.date, set.date], 'editEntry');
  if (e.origin === 'year-close') throw new RequestError(400, 'Die Kursdifferenz berechnet der Jahresabschluss: npm run year:close bucht sie neu.', { code: 'yearClose' });
  if (set.amount !== undefined && (!Number.isFinite(set.amount) || set.amount === 0)) throw new RequestError(400, 'amount muss eine Zahl ungleich 0 sein.', { code: 'amountZero' });
  const before: EntrySet = { origin: e.origin ?? null };
  if (set.date !== undefined) { before.date = e.date; e.date = set.date; }
  if (set.accountDebit !== undefined) { before.accountDebit = e.accountDebit; e.accountDebit = set.accountDebit; }
  if (set.accountCredit !== undefined) { before.accountCredit = e.accountCredit; e.accountCredit = set.accountCredit; }
  if (set.vatCode !== undefined) { before.vatCode = e.vatCode ?? ''; e.vatCode = set.vatCode || undefined; }
  if (set.origin === undefined && (set.vatCode !== undefined || set.accountDebit !== undefined || set.accountCredit !== undefined)) assertCodeSign(e.vatCode, e.accountDebit, e.accountCredit);
  if (set.description !== undefined) { before.description = e.description ?? ''; e.description = set.description || undefined; }
  if (set.amount !== undefined) { before.amount = e.amount; e.amount = set.amount; }
  // The reason explains the booking as its author made it; once a person changes its accounts, code or amount, she decided it.
  const changed = BOOKING_FIELDS.filter((k) => set[k] !== undefined);
  if (set.reason !== undefined) { if (set.reason) e.reason = set.reason; else delete e.reason; }
  else if (e.reason && changed.length) { before.reason = e.reason; delete e.reason; }
  if (set.by !== undefined) { if (set.by) e.by = set.by; else delete e.by; }
  else if (changed.length) {
    before.by = e.by ?? null;
    // `was` names only what changed: a code set to what it was already is a decision, not a change.
    const moved = changed.filter((k) => (before[k] ?? '') !== (e[k] ?? ''));
    e.by = byOf(author, moved.length ? Object.fromEntries(moved.map((k) => [k, before[k]])) as BookingFields : undefined, before.by ?? undefined);
  }
  if (!e.accountDebit && !e.accountCredit) throw new RequestError(400, 'Soll- oder Habenkonto fehlt.', { code: 'noAccount' });
  if (set.origin === undefined) assertTwoSides(e.accountDebit, e.accountCredit, e.vatCode);
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
  if (corrects && !isFilingKey(corrects, filing().length)) throw new RequestError(400, `corrects: ${filing().length === 'half' ? 'YYYY-Hn' : 'YYYY-Qn'}.`);
  assertOpen(books, [date], 'newEntry');
  // An undo (it carries `id`) puts back what was booked; a new booking moves something.
  if (!id) assertTwoSides(rest.accountDebit, rest.accountCredit, rest.vatCode);
  const closed = books.config.closedThrough;
  if (corrects && !(closed && parsePeriod(corrects, date)!.to <= closed)) throw new RequestError(400, `corrects: ${corrects} ist nicht eingereicht.`);
  if (id && books.journalEntries.some((je) => je.id === id)) throw new RequestError(409, `Buchung ${id} gibt es schon.`);
  // An undo (`id`) puts back what was booked; anything new goes on placed accounts only, with a code the form takes.
  if (!id) { assertPlaced(rest.accountDebit, rest.accountCredit); assertCodeTaken(rest.vatCode); assertCodeSign(rest.vatCode, rest.accountDebit, rest.accountCredit); }
  if (transactionRef) {
    const dates = refDates(books, transactionRef);
    if (!dates.length && !isManualRef(transactionRef)) throw new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
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
  if (!tx) throw new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
  assertOpen(books, refDates(books, ref), 'newEntry');
  if (books.journalEntries.some((e) => e.transactionRef === ref)) throw new RequestError(409, 'Die Zahlung ist gebucht: zuerst ihre Buchung in Buchungen löschen.', { code: 'hasEntries' });
  if (!lines.length) throw new RequestError(400, 'lines: mindestens eine Zeile.');
  for (const l of lines) {
    if (!Number.isFinite(l.amount) || l.amount === 0) throw new RequestError(400, 'amount muss eine Zahl ungleich 0 sein.', { code: 'amountZero' });
    if (!l.description.trim()) throw new RequestError(400, 'description darf nicht leer sein.', { code: 'noDescription' });
    if (l.vatCode && !lookupVatCode(l.vatCode)) throw new RequestError(400, `Den Steuercode ${l.vatCode} gibt es nicht.`, { code: 'unknownVatCode', params: { code: l.vatCode } });
    assertCodeTaken(l.vatCode);
    if (!l.accountDebit !== !l.accountCredit ? !isVatAmountCode(l.vatCode) : !l.accountDebit) throw new RequestError(400, 'Soll- oder Habenkonto fehlt.', { code: 'noAccount' });
    assertPlaced(l.accountDebit, l.accountCredit);
    assertTwoSides(l.accountDebit, l.accountCredit, l.vatCode);
    assertCodeSign(l.vatCode, l.accountDebit, l.accountCredit);
  }
  const off = offSide(books, ref, lines, accounts);
  if (off) throw unbalanced(off);
  const rate = tx.currency === baseCurrency() ? {} : { exchangeCurrency: tx.currency, exchangeRate: fx.daily(tx.currency, tx.date) ?? fx.flat(tx.currency) ?? 1 };
  const receipts = [...new Set(books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId))].sort();
  const at = new Date().toISOString();
  const entries = lines.map((l): JournalEntry => ({
    id: randomBytes(8).toString('hex'), transactionRef: ref, date: tx.date,
    accountDebit: l.accountDebit, accountCredit: l.accountCredit, amount: l.amount,
    ...(l.vatCode && { vatCode: l.vatCode }), description: l.description.trim(), ...rate, origin: 'manual', receipts, by: { kind: 'person', at },
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
  if (!tx) throw new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
  assertOpen(books, refDates(books, ref), 'newEntry');
  if (books.journalEntries.some((e) => e.transactionRef === ref)) throw new RequestError(409, 'Die Zahlung ist gebucht: zuerst ihre Buchung in Buchungen löschen.', { code: 'hasEntries' });
  const entries = books.journalEntries.filter((e) => e.transactionRef === own);
  if (!isManualRef(own) || !entries.length || books.transactions.some((t) => t.ref === own) || books.mappings.some((m) => m.transactionRef === own)) throw new RequestError(404, `${own} ist keine Buchung ohne Zahlung.`);
  assertOpen(books, entries.map((e) => e.date), 'editEntry');
  const off = paymentSides({ transactions: books.transactions, journalEntries: entries.map((e) => ({ ...e, transactionRef: ref })) }, ref, accounts).find((s) => s.booked !== s.paid);
  if (off) throw unbalanced(off);
  const before = entries.map((e) => ({ ...e }));
  const receipts = [...new Set(books.mappings.filter((m) => m.transactionRef === ref).map((m) => m.receiptId))].sort();
  for (const e of entries) Object.assign(e, { transactionRef: ref, date: tx.date, receipts, origin: 'manual', by: { kind: 'person', at: new Date().toISOString() } });
  return before;
}

/** Deletes a booking of the open period; returns it as it was. */
/**
 * A booking a person changed or made by hand put back as the last save holds it (`saved`), or
 * taken out when it was booked since (Änderungen › «Rückgängig», src/saving/changes.ts handEdits).
 * A deleted booking comes back as saved, with its id (r6h-28), only while its payment has no
 * booking it did not have at the deletion (`kept` names what was there then): a rule's split or a
 * hand booking made since stands, and the restore is refused naming it, so the payment is never
 * booked twice and no booking is replaced unseen (r8h-23).
 */
export function restoreSaved(books: Books, id: string, saved: JournalEntry | undefined, kept?: readonly string[]): void {
  if (!saved) { deleteEntry(books, id); return; }
  const e = books.journalEntries.find((x) => x.id === id);
  assertOpen(books, [...(e ? [e.date] : []), saved.date], 'editEntry');
  const since = kept && !e ? books.journalEntries.filter((x) => x.transactionRef === saved.transactionRef && !kept.includes(x.id)) : [];
  if (since.length) {
    const by = since.some((x) => x.origin === 'manual' || x.by?.kind === 'person' || x.by?.kind === 'assistant') ? 'person' : 'app';
    throw new RequestError(409, `Die Zahlung ${saved.transactionRef} ist seit dem Löschen wieder gebucht (${since.length} Buchungen, ${by === 'person' ? 'von Hand' : 'von der App'}): sie bleibt. Zuerst die heutige Buchung in Buchungen löschen.`, { code: 'bookedSince', params: { payment: saved.transactionRef, entries: since.length, by } });
  }
  books.journalEntries = e ? books.journalEntries.map((x) => (x.id === id ? saved : x)) : [...books.journalEntries, saved];
}

export function deleteEntry(books: Books, id: string): JournalEntry {
  const entry = entryOf(books, id);
  assertOpen(books, [entry.date], 'deleteEntry');
  books.journalEntries = books.journalEntries.filter((je) => je.id !== id);
  return entry;
}

/** One change by `author`; its undo, or nothing when it changed nothing (a link that was there already). */
export function applyChange(books: Books, c: BookChange, author: Author = BY_HAND): BookChange | undefined {
  switch (c.kind) {
    case 'receipt': return setReceipt(books, c.id, c.set);
    case 'link': return link(books, c.receipt, c.payment);
    case 'unlink': return unlink(books, c.receipt, c.payment);
    case 'entry': return setEntry(books, c.id, c.set, author);
    // A new booking (not one an undo puts back, which keeps its id and author) is its author's decision.
    case 'newEntry': return { kind: 'deleteEntry', id: addEntry(books, c.entry.id ? c.entry : { ...c.entry, by: byOf(author, undefined, undefined) }).id };
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
  /** The conversation: the bookings it changes record the AI, on the person's wish, as their author. */
  conversation: string;
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
 * An answer of the AI sidebar (src/server/routes/assistant.ts): its changes on the person's wish,
 * recorded as the AI's (Author), all or none, and refusals more than a person's edits get. A booking of a payment it dates keeps the
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
    const undo = applyChange(books, change, { kind: 'assistant', conversation: ctx.conversation });
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
    // A payment left without any booking is unbooked, as a person's «Löschen» leaves it (r5h-36): a task, not a sum that is off.
    if (!books.journalEntries.some((e) => e.transactionRef === ref)) continue;
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
