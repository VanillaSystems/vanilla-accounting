/**
 * Closing, reopening and correcting a payslip (docs/specs/payroll.md §6.2 step 6, §6.5, §18): what the
 * person is told before («unvollständig», an earlier month still open, an account the chart lacks), the
 * entries a close books inside the write door, and the events that go to payslips.jsonl. A close warns,
 * never blocks; a closed period stays as it is (the caller's assertOpen and the write door). Pure: the
 * files are written by src/payroll/service.ts.
 */
import type { JournalEntry, Receipt } from '../types/index.js';
import type { Books } from '../books/store.js';
import type { PayrollData } from '../core/modules/schema.js';
import { computePayslip, type PayrollContext, type PayslipDraft } from './compute.js';
import { bookingOf, type PayslipBooking } from './booking.js';
import { latestClosed } from './history.js';
import { firmWageTypes } from './catalogue.js';
import type { PayslipClose, PayslipCorrection, PayslipEvent } from './model.js';
import { payslipRef } from './model.js';
import { inOpening, openingOf } from './opening.js';

/** What closing would do that the person should know first; each a fact, none a block. */
export type CloseWarning =
  | { key: 'missing'; wageType: string; label: string; missing: string }
  | { key: 'earlierOpen'; month: string }
  | { key: 'accountMissing'; account: string }
  | { key: 'withoutAccount'; wageType: string }
  /** Entries of the payslip's ref a person booked or changed (after a reopening): closing replaces them with the payslip's. */
  | { key: 'handEntries'; entries: string[] };

export interface ClosePlan {
  draft: PayslipDraft;
  booking: PayslipBooking;
  warnings: CloseWarning[];
}

/** Why a payroll action does not apply; the settings add a malformed input, an entry a closed payslip used, a number that is none, a duplicate. */
export type PayrollRefusalCode = 'notFound' | 'alreadyClosed' | 'notClosed' | 'notLatest' | 'unknownWageType' | 'badAmount' | 'badInput' | 'unknownInsurance' | 'noExpenseAccount' | 'nothingAccrued' | 'noEmail' | 'noPassword' | 'noOutbox' | 'badPassword' | 'used' | 'socialSecurityNumber' | 'iban' | 'exists' | 'gone' | 'closedPeriod' | 'opening';

export class PayrollRefusal extends Error {
  /** `field`: the input it is about, a key of the UI's `payroll.field.*` words. */
  constructor(readonly code: PayrollRefusalCode, message: string, readonly field?: string) { super(message); }
}

/** The plan of closing `employee`'s `month`: the draft, the entries it books, what to say first. */
export function planClose(ctx: PayrollContext, employee: string, month: string, chart: ReadonlySet<string>, books?: Pick<Books, 'journalEntries'>): ClosePlan {
  if (ctx.history.closed.has(`${month}-${employee}`)) throw new PayrollRefusal('alreadyClosed', `Die Lohnabrechnung ${month} ist schon abgeschlossen.`);
  assertNotOpening(ctx, employee, month);
  const draft = computePayslip(ctx, employee, month);
  if (!draft) throw new PayrollRefusal('notFound', `Keine Lohnabrechnung ${month} für ${employee}.`);
  const booking = bookingOf(draft, ctx.data, ctx.store);
  const warnings: CloseWarning[] = [
    ...draft.missing.map((m) => ({ key: 'missing' as const, wageType: m.wageType, label: m.label, missing: m.missing })),
    ...draft.facts.filter((f) => f.key === 'earlierOpen').map((f) => ({ key: 'earlierOpen' as const, month: String(f.vars?.month) })),
    ...booking.withoutAccount.map((w) => ({ key: 'withoutAccount' as const, wageType: w })),
    ...[...new Set(booking.postings.flatMap((p) => [p.debit, p.credit]))].filter((a) => !chart.has(a)).sort().map((account) => ({ key: 'accountMissing' as const, account })),
  ];
  const hand = (books?.journalEntries ?? []).filter((e) => e.transactionRef === booking.ref && !isOwn(e)).map((e) => e.id);
  if (hand.length) warnings.push({ key: 'handEntries', entries: hand });
  return { draft, booking, warnings };
}

