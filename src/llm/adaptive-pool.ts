/**
 * Adaptive concurrency manager for `claude -p` (and any rate-limited async work).
 *
 * AIMD, like TCP congestion control: ramp concurrency up while calls succeed,
 * halve it on any rate-limit signal, then recover. Reusable across every batch
 * step (extract, extract-vat, match, classify).
 *
 * It also LEARNS between runs: when a `profile` is given, the previous run's
 * stable concurrency seeds this run's starting point (so we don't ramp from
 * scratch every time) — while always staying eager to probe higher, so a good
 * connection is never permanently throttled by one bad past run.
 *
 * Contract for the `task` callback:
 *   - resolve  → success (result stored, concurrency may ramp up)
 *   - throw an error whose message/stderr matches a rate-limit signal
 *              → back off + retry with exponential backoff
 *   - throw any other error → that item fails (result = null), no retry
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from '../workspace/workspace.js';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Detect rate-limit / overload signals from the claude CLI, wherever they show
// up: a thrown error's message, its stderr, or emitted into stdout as text.
export function isRateLimitSignal(s: string): boolean {
  return /rate.?limit|\b429\b|overloaded|too many requests|quota|usage limit|capacity|try again|slow down/i.test(
    s || '',
  );
}

// Exponential backoff with jitter, capped at 30s.
export function defaultBackoffMs(attempt: number): number {
  const base = Math.min(30_000, 1500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export type Outcome<R> = { ok: true; result: R } | { ok: false; error: unknown };

export interface ConcurrencyProfile {
  suggestedStart: number;
  lastPeak: number;
  lastFinal: number;
  lastRateLimitEvents: number;
  runs: number;
  updatedAt: string;
}

const DEFAULT_PROFILE_FILE = join(APP_ROOT, '.llm-concurrency.json');

export function loadConcurrencyProfile(
  name: string,
  file = DEFAULT_PROFILE_FILE,
): ConcurrencyProfile | null {
  if (!existsSync(file)) return null;
  try {
    const all = JSON.parse(readFileSync(file, 'utf8'));
    return all?.[name] ?? null;
  } catch {
    return null;
  }
}

function saveConcurrencyProfile(
  name: string,
  profile: ConcurrencyProfile,
  file = DEFAULT_PROFILE_FILE,
): void {
  let all: Record<string, ConcurrencyProfile> = {};
  if (existsSync(file)) {
    try {
      all = JSON.parse(readFileSync(file, 'utf8')) ?? {};
    } catch {}
  }
  all[name] = profile;
  try {
    writeFileSync(file, JSON.stringify(all, null, 2));
  } catch {}
}

export interface AdaptivePoolOptions<T, R> {
  /** Starting concurrency when there is no learned profile. Default 6. */
  start?: number;
  /** Hard ceiling. Default 24. */
  max?: number;
  /** Floor. Default 1. */
  min?: number;
  /** Consecutive successes before concurrency +1. Default 4. */
  rampAfterSuccesses?: number;
  /** Rate-limit retries per item before giving up. Default 8. */
  maxRateLimitRetries?: number;
  /** Fire onSave() every N completions (0 disables). Default 0. */
  saveEvery?: number;
  isRateLimit?: (signal: string) => boolean;
  backoffMs?: (attempt: number) => number;
  onSettled?: (item: T, index: number, outcome: Outcome<R>) => void;
  onRetry?: (item: T, index: number, attempt: number, delayMs: number) => void;
  onConcurrencyChange?: (limit: number, direction: 'up' | 'down') => void;
  onSave?: () => void;
  /**
   * Persist learnings between runs. When set, the last run's suggestedStart
   * seeds this run's starting concurrency and new learnings are written back.
   */
  profile?: { name: string; file?: string };
}

export interface AdaptivePoolStats {
  ok: number;
  failed: number;
  rateLimitEvents: number;
  peakConcurrency: number;
  finalConcurrency: number;
  startConcurrency: number;
  suggestedNextStart: number;
}

