/**
 * Step 2 of the inbox processing (`npm run extract-vat`): the VAT (MWST) facts read off each
 * receipt's extracted text onto the receipt (vatId, hasSwissVat, vatSummary, lineItems). The
 * receipt is the source of truth for whether Swiss MWST was charged and at which rate(s); the
 * accounting code is decided later, at classify time, from these facts.
 *
 * Takes up only receipts without vatExtractedAt (all of them with `force`). A text without any
 * VAT indicator is recorded hasSwissVat=false without a model call.
 */
import { buildReceiptVatPrompt, parseReceiptVat, type ReceiptVatResult } from '../llm/prompts.js';
import { runAdaptivePool, isRateLimitSignal } from '../llm/adaptive-pool.js';
import type { Receipt } from '../types/index.js';
import { hasVatIndicator } from '../parsers/receipt-text.js';
import type { IntakeNote, StepRun } from './pipeline.js';

// Adaptive concurrency (AIMD — like TCP congestion control):
// push up while calls succeed, halve on any rate-limit signal, then recover.
const START_CONCURRENCY = 6;
const MAX_CONCURRENCY = 24;
const MIN_CONCURRENCY = 1;
const RAMP_AFTER_SUCCESSES = 4; // consecutive successes before +1
const MAX_RATE_LIMIT_RETRIES = 8; // per receipt, before giving up

const MIN_TEXT_LEN = 20; // below this, text is too poor to trust — needs vision review

type Facts = Pick<Receipt, 'vatId' | 'hasSwissVat' | 'vatSummary' | 'lineItems' | 'vatExtractedAt'>;

const NO_VAT: Omit<Facts, 'vatExtractedAt'> = { vatId: undefined, hasSwissVat: false, vatSummary: [], lineItems: undefined };

export function vatStep({ force = false } = {}): StepRun {
  return async ({ books, ask, progress, log }) => {
    const candidates = books.read().receipts.filter((r) => force || !r.vatExtractedAt);
    if (candidates.length === 0) {
      log('All receipts already have VAT facts extracted (use --force to redo).');
      return { notes: [] };
    }

    // Partition: no-text (skip), no-VAT-indicator (deterministic), needs-LLM.
    const noText = candidates.filter((r) => !r.extractedText || r.extractedText.length < MIN_TEXT_LEN);
    const deterministic = candidates.filter((r) => !noText.includes(r) && !hasVatIndicator(r.extractedText));
    const needsLlm = candidates.filter((r) => !noText.includes(r) && !deterministic.includes(r));
    log(
      `${candidates.length} receipt(s) to process: ` +
        `${needsLlm.length} via LLM, ${deterministic.length} no-VAT-indicator (deterministic), ` +
        `${noText.length} skipped (text too poor — needs vision review)\n`,
    );

    /** Writes the facts onto receipts that still have the text they were read from. */
    const apply = (items: Array<[Receipt, Facts]>) => books.update((index) => {
      for (const [was, facts] of items) {
        const r = index.receipts.find((x) => x.id === was.id);
        if (r && r.extractedText === was.extractedText && (force || !r.vatExtractedAt)) Object.assign(r, facts);
      }
    });

    const total = deterministic.length + needsLlm.length;
    apply(deterministic.map((r) => [r, { ...NO_VAT, vatExtractedAt: new Date().toISOString() }]));
    let done = deterministic.length;
    progress(done, total);

    const notes: IntakeNote[] = [];
    if (needsLlm.length && !ask) notes.push({ code: 'noModel', waiting: needsLlm.length });
    if (needsLlm.length && ask) {
      let firstError: string | undefined;
      const { stats } = await runAdaptivePool(
        needsLlm,
        async (r) => {
          const raw = await ask(buildReceiptVatPrompt(r.extractedText), { step: 'receipt-intake.guide.yaml#vat_facts', model: 'sonnet', timeoutMs: 120_000 });
          const result = parseReceiptVat(raw);
          // A rate-limit notice can arrive as text in stdout instead of throwing.
          if (!result) throw new Error(isRateLimitSignal(raw) ? 'rate-limit signal in output' : 'could not parse response');
          return result;
        },
        {
          start: START_CONCURRENCY,
          max: MAX_CONCURRENCY,
          min: MIN_CONCURRENCY,
          rampAfterSuccesses: RAMP_AFTER_SUCCESSES,
          maxRateLimitRetries: MAX_RATE_LIMIT_RETRIES,
          profile: { name: 'extract-vat' },
          onConcurrencyChange: (limit, dir) =>
            log(dir === 'up' ? `  ↑ concurrency → ${limit}` : `  ↓ rate limited — concurrency → ${limit}`),
          onSettled: (r, _i, outcome) => {
            progress(++done, total);
            if (outcome.ok) {
              const v: ReceiptVatResult = outcome.result;
              apply([[r, { vatId: v.vatId, hasSwissVat: v.hasSwissVat, vatSummary: v.vatSummary, lineItems: v.lineItems, vatExtractedAt: new Date().toISOString() }]]);
              const rates = v.vatSummary.map((g) => `${g.ratePercent}%`).join(', ') || 'none';
              log(`  ✓ ${r.filename}: hasSwissVat=${v.hasSwissVat} [${rates}]${v.vatId ? ` ${v.vatId}` : ''}`);
            } else {
              const message = String((outcome.error as any)?.message ?? outcome.error);
              firstError ??= message;
              log(`  ✗ ${r.filename}: ${message.substring(0, 100)}`);
            }
          },
        },
      );
      if (stats.failed) notes.push({ code: 'failed', count: stats.failed, detail: (firstError ?? '').slice(0, 300) });
      log(`\nDone.`);
      log(`  LLM extracted : ${stats.ok}`);
      log(`  Failed        : ${stats.failed}`);
      log(
        `  Rate-limit events: ${stats.rateLimitEvents} | start: ${stats.startConcurrency} | ` +
          `peak: ${stats.peakConcurrency} | next start: ${stats.suggestedNextStart} (learned)`,
      );
    }
    log(`  Deterministic : ${deterministic.length} (no VAT indicator)`);
    log(`  Skipped       : ${noText.length} (text too poor — needs vision review)`);
    for (const r of noText) log(`      ${r.filename}`);
    return { notes };
  };
}
