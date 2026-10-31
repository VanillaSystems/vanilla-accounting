/**
 * Which answers of the AI sidebar the app makes at once and which it holds for the person's
 * «Übernehmen» (MISSION.md: «shows it plainly, and the person keeps it with one click»; persona
 * round 5, x02). An answer is tried on a copy of the books first (src/server/routes/assistant.ts);
 * the difference, booking by booking, decides:
 *
 * - a fix of one payment's bookings (its split parts included) is made at once, with «Rückgängig»;
 * - bookings of several payments that were booked on different accounts, or of more than
 *   FEW_PAYMENTS payments, are a rebooking of the books, not a fix: held;
 * - more than one booking deleted: held;
 * - a rate code (M81, I81) the answer sets while no receipt of the payment shows Swiss VAT: held,
 *   and the row says so. Input tax without proof is never claimed silently.
 */
import type { Books } from '../books/store.js';
import type { JournalEntry, Receipt } from '../types/index.js';
import type { HeldLine, HeldRow, HoldReason } from '../types/assistant.js';
import { evidenceCheck } from '../accounting/evidence-check.js';

/** More payments than this rebooked in one answer are held even when they were all on one account. */
export const FEW_PAYMENTS = 3;

const lineOf = (e: JournalEntry): HeldLine => ({ accountDebit: e.accountDebit, accountCredit: e.accountCredit, ...(e.vatCode ? { vatCode: e.vatCode } : {}), amount: e.amount });
const same = (a: JournalEntry, b: JournalEntry) => JSON.stringify([lineOf(a), a.date, a.description ?? '']) === JSON.stringify([lineOf(b), b.date, b.description ?? '']);

/** The entry claims input tax at a rate that no linked receipt shows (src/accounting/evidence-check.ts). */
export function withoutProof(books: Books, e: JournalEntry): boolean {
  const ids = new Set(books.mappings.filter((m) => m.transactionRef === e.transactionRef).map((m) => m.receiptId));
  const linked = books.receipts.filter((r): r is Receipt => ids.has(r.id));
  return evidenceCheck(e, linked, books.config.closedThrough)?.kind === 'vatWithoutReceipt';
}

/** Each booking the answer changed, added or deleted, as it was (`before`) and as it is now (`after`). */
export function heldRows(before: Books, after: Books): HeldRow[] {
  const was = new Map(before.journalEntries.map((e) => [e.id, e]));
  const now = new Map(after.journalEntries.map((e) => [e.id, e]));
  const rows: HeldRow[] = [];
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    const b = was.get(id);
    const a = now.get(id);
    if (b && a && same(b, a)) continue;
    const e = (a ?? b)!;
    rows.push({
      entry: id, ref: e.transactionRef, date: e.date, text: e.description || e.transactionRef,
      ...(b ? { before: lineOf(b) } : {}), ...(a ? { after: lineOf(a) } : {}),
      ...(a && withoutProof(after, a) ? { noReceipt: true } : {}),
    });
  }
  return rows.sort((x, y) => x.date.localeCompare(y.date) || x.ref.localeCompare(y.ref));
}

/** Why these rows are not made at once; empty: they are a small fix. */
export function holdReasons(rows: readonly HeldRow[]): HoldReason[] {
  // Rebooked: a booking that stays and changes. A deletion is its own reason, not a rebooking (r7h-26).
  const rebooked = rows.filter((r) => r.before && r.after);
  const payments = new Set(rebooked.map((r) => r.ref));
  const kinds = new Set(rebooked.map((r) => `${r.before!.accountDebit}/${r.before!.accountCredit}`));
  const why: HoldReason[] = [];
  if (payments.size > 1 && (kinds.size > 1 || payments.size > FEW_PAYMENTS)) why.push('payments');
  if (rows.filter((r) => r.before && !r.after).length > 1) why.push('deletes');
  if (rows.some((r) => r.noReceipt && r.after?.vatCode !== r.before?.vatCode)) why.push('rateWithoutReceipt');
  return why;
}
