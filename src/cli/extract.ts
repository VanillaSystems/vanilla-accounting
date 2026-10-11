/**
 * npm run extract
 *
 * Scans beleg-import/ (staged) and receipts/ (archived) for PDFs, extracts text
 * with pdf.js (fallback: the model's vision), parses the camt053 statements under bank-statements/
 * (src/workspace/bank-statements.ts) into transactions[], then writes books.json. A statement
 * no bank account of belege.workspace.yaml takes stops the run before anything is written.
 *
 * PNG/JPG files dropped into beleg-import/ are wrapped into a PDF (src/parsers/image-pdf.ts)
 * before scanning; the original image is deleted after conversion.
 *
 * iCloud edge cases: skips .icloud placeholder files and files smaller than 1 KB.
 * Cross-folder duplicates: if a file in beleg-import/ has the same SHA-256 as
 * an archived receipt, it is skipped with a warning.
 */

import 'dotenv/config';
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assignUniqueRefs } from '../parsers/camt053.js';
import { imageToPdf, isImageFile } from '../parsers/image-pdf.js';
import { pdfText } from '../parsers/pdf-text.js';
import { detectVatProofIssue } from '../parsers/receipt-text.js';
import { ask } from '../llm/ask.js';
import { buildVisionPrompt } from '../llm/prompts.js';
import type { Receipt, BankTransaction } from '../types/index.js';
import { emptyBooks, loadBooks, mutateJournal, saveBooks } from '../books/store.js';
import { mergeIndex, readStatementPdfs, readTransactions, readWiseReferences, withinBooks } from '../books/bank-import.js';
import { openWorkspace } from '../workspace/workspace.js';
import { loadInvoices, saveInvoices } from '../invoices/store.js';
import { matchPayments, type PaymentOutcome } from '../invoices/payments.js';
import { fileReceipts, paymentContext } from '../invoices/service.js';

// ─── The PDF's own text, fallback to claude -p for OCR ──────────────────────

/** `pdftotext` names the method of a digital PDF's own text, as the books have recorded it since the first extraction. */
async function extractTextFast(
  pdfPath: string,
): Promise<{ text: string; method: 'pdftotext' | 'claude-vision' }> {
  try {
    const text = (await pdfText(pdfPath)).trim();
    if (text.length > 30) {
      return { text, method: 'pdftotext' };
    }
  } catch {}

  // Fallback: vision OCR on scanned PDFs. The lean call runs from an empty
  // directory, so the Read tool gets the absolute path and that one folder.
  const absPath = resolve(pdfPath);
  try {
    const text = await ask(
      buildVisionPrompt(absPath),
      { step: 'receipt-intake.guide.yaml#vision', model: 'sonnet', timeoutMs: 120_000, read: [dirname(absPath)] },
    );
    return { text, method: 'claude-vision' };
  } catch (e: any) {
    console.error(`  claude -p failed: ${e.message?.substring(0, 100)}`);
    return { text: '', method: 'claude-vision' };
  }
}

// ─── Concurrency pool ───────────────────────────────────────────────────────

function createPool(concurrency: number) {
  let running = 0;
  const queue: (() => void)[] = [];

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    while (running >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      if (queue.length > 0) queue.shift()!();
    }
  };
}

const ws = openWorkspace();
const RECEIPTS_DIR = ws.paths.receipts;
const IMPORT_DIR = ws.paths.inbox;

/** The camt053 transactions; a statement that belongs to no bank account stops the run before anything is written. */
function loadTransactions(): BankTransaction[] {
  const { files, transactions } = readTransactions(ws);
  for (const f of files) {
    if (f.status === 'duplicate') console.log(`  skip ${f.file}: statement ${f.statement.id} is already read from ${f.of}`);
    if (f.status === 'skipped') console.log(`  skip ${f.file}: ${f.reason}`);
  }
  const unmatched = files.filter((f) => f.status === 'unmatched');
  if (unmatched.length) {
    console.error(`⛔ ${unmatched.length} bank statement(s) belong to no bank account; nothing was written.`);
    for (const f of unmatched) console.error(`  bank-statements/${f.file}: ${f.problem}`);
    process.exit(1);
  }
  return transactions;
}

// ─── PDF scanning helpers ────────────────────────────────────────────────────

interface FoundFile {
  filename: string;
  filepath: string;
  location: 'staged' | 'archived';
}

// Wraps any PNG/JPG images in a directory into PDFs, then removes the originals so they
// aren't picked up as duplicates by scanPdfs.
async function convertImagesToPdf(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter(isImageFile)) {
    const imgPath = join(dir, f);
    const pdfPath = imgPath.replace(/\.(png|jpg|jpeg)$/i, '.pdf');
    if (existsSync(pdfPath)) {
      console.warn(`  skip convert (target exists): ${f}`);
      continue;
    }
    try {
      writeFileSync(pdfPath, await imageToPdf(readFileSync(imgPath), f));
      unlinkSync(imgPath);
      console.log(`  converted ${f} -> ${basename(pdfPath)}`);
    } catch (e: any) {
      console.error(`  convert failed for ${f}: ${e.message?.substring(0, 100)}`);
    }
  }
}

