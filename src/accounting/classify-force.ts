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

/**
 * A receipt leaves the books (deleted, or a drop taken back): its links go, and with them the
 * classifier's entries that saw it, so none claims the receipt's VAT without it. Returns the
 * payments left without an entry: the inbox run's book step books them again.
 */
export function removeReceipt(
  books: { receipts: Receipt[]; mappings: Mapping[]; journalEntries: JournalEntry[]; transactions: ReadonlyArray<{ ref: string }>; config?: { closedThrough?: string } },
  id: string,
): string[] {
  const refs = new Set(books.mappings.filter((m) => m.receiptId === id).map((m) => m.transactionRef));
  books.receipts = books.receipts.filter((r) => r.id !== id);
  books.mappings = books.mappings.filter((m) => m.receiptId !== id);
  const known = new Set(books.transactions.map((t) => t.ref).filter((ref) => refs.has(ref)));
  const stale = new Set(entriesWithoutTheirReceipts(books.journalEntries, books.mappings, known, books.config?.closedThrough));
  books.journalEntries = books.journalEntries.filter((e) => !stale.has(e));
  return [...new Set([...stale].map((e) => e.transactionRef))];
}

/**
 * A person corrected a receipt's VAT facts: the classifier's open-period entries of its payments
 * were booked with the facts it had, so they go, under the rules of --force (a payment with a
 * person's entry, a closed one or a correction stays as it is). Returns the payments left without
 * an entry: the inbox run's book step books them again with the new facts.
 */
export function unbookForNewFacts(
  books: { mappings: Mapping[]; journalEntries: JournalEntry[]; transactions: ReadonlyArray<{ ref: string }>; config?: { closedThrough?: string } },
  id: string,
): string[] {
  const linked = new Set(books.mappings.filter((m) => m.receiptId === id).map((m) => m.transactionRef));
  const refs = new Set(books.transactions.map((t) => t.ref).filter((ref) => linked.has(ref)));
  const stale = new Set(entriesForceMayRemove(books.journalEntries, refs, books.config?.closedThrough));
  books.journalEntries = books.journalEntries.filter((e) => !stale.has(e));
  return [...new Set([...stale].map((e) => e.transactionRef))];
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
