/**
 * One action on several picked objects at once (#216, POST /api/batch): what it is, which objects,
 * and what it did. A batch is the single-object change of each object (src/server/edits.ts) in one
 * write; an object a filed period holds, or one the change refuses, is left out and named, and the
 * rest is done. Its undo stays on the server under the batch's id, taken back in one write (POST
 * /api/batch/undo { batchId }), refused when an object changed since.
 */
import type { ApiRefusal } from './api-error.js';
import type { BookChange } from './assistant.js';
import type { BankTransaction } from './index.js';

export type BatchAction =
  /** Receipts: «kein Beleg», as a person sets a receipt's kind (it pays nothing, its links go). */
  | { kind: 'notReceipt' }
  /** Payments: «braucht keinen Beleg». */
  | { kind: 'noReceiptNeeded' }
  /** Payments without a booking: booked by hand on `account`, `vat` a code or a rate as typed ('' none), the bank on its side. */
  | { kind: 'book'; account: string; vat: string }
  /** Entries: every side on `from` goes to `to`; an input-tax code follows the account (I on costs, M on goods). */
  | { kind: 'account'; from: string; to: string }
  /** Entries: the VAT code, a code or a rate as typed ('' none). */
  | { kind: 'vatCode'; to: string }
  /** Entries: one reporting dimension set (null: taken off). */
  | { kind: 'tag'; dimension: string; value: string | null };

export type BatchKind = BatchAction['kind'];
export const BATCH_KINDS: readonly BatchKind[] = ['notReceipt', 'noReceiptNeeded', 'book', 'account', 'vatCode', 'tag'];

/** At most this many objects in one batch (the selection's limit, src/app/selection/model.ts). */
export const BATCH_MAX = 200;

export interface BatchRequest { action: BatchAction; ids: string[]; preview?: boolean }

/** One field of one object, as it was and as it is (or would be, in a preview). */
export interface BatchChange { id: string; field: 'kind' | 'noReceiptNeeded' | 'booking' | 'account' | 'vatCode' | 'tag'; from: string; to: string }

/** An object left out, with the refusal of its own change. */
export interface BatchLeft { id: string; error: string; refusal?: ApiRefusal }

/** What takes one object's change back (kept on the server, src/server/batch.ts keepBatch). */
export type BatchUndo =
  | Extract<BookChange, { kind: 'entry' } | { kind: 'receiptKind' }>
  | { kind: 'payment'; ref: string; noReceiptNeeded: boolean }
  /** A booking by hand taken back: these entries of the payment go, and it waits for the person again when it did. */
  | { kind: 'unbook'; ref: string; entries: string[]; waits?: NonNullable<BankTransaction['waitsForPerson']> };

/** `batchId` names the undo the server keeps; none when nothing changed, or in a preview. */
export interface BatchAnswer { changes: BatchChange[]; left: BatchLeft[]; batchId?: string }
