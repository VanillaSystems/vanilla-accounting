/**
 * Step 3 of the inbox processing (`npm run match`): every staged receipt (location: 'staged').
 * - needsVisionReview: moved to receipts/ under its own name, archived, no model call
 * - otherwise: the model (src/llm/ask.ts) names it and finds its payment; the file is renamed
 *   into receipts/ and linked when the model is at least 80 % sure
 * A link to a payment of a filed quarter is never made (golden rule 1).
 */
import { existsSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { buildMatchPrompt, parseMatchResult, type MatchResult } from '../llm/prompts.js';
import type { BankTransaction, Receipt } from '../types/index.js';
import { periodLock, type Books } from '../books/store.js';
import type { IntakeNote, StepRun } from './pipeline.js';
import { wrote } from '../workspace/own-writes.js';

const MAPPING_THRESHOLD = 0.8;
const CONCURRENCY = 10;

function filterByDateWindow(txs: BankTransaction[], centerDate?: string, windowDays = 14) {
  if (!centerDate) return txs.slice(0, 60);
  const center = new Date(centerDate).getTime();
  const window = windowDays * 24 * 60 * 60 * 1000;
  return txs.filter((tx) => tx.date && Math.abs(new Date(tx.date).getTime() - center) <= window);
}

function filterByAmount(txs: BankTransaction[], receiptAmount?: number, receiptCurrency?: string): BankTransaction[] {
  if (!receiptAmount || receiptAmount <= 0) return txs;

  // Convert receipt amount to CHF for comparison (simplified rates)
  const chfAmount = toCHF(receiptAmount, receiptCurrency || 'CHF');

  // Allow ±30% range to account for fees, partial payments, currency fluctuations
  const minAmount = chfAmount * 0.7;
  const maxAmount = chfAmount * 1.3;

  return txs.filter((tx) => {
    const txAmount = toCHF(tx.amount, tx.currency || 'CHF');
    return txAmount >= minAmount && txAmount <= maxAmount;
  });
}

// Amazon/AliExpress/FedEx group multiple separate purchases (each its own receipt) into a
// single bank transaction — a receipt's amount is often only a fraction of the transaction
// total, so the amount filter must not exclude the transaction for these vendors (AGENTS.md).
const GROUPED_VENDOR_PATTERN = /amazon|aliexpress|fedex/i;

function isGroupedVendorReceipt(text?: string): boolean {
  return !!text && GROUPED_VENDOR_PATTERN.test(text);
}

function filterByVendorKeyword(txs: BankTransaction[], text: string): BankTransaction[] {
  const match = text.match(GROUPED_VENDOR_PATTERN);
  if (!match) return txs;
  const keyword = match[0].toLowerCase();
  return txs.filter((tx) => (tx.description || '').toLowerCase().includes(keyword));
}

function toCHF(amount: number, currency: string): number {
  const rates: Record<string, number> = {
    'CHF': 1,
    'EUR': 0.91,
    'USD': 0.78,
    'GBP': 1.15,
  };
  const rate = rates[currency] || 1;
  return amount * rate;
}

function rankByProximity(txs: BankTransaction[], targetAmount: number, targetCurrency: string): BankTransaction[] {
  const chfTarget = toCHF(targetAmount, targetCurrency);
  return txs
    .map((tx) => ({
      tx,
      diff: Math.abs(toCHF(tx.amount, tx.currency || 'CHF') - chfTarget)
    }))
    .sort((a, b) => a.diff - b.diff)
    .map((item) => item.tx);
}

function guessDate(filename: string): string | undefined {
  const m = filename.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
}

function normalizeFilename(raw: string): string {
  // Strip path separators and other unsafe chars; enforce .pdf extension
  let name = basename(raw).replace(/[/\\:*?"<>|]/g, '-');
  if (!name.toLowerCase().endsWith('.pdf')) {
    name = name.replace(/\.[^.]*$/, '') + '.pdf';
    if (!name.endsWith('.pdf')) name += '.pdf';
  }
  return name || 'receipt.pdf';
}

function resolveCollision(desiredName: string, targetDir: string): string {
  if (!existsSync(join(targetDir, desiredName))) return desiredName;
  const base = desiredName.replace(/\.pdf$/i, '');
  let i = 2;
  while (existsSync(join(targetDir, `${base}-${i}.pdf`))) i++;
  return `${base}-${i}.pdf`;
}

/** The payments the model is shown for one receipt: near its date, near its amount (or its vendor's), best first, at most 20. */
function candidates(receipt: Receipt, all: BankTransaction[]): BankTransaction[] {
  let txs = filterByDateWindow(all, receipt.date ?? guessDate(receipt.filename));
  // Grouped vendors (Amazon/AliExpress/FedEx) bundle multiple receipts into one transaction,
  // so a receipt's amount can be much smaller than the transaction total — filter by vendor
  // keyword instead of amount so the correct transaction isn't excluded as a candidate.
  if (isGroupedVendorReceipt(receipt.extractedText)) txs = filterByVendorKeyword(txs, receipt.extractedText!);
  else if (receipt.amount && receipt.amount > 0) txs = filterByAmount(txs, receipt.amount, receipt.currency);
  if (receipt.amount && receipt.amount > 0) txs = rankByProximity(txs, receipt.amount, receipt.currency || 'CHF');
  return txs.slice(0, 20);
}

export const matchStep: StepRun = async ({ ws, books, ask, progress, log }) => {
  const RECEIPTS_DIR = ws.paths.receipts;
  const IMPORT_DIR = ws.paths.inbox;
  const snapshot = books.read();
  const staged = snapshot.receipts.filter((r) => r.location === 'staged');
  if (staged.length === 0) {
    log('No staged receipts to process. Drop PDFs into beleg-import/ and run `npm run extract` first.');
    return { notes: [] };
  }
  const visionNeeded = staged.filter((r) => r.needsVisionReview);
  const toProcess = staged.filter((r) => !r.needsVisionReview);
  const total = staged.length;
  let completed = 0;
  progress(0, total);

  /**
   * Moves the staged file into receipts/ and changes its receipt in the same synchronous change,
   * if the receipt is still the staged file it was. Returns the new file name, or why not.
   */
  const archive = (receipt: Receipt, desired: string, change: (r: Receipt, books: Books) => void): string | undefined => books.update((index) => {
    const r = index.receipts.find((x) => x.id === receipt.id);
    const srcPath = join(IMPORT_DIR, receipt.filename);
    if (!r || r.location !== 'staged' || r.filename !== receipt.filename || !existsSync(srcPath)) return undefined;
    const target = resolveCollision(desired, RECEIPTS_DIR);
    change(r, index);
    Object.assign(r, { filename: target, location: 'archived' });
    renameSync(srcPath, join(RECEIPTS_DIR, target));
    wrote(srcPath);
    wrote(join(RECEIPTS_DIR, target));
    return target;
  });

  // ── Move needsVisionReview receipts without a model ────────────────────────
  if (visionNeeded.length > 0) log(`Moving ${visionNeeded.length} receipt(s) that need vision review to receipts/ (unlinked)...\n`);
  for (const receipt of visionNeeded) {
    const target = archive(receipt, receipt.filename, () => {});
    progress(++completed, total);
    log(target ? `  moved (needsVisionReview): ${receipt.filename} → ${target}` : `  warn: ${receipt.filename} is not staged in beleg-import/ any more, skipping`);
  }

  if (toProcess.length === 0) {
    log('\nNo receipts to match.');
    return { notes: [] };
  }
  if (!ask) return { notes: [{ code: 'noModel', waiting: toProcess.length }] };

  log(`\nProcessing ${toProcess.length} staged receipt(s) (concurrency: ${CONCURRENCY})...\n`);
  completed = 0;
  let matched = 0;
  let skippedClosed = 0;
  let unlinked = 0;
  const failures: string[] = [];

  async function processReceipt(receipt: Receipt) {
    const srcPath = join(IMPORT_DIR, receipt.filename);
    const line = (msg: string) => log(`  [${completed}/${toProcess.length}]  ${receipt.filename}  ${msg}`);
    if (!existsSync(srcPath)) {
      completed++;
      line('not found in beleg-import/, skipping');
      return;
    }
    const useVision = (receipt.extractedText?.length ?? 0) < 200;
    // absolute: the lean call runs from an empty directory
    const prompt = buildMatchPrompt(receipt.extractedText, candidates(receipt, snapshot.transactions), useVision ? srcPath : undefined);
    let result: MatchResult | null;
    try {
      result = parseMatchResult(await ask!(prompt, { step: 'evidence.guide.yaml#ai', model: 'sonnet', timeoutMs: 120_000, read: useVision ? [IMPORT_DIR] : undefined }));
    } catch (e) {
      completed++;
      failures.push(String(e instanceof Error ? e.message : e));
      line(`error: ${e}`);
      return;
    }
    completed++;
    if (!result) {
      failures.push('could not parse response (no suggestedFilename)');
      line('could not parse response (no suggestedFilename)');
      return;
    }
    const answer = result;
    const sure = answer.confidence >= MAPPING_THRESHOLD && (answer.matchedTransactionRefs?.length ?? 0) > 0;
    let linked: string[] = [];
    const target = archive(receipt, normalizeFilename(answer.suggestedFilename), (r, index) => {
      Object.assign(r, { date: answer.date, description: answer.description, amount: answer.amount, currency: answer.currency });
      if (!sure) return;
      // Periodensperre: never attach a mapping to a transaction inside a closed period.
      const lock = periodLock(index);
      linked = answer.matchedTransactionRefs.filter((ref) => {
        const tx = index.transactions.find((t) => t.ref === ref);
        if (tx && !lock.isClosed(tx.date)) return true;
        if (tx) { log(`  ⚠ skipped mapping to ${ref}: transaction is in the closed period (≤ ${lock.closedThrough})`); skippedClosed++; }
        return false;
      });
      for (const transactionRef of linked) {
        if (!index.mappings.some((m) => m.transactionRef === transactionRef && m.receiptId === receipt.id)) index.mappings.push({ transactionRef, receiptId: receipt.id });
      }
    });
    const pct = `(${((answer.confidence ?? 0) * 100).toFixed(0)}%)`;
    if (!target) line('is not staged in beleg-import/ any more, skipping');
    else if (linked.length) { matched++; line(`→ ${target}  ${pct} refs: ${linked.join(', ')}`); }
    else { unlinked++; line(`→ ${target}  ${pct} unlinked${sure ? ' — all refs in closed period' : ''}`); }
  }

  let running = 0;
  const queue: (() => void)[] = [];
  await Promise.all(toProcess.map(async (receipt) => {
    while (running >= CONCURRENCY) await new Promise<void>((resolve) => queue.push(resolve));
    running++;
    try { await processReceipt(receipt); } finally { running--; queue.shift()?.(); }
    progress(visionNeeded.length + completed, total);
  }));

  log(`\nDone.`);
  log(`  Matched & linked : ${matched}`);
  log(`  Moved (unlinked) : ${unlinked}`);
  log(`  Failed           : ${failures.length}`);
  if (skippedClosed > 0) log(`  Skipped (closed) : ${skippedClosed}  — mappings refused because the transaction is in a closed period`);
  const notes: IntakeNote[] = failures.length ? [{ code: 'failed', count: failures.length, detail: failures[0].slice(0, 300) }] : [];
  return { notes };
};
