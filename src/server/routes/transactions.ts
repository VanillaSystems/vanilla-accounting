import { Router } from 'express';
import type { BankTransaction, TransactionPatch } from '../../types/index.js';
import type { LedgerBankAccount } from '../../workspace/workspace.js';
import { WorkspaceError, WorkspaceRefusal } from '../../workspace/workspace.js';
import { MONEY_ROLES, type MoneyRole } from '../../workspace/banks.js';
import { patchManifest } from '../../workspace/manifest-write.js';
import { ownerOf } from '../../workspace/money-accounts.js';
import { baseCurrency } from '../../engines/index.js';
import { nextManualRef } from '../../books/refs.js';
import { assertOpen, readBooks, refDates, reopenWorkspace, withBooks, RequestError, patchBody, stringField, tagsField, WS } from '../books.js';
import { assertPlaced, attachEntries, bookPayment, dropPayment } from '../edits.js';
import { accountName, setAccountName } from '../../workspace/accounts-write.js';
import { loadFxResolver } from '../../accounting/fx-rates.js';
import { isIsoDate } from '../../accounting/periods.js';
import type { BookingLine } from '../../accounting/manual-booking.js';

export const router = Router();

/** A manifest change refused: the person's words, never a crash. */
function checkedManifest<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof WorkspaceRefusal) throw new RequestError(400, e.message, e.refusal);
    if (e instanceof WorkspaceError) throw new RequestError(400, e.message);
    throw e;
  }
}

/** A description may not be empty; an empty remark clears it; noReceiptNeeded false clears the flag. */
function parseTransactionPatch(body: unknown): TransactionPatch {
  const b = patchBody(body, ['description', 'remarks', 'noReceiptNeeded']);
  const patch: TransactionPatch = {};
  if ('description' in b) {
    const description = stringField(b, 'description').trim();
    if (!description) throw new RequestError(400, 'description darf nicht leer sein.');
    patch.description = description;
  }
  if ('remarks' in b) patch.remarks = stringField(b, 'remarks') || undefined;
  if ('noReceiptNeeded' in b) {
    if (typeof b.noReceiptNeeded !== 'boolean') throw new RequestError(400, 'noReceiptNeeded muss true oder false sein.');
    patch.noReceiptNeeded = b.noReceiptNeeded || undefined;
  }
  return patch;
}

/**
 * The money account a hand movement moves on (#88): the manifest's account of that ledger number
 * (the owner's when none is named), or, when the manifest lacks it and the request names its role
 * and label, a new one, added with its first movement (accounts appear when first used).
 */
function movementAccount(b: ParsedMovement, currency: string | undefined): LedgerBankAccount {
  const named = b.account ?? ownerOf(WS.bankAccounts)?.account;
  if (!named) throw new RequestError(400, 'account fehlt: die Firma hat kein Inhaberkonto.');
  const known = WS.bankAccounts.filter((a) => a.account === named);
  // The owner's account takes an outlay in any currency (#87), as its `manual` label always has.
  const found = known.find((a) => !currency || a.currency === currency) ?? known.find((a) => a.role === 'owner');
  if (found) return found;
  if (known.length) throw new RequestError(400, `Konto ${named} führt ${known.map((a) => a.currency).join(', ')}, nicht ${currency}.`);
  if (!b.role || !b.label) throw new RequestError(400, `Konto ${named} ist kein Geldkonto der Firma: role und label nennen, dann kommt es mit dieser Bewegung dazu.`);
  const added = { bank: b.label, currency: currency ?? baseCurrency(), account: named, label: b.label, role: b.role };
  // Its ledger account joins the chart under its label when the chart lacks it, where the chart's structure places it (as Firma › Geldkonten adds one).
  const charted = checkedManifest(() => accountName(WS, named)) !== undefined;
  if (!charted) assertPlaced(named);
  checkedManifest(() => patchManifest(WS.paths.manifest, { addBank: added }));
  reopenWorkspace();
  if (!charted) checkedManifest(() => setAccountName(WS, named, added.label));
  return WS.bankAccounts.find((a) => a.account === named && a.currency === added.currency)!;
}

interface ParsedMovement {
  date: string;
  description: string;
  amount: number;
  currency?: string;
  direction: BankTransaction['direction'];
  account?: string;
  role?: MoneyRole;
  label?: string;
}

