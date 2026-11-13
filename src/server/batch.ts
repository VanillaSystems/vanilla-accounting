/**
 * One action on several objects (#216): each object's change is the single-object change a person
 * makes by hand (src/server/edits.ts: setReceiptKind, setEntry, bookPayment, the payment's flag),
 * with its own refusals, applied to books loaded once. An object whose change is refused (a filed
 * period above all) is left out with that refusal and leaves the books as they were; the others
 * are done. The answer lists what changed; the undo of all of it stays on the server (keepBatch),
 * with what the batch wrote on each object, and the client names it by its id only.
 */
import { randomUUID } from 'node:crypto';
import type { Books } from '../books/store.js';
import { ClosedPeriodError } from '../books/store.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import type { BatchAction, BatchChange, BatchLeft, BatchUndo } from '../types/batch.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { bookingDraft, inputTaxWithoutReceipt } from '../accounting/manual-booking.js';
import { codeOnAccount, vatCodeOf } from '../accounting/vat-codes.js';
import { assertCodeSign, assertCodeTaken, assertPlaced, assertTwoSides, bookPayment, setEntry, setReceiptKind, type HandTaxPoint } from './edits.js';
import { assertOpen, refDates, refusalOf, RequestError } from './books.js';

export interface BatchContext { bankAccounts: readonly LedgerBankAccount[]; fx: FxResolver; point?: HandTaxPoint }

/** One object's undo and what the batch wrote there: an undo over a later change is refused, not written over it. */
export interface BatchStep { id: string; undo: BatchUndo; wrote: string }

/** A batch run: what changed, what was left out, and the steps that take it back. */
export interface BatchRun { changes: BatchChange[]; left: BatchLeft[]; steps: BatchStep[] }

/**
 * Runs `fn` on one object; a refusal puts the books back as they were before it (the arrays and
 * the objects it may change in place) and is returned instead.
 */
function guarded(books: Books, touched: object[], fn: () => void): unknown {
  const arrays = { journalEntries: [...books.journalEntries], transactions: [...books.transactions], mappings: [...books.mappings], receipts: [...books.receipts] };
  const saved = touched.map((o) => [o, structuredClone(o)] as const);
  try {
    fn();
    return undefined;
  } catch (e) {
    Object.assign(books, arrays);
    for (const [o, copy] of saved) {
      for (const k of Object.keys(o)) delete (o as Record<string, unknown>)[k];
      Object.assign(o, copy);
    }
    return e;
  }
}

const leftOf = (id: string, e: unknown): BatchLeft => {
  const refusal = refusalOf(e);
  return { id, error: e instanceof Error ? e.message : String(e), ...(refusal ? { refusal } : {}) };
};

/** An object the action does not apply to (already so, not on the account): left out, said plainly. */
const notFor = (id: string, error: string, code: 'batchUnchanged' | 'batchNotOn' | 'batchBooked' | 'batchNoReceipt', params?: Record<string, string>): BatchLeft =>
  ({ id, error, refusal: { code, ...(params ? { params } : {}) } as BatchLeft['refusal'] });

const sides = (e: JournalEntry) => `${e.accountDebit || '–'} / ${e.accountCredit || '–'}`;

/**
 * The action on every object of `ids`, in one pass over `books`. A refusal the action itself
 * earns for all (a code the firm's form does not take, an account outside the chart) refuses the
 * whole batch before anything changes. When every object is left out for a filed period, that
 * refusal is the answer (403), so a batch of filed objects is refused as their single change is.
 */
export function runBatch(books: Books, action: BatchAction, ids: readonly string[], ctx: BatchContext): BatchRun {
  const changes: BatchChange[] = [];
  const left: BatchLeft[] = [];
  const undo: BatchStep[] = [];
  if (action.kind === 'book' || action.kind === 'account') assertPlaced(action.kind === 'book' ? action.account : action.to);
  if (action.kind === 'vatCode' && action.to && !/^-?\d/.test(action.to)) assertCodeTaken(action.to);
  if (action.kind === 'book' && action.vat && !/^-?\d/.test(action.vat)) assertCodeTaken(action.vat);
  let firstClosed: unknown;
  for (const id of new Set(ids)) {
    const before = changes.length;
    const stepsBefore = undo.length;
    const err = one(books, action, id, ctx, changes, undo, left);
    if (err) {
      changes.length = before;
      undo.length = stepsBefore;
      if (err instanceof ClosedPeriodError && !firstClosed) firstClosed = err;
      left.push(leftOf(id, err));
    }
  }
  if (!changes.length && firstClosed && left.every((l) => l.refusal?.code === 'periodClosed')) throw firstClosed;
  return { changes, left, steps: undo };
}

