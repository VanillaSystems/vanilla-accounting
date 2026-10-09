import { Router } from 'express';
import { renameSync, existsSync, unlinkSync, createReadStream } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Receipt, ReceiptPatch } from '../../types/index.js';
import { ask } from '../../llm/ask.js';
import { buildDateSuggestPrompt, buildVisionPrompt } from '../../llm/prompts.js';
import { receiptDir, assertOpen, receiptDates, readBooks, withBooks, RequestError, patchBody, stringField } from '../books.js';

export const router = Router();

/** An empty description or remark clears it. */
function parseReceiptPatch(body: unknown): ReceiptPatch {
  const b = patchBody(body, ['filename', 'date', 'amount', 'currency', 'description', 'remarks']);
  const patch: ReceiptPatch = {};
  if ('filename' in b) {
    const filename = stringField(b, 'filename').trim();
    if (!filename || filename !== basename(filename) || filename.startsWith('.')) {
      throw new RequestError(400, 'filename muss ein Dateiname ohne Pfad sein.');
    }
    patch.filename = filename;
  }
  if ('date' in b) {
    const date = stringField(b, 'date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RequestError(400, 'date muss JJJJ-MM-TT sein.');
    patch.date = date;
  }
  if ('amount' in b !== 'currency' in b) throw new RequestError(400, 'amount und currency nur zusammen.');
  if ('amount' in b) {
    if (typeof b.amount !== 'number' || !Number.isFinite(b.amount)) throw new RequestError(400, 'amount muss eine Zahl sein.');
    const currency = stringField(b, 'currency').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new RequestError(400, 'currency muss ein ISO-Code sein (z.B. CHF).');
    patch.amount = b.amount;
    patch.currency = currency;
  }
  if ('description' in b) patch.description = stringField(b, 'description') || undefined;
  if ('remarks' in b) patch.remarks = stringField(b, 'remarks') || undefined;
  return patch;
}

router.get('/api/receipts/:id', (req, res) => {
  const receipt = readBooks().receipts.find((r) => r.id === req.params.id);
  if (!receipt) throw new RequestError(404, 'Receipt not found');

  const pdfPath = join(receiptDir(receipt.location), receipt.filename);
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

    const [receipt] = books.receipts.splice(idx, 1);
    pdfPath = join(receiptDir(receipt.location), receipt.filename);
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

  const pdfPath = join(receiptDir(receipt.location), receipt.filename);
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

router.post('/api/receipts/:id/suggest-date', async (req, res) => {
  const receipt = readBooks().receipts.find((r) => r.id === req.params.id);
  if (!receipt) throw new RequestError(404, 'Receipt not found');

  try {
    const raw = await ask(buildDateSuggestPrompt(receipt.extractedText), { step: 'ui/receipt-date', model: 'sonnet' });
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let result: { date?: string } | null = null;
    try { result = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) try { result = JSON.parse(m[0]); } catch {}
    }
    res.json({ date: result?.date ?? '' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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
      if (patch.filename !== undefined) undoRename = renameReceiptFile(receipt, patch.filename);
      books.receipts[idx] = { ...receipt, ...patch };
      return { ok: true, receipt: books.receipts[idx] };
    });
  } catch (err) {
    undoRename();
    throw err;
  }
});

/** Renames the receipt's PDF on disk (a missing file is left alone) and returns the undo. */
function renameReceiptFile(receipt: Receipt, filename: string): () => void {
  if (filename === receipt.filename) return () => {};
  const dir = receiptDir(receipt.location);
  const from = join(dir, receipt.filename);
  const to = join(dir, filename);
  // Case-only renames hit the same file on a case-insensitive disk; that is not a clash.
  if (existsSync(to) && filename.toLowerCase() !== receipt.filename.toLowerCase()) {
    throw new RequestError(409, `Datei ${filename} existiert bereits.`, { code: 'fileExists', params: { filename } });
  }
  if (!existsSync(from)) return () => {};
  renameSync(from, to);
  return () => renameSync(to, from);
}