function parseMovement(body: unknown): ParsedMovement {
  const b = patchBody(body, ['date', 'description', 'amount', 'currency', 'direction', 'account', 'role', 'label']);
  const text = (k: string) => (b[k] === undefined ? undefined : stringField(b, k).trim() || undefined);
  const date = text('date');
  const description = text('description');
  if (!date || !isIsoDate(date) || !description || typeof b.amount !== 'number' || !Number.isFinite(b.amount) || b.amount === 0) {
    throw new RequestError(400, 'date (JJJJ-MM-TT), description und amount (eine Zahl ungleich 0) sind nötig.');
  }
  const direction = (text('direction') ?? 'DBIT') as BankTransaction['direction'];
  if (direction !== 'DBIT' && direction !== 'CRDT') throw new RequestError(400, 'direction ist DBIT (Geld hinaus) oder CRDT (Geld herein).');
  const role = text('role') as MoneyRole | undefined;
  if (role !== undefined && !MONEY_ROLES.includes(role)) throw new RequestError(400, `role ist eines von ${MONEY_ROLES.join(', ')}.`);
  const currency = text('currency')?.toUpperCase();
  return { date, description, amount: b.amount, direction, ...(currency ? { currency } : {}), ...(text('account') ? { account: text('account') } : {}), ...(role ? { role } : {}), ...(text('label') ? { label: text('label') } : {}) };
}

/**
 * A movement made by hand on any money account (#88): a cash purchase, an employee's outlay, a
 * payment on a bank account whose statements are not imported. Without `account` it is the
 * owner's, as before. It is booked like any payment; a statement imported later is matched to it
 * (src/books/bank-import.ts matchStatementRows), never added beside it.
 */
router.post('/api/transactions/manual', (req, res) => {
  const b = parseMovement(req.body);
  assertOpen(readBooks(), [b.date], 'newTransaction');
  const account = movementAccount(b, b.currency);
  return withBooks(res, (books) => {
    assertOpen(books, [b.date], 'newTransaction');
    const ref = nextManualRef(books, b.date.slice(0, 4));
    books.transactions.push({ ref, bank: account.bank, source: 'manual', date: b.date, amount: Math.abs(b.amount), currency: b.currency ?? account.currency, direction: b.direction, description: b.description });
    return { ok: true, ref };
  });
});

router.patch('/api/transactions/:ref', (req, res) => {
  const patch = parseTransactionPatch(req.body);
  const { ref } = req.params;

  return withBooks(res, (books) => {
    const idx = books.transactions.findIndex((t) => t.ref === ref);
    if (idx === -1) throw new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
    assertOpen(books, refDates(books, ref), 'editTransaction');

    books.transactions[idx] = { ...books.transactions[idx], ...patch };
    return { ok: true, transaction: books.transactions[idx] };
  });
});

router.delete('/api/transactions/:ref', (req, res) => {
  const { ref } = req.params;
  return withBooks(res, (books) => {
    dropPayment(books, ref);
    return { ok: true };
  });
});

/** One line of a booking by hand: accounts, an amount in the payment's currency, a VAT code, a text. */
function bookingLine(raw: unknown): BookingLine {
  const b = patchBody(raw, ['accountDebit', 'accountCredit', 'amount', 'vatCode', 'description', 'tags']);
  const text = (k: string) => (b[k] === undefined ? '' : stringField(b, k).trim());
  if (typeof b.amount !== 'number') throw new RequestError(400, 'amount muss eine Zahl ungleich 0 sein.');
  const vatCode = text('vatCode');
  const tags = tagsField(b.tags);
  return { accountDebit: text('accountDebit'), accountCredit: text('accountCredit'), amount: b.amount, ...(vatCode && { vatCode }), description: text('description'), ...(tags && { tags }) };
}

/** A booking typed without its payment, tied to it (src/server/edits.ts attachEntries); answers the entries as they were, for the undo. */
router.post('/api/transactions/:ref/attach', (req, res) => {
  const own = (req.body as { ref?: unknown })?.ref;
  if (typeof own !== 'string' || !own) throw new RequestError(400, 'ref: die Buchung ohne Zahlung (M2026-004).');
  return withBooks(res, (books) => ({ before: attachEntries(books, req.params.ref, own, WS.bankAccounts) }));
});

/** A payment booked by hand, in one or more lines that add up to it (src/server/edits.ts bookPayment). */
router.post('/api/transactions/:ref/entries', (req, res) => {
  const lines = (req.body as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) throw new RequestError(400, 'lines: eine Liste von Zeilen.');
  const parsed = lines.map(bookingLine);
  return withBooks(res, (books) => ({ entries: bookPayment(books, req.params.ref, parsed, WS.bankAccounts, loadFxResolver()) }));
});