/** One object's change; its refusal, or undefined when it was done (or left out by `left`). */
function one(books: Books, action: BatchAction, id: string, ctx: BatchContext, changes: BatchChange[], undo: BatchStep[], left: BatchLeft[]): unknown {
  switch (action.kind) {
    case 'notReceipt': {
      const r = books.receipts.find((x) => x.id === id);
      if (!r) return new RequestError(404, 'Receipt not found', { code: 'gone', params: { what: 'receipt' } });
      if (r.kind === 'noise') { left.push(notFor(id, 'ist schon «kein Beleg»', 'batchUnchanged')); return undefined; }
      const from = r.kind ?? 'invoice';
      return guarded(books, [r], () => {
        const back = setReceiptKind(books, { kind: 'receiptKind', id, as: 'noise' });
        if (back.kind === 'receiptKind') undo.push({ id, undo: back, wrote: stateOf(books, back) });
        changes.push({ id, field: 'kind', from, to: 'noise' });
      });
    }
    case 'noReceiptNeeded': {
      const tx = books.transactions.find((t) => t.ref === id);
      if (!tx) return new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
      try { assertOpen(books, refDates(books, id), 'editTransaction'); } catch (err) { return err; }
      if (tx.noReceiptNeeded) { left.push(notFor(id, 'braucht schon keinen Beleg', 'batchUnchanged')); return undefined; }
      return guarded(books, [tx], () => {
        assertOpen(books, refDates(books, id), 'editTransaction');
        tx.noReceiptNeeded = true;
        const back: BatchUndo = { kind: 'payment', ref: id, noReceiptNeeded: false };
        undo.push({ id, undo: back, wrote: stateOf(books, back) });
        changes.push({ id, field: 'noReceiptNeeded', from: 'no', to: 'yes' });
      });
    }
    case 'book': {
      const tx = books.transactions.find((t) => t.ref === id);
      if (!tx) return new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
      return bookOne(books, tx, action, ctx, changes, undo, left);
    }
    case 'account': case 'vatCode': case 'tag': {
      const e = books.journalEntries.find((x) => x.id === id);
      if (!e) return new RequestError(404, 'Journal entry not found', { code: 'gone', params: { what: 'entry' } });
      return entryOne(books, e, action, changes, undo, left);
    }
  }
}

function bookOne(books: Books, tx: BankTransaction, action: Extract<BatchAction, { kind: 'book' }>, ctx: BatchContext, changes: BatchChange[], undo: BatchStep[], left: BatchLeft[]): unknown {
  // A filed payment is refused as its booking by hand is, before whether it is booked at all.
  try { assertOpen(books, refDates(books, tx.ref), 'newEntry'); } catch (e) { return e; }
  const draft = bookingDraft(books, tx.ref, ctx.bankAccounts);
  if (!draft?.bank) return new RequestError(400, 'Das Geldkonto der Zahlung fehlt in der Firma.', { code: 'noAccount' });
  const amount = draft.lines.reduce((s, l) => s + l.amount, 0);
  if (!(amount > 0)) { left.push(notFor(tx.ref, 'ist schon gebucht', 'batchBooked')); return undefined; }
  const accountDebit = draft.bank.side === 'accountDebit' ? draft.bank.account : action.account;
  const accountCredit = draft.bank.side === 'accountCredit' ? draft.bank.account : action.account;
  const vat = vatCodeOf(action.vat, accountDebit, accountCredit);
  if (!vat) return new RequestError(400, `${action.vat} ist weder ein Steuercode noch ein Satz, den die Firma kennt.`, { code: 'unknownVatCode', params: { code: action.vat } });
  // No receipt, no input tax for a batch: a person who has other proof books that payment by hand and names it (#134).
  if (!draft.receipts.length && !tx.inputTaxProof && inputTaxWithoutReceipt(vat.code)) { left.push(notFor(tx.ref, 'ohne Beleg keine Vorsteuer: einzeln buchen und den anderen Nachweis nennen', 'batchNoReceipt')); return undefined; }
  const waits = tx.waitsForPerson;
  return guarded(books, [tx], () => {
    const description = draft.lines[0]?.description || tx.description;
    const made = bookPayment(books, tx.ref, [{ accountDebit, accountCredit, amount: Math.round(amount * 100) / 100, ...(vat.code && { vatCode: vat.code }), description }], ctx.bankAccounts, ctx.fx, undefined, [], {}, ctx.point);
    const back: BatchUndo = { kind: 'unbook', ref: tx.ref, entries: made.map((e) => e.id), ...(waits ? { waits } : {}) };
    undo.push({ id: tx.ref, undo: back, wrote: stateOf(books, back) });
    // What was booked: on the agreed basis a line may sit on its receipt's day over the open item, the payment settling it (#360).
    const line = (e: JournalEntry) => `${e.accountDebit} / ${e.accountCredit}${e.vatCode ? ` ${e.vatCode}` : ''}`;
    const to = made.length === 1 && made[0].date === tx.date ? line(made[0]) : made.map((e) => `${e.date.split('-').reverse().join('.')} ${line(e)}`).join(' · ');
    changes.push({ id: tx.ref, field: 'booking', from: '', to });
  });
}