/**
 * A month of the person's opening is never closed here (§22 decision 43): its wage was paid and booked by hand
 * before payroll ran in the app, so a payslip would book it a second time. Not a warning: a boundary of the books.
 */
export function assertNotOpening(ctx: Pick<PayrollContext, 'store'>, employee: string, month: string): void {
  const e = ctx.store.employees.find((x) => x.id === employee);
  if (!e || !inOpening(e, month)) return;
  const o = openingOf(e, month.slice(0, 4))!;
  const name = (m: string) => new Intl.DateTimeFormat('de-CH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`));
  throw new PayrollRefusal('opening', `${name(month)} gehört zur Eröffnung (Januar bis ${name(o.through!)}): dieser Lohn ist schon bezahlt und von Hand gebucht, eine Lohnabrechnung würde ihn ein zweites Mal buchen. Ändern lässt sich die Eröffnung bei der Person.`);
}

/** The journal entries of a plan, with ids from `id`: one per posting, on the posting date, by payroll's check, no VAT code. */
export function entriesOf(plan: Pick<ClosePlan, 'booking'>, id: () => string, receiptId?: string): JournalEntry[] {
  return plan.booking.postings.map((p) => ({
    id: id(), transactionRef: plan.booking.ref, date: plan.booking.date,
    accountDebit: p.debit, accountCredit: p.credit, amount: p.amount, description: p.text,
    by: { kind: 'code', check: 'payroll' }, ...(receiptId ? { receipts: [receiptId] } : {}),
  }));
}

/** The receipt record of a payslip's PDF: a document of the firm, its facts known, so no step reads it again or sends it to a model. */
export function payslipReceipt(plan: Pick<ClosePlan, 'draft'>, id: string, filename: string, size: number, now: string): Receipt {
  const d = plan.draft;
  return {
    id, filename, originalFilename: filename, extractedText: `Lohnabrechnung ${d.month}`, extractionMethod: 'pdftotext',
    fileSize: size, indexedAt: now, location: 'archived', date: d.postingDate, description: `Lohnabrechnung ${d.month}`,
    kind: 'payslip', kindBy: 'rule', kindRule: 'payroll', hasSwissVat: false, vatExtractedAt: now,
  };
}

const isOwn = (e: JournalEntry) => e.by?.kind === 'code' && e.by.check === 'payroll';

/**
 * Books a plan into `books` (inside the caller's write door, as the person who confirmed it): every entry
 * the ref holds goes first (code's own left by a close that never got its event, and a person's the warning
 * named), then the plan's entries, its receipt and the receipt's link to the ref. An earlier PDF of the same
 * payslip (kept after a reopening because a payment is linked to it) hands its links to the new one and goes.
 * Returns the receipts taken out, whose files the caller removes when their name differs.
 */
export function applyClose(books: Books, plan: ClosePlan, entries: readonly JournalEntry[], receipt: Receipt): Receipt[] {
  const ref = plan.booking.ref;
  books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== ref);
  const before = books.receipts.filter((r) => r.kind === 'payslip' && r.kindRule === 'payroll' && r.filename === receipt.filename && r.id !== receipt.id);
  const old = new Set(before.map((r) => r.id));
  if (old.size) {
    books.mappings = books.mappings.flatMap((m) => (!old.has(m.receiptId) ? [m] : m.transactionRef === ref ? [] : [{ ...m, receiptId: receipt.id }]));
    for (const e of books.journalEntries) if (e.receipts?.some((r) => old.has(r))) e.receipts = e.receipts.map((r) => (old.has(r) ? receipt.id : r));
    books.receipts = books.receipts.filter((r) => !old.has(r.id));
  }
  books.journalEntries.push(...entries);
  if (!books.receipts.some((r) => r.id === receipt.id)) books.receipts.push(receipt);
  if (!books.mappings.some((m) => m.receiptId === receipt.id && m.transactionRef === ref)) books.mappings.push({ transactionRef: ref, receiptId: receipt.id, by: 'rule', rule: 'payroll' });
  return before;
}

