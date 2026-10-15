import { createHash } from 'node:crypto';
import type { JournalEntry, Mapping, Receipt } from '../types/index.js';

/**
 * The entries `classify --force` may remove so it can book their transactions again.
 *
 * The decision is per transaction, because classify rebooks only a transaction left with
 * no entry at all: removing part of a transaction's entries would lose them for good.
 * A transaction is rebooked only when every entry on it is classify's own work in the
 * open period. One entry that is closed, carries `corrects`, or belongs to another tool
 * keeps the whole transaction as it is. Entries with no bank or manual transaction behind
 * them (SHOPIFY-<n> sales, M-ref Eigenverbrauch, 0535 corrections) are never classify's,
 * since classify can only book a transaction it can see.
 */
export function entriesForceMayRemove(
  entries: readonly JournalEntry[],
  transactionRefs: ReadonlySet<string>,
  closedThrough: string | undefined,
): JournalEntry[] {
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const group = byRef.get(e.transactionRef);
    if (group) group.push(e);
    else byRef.set(e.transactionRef, [e]);
  }
  const removable: JournalEntry[] = [];
  for (const [ref, group] of byRef) {
    if (!transactionRefs.has(ref)) continue;
    if (isRebookShopifyPayout(ref, group)) continue;
    if (group.every((e) => isClassifyOpenEntry(e, closedThrough))) removable.push(...group);
  }
  return removable;
}

/**
 * The classifier's open-period entries of payments whose receipts changed since it booked them: a
 * receipt linked later (or unlinked) is evidence the booking never saw, its VAT above all. Only
 * entries that recorded what they saw take part, under the same rules as --force.
 */
export function entriesWithoutTheirReceipts(
  entries: readonly JournalEntry[],
  mappings: ReadonlyArray<{ transactionRef: string; receiptId: string }>,
  transactionRefs: ReadonlySet<string>,
  closedThrough: string | undefined,
): JournalEntry[] {
  const linked = new Map<string, Set<string>>();
  for (const m of mappings) (linked.get(m.transactionRef) ?? linked.set(m.transactionRef, new Set()).get(m.transactionRef)!).add(m.receiptId);
  const same = (a: readonly string[], b: Set<string> | undefined) => a.length === (b?.size ?? 0) && a.every((id) => b!.has(id));
  const removable = new Set(entriesForceMayRemove(entries, transactionRefs, closedThrough));
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of entries) if (removable.has(e)) (byRef.get(e.transactionRef) ?? byRef.set(e.transactionRef, []).get(e.transactionRef)!).push(e);
  return [...byRef.entries()].flatMap(([ref, group]) =>
    (group.every((e) => e.origin === 'classify' && e.receipts) && !same(group[0].receipts!, linked.get(ref)) ? group : []));
}

type Relinkable = { mappings: Mapping[]; journalEntries: JournalEntry[]; transactions: ReadonlyArray<{ ref: string }>; config?: { closedThrough?: string } };

/**
 * The evidence of these payments changed: the classifier's open-period entries that no longer fit
 * it go at once, and the inbox run's book step books the payments again. Returns the payments left
 * without an entry. Hand bookings, filed quarters, corrections and rebook-shopify payouts stay
 * (entriesForceMayRemove), whichever the change:
 * - 'links': a receipt linked, taken back or deleted. Only entries that recorded the receipts they
 *   saw take part, and only when those differ from what is linked now (entriesWithoutTheirReceipts).
 *   An older entry without that record cannot tell whether it saw the receipt, and a person may
 *   have shaped it before `origin` existed: it stays.
 * - 'facts': a person corrected the VAT facts of a receipt linked to them. Every entry --force may
 *   remove goes, older ones too: whatever it saw, it was booked with the facts as they were.
 */
export function unbookPayments(books: Relinkable, refs: Iterable<string>, changed: 'links' | 'facts'): string[] {
  const want = new Set(refs);
  const known = new Set(books.transactions.map((t) => t.ref).filter((ref) => want.has(ref)));
  const closed = books.config?.closedThrough;
  const stale = new Set(changed === 'links'
    ? entriesWithoutTheirReceipts(books.journalEntries, books.mappings, known, closed)
    : entriesForceMayRemove(books.journalEntries, known, closed));
  books.journalEntries = books.journalEntries.filter((e) => !stale.has(e));
  return [...new Set([...stale].map((e) => e.transactionRef))];
}

/** A receipt leaves the books (deleted, or a drop taken back): its links go, and with them the classifier's entries that saw it. */
export function removeReceipt(books: Relinkable & { receipts: Receipt[] }, id: string): string[] {
  const refs = books.mappings.filter((m) => m.receiptId === id).map((m) => m.transactionRef);
  books.receipts = books.receipts.filter((r) => r.id !== id);
  books.mappings = books.mappings.filter((m) => m.receiptId !== id);
  return unbookPayments(books, refs, 'links');
}

function isClassifyOpenEntry(e: JournalEntry, closedThrough: string | undefined): boolean {
  if (closedThrough && e.date <= closedThrough) return false;
  if (e.corrects) return false;
  // Entries booked before `origin` existed carry none; on a real transaction they are
  // classify's or the API classify route's, as far as the books can tell.
  return e.origin === undefined || e.origin === 'classify';
}

/**
 * rebook-shopify replaces a Stripe payout's entries with per-order sales and gives the
 * payout leg the id sha256("payout|<ref>"). Rebooking such a payout through classify
 * would bring back the aggregated V0 revenue it replaced.
 */
function isRebookShopifyPayout(ref: string, group: readonly JournalEntry[]): boolean {
  const payoutId = createHash('sha256').update(`payout|${ref}`).digest('hex').substring(0, 16);
  return group.some((e) => e.id === payoutId);
}
