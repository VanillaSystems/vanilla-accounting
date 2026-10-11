import { Router } from 'express';
import type { TransactionPatch } from '../../types/index.js';
import { nextManualRef } from '../../books/refs.js';
import { assertOpen, refDates, withBooks, RequestError, patchBody, stringField } from '../books.js';

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
    if (idx === -1) throw new RequestError(404, 'Transaction not found');
    assertOpen(books, refDates(books, ref), 'editTransaction');

    books.transactions[idx] = { ...books.transactions[idx], ...patch };
    return { ok: true, transaction: books.transactions[idx] };
  });
});

router.delete('/api/transactions/:ref', (req, res) => {
  const { ref } = req.params;
  return withBooks(res, (books) => {
    const tx = books.transactions.find((t) => t.ref === ref);
    if (!tx) throw new RequestError(404, 'Transaction not found');
    if (tx.source !== 'manual') {
      throw new RequestError(400, 'Nur manuelle Transaktionen können gelöscht werden. Banktransaktionen stammen aus dem Kontoauszug (camt053/Wise).', { code: 'manualOnly' });
    }
    assertOpen(books, refDates(books, ref), 'deleteTransaction');

    books.transactions = books.transactions.filter((t) => t.ref !== ref);
    books.mappings = books.mappings.filter((m) => m.transactionRef !== ref);
    return { ok: true };
  });
});
