/**
 * Step 1 of the inbox processing (`npm run extract`): the text of every new PDF in beleg-import/
 * (staged) and receipts/ (archived), with pdf.js and the model's vision as fallback, and the
 * bank side read again from bank-statements/ (src/books/bank-import.ts). Payments carrying an
 * invoice's reference are booked from the invoice (ADR 0010). A statement no bank account of
 * belege.workspace.yaml takes stops the step before anything is written.
 *
 * PNG/JPG files dropped into beleg-import/ are wrapped into a PDF (src/parsers/image-pdf.ts)
 * first; the original image is deleted. iCloud placeholders and files that are no PDF yet are skipped. A
 * file in beleg-import/ with the SHA-256 of an archived receipt is skipped with a warning.
 */
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { assignUniqueRefs } from '../parsers/camt053.js';
import { imageToPdf, isImageFile } from '../parsers/image-pdf.js';
import { pdfText } from '../parsers/pdf-text.js';
import { detectVatProofIssue } from '../parsers/receipt-text.js';
import { buildVisionPrompt } from '../llm/prompts.js';
import type { Receipt } from '../types/index.js';
import { mergeIndex, readStatementPdfs, readTransactions, readWiseReferences, withinBooks } from '../books/bank-import.js';
import type { BankFiles } from '../books/bank-import.js';
import { loadInvoices, saveInvoices } from '../invoices/store.js';
import { matchPayments, type PaymentOutcome } from '../invoices/payments.js';
import { fileReceipts, paymentContext } from '../invoices/service.js';
import type { Ask, IntakeNote, StepRun } from './pipeline.js';

// ─── The PDF's own text, fallback to the model's vision for OCR ─────────────

/** `pdftotext` names the method of a digital PDF's own text, as the books have recorded it since the first extraction. */
async function extractTextFast(
  pdfPath: string,
  ask: Ask | undefined,
  log: (line: string) => void,
): Promise<{ text: string; method: 'pdftotext' | 'claude-vision'; vision?: 'none' }> {
  try {
    const text = (await pdfText(pdfPath)).trim();
    if (text.length > 30) {
      return { text, method: 'pdftotext' };
    }
  } catch {}

  if (!ask) return { text: '', method: 'claude-vision', vision: 'none' };
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
    log(`  claude -p failed: ${e.message?.substring(0, 100)}`);
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

// ─── PDF scanning helpers ────────────────────────────────────────────────────

interface FoundFile {
  filename: string;
  filepath: string;
  location: 'staged' | 'archived';
}

// Wraps any PNG/JPG/HEIC images in a directory into PDFs, then removes the originals so they
// aren't picked up as duplicates by scanPdfs.
async function convertImagesToPdf(dir: string, log: (line: string) => void): Promise<void> {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter(isImageFile)) {
    const imgPath = join(dir, f);
    const pdfPath = imgPath.replace(/\.[^.]+$/, '.pdf');
    if (existsSync(pdfPath)) {
      log(`  skip convert (target exists): ${f}`);
      continue;
    }
    try {
      writeFileSync(pdfPath, await imageToPdf(readFileSync(imgPath), f));
      unlinkSync(imgPath);
      log(`  converted ${f} -> ${basename(pdfPath)}`);
    } catch (e: any) {
      log(`  convert failed for ${f}: ${e.message?.substring(0, 100)}`);
    }
  }
}

function isPdf(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(5);
    return readSync(fd, head, 0, 5, 0) === 5 && head.toString('latin1') === '%PDF-';
  } finally {
    closeSync(fd);
  }
}

function scanPdfs(dir: string, location: 'staged' | 'archived'): FoundFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => {
      if (!f.toLowerCase().endsWith('.pdf')) return false;
      if (f.endsWith('.icloud')) return false;
      // An iCloud placeholder or a file still being written is no PDF yet; a small PDF is one.
      return isPdf(join(dir, f));
    })
    .sort()
    .map((f) => ({ filename: f, filepath: join(dir, f), location }));
}

const idOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex').substring(0, 16);

/** The camt053 files that belong to no bank account, as `bank-statements/<file>: <problem>`. */
function unmatchedOf(bank: BankFiles): string[] {
  return bank.files.flatMap((f) => (f.status === 'unmatched' ? [`bank-statements/${f.file}: ${f.problem}`] : []));
}

interface Extracted { text: string; method: Receipt['extractionMethod']; fileSize: number }

