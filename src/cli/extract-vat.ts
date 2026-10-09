/**
 * npm run extract-vat
 *
 * Reads the VAT (MWST) facts off each receipt's already-extracted text and
 * writes them onto the receipt (vatId, hasSwissVat, vatSummary, lineItems).
 *
 * This is the receipt-level grounding of the VAT rules: the receipt is the
 * source of truth for whether Swiss MWST was charged and at which rate(s).
 * The accounting code (I/M/V + sign) is still decided later at classify time,
 * which will consume these facts instead of re-reading truncated receipt text.
 *
 * Idempotent: skips receipts that already have vatExtractedAt unless --force.
 * Cost control: receipts whose text shows no VAT indicator at all are marked
 * hasSwissVat=false WITHOUT an LLM call.
 *
 * Uses the `claude` CLI (Claude Pro/subscription), consistent with extract.ts,
 * match.ts and classify.ts.
 */

import 'dotenv/config';
import { buildReceiptVatPrompt, parseReceiptVat } from '../llm/prompts.js';
import { ask } from '../llm/ask.js';
import { runAdaptivePool, isRateLimitSignal } from '../llm/adaptive-pool.js';
import type { Receipt } from '../types/index.js';
import { loadBooks, mutateJournal, saveBooks, type Books } from '../books/store.js';
import { openWorkspace } from '../workspace/workspace.js';


const ws = openWorkspace();

// Adaptive concurrency (AIMD — like TCP congestion control):
// push up while calls succeed, halve on any rate-limit signal, then recover.
const START_CONCURRENCY = 6;
const MAX_CONCURRENCY = 24;
const MIN_CONCURRENCY = 1;
const RAMP_AFTER_SUCCESSES = 4; // consecutive successes before +1
const MAX_RATE_LIMIT_RETRIES = 8; // per receipt, before giving up
const SAVE_EVERY = 10; // persist index every N completions

const MIN_TEXT_LEN = 20; // below this, text is too poor to trust — needs vision review

// Cheap pre-filter: does the text contain anything that could be Swiss MWST?
// Absence lets us skip the LLM and record hasSwissVat=false directly.
function hasVatIndicator(text: string): boolean {
  return /MWST|MwSt|Mehrwertsteuer|CHE-\d{3}|\bVAT\b|USt|\d[.,]\d\s?%/i.test(text);
}

function nowIso(): string {
  return new Date().toISOString();
}

async function main() {
  const index = loadBooks(ws);
  await mutateJournal(index, extractVat);
}

async function extractVat(index: Books) {
  const force = process.argv.includes('--force');

  const candidates = index.receipts.filter(
    (r) => (force || !r.vatExtractedAt),
  );

  if (candidates.length === 0) {
    console.log('All receipts already have VAT facts extracted (use --force to redo).');
    return;
  }

  // Partition: no-text (skip), no-VAT-indicator (deterministic), needs-LLM.
  const noText: Receipt[] = [];
  const deterministic: Receipt[] = [];
  const needsLlm: Receipt[] = [];

  for (const r of candidates) {
    if (!r.extractedText || r.extractedText.length < MIN_TEXT_LEN) noText.push(r);
    else if (!hasVatIndicator(r.extractedText)) deterministic.push(r);
    else needsLlm.push(r);
  }

  console.log(
    `${candidates.length} receipt(s) to process: ` +
      `${needsLlm.length} via LLM, ${deterministic.length} no-VAT-indicator (deterministic), ` +
      `${noText.length} skipped (text too poor — needs vision review)\n`,
  );

  // Deterministic: no VAT indicator in the text → no Swiss VAT.
  for (const r of deterministic) {
    r.vatId = undefined;
    r.hasSwissVat = false;
    r.vatSummary = [];
    r.lineItems = undefined;
    r.vatExtractedAt = nowIso();
  }

  // LLM extraction via the reusable adaptive concurrency manager. The task
  // throws on rate-limit (→ backoff + retry) or parse failure (→ item fails);
  // resolving stores the parsed result and lets concurrency ramp up.
  const { stats } = await runAdaptivePool(
    needsLlm,
    async (r) => {
      const raw = await ask(buildReceiptVatPrompt(r.extractedText), { step: 'receipt-intake.guide.yaml#vat_facts', model: 'sonnet', timeoutMs: 120_000 });
      const result = parseReceiptVat(raw);
      if (!result) {
        // A rate-limit notice can arrive as text in stdout instead of throwing.
        throw new Error(isRateLimitSignal(raw) ? 'rate-limit signal in output' : 'could not parse response');
      }
      r.vatId = result.vatId;
      r.hasSwissVat = result.hasSwissVat;
      r.vatSummary = result.vatSummary;
      r.lineItems = result.lineItems;
      r.vatExtractedAt = nowIso();
      return result;
    },
    {
      start: START_CONCURRENCY,
      max: MAX_CONCURRENCY,
      min: MIN_CONCURRENCY,
      rampAfterSuccesses: RAMP_AFTER_SUCCESSES,
      maxRateLimitRetries: MAX_RATE_LIMIT_RETRIES,
      saveEvery: SAVE_EVERY,
      profile: { name: 'extract-vat' },
      onSave: () => saveBooks(ws, index),
      onConcurrencyChange: (limit, dir) =>
        console.log(dir === 'up' ? `  ↑ concurrency → ${limit}` : `  ↓ rate limited — concurrency → ${limit}`),
      onSettled: (r, _i, outcome) => {
        if (outcome.ok) {
          const rates = outcome.result.vatSummary.map((g) => `${g.ratePercent}%`).join(', ') || 'none';
          console.log(
            `  ✓ ${r.filename}: hasSwissVat=${outcome.result.hasSwissVat} [${rates}]${outcome.result.vatId ? ` ${outcome.result.vatId}` : ''}`,
          );
        } else {
          console.log(`  ✗ ${r.filename}: ${String((outcome.error as any)?.message ?? outcome.error).substring(0, 100)}`);
        }
      },
    },
  );

  // Persist deterministic + no-text changes + final LLM results.
  saveBooks(ws, index);

  console.log(`\nDone.`);
  console.log(`  LLM extracted : ${stats.ok}`);
  console.log(`  Deterministic : ${deterministic.length} (no VAT indicator)`);
  console.log(`  Failed        : ${stats.failed}`);
  console.log(`  Skipped       : ${noText.length} (text too poor — needs vision review)`);
  console.log(
    `  Rate-limit events: ${stats.rateLimitEvents} | start: ${stats.startConcurrency} | ` +
      `peak: ${stats.peakConcurrency} | next start: ${stats.suggestedNextStart} (learned)`,
  );
  if (noText.length > 0) {
    for (const r of noText) console.log(`      ${r.filename}`);
  }
  console.log(`\nWrote ${ws.paths.books}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