function entryOne(books: Books, e: JournalEntry, action: Extract<BatchAction, { kind: 'account' | 'vatCode' | 'tag' }>, changes: BatchChange[], undo: BatchStep[], left: BatchLeft[]): unknown {
  // A filed entry is named as filed, before whether the action applies to it.
  try { assertOpen(books, [e.date], 'editEntry'); } catch (err) { return err; }
  if (action.kind === 'account' && e.accountDebit !== action.from && e.accountCredit !== action.from) {
    left.push(notFor(e.id, `steht nicht auf ${action.from}`, 'batchNotOn', { account: action.from }));
    return undefined;
  }
  const was = { sides: sides(e), vatCode: e.vatCode ?? '', tags: e.tags };
  return guarded(books, [e], () => {
    if (action.kind === 'account') {
      const accountDebit = e.accountDebit === action.from ? action.to : e.accountDebit;
      const accountCredit = e.accountCredit === action.from ? action.to : e.accountCredit;
      const code = codeOnAccount(e.vatCode, accountDebit, accountCredit);
      const back = setEntry(books, e.id, { accountDebit, accountCredit, ...(code && code !== e.vatCode ? { vatCode: code } : {}) });
      if (back.kind === 'entry') undo.push({ id: e.id, undo: back, wrote: stateOf(books, back) });
      changes.push({ id: e.id, field: 'account', from: action.from, to: action.to });
      if (code && code !== was.vatCode) changes.push({ id: e.id, field: 'vatCode', from: was.vatCode, to: code });
    } else if (action.kind === 'vatCode') {
      const typed = vatCodeOf(action.to, e.accountDebit, e.accountCredit);
      if (!typed) throw new RequestError(400, `${action.to} ist weder ein Steuercode noch ein Satz, den die Firma kennt.`, { code: 'unknownVatCode', params: { code: action.to } });
      if (typed.code === was.vatCode) { left.push(notFor(e.id, 'hat diesen Code schon', 'batchUnchanged')); return; }
      // No receipt, no input tax, as for a booking by batch: a person with other proof sets it on that entry alone and names it (#134).
      if (inputTaxWithoutReceipt(typed.code) && !proved(books, e)) { left.push(notFor(e.id, 'ohne Beleg keine Vorsteuer: einzeln ändern und den anderen Nachweis nennen', 'batchNoReceipt')); return; }
      const back = setEntry(books, e.id, { vatCode: typed.code });
      if (back.kind === 'entry') undo.push({ id: e.id, undo: back, wrote: stateOf(books, back) });
      changes.push({ id: e.id, field: 'vatCode', from: was.vatCode, to: typed.code });
    } else {
      const now = e.tags?.[action.dimension] ?? '';
      if (now === (action.value ?? '')) { left.push(notFor(e.id, 'trägt diesen Wert schon', 'batchUnchanged')); return; }
      const tags = { ...(e.tags ?? {}) };
      if (action.value) tags[action.dimension] = action.value; else delete tags[action.dimension];
      const back = setEntry(books, e.id, { tags: Object.keys(tags).length ? tags : null });
      if (back.kind === 'entry') undo.push({ id: e.id, undo: back, wrote: stateOf(books, back) });
      changes.push({ id: e.id, field: 'tag', from: now, to: action.value ?? '' });
    }
  });
}

/** A receipt linked to the entry's payment or to the entry, or other proof the person named for the payment (#134). */
function proved(books: Books, e: JournalEntry): boolean {
  if (e.receipts?.length) return true;
  if (!e.transactionRef) return false;
  return books.mappings.some((m) => m.transactionRef === e.transactionRef) || !!books.transactions.find((t) => t.ref === e.transactionRef)?.inputTaxProof;
}

