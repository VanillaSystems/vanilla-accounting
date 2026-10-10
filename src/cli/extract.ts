/**
 * npm run extract
 *
 * Scans beleg-import/ (staged) and receipts/ (archived) for PDFs, extracts text
 * via pdftotext (fallback: tesseract), parses the camt053 statements under bank-statements/
 * (src/workspace/bank-statements.ts) into transactions[], then writes books.json. A statement
 * no bank account of belege.workspace.yaml takes stops the run before anything is written.
 *
 * PNG/JPG files dropped into beleg-import/ are converted to PDF (via ImageMagick's
 * `convert`) before scanning; the original image is deleted after conversion.
 *
 * iCloud edge cases: skips .icloud placeholder files and files smaller than 1 KB.
 * Cross-folder duplicates: if a file in beleg-import/ has the same SHA-256 as
 * an archived receipt, it is skipped with a warning.
 */

import 'dotenv/config';
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { assignUniqueRefs, transactionsOf } from '../parsers/camt053.js';
import { ask } from '../llm/ask.js';
import { buildVisionPrompt } from '../llm/prompts.js';
import { wiseReferences } from '../parsers/wise-statement-pdf.js';
import type { Receipt, BankTransaction, BankStatement, Index, Mapping } from '../types/index.js';
import { emptyBooks, loadBooks, mutateJournal, periodLock, saveBooks } from '../books/store.js';
import { openWorkspace } from '../workspace/workspace.js';
import { readBankStatements } from '../workspace/bank-statements.js';
import { loadInvoices, saveInvoices } from '../invoices/store.js';
import { matchPayments, type PaymentOutcome } from '../invoices/payments.js';
import { fileReceipts, paymentContext } from '../invoices/service.js';

const execFileAsync = promisify(execFile);

// ─── Fast pdftotext, fallback to claude -p for OCR ──────────────────────────