export async function runAdaptivePool<T, R>(
  items: T[],
  task: (item: T, index: number) => Promise<R>,
  options: AdaptivePoolOptions<T, R> = {},
): Promise<{ results: (R | null)[]; stats: AdaptivePoolStats }> {
  const max = options.max ?? 24;
  const min = options.min ?? 1;
  const rampAfter = options.rampAfterSuccesses ?? 4;
  const maxRetries = options.maxRateLimitRetries ?? 8;
  const saveEvery = options.saveEvery ?? 0;
  const isRL = options.isRateLimit ?? isRateLimitSignal;
  const backoff = options.backoffMs ?? defaultBackoffMs;
  const clamp = (n: number) => Math.max(min, Math.min(max, n));

  const learned = options.profile
    ? loadConcurrencyProfile(options.profile.name, options.profile.file)
    : null;
  const startConcurrency = clamp(learned?.suggestedStart ?? options.start ?? 6);

  const results: (R | null)[] = new Array(items.length).fill(null);
  let ok = 0;
  let failed = 0;
  let rateLimitEvents = 0;
  let peak = 0;
  let limit = startConcurrency;
  let active = 0;
  let consecutive = 0;
  let saveCounter = 0;

  function bumpUp() {
    consecutive++;
    if (consecutive >= rampAfter && limit < max) {
      limit++;
      consecutive = 0;
      options.onConcurrencyChange?.(limit, 'up');
    }
  }
  function backOff() {
    rateLimitEvents++;
    consecutive = 0;
    const next = Math.max(min, Math.floor(limit / 2));
    if (next < limit) {
      limit = next;
      options.onConcurrencyChange?.(limit, 'down');
    }
  }

  async function processItem(item: T, index: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await task(item, index);
        results[index] = result;
        ok++;
        bumpUp();
        options.onSettled?.(item, index, { ok: true, result });
        return;
      } catch (error: any) {
        const signal = `${error?.message ?? ''} ${error?.stderr ?? ''}`;
        if (isRL(signal)) {
          backOff();
          if (attempt < maxRetries) {
            const delay = backoff(attempt);
            options.onRetry?.(item, index, attempt, delay);
            await sleep(delay);
            continue;
          }
        }
        failed++;
        options.onSettled?.(item, index, { ok: false, error });
        return;
      }
    }
  }

  if (items.length > 0) {
    await new Promise<void>((resolve) => {
      let next = 0;
      let completed = 0;
      const total = items.length;
      function pump() {
        while (active < limit && next < total) {
          const i = next++;
          active++;
          if (active > peak) peak = active;
          processItem(items[i], i).finally(() => {
            active--;
            completed++;
            if (saveEvery > 0 && ++saveCounter >= saveEvery) {
              saveCounter = 0;
              options.onSave?.();
            }
            if (completed === total) resolve();
            else pump(); // re-fills freed slots and picks up any ramp-up
          });
        }
      }
      pump();
    });
  }

  // Next-run suggestion: profit from this run, but stay eager to probe higher.
  // No rate-limit events → push the ceiling up. Otherwise start near where it
  // stabilised (midpoint of peak and final) and let AIMD re-probe upward — so
  // one bad run never permanently throttles a connection that can go faster.
  const suggestedNextStart =
    rateLimitEvents === 0
      ? clamp(Math.max(startConcurrency, peak) + 1)
      : clamp(Math.round((peak + limit) / 2));

  if (options.profile) {
    saveConcurrencyProfile(
      options.profile.name,
      {
        suggestedStart: suggestedNextStart,
        lastPeak: peak,
        lastFinal: limit,
        lastRateLimitEvents: rateLimitEvents,
        runs: (learned?.runs ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      },
      options.profile.file,
    );
  }

  return {
    results,
    stats: {
      ok,
      failed,
      rateLimitEvents,
      peakConcurrency: peak,
      finalConcurrency: limit,
      startConcurrency,
      suggestedNextStart,
    },
  };
}