/** The close event of a plan (§9.3): the payslip as it stands from now, with what it used and booked. */
export function closeEventOf(plan: ClosePlan, now: string, receiptId: string, entries: readonly JournalEntry[]): PayslipClose {
  const d = plan.draft;
  return {
    event: 'close', id: d.id, employee: d.employee, month: d.month, postingDate: d.postingDate, payday: d.payday, closedAt: now, closedBy: 'person',
    lines: d.lines, bases: d.bases, gross: d.gross, net: d.net, payout: d.payout, employer: d.employer, ...(d.text ? { text: d.text } : {}),
    left: d.missing, receiptId, entries: entries.map((e) => e.id), used: d.used, person: d.person, ...(d.holidays ? { holidays: d.holidays } : {}),
  };
}

/** Whether `close` may be reopened: the person's latest closed month (the period lock is the caller's). */
export function assertReopenable(ctx: PayrollContext, id: string): PayslipClose {
  const close = ctx.history.closed.get(id);
  if (!close) throw new PayrollRefusal('notClosed', `Die Lohnabrechnung ${id} ist nicht abgeschlossen.`);
  if (latestClosed(ctx.history, close.employee)?.id !== id) {
    throw new PayrollRefusal('notLatest', 'Nur der letzte abgeschlossene Monat lässt sich wieder öffnen; einen früheren korrigiert die Rückwirkende Korrektur im nächsten offenen Monat.');
  }
  return close;
}

/**
 * Takes back what a close booked (inside the caller's write door, as the person): its entries the app
 * booked under the ref and the PDF's link to the ref. An entry a person changed since stays hers (`kept`;
 * closing again names it and replaces it). The PDF goes from Belege (`receipt`, its file the caller's)
 * unless a payment is linked to it: then it stays that payment's proof until the next close replaces it.
 */
export function applyReopen(books: Books, close: PayslipClose): { removed: string[]; kept: string[]; receipt?: Receipt } {
  const ref = payslipRef(close.month, close.employee);
  const own = (e: JournalEntry) => e.transactionRef === ref && isOwn(e);
  const removed = books.journalEntries.filter(own).map((e) => e.id);
  const kept = books.journalEntries.filter((e) => e.transactionRef === ref && !own(e)).map((e) => e.id);
  books.journalEntries = books.journalEntries.filter((e) => !own(e));
  books.mappings = books.mappings.filter((m) => !(m.receiptId === close.receiptId && m.transactionRef === ref));
  const receipt = books.receipts.find((r) => r.id === close.receiptId);
  if (receipt && !books.mappings.some((m) => m.receiptId === receipt.id)) {
    books.receipts = books.receipts.filter((r) => r.id !== receipt.id);
    return { removed, kept, receipt };
  }
  return { removed, kept };
}

export const reopenEventOf = (close: PayslipClose, now: string): PayslipEvent => ({ event: 'reopen', id: close.id, at: now, by: 'person' });

/**
 * A Rückwirkende Korrektur on a closed payslip (§6.5 step 1): a Lohnart and an amount, or a base and a
 * rate difference, on one side. It changes nothing closed; the person's next open month carries it.
 */
export function correctionOf(ctx: PayrollContext, data: PayrollData, of: string, input: { wageType: string; amount?: number; base?: number; rateDiff?: number; text?: string }, id: string, now: string): PayslipCorrection {
  const close = ctx.history.closed.get(of);
  if (!close) throw new PayrollRefusal('notClosed', `Die Lohnabrechnung ${of} ist nicht abgeschlossen: eine Änderung gehört in den offenen Monat.`);
  const w = firmWageTypes(data, ctx.store).get(input.wageType);
  if (!w) throw new PayrollRefusal('unknownWageType', `Lohnart ${input.wageType} gibt es nicht.`);
  const side = w.side ?? 'employee';
  const amount = input.amount ?? (input.base !== undefined && input.rateDiff !== undefined ? Math.round(input.base * input.rateDiff) / 100 : undefined);
  if (amount === undefined || !Number.isFinite(amount) || amount === 0) throw new PayrollRefusal('badAmount', 'Ein Betrag, oder eine Basis und eine Satzdifferenz.');
  return {
    event: 'correction', id, of, wageType: input.wageType, side, amount,
    ...(input.base !== undefined ? { base: input.base } : {}), ...(input.rateDiff !== undefined ? { rateDiff: input.rateDiff } : {}),
    ...(input.text ? { text: input.text } : {}), at: now, by: 'person',
  };
}
