import { Router } from 'express';
import { renameSync, existsSync, unlinkSync, createReadStream } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { RECEIPT_KINDS, type Receipt, type ReceiptKind, type ReceiptPatch } from '../../types/index.js';
import { ask } from '../../llm/ask.js';
import { buildVisionPrompt } from '../../llm/prompts.js';
import { findFile } from '../../workspace/workspace.js';
import { WS, receiptPath, assertOpen, receiptDates, readBooks, withBooks, RequestError, patchBody, stringField } from '../books.js';

export const router = Router();

/** An empty description or remark clears it; null clears a date, an amount or a kind. */
function parseReceiptPatch(body: unknown): ReceiptPatch {
  const b = patchBody(body, ['filename', 'date', 'amount', 'currency', 'description', 'remarks', 'kind']);
  const patch: ReceiptPatch = {};
  if ('filename' in b) {
    const filename = stringField(b, 'filename').trim();
    if (!filename || filename !== basename(filename) || filename.startsWith('.')) {
      throw new RequestError(400, 'filename muss ein Dateiname ohne Pfad sein.');
    }
    patch.filename = filename;
  }
  if ('date' in b) {
    if (b.date === null) patch.date = null;
    else {
      const date = stringField(b, 'date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RequestError(400, 'date muss JJJJ-MM-TT sein.');
      patch.date = date;
    }
  }
  if (b.amount === null) {
    if ('currency' in b) throw new RequestError(400, 'amount und currency nur zusammen.');
    patch.amount = null;
  } else {
    if ('amount' in b !== 'currency' in b) throw new RequestError(400, 'amount und currency nur zusammen.');
    if ('amount' in b) {
      if (typeof b.amount !== 'number' || !Number.isFinite(b.amount)) throw new RequestError(400, 'amount muss eine Zahl sein.');
      const currency = stringField(b, 'currency').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new RequestError(400, 'currency muss ein ISO-Code sein (z.B. CHF).');
      patch.amount = b.amount;
      patch.currency = currency;
    }
  }
  if ('description' in b) patch.description = stringField(b, 'description') || undefined;
  if ('remarks' in b) patch.remarks = stringField(b, 'remarks') || undefined;
  if ('kind' in b) {
    if (b.kind !== null && !RECEIPT_KINDS.includes(b.kind as ReceiptKind)) throw new RequestError(400, `kind muss eines von ${RECEIPT_KINDS.join(', ')} sein.`);
    patch.kind = b.kind as ReceiptKind | null;
  }
  return patch;
}

/** The receipt with the patch applied: null removes a field, a kind is a person's. */
function patched(receipt: Receipt, { date, amount, kind, ...rest }: ReceiptPatch): Receipt {
  const out: Receipt = { ...receipt, ...rest };
  if (date !== undefined) out.date = date ?? undefined;
  if (amount !== undefined) out.amount = amount ?? undefined;
  if (kind !== undefined) {
    out.kind = kind ?? undefined;
    out.kindBy = kind ? 'human' : undefined;
    out.kindRule = undefined;
  }
  return out;
}

router.get('/api/receipts/:id', (req, res) => {
  const books = readBooks();
  const receipt = books.receipts.find((r) => r.id === req.params.id);
  if (!receipt) throw new RequestError(404, 'Receipt not found');

  const pdfPath = receiptPath(books, receipt);
  if (!existsSync(pdfPath)) throw new RequestError(404, 'File not found on disk');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(receipt.filename)}"`);
  createReadStream(pdfPath).pipe(res);
});

router.delete('/api/receipts/:id', (req, res) => {
  const { id } = req.params;
  let pdfPath = '';
  withBooks(res, (books) => {
    const idx = books.receipts.findIndex((r) => r.id === id);
    if (idx === -1) throw new RequestError(404, 'Receipt not found');
    assertOpen(books, receiptDates(books, id), 'deleteReceipt');

    pdfPath = receiptPath(books, books.receipts[idx]);
    books.receipts.splice(idx, 1);
    books.mappings = books.mappings.filter((m) => m.receiptId !== id);
    return { ok: true };
  });
  try { unlinkSync(pdfPath); } catch {}
});

/**
 * OCR of a receipt PDF by the model. Only called when the user explicitly approves via the UI.
 * The model reads the PDF first; the text is then saved to books loaded after it answered.
 */
router.post('/api/vision/extract', async (req, res) => {
  const { receiptId } = req.body as { receiptId: string };
  const books = readBooks();
  const receipt = books.receipts.find((r) => r.id === receiptId);
  if (!receipt) throw new RequestError(404, 'Receipt not found');
  assertOpen(books, receiptDates(books, receiptId), 'editReceipt');

  const pdfPath = receiptPath(books, receipt);
  if (!existsSync(pdfPath)) throw new RequestError(404, 'PDF file not found on disk');

  const text = await ask(buildVisionPrompt(pdfPath), {
    step: 'receipt-intake.guide.yaml#vision', model: 'sonnet', timeoutMs: 120_000, read: [dirname(pdfPath)],
  });
  withBooks(res, (books) => {
    const receipt = books.receipts.find((r) => r.id === receiptId);
    if (!receipt) throw new RequestError(404, 'Receipt not found');
    assertOpen(books, receiptDates(books, receiptId), 'editReceipt');
    receipt.extractedText = text;
    receipt.extractionMethod = 'claude';
    receipt.needsVisionReview = undefined;
    return { ok: true, extractedText: text };
  });
});

// One edit of a receipt is one write: every field is validated before anything changes, and
// a file rename is undone if the books are not saved, so a receipt is never half-edited.
router.patch('/api/receipts/:id', (req, res) => {
  const patch = parseReceiptPatch(req.body);
  const { id } = req.params;
  let undoRename = () => {};
  try {
    withBooks(res, (books) => {
      const idx = books.receipts.findIndex((r) => r.id === id);
      if (idx === -1) throw new RequestError(404, 'Receipt not found');
      assertOpen(books, receiptDates(books, id), 'editReceipt');

      const receipt = books.receipts[idx];
      if (patch.filename !== undefined) undoRename = renameReceiptFile(receiptPath(books, receipt), patch.filename);
      books.receipts[idx] = patched(receipt, patch);
      return { ok: true, receipt: books.receipts[idx] };
    });
  } catch (err) {
    undoRename();
    throw err;
  }
});

/** Renames the receipt's PDF on disk (a missing file is left alone) and returns the undo. A name another year folder holds is a clash too. */
function renameReceiptFile(from: string, filename: string): () => void {
  if (filename === basename(from)) return () => {};
  const to = join(dirname(from), filename);
  const elsewhere = dirname(from) !== WS.paths.inbox && findFile(WS.paths, 'receipts', filename);
  // Case-only renames hit the same file on a case-insensitive disk; that is not a clash.
  if ((existsSync(to) || elsewhere) && filename.toLowerCase() !== basename(from).toLowerCase()) {
    throw new RequestError(409, `Datei ${filename} existiert bereits.`, { code: 'fileExists', params: { filename } });
  }
  if (!existsSync(from)) return () => {};
  renameSync(from, to);
  return () => renameSync(to, from);
}
