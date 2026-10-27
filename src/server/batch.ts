/**
 * One action on several objects (#216): each object's change is the single-object change a person
 * makes by hand (src/server/edits.ts: setReceiptKind, setEntry, bookPayment, the payment's flag),
 * with its own refusals, applied to books loaded once. An object whose change is refused (a filed
 * period above all) is left out with that refusal and leaves the books as they were; the others
 * are done. The answer lists what changed and the undo of all of it, applied the same way.
 */
import type { Books } from '../books/store.js';
import { ClosedPeriodError } from '../books/store.js';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import type { BatchAction, BatchAnswer, BatchChange, BatchLeft, BatchUndo } from '../types/batch.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import type { FxResolver } from '../accounting/fx-rates.js';
import { bookingDraft, inputTaxWithoutReceipt } from '../accounting/manual-booking.js';
import { codeOnAccount, vatCodeOf } from '../accounting/vat-codes.js';
import { assertCodeTaken, assertPlaced, bookPayment, setEntry, setReceiptKind } from './edits.js';
import { assertOpen, refDates, refusalOf, RequestError } from './books.js';

export interface BatchContext { bankAccounts: readonly LedgerBankAccount[]; fx: FxResolver }

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
export function runBatch(books: Books, action: BatchAction, ids: readonly string[], ctx: BatchContext): BatchAnswer {
  const changes: BatchChange[] = [];
  const left: BatchLeft[] = [];
  const undo: BatchUndo[] = [];
  if (action.kind === 'book' || action.kind === 'account') assertPlaced(action.kind === 'book' ? action.account : action.to);
  if (action.kind === 'vatCode' && action.to && !/^-?\d/.test(action.to)) assertCodeTaken(action.to);
  if (action.kind === 'book' && action.vat && !/^-?\d/.test(action.vat)) assertCodeTaken(action.vat);
  let firstClosed: unknown;
  for (const id of new Set(ids)) {
    const before = changes.length;
    const err = one(books, action, id, ctx, changes, undo, left);
    if (err) {
      changes.length = before;
      if (err instanceof ClosedPeriodError && !firstClosed) firstClosed = err;
      left.push(leftOf(id, err));
    }
  }
  if (!changes.length && firstClosed && left.every((l) => l.refusal?.code === 'periodClosed')) throw firstClosed;
  return { changes, left, undo };
}

/** One object's change; its refusal, or undefined when it was done (or left out by `left`). */
function one(books: Books, action: BatchAction, id: string, ctx: BatchContext, changes: BatchChange[], undo: BatchUndo[], left: BatchLeft[]): unknown {
  switch (action.kind) {
    case 'notReceipt': {
      const r = books.receipts.find((x) => x.id === id);
      if (!r) return new RequestError(404, 'Receipt not found', { code: 'gone', params: { what: 'receipt' } });
      if (r.kind === 'noise') { left.push(notFor(id, 'ist schon «kein Beleg»', 'batchUnchanged')); return undefined; }
      const from = r.kind ?? 'invoice';
      return guarded(books, [r], () => {
        const back = setReceiptKind(books, { kind: 'receiptKind', id, as: 'noise' });
        if (back.kind === 'receiptKind') undo.push(back);
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
        undo.push({ kind: 'payment', ref: id, noReceiptNeeded: false });
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

function bookOne(books: Books, tx: BankTransaction, action: Extract<BatchAction, { kind: 'book' }>, ctx: BatchContext, changes: BatchChange[], undo: BatchUndo[], left: BatchLeft[]): unknown {
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
  if (!draft.receipts.length && inputTaxWithoutReceipt(vat.code)) { left.push(notFor(tx.ref, 'ohne Beleg keine Vorsteuer: einzeln buchen und den anderen Nachweis nennen', 'batchNoReceipt')); return undefined; }
  const waits = tx.waitsForPerson;
  return guarded(books, [tx], () => {
    const description = draft.lines[0]?.description || tx.description;
    const made = bookPayment(books, tx.ref, [{ accountDebit, accountCredit, amount: Math.round(amount * 100) / 100, ...(vat.code && { vatCode: vat.code }), description }], ctx.bankAccounts, ctx.fx);
    undo.push({ kind: 'unbook', ref: tx.ref, entries: made.map((e) => e.id), ...(waits ? { waits } : {}) });
    changes.push({ id: tx.ref, field: 'booking', from: '', to: `${accountDebit} / ${accountCredit}${vat.code ? ` ${vat.code}` : ''}` });
  });
}

function entryOne(books: Books, e: JournalEntry, action: Extract<BatchAction, { kind: 'account' | 'vatCode' | 'tag' }>, changes: BatchChange[], undo: BatchUndo[], left: BatchLeft[]): unknown {
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
      if (back.kind === 'entry') undo.push(back);
      changes.push({ id: e.id, field: 'account', from: action.from, to: action.to });
      if (code && code !== was.vatCode) changes.push({ id: e.id, field: 'vatCode', from: was.vatCode, to: code });
    } else if (action.kind === 'vatCode') {
      const typed = vatCodeOf(action.to, e.accountDebit, e.accountCredit);
      if (!typed) throw new RequestError(400, `${action.to} ist weder ein Steuercode noch ein Satz, den die Firma kennt.`, { code: 'unknownVatCode', params: { code: action.to } });
      if (typed.code === was.vatCode) { left.push(notFor(e.id, 'hat diesen Code schon', 'batchUnchanged')); return; }
      const back = setEntry(books, e.id, { vatCode: typed.code });
      if (back.kind === 'entry') undo.push(back);
      changes.push({ id: e.id, field: 'vatCode', from: was.vatCode, to: typed.code });
    } else {
      const now = e.tags?.[action.dimension] ?? '';
      if (now === (action.value ?? '')) { left.push(notFor(e.id, 'trägt diesen Wert schon', 'batchUnchanged')); return; }
      const tags = { ...(e.tags ?? {}) };
      if (action.value) tags[action.dimension] = action.value; else delete tags[action.dimension];
      const back = setEntry(books, e.id, { tags: Object.keys(tags).length ? tags : null });
      if (back.kind === 'entry') undo.push(back);
      changes.push({ id: e.id, field: 'tag', from: now, to: action.value ?? '' });
    }
  });
}

/**
 * A batch taken back: each undo applied as its single change's undo is (setEntry with `origin`,
 * setReceiptKind with the links, the payment's flag, the entries of a booking by hand), all or
 * none: one refusal (a period filed since) refuses the whole undo.
 */
export function undoBatch(books: Books, undos: readonly BatchUndo[]): void {
  for (const u of undos) {
    switch (u.kind) {
      case 'entry': setEntry(books, u.id, u.set); break;
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
