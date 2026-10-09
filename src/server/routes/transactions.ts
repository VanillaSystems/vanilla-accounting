import { Router } from 'express';
import type { TransactionPatch } from '../../types/index.js';
import { ask } from '../../llm/ask.js';
import { buildManualTxSuggestPrompt } from '../../llm/prompts.js';
import { CLOSED, assertOpen, refDates, readBooks, withBooks, RequestError, patchBody, stringField } from '../books.js';

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

router.post('/api/transactions/manual/suggest', async (req, res) => {
  const { receiptId } = req.body as { receiptId: string };
  const receipt = readBooks().receipts.find((r) => r.id === receiptId);
  if (!receipt) throw new RequestError(404, 'Receipt not found');

  try {
    const raw = await ask(buildManualTxSuggestPrompt(receipt.extractedText), { step: 'ui/auslage', model: 'sonnet' });
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let result: { date?: string; description?: string; amount?: number; currency?: string } | null = null;
    try { result = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) try { result = JSON.parse(m[0]); } catch {}
    }
    if (!result) throw new Error('Could not parse LLM response');
    res.json({
      date: result.date ?? '',
      description: result.description ?? '',
      amount: result.amount ?? null,
      currency: result.currency ?? 'CHF',
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.post('/api/transactions/manual', (req, res) => {
  const { date, description, amount, currency } = req.body as {
    date: string; description: string; amount: number; currency: string;
  };
  if (!date || !description || amount == null || !currency) {
    throw new RequestError(400, 'date, description, amount, currency are required');
  }

  return withBooks(res, (books) => {
    assertOpen(books, [date], CLOSED.newTransaction);
    const year = date.slice(0, 4);
    // A ref is taken if anything points at it: the Eigenverbrauch rebookings carry
    // M<year>-NNN refs with no transaction behind them, so transactions alone are not enough.
    const taken = [
      ...books.transactions.map((t) => t.ref),
      ...books.journalEntries.map((j) => j.transactionRef),
      ...books.mappings.map((m) => m.transactionRef),
    ].filter((ref) => ref.startsWith(`M${year}-`));
    const maxSeq = taken.reduce((max, ref) => {
      const n = parseInt(ref.slice(6), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
    const ref = `M${year}-${String(maxSeq + 1).padStart(3, '0')}`;

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
    assertOpen(books, refDates(books, ref), CLOSED.editTransaction);

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
      throw new RequestError(400, 'Nur manuelle Transaktionen können gelöscht werden. Banktransaktionen stammen aus dem Kontoauszug (camt053/Wise).');
    }
    assertOpen(books, refDates(books, ref), CLOSED.deleteTransaction);

    books.transactions = books.transactions.filter((t) => t.ref !== ref);
    books.mappings = books.mappings.filter((m) => m.transactionRef !== ref);
    return { ok: true };
  });
});
