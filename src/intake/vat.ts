/**
 * Step 2 of the inbox processing (`npm run extract-vat`): the VAT (MWST) facts read off each
 * receipt's extracted text onto the receipt (vatId, hasSwissVat, vatSummary, lineItems). The
 * receipt is the source of truth for whether Swiss MWST was charged and at which rate(s); the
 * accounting code is decided later, at classify time, from these facts.
 *
 * Takes up only receipts without VAT facts (all of them with `force`), never one of a filed quarter
 * and never one waiting for a vision read. A text that proves nothing (textProves in
 * src/parsers/receipt-text.ts: an OCR's noise however long, #284) is flagged so once, with a note
 * naming it, and stays out until a vision read gives it text: the #57 question «Beleg nicht lesbar»
 * comes up instead of a «no VAT». A «no VAT» read earlier off such a text is forgotten and flagged
 * the same way. Facts the books wrote themselves (an invoice's receipt, a tutti purchase) carry no
 * vatExtractedAt and stay, and facts a person set (vatBy 'human', src/accounting/vat-facts.ts) are
 * never taken up, with `force` too. A text that proves something and shows no VAT indicator is
 * recorded hasSwissVat=false without a model call, on a receipt that has no facts. Only a model answer that parses as VAT facts replaces facts.
 */
import { creditSigned } from '../accounting/credit-signed.js';
import { buildReceiptVatPrompt, parseReceiptVat, type ReceiptVatResult } from '../llm/prompts.js';
import { runAdaptivePool, isRateLimitSignal } from '../llm/adaptive-pool.js';
import { periodLock, type Books } from '../books/store.js';
import { vatSetup } from '../engines/index.js';
import type { Receipt } from '../types/index.js';
import { hasVatIndicator, textFacts, textProves, unprovenNoVat } from '../parsers/receipt-text.js';
import type { IntakeNote, StepRun } from './pipeline.js';

// Adaptive concurrency (AIMD — like TCP congestion control):
// push up while calls succeed, halve on any rate-limit signal, then recover.
const START_CONCURRENCY = 6;
const MAX_CONCURRENCY = 24;
const MIN_CONCURRENCY = 1;
const RAMP_AFTER_SUCCESSES = 4; // consecutive successes before +1
const MAX_RATE_LIMIT_RETRIES = 8; // per receipt, before giving up

type Facts = Pick<Receipt, 'vatId' | 'hasSwissVat' | 'vatSummary' | 'lineItems' | 'vatExtractedAt'>;

const NO_VAT: Omit<Facts, 'vatExtractedAt'> = { vatId: undefined, hasSwissVat: false, vatSummary: [], lineItems: undefined };

/** A receipt whose VAT facts were read (or decided) already: the step leaves it. */
export const hasFacts = (r: Receipt) => r.vatExtractedAt != null || r.hasSwissVat !== undefined;

const READ_FACTS = ['vatId', 'hasSwissVat', 'vatSummary', 'lineItems', 'vatExtractedAt'] as const;

/** Forgets the VAT facts this step read off a receipt's text, when that text is replaced or proves nothing. Facts a person set or the books wrote stay. */
export function forgetReadFacts(r: Receipt): void {
  if (r.vatBy === 'human' || r.vatExtractedAt == null) return;
  for (const k of READ_FACTS) delete r[k];
}

/**
 * A receipt of a filed quarter: every payment it is linked to (unlinked: its own date) lies in the
 * closed period. Its VAT was declared as booked; a wrong one is a correction in the open period.
 */
export function filedReceipt(books: Pick<Books, 'config' | 'mappings' | 'transactions' | 'journalEntries'>, r: Receipt): boolean {
  const lock = periodLock(books);
  const refs = new Set(books.mappings.filter((m) => m.receiptId === r.id).map((m) => m.transactionRef));
  const dates = [...books.transactions.filter((t) => refs.has(t.ref)).map((t) => t.date), ...books.journalEntries.filter((e) => refs.has(e.transactionRef)).map((e) => e.date)];
  return dates.length ? dates.every(lock.isClosed) : !!r.date && lock.isClosed(r.date);
}

/**
 * «No Swiss VAT» code read off the text's words without a model (textFacts `noSwissVat`, #384): a
 * provisional fact, kept without `vatExtractedAt`, that a model's reading replaces when one comes.
 */
export const provisionalNoVat = (r: Receipt): boolean =>
  r.vatBy !== 'human' && r.kindBy !== 'human' && r.kind !== 'sales-record' && r.hasSwissVat === false && r.vatExtractedAt == null
  && !r.vatId && !r.vatSummary?.length && !!textFacts(r.extractedText ?? '').noSwissVat;

