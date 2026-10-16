import type { Index } from '../types/index.js';

/** A ref of its own (M2026-004): a manual transaction's, or an entry's that has no payment. */
export const isManualRef = (ref: string): boolean => /^M\d{4}-\d{3,}$/.test(ref);

/**
 * The next free M<year>-NNN, the ref of a manual transaction (an Auslage) or of an entry with no
 * transaction behind it (an Eigenverbrauch rebooking, a year-end accrual). A ref is taken when a
 * transaction, an entry or a mapping names it.
 */
export function nextManualRef(books: Pick<Index, 'transactions' | 'journalEntries' | 'mappings'>, year: string): string {
  const prefix = `M${year}-`;
  const taken = [
    ...books.transactions.map((t) => t.ref),
    ...(books.journalEntries ?? []).map((j) => j.transactionRef),
    ...books.mappings.map((m) => m.transactionRef),
  ].filter((ref) => ref.startsWith(prefix));
  const max = taken.reduce((n, ref) => {
    const seq = parseInt(ref.slice(prefix.length), 10);
    return isNaN(seq) ? n : Math.max(n, seq);
  }, 0);
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}