/**
 * What an object now holds of what the batch wrote, as one string: an entry's fields the batch
 * changed with its origin and author, a receipt's kind, a payment's flag, the entries a booking
 * made. Equal before the undo to what it was right after the batch, or someone changed it since.
 */
function stateOf(books: Books, u: BatchUndo): string {
  switch (u.kind) {
    case 'entry': {
      const e = books.journalEntries.find((x) => x.id === u.id);
      if (!e) return 'gone';
      const keys = [...new Set([...Object.keys(u.set), 'origin', 'by'])].sort() as Array<keyof JournalEntry>;
      return JSON.stringify(keys.map((k) => [k, e[k] ?? null]));
    }
    case 'receiptKind': return JSON.stringify(books.receipts.find((r) => r.id === u.id)?.kind ?? 'gone');
    case 'payment': {
      const tx = books.transactions.find((t) => t.ref === u.ref);
      return JSON.stringify(tx ? !!tx.noReceiptNeeded : 'gone');
    }
    case 'unbook': return JSON.stringify(u.entries.map((id) => {
      const e = books.journalEntries.find((x) => x.id === id && x.transactionRef === u.ref);
      return e ? [e.date, e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? null, e.origin ?? null, e.by ?? null, e.tags ?? null] : 'gone';
    }));
  }
}

const KEPT_MAX = 50;
const kept = new Map<string, { root: string; steps: BatchStep[] }>();

/** A batch's undo kept on the server under a new id (the last KEPT_MAX batches); undefined when nothing can be taken back. */
export function keepBatch(root: string, steps: readonly BatchStep[]): string | undefined {
  if (!steps.length) return undefined;
  const id = randomUUID();
  kept.set(id, { root, steps: [...steps] });
  while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
  return id;
}

/** The undo kept for `batchId` in the workspace at `root`, or 404 when there is none (taken back already, another workspace, the app restarted). */
export function keptBatch(root: string, batchId: string): BatchStep[] {
  const k = kept.get(batchId);
  if (!k || k.root !== root) throw new RequestError(404, 'Diesen Sammelauftrag kann die App nicht mehr zurücknehmen.', { code: 'batchUndoGone' });
  return k.steps;
}

/** A batch taken back: its undo is used once. */
export const forgetBatch = (batchId: string): void => { kept.delete(batchId); };

/**
 * A batch taken back: each undo applied as its single change's undo is (setEntry with `origin`,
 * setReceiptKind with the links, the payment's flag, the entries the batch booked), all or none.
 * An object changed since the batch (by the person or a run) refuses the whole undo (409, each
 * named), so the undo never writes over a later change nor takes a later author's name off; a
 * period filed since refuses it too. Every entry put back passes a change by hand's checks.
 */
export function undoBatch(books: Books, steps: readonly BatchStep[]): void {
  const since = steps.filter((s) => stateOf(books, s.undo) !== s.wrote).map((s) => s.id);
  if (since.length) {
    const ids = [...new Set(since)];
    throw new RequestError(409, `Seit dem Sammelauftrag geändert: ${ids.join(', ')}. Diese von Hand zurücksetzen.`, { code: 'batchChangedSince', params: { n: ids.length, ids: ids.slice(0, 5).join(', ') } });
  }
  for (const { undo: u } of steps) {
    switch (u.kind) {
      case 'entry': {
        setEntry(books, u.id, u.set);
        const e = books.journalEntries.find((x) => x.id === u.id)!;
        assertPlaced(e.accountDebit, e.accountCredit);
        assertCodeTaken(e.vatCode);
        assertCodeSign(e.vatCode, e.accountDebit, e.accountCredit);
        assertTwoSides(e.accountDebit, e.accountCredit, e.vatCode);
        break;
      }
      case 'receiptKind': setReceiptKind(books, u); break;
      case 'payment': {
        const tx = books.transactions.find((t) => t.ref === u.ref);
        if (!tx) throw new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
        assertOpen(books, refDates(books, u.ref), 'editTransaction');
        if (u.noReceiptNeeded) tx.noReceiptNeeded = true; else delete tx.noReceiptNeeded;
        break;
      }
      case 'unbook': {
        const gone = books.journalEntries.filter((e) => e.transactionRef === u.ref && u.entries.includes(e.id));
        assertOpen(books, gone.map((e) => e.date), 'deleteEntry');
        books.journalEntries = books.journalEntries.filter((e) => !gone.includes(e));
        const tx = books.transactions.find((t) => t.ref === u.ref);
        if (tx && u.waits) tx.waitsForPerson = u.waits;
        break;
      }
    }
  }
}