/**
 * The receipts the step takes up: what the run view lists as read is what the step works on. Facts a person set are never taken up,
 * not even with `force`; a bank statement has no VAT facts. `withModel`: a model reads, so code's provisional facts are taken up too.
 */
export const vatCandidates = (books: Books, force = false, withModel = false): Receipt[] =>
  books.receipts.filter((r) => r.vatBy !== 'human' && r.kind !== 'statement' && (force || ((!hasFacts(r) || unprovenNoVat(r) || (withModel && provisionalNoVat(r))) && !r.needsVisionReview && !filedReceipt(books, r))));

export function vatStep({ force = false } = {}): StepRun {
  return async ({ books, ask, progress, log }) => {
    if (!vatSetup().registered) {
      log('The firm is not registered for VAT: no VAT facts are read off its receipts.');
      return { notes: [] };
    }
    const candidates = vatCandidates(books.read(), force, !!ask);
    if (candidates.length === 0) {
      log('All receipts already have VAT facts extracted (use --force to redo).');
      return { notes: [] };
    }

    // Partition: no-text (skip), no-VAT-indicator (deterministic), needs-LLM.
    const noText = candidates.filter((r) => !textProves(r));
    const deterministic = candidates.filter((r) => !noText.includes(r) && !hasVatIndicator(r.extractedText));
    const needsLlm = candidates.filter((r) => !noText.includes(r) && !deterministic.includes(r));
    log(
      `${candidates.length} receipt(s) to process: ` +
        `${needsLlm.length} via LLM, ${deterministic.length} no-VAT-indicator (deterministic), ` +
        `${noText.length} skipped (text too poor — needs vision review)\n`,
    );

    /** Writes the facts onto receipts that still have the text they were read from. */
    const apply = (items: Array<[Receipt, Facts]>, replace: boolean) => books.update((index) => {
      for (const [was, facts] of items) {
        const r = index.receipts.find((x) => x.id === was.id);
        // A person may have set the facts while the model read them.
        if (r && r.vatBy !== 'human' && r.extractedText === was.extractedText && (replace || !hasFacts(r) || (!!facts.vatExtractedAt && provisionalNoVat(r)))) {
          Object.assign(r, facts);
          r.amount = creditSigned(r);
        }
      }
    });

    const total = deterministic.length + needsLlm.length;
    // No indicator is no evidence against facts a receipt has.
    apply(deterministic.map((r) => [r, { ...NO_VAT, vatExtractedAt: new Date().toISOString() }]), false);
    let done = deterministic.length;
    progress(done, total);

    const notes: IntakeNote[] = [];
    // A scan too poor to read waits for a vision read instead of coming back in every run.
    if (noText.length && !force) {
      books.update((index) => {
        for (const r of index.receipts) if (noText.some((x) => x.id === r.id)) { r.needsVisionReview = true; forgetReadFacts(r); }
      });
      notes.push({ code: 'poorScan', files: noText.map((r) => r.filename) });
    }
    if (needsLlm.length && !ask) {
      // A VAT number with MWST and amounts that add up at a Swiss rate need no model; nor does a text that says in words it charges no Swiss VAT.
      const proven = needsLlm.flatMap((r): Array<[Receipt, Facts]> => {
        const f = textFacts(r.extractedText);
        if (f.vatId && f.vatSummary) return [[r, { vatId: f.vatId, hasSwissVat: true, vatSummary: f.vatSummary, lineItems: undefined, vatExtractedAt: new Date().toISOString() }]];
        // Provisional: no vatExtractedAt, so a model's reading later replaces it (provisionalNoVat).
        return f.noSwissVat ? [[r, { ...NO_VAT }]] : [];
      });
      apply(proven, false);
      for (const [r, f] of proven) log(`  ✓ ${r.filename}: from its text, ${f.hasSwissVat ? `${f.vatSummary!.map((g) => `${g.ratePercent}%`).join(', ')} ${f.vatId}` : 'no Swiss VAT, said in words'}`);
      progress(done += proven.length, total);
      const waiting = needsLlm.length - proven.length;
      if (waiting) notes.push({ code: 'noModel', waiting });
    }
    if (needsLlm.length && ask) {
      let firstError: string | undefined;
      const { stats } = await runAdaptivePool(
        needsLlm,
        async (r) => {
          const raw = await ask(buildReceiptVatPrompt(r.extractedText), { step: 'receipt-vat', timeoutMs: 120_000 });
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
              apply([[r, { vatId: v.vatId, hasSwissVat: v.hasSwissVat, vatSummary: v.vatSummary, lineItems: v.lineItems, vatExtractedAt: new Date().toISOString() }]], force);
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
