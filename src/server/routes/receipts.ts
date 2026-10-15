import { Router } from 'express';
import { renameSync, existsSync, createReadStream, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { RECEIPT_KINDS, type Mapping, type Receipt, type ReceiptKind, type ReceiptPatch } from '../../types/index.js';
import { entriesWithoutTheirReceipts, removeReceipt } from '../../accounting/classify-force.js';
import { bookAgain } from './automation.js';
import { ask } from '../../llm/ask.js';
import { buildVisionPrompt } from '../../llm/prompts.js';
import { findFile } from '../../workspace/workspace.js';
import { WS, receiptPath, assertOpen, receiptDates, refDates, readBooks, updateBooks, withBooks, RequestError, patchBody, stringField } from '../books.js';

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

/**
 * A deleted receipt waits in data/trash/<id>/ for TRASH_DAYS: its file, and what the books held
 * of it, so a restore («Rückgängig» in the toast) puts both back.
 */
interface Trashed { deletedAt: string; receipt: Receipt; mappings: Mapping[]; file: string }
const TRASH_DAYS = 30;
const trashOf = (id: string) => join(WS.paths.data, 'trash', id);
const ID = /^[\w-]+$/;

function emptyOldTrash(): void {
  const root = join(WS.paths.data, 'trash');
  if (!existsSync(root)) return;
  const before = new Date(Date.now() - TRASH_DAYS * 864e5).toISOString();
  for (const id of readdirSync(root)) {
    const meta = join(root, id, 'trashed.json');
    const at = existsSync(meta) ? (JSON.parse(readFileSync(meta, 'utf8')) as Trashed).deletedAt : '';
    if (at < before) rmSync(join(root, id), { recursive: true, force: true });
  }
}

/** The receipt leaves the books with its links and the entries booked with it; its payments are booked again without it. */
router.delete('/api/receipts/:id', async (req, res) => {
  const { id } = req.params;
  const { trashed, pdfPath, again } = updateBooks((books) => {
    const receipt = books.receipts.find((r) => r.id === id);
    if (!receipt) throw new RequestError(404, 'Receipt not found');
    assertOpen(books, receiptDates(books, id), 'deleteReceipt');
    const pdfPath = receiptPath(books, receipt);
    const trashed: Trashed = { deletedAt: new Date().toISOString(), receipt, mappings: books.mappings.filter((m) => m.receiptId === id), file: relative(WS.paths.root, pdfPath) };
    return { trashed, pdfPath, again: removeReceipt(books, id) };
  });
  emptyOldTrash();
  mkdirSync(trashOf(id), { recursive: true });
  writeFileSync(join(trashOf(id), 'trashed.json'), JSON.stringify(trashed, null, 2));
  if (existsSync(pdfPath)) renameSync(pdfPath, join(trashOf(id), basename(pdfPath)));
  if (again.length) await bookAgain(trashed.receipt.filename);
  res.json({ ok: true });
});

/** A deleted receipt back from the trash, with its links to payments that are still there; those payments are booked again with it. */
router.post('/api/receipts/:id/restore', async (req, res) => {
  const { id } = req.params;
  const meta = join(trashOf(id), 'trashed.json');
  if (!ID.test(id) || !existsSync(meta)) throw new RequestError(404, 'Dieser Beleg liegt nicht mehr im Papierkorb.');
  const t = JSON.parse(readFileSync(meta, 'utf8')) as Trashed;
  const from = join(trashOf(id), basename(t.file));
  const to = join(WS.paths.root, t.file);
  const again = updateBooks((books) => {
    if (books.receipts.some((r) => r.id === id)) throw new RequestError(409, 'Dieser Beleg ist schon in den Büchern.');
    if (existsSync(to) || findFile(WS.paths, 'receipts', t.receipt.filename)) {
      throw new RequestError(409, `Datei ${t.receipt.filename} existiert bereits.`, { code: 'fileExists', params: { filename: t.receipt.filename } });
    }
    const refs = new Set(books.transactions.map((x) => x.ref));
    const links = t.mappings.filter((m) => refs.has(m.transactionRef));
    assertOpen(books, links.flatMap((m) => refDates(books, m.transactionRef)), 'editReceipt');
    books.receipts.push(t.receipt);
    books.mappings.push(...links);
    return entriesWithoutTheirReceipts(books.journalEntries, books.mappings, new Set(links.map((m) => m.transactionRef)), books.config.closedThrough).length > 0;
  });
  if (existsSync(from)) { mkdirSync(dirname(to), { recursive: true }); renameSync(from, to); }
  rmSync(trashOf(id), { recursive: true, force: true });
  if (again) await bookAgain(t.receipt.filename);
  res.json({ ok: true, receipt: t.receipt });
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
