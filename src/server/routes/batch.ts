/**
 * Several objects at once (#216, src/server/batch.ts):
 *
 *   POST /api/batch       { action, ids, preview? } → { changes, left, batchId? }: one write as the person;
 *                         a preview runs the same on books it does not save; the undo stays here
 *   POST /api/batch/undo  { batchId } → the batch taken back in one write (409 when an object
 *                         changed since, 404 when the undo is no longer kept)
 *
 * Every object's change refuses a filed period as its single change does (assertOpen in
 * src/server/edits.ts); such an object is left out and named, and a batch of filed objects only
 * is refused (403). Links a receipt set aside took away, and links an undo puts back, book their
 * payments again as the single change does.
 */
import { Router } from 'express';
import { readBooks, RequestError, tagsField, updateBooks, WS } from '../books.js';
import { forgetBatch, keepBatch, keptBatch, runBatch, undoBatch, type BatchStep } from '../batch.js';
import { learnFromCorrection } from '../questions.js';
import { handTaxPoint, relinked } from '../edits.js';
import { loadFxResolver } from '../../accounting/fx-rates.js';
import { BATCH_KINDS, BATCH_MAX, type BatchAction, type BatchAnswer } from '../../types/batch.js';
import type { BookChange } from '../../types/assistant.js';
import { bookAgain } from './automation.js';

export const router = Router();

const text = (v: unknown, key: string): string => {
  if (typeof v !== 'string') throw new RequestError(400, `${key} muss ein Text sein.`);
  return v.trim();
};

function actionOf(raw: unknown): BatchAction {
  const a = (raw ?? {}) as Record<string, unknown>;
  if (!BATCH_KINDS.includes(a.kind as BatchAction['kind'])) throw new RequestError(400, `action.kind: ${BATCH_KINDS.join(', ')}.`);
  switch (a.kind as BatchAction['kind']) {
    case 'notReceipt': return { kind: 'notReceipt' };
    case 'noReceiptNeeded': return { kind: 'noReceiptNeeded' };
    case 'book': {
      const account = text(a.account, 'account');
      if (!account) throw new RequestError(400, 'account: das Konto, auf das gebucht wird.');
      return { kind: 'book', account, vat: text(a.vat ?? '', 'vat') };
    }
    case 'account': {
      const from = text(a.from, 'from');
      const to = text(a.to, 'to');
      if (!from || !to || from === to) throw new RequestError(400, 'from und to: zwei verschiedene Konten.');
      return { kind: 'account', from, to };
    }
    case 'vatCode': return { kind: 'vatCode', to: text(a.to ?? '', 'to') };
    case 'tag': {
      const dimension = text(a.dimension, 'dimension');
      const value = a.value === null || a.value === '' ? null : text(a.value, 'value');
      // The dimension and the value as a booking's tags take them (Firma › Dimensionen, #127).
      tagsField({ [dimension]: value ?? 'x' });
      return { kind: 'tag', dimension, value };
    }
  }
}

function idsOf(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.length || !raw.every((x) => typeof x === 'string' && x)) throw new RequestError(400, 'ids: eine Liste von Ids.');
  if (raw.length > BATCH_MAX) throw new RequestError(400, `Höchstens ${BATCH_MAX} auf einmal, nicht ${raw.length}.`, { code: 'batchLimit', params: { max: BATCH_MAX, n: raw.length } });
  return raw as string[];
}

/** The payments whose links a batch or its undo changed: booked again, as after a link by hand. */
const rebook = (steps: readonly BatchStep[]): Array<Extract<BookChange, { kind: 'receiptKind' }>> =>
  steps.map((s) => s.undo).filter((u): u is Extract<BookChange, { kind: 'receiptKind' }> => u.kind === 'receiptKind' && !!u.links?.length);

/** The payments of entries whose account or code a batch or its undo changed: the sale question follows them, as after a change by hand (r10f-22). */
const corrected = (steps: readonly BatchStep[]): string[] =>
  steps.flatMap((s) => (s.undo.kind === 'entry' && ('vatCode' in s.undo.set || 'accountDebit' in s.undo.set || 'accountCredit' in s.undo.set) ? [s.id] : []));

const refsOf = (entryIds: readonly string[]): string[] => {
  if (!entryIds.length) return [];
  const books = readBooks();
  return entryIds.flatMap((id) => books.journalEntries.find((e) => e.id === id)?.transactionRef ?? []);
};

router.post('/api/batch', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const action = actionOf(b.action);
  const ids = idsOf(b.ids);
  const ctx = { bankAccounts: WS.bankAccounts, fx: loadFxResolver(), point: handTaxPoint(WS) };
  if (b.preview === true) {
    const { changes, left } = runBatch(readBooks(), action, ids, ctx);
    res.json({ changes, left } satisfies BatchAnswer);
    return;
  }
  let again: { payments: string[]; file?: string } = { payments: [] };
  const run = updateBooks((books) => {
    const out = runBatch(books, action, ids, ctx);
    again = relinked(books, rebook(out.steps));
    return out;
  });
  if (again.payments.length) await bookAgain(again.file ?? again.payments[0]);
  const learn = refsOf(corrected(run.steps));
  if (learn.length) learnFromCorrection(learn);
  const batchId = keepBatch(WS.paths.root, run.steps);
  res.json({ changes: run.changes, left: run.left, ...(batchId ? { batchId } : {}) } satisfies BatchAnswer);
});

router.post('/api/batch/undo', async (req, res) => {
  const batchId = (req.body as { batchId?: unknown })?.batchId;
  if (typeof batchId !== 'string' || !batchId) throw new RequestError(400, 'batchId: die Id, die der Sammelauftrag zurückgab.');
  const steps = keptBatch(WS.paths.root, batchId);
  let again: { payments: string[]; file?: string } = { payments: [] };
  updateBooks((books) => {
    undoBatch(books, steps);
    again = relinked(books, rebook(steps));
  });
  forgetBatch(batchId);
  if (again.payments.length) await bookAgain(again.file ?? again.payments[0]);
  const learn = refsOf(corrected(steps));
  if (learn.length) learnFromCorrection(learn);
  res.json({ ok: true });
});
