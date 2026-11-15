/**
 * What a booking sends to POST /api/journal-entries, and the fields an undo of a deletion sends on
 * top (with the entry's `id`) so that the booking comes back as it was, its provenance included:
 * who booked it (`by`), the rule, the reason, the run and the receipts it saw. Without them the
 * booking page said «Claude» of a booking a rule had made (r8f-46). The route takes these fields
 * only with `id`; a new booking is its author's.
 */
import type { JournalEntry } from '../types/index.js';

/** The provenance an undo puts back. */
export const UNDO_FIELDS = ['by', 'rule', 'reason', 'run', 'receipts'] as const;

export type JournalEntryInput = Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'amount'> & { description: string }
  & Partial<Pick<JournalEntry, 'id' | 'transactionRef' | 'vatCode' | 'exchangeCurrency' | 'exchangeRate' | 'corrects' | 'origin' | 'tags' | (typeof UNDO_FIELDS)[number]>>
  /** A correction of a filed entry: the entry it corrects and what was wrong, for its case (r8c-6). */
  & { correctsEntry?: string; correction?: 'vat' | 'account' | 'storno' }
  /** The receipt the booking is for (a late receipt of a filed payment, r10h-6): linked to the new entry, and pointed at the payment corrected. */
  & { receipt?: string }
  /** An undo's: the person's links its deletion took along (DeletedEntry). */
  & { takenLinks?: string[] };

/**
 * A booking as its deletion returns it (src/server/edits.ts deleteEntry). The last entry of a
 * module's booking under a ref of its own takes the links a person or the AI made to that ref along
 * (#524): `takenLinks` names them, apart from the entry's own `receipts` (what the module saw), so
 * the undo links exactly those again and never writes them into the module's booking. Never in the books.
 */
export type DeletedEntry = JournalEntry & { takenLinks?: string[] };

/** A deleted booking as its undo books it again: everything that made it what it was. */
export function undoInput(e: DeletedEntry): JournalEntryInput {
  return {
    id: e.id,
    transactionRef: e.transactionRef,
    date: e.date,
    accountDebit: e.accountDebit,
    accountCredit: e.accountCredit,
    amount: e.amount,
    description: e.description || e.transactionRef,
    ...(e.vatCode && { vatCode: e.vatCode }),
    ...(e.exchangeCurrency && e.exchangeRate !== undefined && { exchangeCurrency: e.exchangeCurrency, exchangeRate: e.exchangeRate }),
    ...(e.corrects && { corrects: e.corrects }),
    ...(e.tags && { tags: e.tags }),
    ...(e.origin && { origin: e.origin }),
    ...(e.by && { by: e.by }),
    ...(e.rule && { rule: e.rule }),
    ...(e.reason && { reason: e.reason }),
    ...(e.run && { run: e.run }),
    ...(e.receipts && { receipts: e.receipts }),
    ...(e.takenLinks?.length && { takenLinks: e.takenLinks }),
  };
}