// ─── The step ────────────────────────────────────────────────────────────────

export const readStep: StepRun = async ({ ws, books, ask, progress, log }) => {
  // First: a statement that belongs to no bank account stops the step before receipts are read.
  const bank = readTransactions(ws);
  for (const f of bank.files) {
    if (f.status === 'duplicate') log(`  skip ${f.file}: statement ${f.statement.id} is already read from ${f.of}`);
    if (f.status === 'skipped') log(`  skip ${f.file}: ${f.reason}`);
  }
  const unmatched = unmatchedOf(bank);
  if (unmatched.length) return { notes: [{ code: 'unmatched', files: unmatched }], stop: true };
  if (!existsSync(ws.paths.receipts)) return { notes: [{ code: 'error', detail: `receipts/ directory not found at ${ws.paths.receipts}` }], stop: true };

  await convertImagesToPdf(ws.paths.inbox, log);

  // Archived receipts first, then staged (for cross-folder duplicate detection)
  const archivedFiles = scanPdfs(ws.paths.receipts, 'archived');
  const stagedFiles = scanPdfs(ws.paths.inbox, 'staged');
  log(`Found ${archivedFiles.length} PDFs in receipts/, ${stagedFiles.length} PDFs in beleg-import/\n`);

  const files: Array<FoundFile & { id: string }> = [];
  const seen = new Map<string, string>();
  for (const f of [...archivedFiles, ...stagedFiles]) {
    const id = idOf(f.filepath);
    const first = seen.get(id);
    if (first) {
      log(f.location === 'staged' && archivedFiles.some((a) => a.filename === first)
        ? `  warn: ${f.filename} in beleg-import/ duplicates an archived receipt — skipping`
        : `  DUPE  ${f.filename} (same content as ${first})`);
      continue;
    }
    seen.set(id, f.filename);
    files.push({ ...f, id });
  }

  const known = new Map(books.read().receipts.map((r) => [r.id, r]));
  const toExtract = files.filter((f) => !known.get(f.id)?.extractedText);
  progress(0, toExtract.length);

  const pool = createPool(5);
  const extracted = new Map<string, Extracted>();
  let waitingForModel = 0;
  await Promise.all(toExtract.map((f) => pool(async () => {
    const out = await extractTextFast(f.filepath, ask, log);
    if (out.vision === 'none') waitingForModel++;
    extracted.set(f.id, { text: out.text, method: out.method, fileSize: statSync(f.filepath).size });
    progress(extracted.size, toExtract.length);
    log(`  [${extracted.size}/${toExtract.length}] ${f.filename} → ${out.method}, ${out.text.length} chars${detectVatProofIssue(out.text) ? '  ⚠ VAT proof missing' : ''}`);
  })));

  const wiseRefs = await readWiseReferences(ws, (msg) => log(`  warn: ${msg}`));
  const bankStatements = readStatementPdfs(ws);
  const invoices = loadInvoices(ws);
  const payments = paymentContext(ws);

  // Everything read from disk is read again here, in the one synchronous change: a file deleted
  // or a statement uploaded while the texts were read is not undone.
  const outcome = books.update((index) => {
    const now = readTransactions(ws);
    const stillUnmatched = unmatchedOf(now);
    if (stillUnmatched.length) throw new Error(`Kontoauszug ohne Bankkonto: ${stillUnmatched.join('; ')}`);
    const byId = new Map(index.receipts.map((r) => [r.id, r]));
    const receipts = files.filter((f) => existsSync(f.filepath)).flatMap(({ id, filename, location }): Receipt[] => {
      const existing = byId.get(id);
      const fresh = existing?.extractedText ? undefined : extracted.get(id);
      if (!fresh) return existing ? [{ ...existing, filename, location, remarks: existing.remarks ?? detectVatProofIssue(existing.extractedText) }] : [];
      return [{
        id,
        filename,
        originalFilename: existing?.originalFilename ?? filename,
        extractedText: fresh.text,
        extractionMethod: fresh.method,
        fileSize: fresh.fileSize,
        indexedAt: existing?.indexedAt ?? new Date().toISOString(),
        location,
        date: existing?.date,
        description: existing?.description,
        amount: existing?.amount,
        currency: existing?.currency,
        needsVisionReview: fresh.text.length === 0 || undefined,
        remarks: existing?.remarks ?? detectVatProofIssue(fresh.text),
      } as Receipt];
    });
    // The books keep their order, new receipts after them: a second run writes the same file.
    const pos = new Map(index.receipts.map((r, i) => [r.id, i]));
    receipts.sort((a, b) => (pos.get(a.id) ?? pos.size) - (pos.get(b.id) ?? pos.size));
    const { kept, before } = withinBooks(now.transactions, index.config);
    if (kept.length < now.transactions.length) {
      log(`  skipped ${now.transactions.length - kept.length} bank transaction(s) dated before ${before}, when the books open (config.openingBalances)`);
    }
    const merged = mergeIndex(index, { receipts, bankTransactions: assignUniqueRefs(kept), wiseRefs, bankStatements });
    Object.assign(index, merged.index);
    // Paid invoices first (ADR 0010): a payment with an invoice's reference is booked from the invoice, before classify sees it.
    const paid = payments ? matchPayments(index, invoices, payments) : undefined;
    if (paid) {
      fileReceipts(ws, paid.files);
      saveInvoices(ws, invoices);
    }
    return { ...merged, paid, counts: { receipts: index.receipts, transactions: index.transactions.length, statements: index.bankStatements.length, mappings: index.mappings.length } };
  });

  const { counts, paid, brokenClosedLinks, vanishedClosedTransactions } = outcome;
  log(`\nDone.`);
  log(`  ${counts.receipts.filter((r) => r.location === 'archived').length} archived receipts (receipts/)`);
  log(`  ${counts.receipts.filter((r) => r.location === 'staged').length} staged receipts (beleg-import/)`);
  log(`  ${counts.transactions} transactions`);
  log(`  ${counts.statements} bank statement PDFs`);
  log(`  ${counts.mappings} mappings`);
  if (paid) reportPayments(paid, log);

  const flagged = counts.receipts.filter((r) => r.remarks?.startsWith('⚠ VAT PROOF MISSING'));
  if (flagged.length > 0) {
    log(`\n⚠ ${flagged.length} receipt(s) flagged: no VAT proof (see remarks in UI):`);
    for (const r of flagged) log(`    ${r.filename}`);
  }

  // Golden rule 1: a filed quarter's evidence is never dropped silently. These were kept as
  // they were; a person must fix them (re-link the receipt, restore the camt053 file).
  const notes: IntakeNote[] = [];
  if (brokenClosedLinks.length > 0) {
    log(`\n⛔ ${brokenClosedLinks.length} receipt link(s) in a FILED quarter point at a receipt file that is gone (re-downloaded or compressed PDFs get a new id). Kept; re-link them by hand:`);
    for (const m of brokenClosedLinks) log(`    ${m.transactionRef} → ${m.receiptId} (${known.get(m.receiptId)?.filename ?? 'unknown file'})`);
  }
  if (vanishedClosedTransactions.length > 0) {
    log(`\n⛔ ${vanishedClosedTransactions.length} bank transaction(s) in a FILED quarter are in no camt053 file any more. Kept as they were; restore the bank statement file:`);
    for (const t of vanishedClosedTransactions) log(`    ${t.date} ${t.ref} ${t.amount} ${t.currency} ${t.description}`);
  }
  const kept = brokenClosedLinks.length + vanishedClosedTransactions.length;
  if (kept) notes.push({ code: 'filedKept', count: kept });
  if (waitingForModel) notes.push({ code: 'noModel', waiting: waitingForModel });
  return { notes };
};

function reportPayments(paid: PaymentOutcome, log: (line: string) => void): void {
  for (const p of paid.paid) {
    log(`  Rechnung ${p.number}: ${p.amount.toFixed(2)}${p.fee ? ` + Mahngebühr ${p.fee.toFixed(2)}` : ''} bezahlt (${p.transactionRef})${p.booked ? ', Ertrag gebucht' : ''}`);
  }
  const why = { cancelled: 'die Rechnung ist storniert', currency: 'andere Währung als die Rechnung', surplus: 'mehr als offen', batch: 'Sammelzahlung mit Teilen ohne Rechnung, nicht gebucht', booked: 'die Zahlung ist schon gebucht, ohne die Rechnung', closed: 'in einer abgeschlossenen Periode' };
  for (const q of paid.questions) log(`  ⚠ Zahlung ${q.transactionRef} (${q.amount.toFixed(2)}) mit der Referenz von Rechnung ${q.number}: ${why[q.problem]}. Bitte entscheiden.`);
}
