/**
 * npm run match
 *
 * Processes all staged receipts (location: 'staged'):
 * - needsVisionReview → move to receipts/ with original filename, mark archived, no LLM call
 * - normal → ask the model (src/llm/ask.ts), apply suggested filename, rename+move to receipts/,
 *   write mappings if confidence ≥ 80%
 */

import 'dotenv/config';
import { existsSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { buildMatchPrompt, parseMatchResult } from '../llm/prompts.js';
import { ask } from '../llm/ask.js';
import type { BankTransaction } from '../types/index.js';
import { loadBooks, mutateJournal, periodLock, saveBooks, type Books } from '../books/store.js';
import { openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();
const RECEIPTS_DIR = ws.paths.receipts;
const IMPORT_DIR = ws.paths.inbox;
const MAPPING_THRESHOLD = 0.8;

function callMatcher(prompt: string, useVision: boolean): Promise<string> {
  return ask(prompt, { step: 'evidence.guide.yaml#ai', model: 'sonnet', timeoutMs: 120_000, read: useVision ? [IMPORT_DIR] : undefined });
}

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

async function main() {
  const index = loadBooks(ws);
  await mutateJournal(index, matchStaged);
}

async function matchStaged(index: Books) {
  const staged = index.receipts.filter((r) => r.location === 'staged');

  if (staged.length === 0) {
    console.log('No staged receipts to process. Drop PDFs into beleg-import/ and run `npm run extract` first.');
    return;
  }

  const visionNeeded = staged.filter((r) => r.needsVisionReview);
  const toProcess = staged.filter((r) => !r.needsVisionReview);

  // ── Move needsVisionReview receipts without a model ────────────────────────
  if (visionNeeded.length > 0) {
    console.log(`Moving ${visionNeeded.length} receipt(s) that need vision review to receipts/ (unlinked)...\n`);
    for (const receipt of visionNeeded) {
      const srcPath = join(IMPORT_DIR, receipt.filename);
      if (!existsSync(srcPath)) {
        console.warn(`  warn: ${receipt.filename} not found in beleg-import/, skipping`);
        continue;
      }
      const targetFilename = resolveCollision(receipt.filename, RECEIPTS_DIR);
      const destPath = join(RECEIPTS_DIR, targetFilename);
      try {
        renameSync(srcPath, destPath);
      } catch (e) {
        console.warn(`  warn: could not move ${receipt.filename}: ${e}`);
        continue;
      }
      const idx = index.receipts.findIndex((r) => r.id === receipt.id);
      if (idx !== -1) {
        index.receipts[idx].filename = targetFilename;
        index.receipts[idx].location = 'archived';
      }
      console.log(`  moved (needsVisionReview): ${receipt.filename} → ${targetFilename}`);
    }
    saveBooks(ws, index);
  }

  if (toProcess.length === 0) {
    console.log('\nNo receipts to match.');
    return;
  }

  const CONCURRENCY = 10;
  console.log(`\nProcessing ${toProcess.length} staged receipt(s) (concurrency: ${CONCURRENCY})...\n`);
  const allTxs = index.transactions;

  let completed = 0;
  let matched = 0;
  let skippedClosed = 0;
  let unlinked = 0;
  let failed = 0;
  let running = 0;
  const queue: (() => void)[] = [];

  async function withPool<T>(fn: () => Promise<T>): Promise<T> {
    while (running >= CONCURRENCY) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running++;
    try { return await fn(); }
    finally { running--; if (queue.length > 0) queue.shift()!(); }
  }

  async function processReceipt(receipt: typeof toProcess[0]) {
    const srcPath = join(IMPORT_DIR, receipt.filename);
    if (!existsSync(srcPath)) {
      completed++;
      console.log(`  [${completed}/${toProcess.length}]  ${receipt.filename}  not found in beleg-import/, skipping`);
      failed++;
      return;
    }

    const centerDate = receipt.date ?? guessDate(receipt.filename);
    let txs = filterByDateWindow(allTxs, centerDate);

    // Grouped vendors (Amazon/AliExpress/FedEx) bundle multiple receipts into one transaction,
    // so a receipt's amount can be much smaller than the transaction total — filter by vendor
    // keyword instead of amount so the correct transaction isn't excluded as a candidate.
    if (isGroupedVendorReceipt(receipt.extractedText)) {
      txs = filterByVendorKeyword(txs, receipt.extractedText!);
    } else if (receipt.amount && receipt.amount > 0) {
      txs = filterByAmount(txs, receipt.amount, receipt.currency);
    }

    // Rank by amount proximity to show best matches first
    if (receipt.amount && receipt.amount > 0) {
      txs = rankByProximity(txs, receipt.amount, receipt.currency || 'CHF');
    }

    // Limit to top 20 candidates
    txs = txs.slice(0, 20);

    const pdfPathForModel = srcPath; // absolute: the lean call runs from an empty directory
    const useVision = (receipt.extractedText?.length ?? 0) < 200 && existsSync(srcPath);
    const prompt = buildMatchPrompt(receipt.extractedText, txs, useVision ? pdfPathForModel : undefined);

    let result = null;
    try {
      const raw = await callMatcher(prompt, useVision);
      result = parseMatchResult(raw);
    } catch (e) {
      completed++;
      console.log(`  [${completed}/${toProcess.length}]  ${receipt.filename}  error: ${e}`);
      failed++;
      return;
    }

    completed++;

    if (!result) {
      console.log(`  [${completed}/${toProcess.length}]  ${receipt.filename}  could not parse response (no suggestedFilename)`);
      failed++;
      return;
    }

    // Normalize and resolve filename collisions
    const targetFilename = resolveCollision(normalizeFilename(result.suggestedFilename), RECEIPTS_DIR);
    const destPath = join(RECEIPTS_DIR, targetFilename);

    // Move file atomically — only update index if move succeeds
    try {
      renameSync(srcPath, destPath);
    } catch (e) {
      console.log(`  [${completed}/${toProcess.length}]  ${receipt.filename}  file move failed: ${e}`);
      failed++;
      return;
    }

    const idx = index.receipts.findIndex((r) => r.id === receipt.id);
    if (idx === -1) return;

    index.receipts[idx].filename = targetFilename;
    index.receipts[idx].location = 'archived';
    index.receipts[idx].date = result.date;
    index.receipts[idx].description = result.description;
    index.receipts[idx].amount = result.amount;
    index.receipts[idx].currency = result.currency;

    if (result.confidence >= MAPPING_THRESHOLD && result.matchedTransactionRefs.length > 0) {
      // Periodensperre: never attach a mapping to a transaction inside a closed period.
      const lock = periodLock(index);
      const allowedRefs = result.matchedTransactionRefs.filter((ref) => {
        if (!lock.isClosed(index.transactions.find((t) => t.ref === ref)?.date)) return true;
        console.log(`  ⚠ skipped mapping to ${ref}: transaction is in the closed period (≤ ${lock.closedThrough})`);
        skippedClosed++;
        return false;
      });
      for (const transactionRef of allowedRefs) {
        const exists = index.mappings.some((m) => m.transactionRef === transactionRef && m.receiptId === receipt.id);
        if (!exists) index.mappings.push({ transactionRef, receiptId: receipt.id });
      }
      if (allowedRefs.length === 0) {
        console.log(`  [${completed}/${toProcess.length}]  ${receipt.filename} → ${targetFilename}  (${(result.confidence * 100).toFixed(0)}%) unlinked — all refs in closed period`);
        unlinked++;
        return;
      }
      console.log(`  [${completed}/${toProcess.length}]  ${receipt.filename} → ${targetFilename}  (${(result.confidence * 100).toFixed(0)}%) refs: ${result.matchedTransactionRefs.join(', ')}`);
      matched++;
    } else {
      console.log(`  [${completed}/${toProcess.length}]  ${receipt.filename} → ${targetFilename}  (${(result.confidence * 100).toFixed(0)}%) unlinked`);
      unlinked++;
    }
  }

  // Process with concurrency pool, save periodically
  let saveCounter = 0;
  const promises = toProcess.map((receipt) =>
    withPool(async () => {
      await processReceipt(receipt);
      saveCounter++;
      if (saveCounter % 5 === 0) saveBooks(ws, index);
    }),
  );
  await Promise.all(promises);
  saveBooks(ws, index);

  console.log(`\nDone.`);
  console.log(`  Matched & linked : ${matched}`);
  console.log(`  Moved (unlinked) : ${unlinked}`);
  console.log(`  Failed           : ${failed}`);
  if (skippedClosed > 0) {
    console.log(`  Skipped (closed) : ${skippedClosed}  — mappings refused because the transaction is in a closed period`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
