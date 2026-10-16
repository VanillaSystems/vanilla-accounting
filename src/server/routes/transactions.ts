import { Router } from 'express';
import type { TransactionPatch } from '../../types/index.js';
import { nextManualRef } from '../../books/refs.js';
import { assertOpen, refDates, withBooks, RequestError, patchBody, stringField, WS } from '../books.js';
import { attachEntries, bookPayment } from '../edits.js';
import { loadFxResolver } from '../../accounting/fx-rates.js';
import type { BookingLine } from '../../accounting/manual-booking.js';

export const router = Router();

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

router.post('/api/transactions/manual', (req, res) => {
  const { date, description, amount, currency } = req.body as {
    date: string; description: string; amount: number; currency: string;
  };
  if (!date || !description || amount == null || !currency) {
    throw new RequestError(400, 'date, description, amount, currency are required');
  }

  return withBooks(res, (books) => {
    assertOpen(books, [date], 'newTransaction');
    const ref = nextManualRef(books, date.slice(0, 4));

    books.transactions.push({
      ref,
      bank: 'manual',
      source: 'manual',
      date,
      amount: Number(amount),
      currency,
      direction: 'DBIT',
      description,
    });
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
    const tx = books.transactions.find((t) => t.ref === ref);
    if (!tx) throw new RequestError(404, 'Transaction not found', { code: 'gone', params: { what: 'payment' } });
    if (tx.source !== 'manual') {
      throw new RequestError(400, 'Nur manuelle Transaktionen können gelöscht werden. Banktransaktionen stammen aus dem Kontoauszug (camt053/Wise).', { code: 'manualOnly' });
    }
    assertOpen(books, refDates(books, ref), 'deleteTransaction');
    // A private payment goes with its bookings and its links: without the payment they book nothing (r7h-23: the undo is one step).
    books.transactions = books.transactions.filter((t) => t.ref !== ref);
    books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== ref);
    books.mappings = books.mappings.filter((m) => m.transactionRef !== ref);
    return { ok: true };
  });
});

/** One line of a booking by hand: accounts, an amount in the payment's currency, a VAT code, a text. */
function bookingLine(raw: unknown): BookingLine {
  const b = patchBody(raw, ['accountDebit', 'accountCredit', 'amount', 'vatCode', 'description']);
  const text = (k: string) => (b[k] === undefined ? '' : stringField(b, k).trim());
  if (typeof b.amount !== 'number') throw new RequestError(400, 'amount muss eine Zahl ungleich 0 sein.');
  const vatCode = text('vatCode');
  return { accountDebit: text('accountDebit'), accountCredit: text('accountCredit'), amount: b.amount, ...(vatCode && { vatCode }), description: text('description') };
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
