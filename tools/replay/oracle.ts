/**
 * The oracle that plays the person (README.md «The oracle»): what it does to one payment, decided
 * from the app's state and the answer key alone (pure; drive.ts carries the actions out through the
 * app's API), and how each action counts as a touch.
 *
 * Round one, after the app's own runs: it links the receipts the key links and unlinks the others,
 * says «needs no receipt» where the key's payment needs none and the app waits for one, and
 * answers the app's sale question by the key's booking. The app then runs again.
 * Round two: a payment whose lines still differ from the key is booked as the key books it (by hand
 * when the app booked nothing, else in place of the app's lines), and the links are put right again.
 */
import type { BankTransaction, JournalEntry } from '../../src/types/index.js';
import { canonical, compare, type Verdict } from './compare.js';

/** How a person touched a payment. */
export type TouchKind = 'answer' | 'correction' | 'hand' | 'link' | 'noReceipt' | 'private';
export const TOUCH_KINDS: readonly TouchKind[] = ['answer', 'correction', 'hand', 'link', 'noReceipt', 'private'];

/** A payment as the app has it at one moment. */
export interface CaseView {
  ref: string;
  tx?: Pick<BankTransaction, 'noReceiptNeeded' | 'waitsForReceipt'>;
  entries: JournalEntry[];
  receipts: string[];
  /** The app's open question about it, when it asks one. */
  question?: { id: string; topic?: string; choices: string[] };
  /** A run waits for the person on it (a task). */
  task?: boolean;
}

/** The key's side of a payment. */
export interface KeySide {
  tx: Pick<BankTransaction, 'noReceiptNeeded'>;
  entries: JournalEntry[];
  receipts: string[];
}

/**
 * Where the app left a payment after its own runs: booked and right, booked and wrong without
 * saying so (a silent error), asked the person (a question or a task), or left open (no booking,
 * waiting for a receipt or refused).
 */
export type Pass = 'right' | 'wrong' | 'asked' | 'open';

export function passOf(view: CaseView, key: KeySide): { pass: Pass; verdict: Verdict } {
  const verdict = compare(view, key);
  if (view.question || view.task) return { pass: 'asked', verdict };
  if (!view.entries.length) return { pass: 'open', verdict };
  return { pass: verdict.ok ? 'right' : 'wrong', verdict };
}

export type Action =
  | { kind: 'link'; add: string[]; remove: string[] }
  | { kind: 'noReceipt' }
  | { kind: 'answer'; question: string; choice: string }
  | { kind: 'book'; entries: JournalEntry[]; replace: string[] };

export interface Context {
  /** The receipts the replay's books hold: only those can be linked. */
  hasReceipt(id: string): boolean;
  /** The owner's account: a line on it is a private share. */
  owner: string;
  /** The sale question's choice the key's booking means (saleDomestic, saleAbroad, notSale). */
  saleChoice(entries: readonly JournalEntry[]): string;
}

function linkAction(view: CaseView, key: KeySide, ctx: Context): Action[] {
  const add = key.receipts.filter((r) => !view.receipts.includes(r) && ctx.hasReceipt(r));
  const remove = view.receipts.filter((r) => !key.receipts.includes(r));
  return add.length || remove.length ? [{ kind: 'link', add, remove }] : [];
}

/** Round one: links, «needs no receipt», the sale question. */
export function planFirst(view: CaseView, key: KeySide, ctx: Context): Action[] {
  const out = linkAction(view, key, ctx);
  const waits = !view.entries.length && !!view.tx?.waitsForReceipt;
  if (!view.tx?.noReceiptNeeded && (key.tx.noReceiptNeeded || (waits && !key.receipts.length))) out.push({ kind: 'noReceipt' });
  if (view.question && !view.entries.length && view.question.topic === 'saleVat') {
    const choice = ctx.saleChoice(key.entries);
    if (view.question.choices.includes(choice)) out.push({ kind: 'answer', question: view.question.id, choice });
  }
  return out;
}

/** Round two: the booking as the key has it, and the links once more. */
export function planSecond(view: CaseView, key: KeySide, ctx: Context): Action[] {
  const out: Action[] = [];
  if (!compare(view, key).lines) out.push({ kind: 'book', entries: key.entries, replace: view.entries.map((e) => e.id) });
  return [...out, ...linkAction(view, key, ctx)];
}

const onOwner = (entries: readonly JournalEntry[], owner: string) => canonical(entries).some((l) => l.debit === owner || l.credit === owner);

/**
 * The touch an action is, given where the app had left the payment after its own runs (`first`):
 * a booking of a payment the app asked about answers it; one that puts a share on the owner's
 * account the app did not is a private split; else by hand (nothing booked) or a correction.
 */
export function touchOf(action: Action, first: CaseView, now: CaseView, ctx: Context): TouchKind {
  switch (action.kind) {
    case 'link': return 'link';
    case 'noReceipt': return 'noReceipt';
    case 'answer': return 'answer';
    case 'book':
      if (first.question || first.task) return 'answer';
      if (onOwner(action.entries, ctx.owner) && !onOwner(now.entries, ctx.owner)) return 'private';
      return now.entries.length ? 'correction' : 'hand';
  }
}