function scanPdfs(dir: string, location: 'staged' | 'archived'): FoundFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => {
      if (!f.toLowerCase().endsWith('.pdf')) return false;
      if (f.endsWith('.icloud')) return false;
      const stat = statSync(join(dir, f));
      if (stat.size < 1024) return false; // iCloud placeholder
      return true;
    })
    .sort()
    .map((f) => ({ filename: f, filepath: join(dir, f), location }));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load existing index to preserve mappings and already-extracted data
  const index = existsSync(ws.paths.books) ? loadBooks(ws) : emptyBooks();
  // First: a statement that belongs to no bank account stops the run before receipts are read.
  const parsed = loadTransactions();

  const existingById = new Map(index.receipts.map((r) => [r.id, r]));

  if (!existsSync(RECEIPTS_DIR)) {
    console.error(`receipts/ directory not found at ${RECEIPTS_DIR}`);
    process.exit(1);
  }

  // Convert any dropped PNG/JPG images in beleg-import/ to PDFs before scanning
  await convertImagesToPdf(IMPORT_DIR);

  // Scan archived receipts first, then staged (for cross-folder duplicate detection)
  const archivedFiles = scanPdfs(RECEIPTS_DIR, 'archived');
  const stagedFiles = existsSync(IMPORT_DIR) ? scanPdfs(IMPORT_DIR, 'staged') : [];

  console.log(`Found ${archivedFiles.length} PDFs in receipts/, ${stagedFiles.length} PDFs in beleg-import/\n`);

  // Compute SHA-256 ids for archived files first, to detect cross-folder duplicates
  const archivedIds = new Set<string>();
  const allFiles: FoundFile[] = [];

  for (const f of archivedFiles) {
    const content = readFileSync(f.filepath);
    const id = createHash('sha256').update(content).digest('hex').substring(0, 16);
    archivedIds.add(id);
    allFiles.push(f);
  }

  for (const f of stagedFiles) {
    const content = readFileSync(f.filepath);
    const id = createHash('sha256').update(content).digest('hex').substring(0, 16);
    if (archivedIds.has(id)) {
      console.warn(`  warn: ${f.filename} in beleg-import/ duplicates an archived receipt — skipping`);
      continue;
    }
    allFiles.push(f);
  }

  const newReceipts: Receipt[] = [];
  const seenHashes = new Map<string, string>();
  const vatProofFlags: string[] = [];

  // Separate files into skip (already extracted) and needs-extraction
  interface FileWithMeta extends FoundFile {
    idx: number;
    id: string;
    stat: import('node:fs').Stats;
    existing?: Receipt;
  }
  const toExtract: FileWithMeta[] = [];

  for (let i = 0; i < allFiles.length; i++) {
    const { filename, filepath, location } = allFiles[i];
    const stat = statSync(filepath);
    const content = readFileSync(filepath);
    const id = createHash('sha256').update(content).digest('hex').substring(0, 16);

    if (seenHashes.has(id)) {
      process.stdout.write(`  [${i + 1}/${allFiles.length}] DUPE  ${filename} (same content as ${seenHashes.get(id)})\n`);
      continue;
    }
    seenHashes.set(id, filename);

    const existing = existingById.get(id);
    if (existing && existing.extractedText.length > 0) {
      const vatIssue = detectVatProofIssue(existing.extractedText);
      if (vatIssue) vatProofFlags.push(filename);
      newReceipts.push({ ...existing, filename, location, remarks: existing.remarks ?? vatIssue });
      process.stdout.write(`  [${i + 1}/${allFiles.length}] skip  ${filename} (${location})\n`);
      continue;
    }

    toExtract.push({ ...allFiles[i], idx: i, id, stat, existing });
  }

  // Extract concurrently with pool of 5
  const pool = createPool(5);
  let doneCount = 0;

  const extractionPromises = toExtract.map((file) =>
    pool(async () => {
      const { filename, filepath, location, idx, id, stat, existing } = file;
      const extracted = await extractTextFast(filepath);
      doneCount++;
      const vatIssue = detectVatProofIssue(extracted.text);
      if (vatIssue) vatProofFlags.push(filename);
      process.stdout.write(
        `  [${doneCount}/${toExtract.length}] ${filename} → ${extracted.method}, ${extracted.text.length} chars${vatIssue ? '  ⚠ VAT proof missing' : ''}\n`,
      );

      return {
        id,
        filename,
        originalFilename: existing?.originalFilename ?? filename,
        extractedText: extracted.text,
        extractionMethod: extracted.method as Receipt['extractionMethod'],
        fileSize: stat.size,
        indexedAt: existing?.indexedAt ?? new Date().toISOString(),
        location,
        date: existing?.date,
        description: existing?.description,
        amount: existing?.amount,
        currency: existing?.currency,
        needsVisionReview: extracted.text.length === 0 || undefined,
        remarks: existing?.remarks ?? vatIssue,
      } as Receipt;
    }),
  );

  const extractedReceipts = await Promise.all(extractionPromises);
  newReceipts.push(...extractedReceipts);

  const wiseRefs = await readWiseReferences(ws, (msg) => console.warn(`  warn: ${msg}`));

  const { kept, before } = withinBooks(parsed, index.config);
  if (kept.length < parsed.length) {
    console.log(`  skipped ${parsed.length - kept.length} bank transaction(s) dated before ${before}, when the books open (config.openingBalances)`);
  }
  const scan = {
    receipts: newReceipts,
    bankTransactions: assignUniqueRefs(kept),
    wiseRefs,
    bankStatements: readStatementPdfs(ws),
  };
  // Paid invoices first (ADR 0010): a payment with an invoice's reference is booked from the invoice, before classify sees it.
  const invoices = loadInvoices(ws);
  const payments = paymentContext(ws);
  const { brokenClosedLinks, vanishedClosedTransactions, paid } = mutateJournal(index, (books) => {
    const merged = mergeIndex(books, scan);
    Object.assign(books, merged.index);
    return { ...merged, paid: payments ? matchPayments(books, invoices, payments) : undefined };
  });
  if (paid) {
    fileReceipts(ws, paid.files);
    saveInvoices(ws, invoices);
  }
  saveBooks(ws, index);

  const stagedCount = newReceipts.filter((r) => r.location === 'staged').length;
  const archivedCount = newReceipts.filter((r) => r.location === 'archived').length;

  console.log(`\nDone.`);
  console.log(`  ${archivedCount} archived receipts (receipts/)`);
  console.log(`  ${stagedCount} staged receipts (beleg-import/)`);
  console.log(`  ${index.transactions.length} transactions`);
  console.log(`  ${index.bankStatements.length} bank statement PDFs`);
  console.log(`  ${index.mappings.length} mappings`);
  if (paid) reportPayments(paid);

  if (vatProofFlags.length > 0) {
    console.log(`\n⚠ ${vatProofFlags.length} receipt(s) flagged: no VAT proof (see remarks in UI):`);
    for (const f of vatProofFlags) console.log(`    ${f}`);
  }

  // Golden rule 1: a filed quarter's evidence is never dropped silently. These were kept as
  // they were; a person must fix them (re-link the receipt, restore the camt053 file).
  if (brokenClosedLinks.length > 0) {
    console.error(`\n⛔ ${brokenClosedLinks.length} receipt link(s) in a FILED quarter point at a receipt file that is gone (re-downloaded or compressed PDFs get a new id). Kept; re-link them by hand:`);
    for (const m of brokenClosedLinks) {
      console.error(`    ${m.transactionRef} → ${m.receiptId} (${existingById.get(m.receiptId)?.filename ?? 'unknown file'})`);
    }
  }
  if (vanishedClosedTransactions.length > 0) {
    console.error(`\n⛔ ${vanishedClosedTransactions.length} bank transaction(s) in a FILED quarter are in no camt053 file any more. Kept as they were; restore the bank statement file:`);
    for (const t of vanishedClosedTransactions) console.error(`    ${t.date} ${t.ref} ${t.amount} ${t.currency} ${t.description}`);
  }

  console.log(`\nWrote ${ws.paths.books}`);
}

function reportPayments(paid: PaymentOutcome): void {
  for (const p of paid.paid) {
    console.log(`  Rechnung ${p.number}: ${p.amount.toFixed(2)}${p.fee ? ` + Mahngebühr ${p.fee.toFixed(2)}` : ''} bezahlt (${p.transactionRef})${p.booked ? ', Ertrag gebucht' : ''}`);
  }
  const why = { cancelled: 'die Rechnung ist storniert', currency: 'andere Währung als die Rechnung', surplus: 'mehr als offen', batch: 'Sammelzahlung mit Teilen ohne Rechnung, nicht gebucht', booked: 'die Zahlung ist schon gebucht, ohne die Rechnung', closed: 'in einer abgeschlossenen Periode' };
  for (const q of paid.questions) console.log(`  ⚠ Zahlung ${q.transactionRef} (${q.amount.toFixed(2)}) mit der Referenz von Rechnung ${q.number}: ${why[q.problem]}. Bitte entscheiden.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