async function extractTextFast(
  pdfPath: string,
): Promise<{ text: string; method: 'pdftotext' | 'claude-vision' }> {
  // Try pdftotext first (instant for digital PDFs)
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-enc', 'UTF-8', pdfPath, '-']);
    const text = stdout.trim();
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
const BANK_STATEMENTS_DIR = ws.paths.statements;

// ─── Transactions from camt053 XML ──────────────────────────────────────────

function loadTransactions(): BankTransaction[] {
  const files = readBankStatements(ws);
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
  return files.flatMap((f) => (f.status === 'read' ? transactionsOf(f.statement, f.account) : []));
}

/**
 * The books open on 1 January of the first year with opening balances. A bank export often
 * starts a few days earlier; those rows belong to the prior year's books, whose result the
 * opening balances already carry. Books without opening balances keep every row.
 */
export function withinBooks(transactions: BankTransaction[], config: Index['config']): { kept: BankTransaction[]; before?: string } {
  const years = Object.keys(config?.openingBalances ?? {}).sort();
  if (years.length === 0) return { kept: transactions };
  const opens = `${years[0]}-01-01`;
  return { kept: transactions.filter((t) => t.date >= opens), before: opens };
}

// ─── Bank statements from PDF filenames ─────────────────────────────────────

function parseRaiffeisenDate(filename: string): { fromDate: string; toDate: string } | null {
  // "Kontoauszug 01.01.2026 - 31.01.2026 - CH... - 2026-01-31.pdf"
  const m = filename.match(/(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  const fromDate = `${m[3]}-${m[2]}-${m[1]}`;
  const toDate = `${m[6]}-${m[5]}-${m[4]}`;
  return { fromDate, toDate };
}

function parseWiseDates(filename: string): {
  fromDate: string;
  toDate: string;
  currency: string;
} | null {
  // "statement_12345678_CHF_2026-01-01_2026-01-31.pdf"
  const m = filename.match(/statement_\d+_([A-Z]{3})_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.pdf/);
  if (!m) return null;
  return { currency: m[1], fromDate: m[2], toDate: m[3] };
}

/** The monthly statement PDFs in each bank's folder, named the way Raiffeisen or Wise name them. */
function loadBankStatements(): BankStatement[] {
  const statements: BankStatement[] = [];
  for (const bank of new Set(ws.bankAccounts.filter((a) => a.statements).map((a) => a.bank))) {
    const dir = join(BANK_STATEMENTS_DIR, bank);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.pdf'))) {
      const parsed = parseRaiffeisenDate(file) ?? parseWiseDates(file);
      if (parsed) statements.push({ bank, filename: file, ...parsed });
    }
  }
  return statements.sort((a, b) => a.fromDate.localeCompare(b.fromDate));
}

// ─── PDF scanning helpers ────────────────────────────────────────────────────

interface FoundFile {
  filename: string;
  filepath: string;
  location: 'staged' | 'archived';
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'];

// Converts any PNG/JPG images in a directory to PDFs (via ImageMagick), then
// removes the originals so they aren't picked up as duplicates by scanPdfs.
async function convertImagesToPdf(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  const images = readdirSync(dir).filter((f) => {
    const lower = f.toLowerCase();
    return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  });

  for (const f of images) {
    const imgPath = join(dir, f);
    const pdfPath = imgPath.replace(/\.(png|jpg|jpeg)$/i, '.pdf');
    if (existsSync(pdfPath)) {
      console.warn(`  skip convert (target exists): ${f}`);
      continue;
    }
    try {
      await execFileAsync('convert', [imgPath, pdfPath]);
      unlinkSync(imgPath);
      console.log(`  converted ${f} -> ${basename(pdfPath)}`);
    } catch (e: any) {
      console.error(`  convert failed for ${f}: ${e.message?.substring(0, 100)}`);
    }
  }
}

// ─── VAT-proof heuristics ────────────────────────────────────────────────────
//
// Some vendors expose two different PDFs for the same purchase: a summary/
// confirmation page (no proof of Swiss VAT) and the actual tax invoice (shows
// the CHE-... UID). Filing the wrong one silently loses the VAT deduction —
// see docs/runbooks/receipt-collection.md for the full list of vendor traps.
// This only flags known patterns; absence of a flag is not proof a receipt is fine.
// A Swiss UID survives PDF text extraction in more shapes than one: pdftotext
// wraps it across lines ("#CHE-\n153.004.184 MWST" on Shopify's bills, the same
// break after "CHE-" on some other invoices), and some layouts
// space the groups out. Matching the strict "CHE-###.###.###" form alone
// produces false "no VAT proof" verdicts on perfectly good invoices, so allow
// whitespace between every part.
const SWISS_UID_RE = /CHE[-\s]*\d{3}[.\s]*\d{3}[.\s]*\d{3}/;

export function hasSwissUid(text: string): boolean {
  return SWISS_UID_RE.test(text);
}

function detectVatProofIssue(text: string): string | undefined {
  // Amazon.de "Order Summary" (order-history print/PDF) vs. the real per-seller
  // "Rechnung" invoice. The summary only ever shows "Estimated VAT"; the real
  // invoice shows "Rechnungsnummer" + "USt-IDNr. CHE-...".
  if (/Order Summary/i.test(text) && /Estimated VAT/i.test(text) && !hasSwissUid(text)) {
    return '⚠ VAT PROOF MISSING: this looks like an Amazon order-summary page, not the real invoice — no CHE-... VAT ID shown, so it cannot justify a VAT refund. Download the actual "Invoice" PDF per order/seller from the order details popover instead (see docs/runbooks/receipt-collection.md § Amazon.de).';
  }
  return undefined;
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

// ─── Merge: previous index + what is on disk now → new index ──────────────────

export interface Scan {
  /** Every receipt file on disk, already extracted. */
  receipts: Receipt[];
  /** Transactions parsed from the camt053 files, refs already unique. */
  bankTransactions: BankTransaction[];
  /** Wise transaction id → transfer reference, from the monthly statement PDFs of the `wise` accounts. */
  wiseRefs: Map<string, string>;
  bankStatements: BankStatement[];
}

/**
 * Where each transaction field comes from. A rebuild takes the 'bank' fields from the camt053
 * (and the Wise PDFs) and keeps every other field from the previous index: a remark, "no
 * receipt needed", whatever a later step adds. A new BankTransaction field does not compile
 * until it is listed here.
 */
const TRANSACTION_FIELD_SOURCE = {
  ref: 'bank', bank: 'bank', date: 'bank', amount: 'bank', currency: 'bank', direction: 'bank',
  description: 'bank', type: 'bank', parts: 'bank', reference: 'bank',
  source: 'kept', remarks: 'kept', noReceiptNeeded: 'kept',
} as const satisfies Record<keyof BankTransaction, 'bank' | 'kept'>;

function keptFields(t: BankTransaction): Partial<BankTransaction> {
  return Object.fromEntries(
    Object.entries(t).filter(([k]) => TRANSACTION_FIELD_SOURCE[k as keyof BankTransaction] !== 'bank'),
  );
}

export interface Merged {
  index: Index;
  /** Links in a filed quarter whose receipt file is gone. Kept: a person must re-link them. */
  brokenClosedLinks: Mapping[];
  /** Filed-quarter bank transactions no camt053 file contains any more. Kept as they were. */
  vanishedClosedTransactions: BankTransaction[];
}

export function mergeIndex(previous: Index, scan: Scan): Merged {
  // Golden rule 1: whatever is dated in a filed quarter stays exactly as filed.
  const lock = periodLock(previous);
  const isClosed = (t: BankTransaction | undefined) => lock.isClosed(t?.date);

  const previousByRef = new Map(previous.transactions.map((t) => [t.ref, t]));
  const freshRefs = new Set(scan.bankTransactions.map((t) => t.ref));
  const fromBank = scan.bankTransactions.map((t) => {
    const before = previousByRef.get(t.ref);
    return before ? { ...t, ...keptFields(before) } : t;
  });
  const vanishedClosedTransactions = previous.transactions.filter(
    (t) => t.source !== 'manual' && !freshRefs.has(t.ref) && isClosed(t),
  );
  const manual = previous.transactions.filter((t) => t.source === 'manual');

  const transactions = [...fromBank, ...vanishedClosedTransactions, ...manual].map((t) => {
    const out = { ...t };
    // Wise drops transfer references from camt053; its monthly PDFs keep them. The map holds
    // Wise transaction ids only (CARD-…, TRANSFER-…), read from the folders of `wise` accounts.
    const fromPdf = scan.wiseRefs.get(t.ref.split('~')[0]);
    if (fromPdf && !out.reference) out.reference = fromPdf;
    // A closed transaction stays exactly as filed, so batch parts and references are only
    // attached in open periods.
    if (isClosed(out)) { delete out.parts; delete out.reference; }
    return out;
  });

  const receiptIds = new Set(scan.receipts.map((r) => r.id));
  const byRef = new Map(transactions.map((t) => [t.ref, t]));
  const brokenClosedLinks: Mapping[] = [];
  const mappings = previous.mappings.filter((m) => {
    if (m.transactionRef === undefined) return false;
    if (receiptIds.has(m.receiptId)) return true;
    if (!isClosed(byRef.get(m.transactionRef))) return false;
    brokenClosedLinks.push(m);
    return true;
  });

  return {
    index: { ...previous, receipts: scan.receipts, transactions, bankStatements: scan.bankStatements, mappings },
    brokenClosedLinks,
    vanishedClosedTransactions,
  };
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

  // Wise drops transfer references from camt053; its monthly PDFs keep them.
  const wiseRefs = new Map<string, string>();
  for (const bank of new Set(ws.bankAccounts.filter((a) => a.statements === 'wise').map((a) => a.bank))) {
    const wiseDir = join(BANK_STATEMENTS_DIR, bank);
    if (!existsSync(wiseDir)) continue;
    for (const f of readdirSync(wiseDir).filter((x) => x.endsWith('.pdf'))) {
      try {
        const { stdout } = await execFileAsync('pdftotext', ['-raw', join(wiseDir, f), '-']);
        for (const [id, ref] of wiseReferences(stdout)) wiseRefs.set(id, ref);
      } catch (e) { console.warn(`  warn: ${f}: ${e}`); }
    }
  }

  const { kept, before } = withinBooks(parsed, index.config);
  if (kept.length < parsed.length) {
    console.log(`  skipped ${parsed.length - kept.length} bank transaction(s) dated before ${before}, when the books open (config.openingBalances)`);
  }
  const scan = {
    receipts: newReceipts,
    bankTransactions: assignUniqueRefs(kept),
    wiseRefs,
    bankStatements: loadBankStatements(),
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
