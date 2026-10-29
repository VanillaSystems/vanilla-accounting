/**
 * What a step that works on the books as a whole (the inbox processing) read and what it made, as
 * data the run view words: the files or receipts it had to do, and every receipt it took up or
 * changed, every payment it linked, every entry it booked, each with the facts a person checks.
 * Derived from the books before and after the step, so it says what happened, not what was meant.
 */
import type { Books } from '../books/store.js';
import type { JournalEntry, Receipt } from '../types/index.js';

/** What the step had in front of it. */
export type Took =
  | { kind: 'files'; names: string[] }
  | { kind: 'receipts'; ids: string[]; files: string[] }
  | { kind: 'transactions'; n: number }
  /** Open payments it left alone: they wait for the account's reconciliation (#254); `payment`, `date`: a movement whose statement shows it. */
  | { kind: 'held'; account: string; n: number; payment: string; date: string };

/** One thing it made, with the facts to check it by. */
export type Made =
  | { kind: 'receipt'; id: string; file: string; date?: string; amount?: number; currency?: string; vatId?: string; swissVat?: boolean; changed: string[]; isNew: boolean }
  | { kind: 'link'; receipt: string; receiptFile: string; transaction: string; date?: string; amount?: number; currency?: string; counterparty?: string }
  | { kind: 'entry'; id: string; date: string; debit: string; credit: string; amount: number; vatCode?: string; description?: string };

export interface StepSummary { took: Took[]; made: Made[] }

/** The fields of a receipt a person cares about when it changes; the rest (text, timestamps) is noise here. */
const SEEN: Array<keyof Receipt> = ['filename', 'location', 'date', 'amount', 'currency', 'description', 'vatId', 'hasSwissVat', 'vatSummary'];

export function madeBetween(before: Books, after: Books): Made[] {
  const was = new Map(before.receipts.map((r) => [r.id, r]));
  const made: Made[] = [];
  for (const r of after.receipts) {
    const old = was.get(r.id);
    const changed = old ? SEEN.filter((k) => JSON.stringify(old[k]) !== JSON.stringify(r[k])) : [];
    if (old && !changed.length) continue;
    made.push({
      kind: 'receipt', id: r.id, file: r.filename, isNew: !old, changed: changed as string[],
      ...(r.date ? { date: r.date } : {}), ...(r.amount !== undefined ? { amount: r.amount } : {}), ...(r.currency ? { currency: r.currency } : {}),
      ...(r.vatId ? { vatId: r.vatId } : {}), ...(r.hasSwissVat !== undefined ? { swissVat: r.hasSwissVat } : {}),
    });
  }
  const linked = new Set(before.mappings.map((m) => `${m.transactionRef}:${m.receiptId}`));
  const receipts = new Map(after.receipts.map((r) => [r.id, r]));
  const txs = new Map(after.transactions.map((t) => [t.ref, t]));
  for (const m of after.mappings) {
    if (linked.has(`${m.transactionRef}:${m.receiptId}`)) continue;
    const t = txs.get(m.transactionRef);
    made.push({
      kind: 'link', receipt: m.receiptId, receiptFile: receipts.get(m.receiptId)?.filename ?? m.receiptId, transaction: m.transactionRef,
      ...(t ? { date: t.date, amount: t.direction === 'DBIT' ? -t.amount : t.amount, currency: t.currency, counterparty: t.description } : {}),
    });
  }
  const booked = new Set(before.journalEntries.map((e) => e.id));
  for (const e of after.journalEntries) if (!booked.has(e.id)) made.push(madeEntry(e));
  return made;
}

/** A booking as the run view and the run's digest count it. */
export const madeEntry = (e: JournalEntry): Made => ({
  kind: 'entry', id: e.id, date: e.date, debit: e.accountDebit, credit: e.accountCredit, amount: e.amount,
  ...(e.vatCode ? { vatCode: e.vatCode } : {}), ...(e.description ? { description: e.description } : {}),
});
