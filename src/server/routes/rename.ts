import { Router } from 'express';
import { renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ask } from '../../llm/ask.js';
import type { Receipt } from '../../types/index.js';
import { buildRenamePrompt, parseMatchResult } from '../../llm/prompts.js';
import { extractText } from '../../parsers/pdf.js';
import { periodLock } from '../../books/store.js';
import { WS, receiptDir, receiptDates, readBooks, updateBooks, RequestError } from '../books.js';

export const router = Router();

const RENAME = { step: 'ui/rename', model: 'sonnet' } as const;

/**
 * Renames every archived receipt of an open period to the model's suggestion, five model calls
 * at a time. Each wave's renames are applied to books loaded after its answers came, so an edit
 * made meanwhile survives; a receipt renamed, moved or locked meanwhile is skipped.
 */
router.post('/api/rename/batch', async (_req, res) => {
  const books = readBooks();
  const lock = periodLock(books);
  // Only rename archived receipts (staged receipts are renamed by `match`)
  const targets = books.receipts.filter((r) => r.location === 'archived' && !receiptDates(books, r.id).some((d) => lock.isClosed(d)));

  let renamed = 0;
  let skipped = 0;
  let failed = 0;

  async function suggest(receipt: Receipt): Promise<{ receipt: Receipt; filename: string } | undefined> {
    try {
      const pdfPath = join(WS.paths.receipts, receipt.filename);
      if (!existsSync(pdfPath)) { skipped++; return; }
      const text = await getTextForRename(pdfPath, receipt.extractedText);
      const result = parseMatchResult(await ask(buildRenamePrompt(text), RENAME));
      if (!result?.suggestedFilename) { failed++; return; }
      return { receipt, filename: result.suggestedFilename };
    } catch {
      failed++;
    }
  }

  const CONCURRENCY = 5;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const suggestions = (await Promise.all(targets.slice(i, i + CONCURRENCY).map(suggest))).filter((s) => !!s);
    if (!suggestions.length) continue;
    updateBooks((books) => {
      const lock = periodLock(books);
      for (const { receipt: asked, filename } of suggestions) {
        const receipt = books.receipts.find((r) => r.id === asked.id);
        if (!receipt) { failed++; continue; }
        const unchanged = receipt.location === 'archived' && receipt.filename === asked.filename;
        if (!unchanged || receiptDates(books, receipt.id).some((d) => lock.isClosed(d))) { skipped++; continue; }
        if (receipt.filename !== filename) {
          const oldPath = join(WS.paths.receipts, receipt.filename);
          const newPath = join(WS.paths.receipts, filename);
          if (!existsSync(oldPath) || existsSync(newPath)) { skipped++; continue; }
          renameSync(oldPath, newPath);
          receipt.filename = filename;
        }
        renamed++;
      }
    });
  }

  res.json({ ok: true, renamed, skipped, failed });
});

/** Heuristic: extracted text is too poor to be useful if it has fewer than 30 real characters */
function hasUsableText(text: string): boolean {
  return (text ?? '').replace(/[^a-zA-Z0-9äöüÄÖÜ]/g, '').length >= 30;
}

/**
 * Return the best available text for a receipt using local OCR only.
 * Never sends anything to AI — vision extraction requires explicit user approval.
 */
async function getTextForRename(pdfPath: string, existingText: string): Promise<string> {
  if (hasUsableText(existingText)) return existingText;

  // Re-run local pipeline (pdftotext → tesseract)
  const extracted = await extractText(pdfPath);
  if (extracted.imagePath) {
    try { unlinkSync(extracted.imagePath); } catch {}
  }
  return extracted.text;
}

router.post('/api/rename/suggest', async (req, res) => {
  const { receiptId } = req.body as { receiptId: string };
  const receipt = readBooks().receipts.find((r) => r.id === receiptId);
  if (!receipt) throw new RequestError(404, 'Receipt not found');

  try {
    const pdfPath = join(receiptDir(receipt.location), receipt.filename);
    if (!existsSync(pdfPath)) {
      res.status(404).json({ error: 'PDF file not found on disk' }); return;
    }
    const text = await getTextForRename(pdfPath, receipt.extractedText);
    const raw = await ask(buildRenamePrompt(text), RENAME);
    const result = parseMatchResult(raw);
    res.json({ suggestedFilename: result?.suggestedFilename ?? receipt.filename });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
