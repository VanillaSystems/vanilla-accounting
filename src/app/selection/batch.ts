/**
 * The batches a person runs on picked rows (#216), in the browser. A batch the server runs
 * (POST /api/batch) is previewed there first and done in one write; one made of single requests
 * (a receipt's «Zahlung suchen», «Neu lesen», «Löschen») goes through the single-object routes
 * one after the other. Either way the toast says what was done and what was left out, and its
 * «Rückgängig» takes the whole batch back in one step.
 */
import type { BatchAction, BatchAnswer, BatchChange, BatchLeft } from '../../types/batch.js';
import { ApiError, api, errorText } from '../lib/api.js';
import { t } from '../i18n/index.js';
import type { Nav } from '../areas/index.js';

/** A line of a preview or a toast: how many, and what. */
export interface Line { n: number; text: string; names: string[] }

const FIELD_TEXT: Record<BatchChange['field'], (c: BatchChange) => string> = {
  kind: () => t('batch.line.notReceipt'),
  noReceiptNeeded: () => t('batch.line.noReceiptNeeded'),
  booking: (c) => t('batch.line.booking', { to: c.to }),
  account: (c) => `${c.from} → ${c.to}`,
  vatCode: (c) => t('batch.line.vatCode', { from: c.from || t('batch.none'), to: c.to || t('batch.none') }),
  tag: (c) => `${c.from || t('batch.none')} → ${c.to || t('batch.none')}`,
};

/** The changes grouped by what they do: «12: 6510 → 6570». */
export function changeLines(changes: readonly BatchChange[], name: (id: string) => string): Line[] {
  const out = new Map<string, Line & { ids: Set<string> }>();
  for (const c of changes) {
    const text = FIELD_TEXT[c.field](c);
    const line = out.get(text) ?? { n: 0, text, names: [], ids: new Set<string>() };
    if (!line.ids.has(c.id)) { line.ids.add(c.id); line.n++; line.names.push(name(c.id)); }
    out.set(text, line);
  }
  return [...out.values()].map(({ ids: _, ...l }) => l);
}

/** What was left out, grouped by why, each object named. */
export function leftLines(left: readonly BatchLeft[], name: (id: string) => string): Line[] {
  const out = new Map<string, Line>();
  for (const l of left) {
    const text = errorText(new ApiError({ error: l.error, ...(l.refusal ?? {}) } as ConstructorParameters<typeof ApiError>[0]));
    const line = out.get(text) ?? { n: 0, text, names: [] };
    line.n++;
    line.names.push(name(l.id));
    out.set(text, line);
  }
  return [...out.values()];
}

/** The objects a batch changed. */
export const doneIds = (a: BatchAnswer): string[] => [...new Set(a.changes.map((c) => c.id))];

/** A preview of a server batch: what would change and what would be left out; nothing is written. */
export const preview = (action: BatchAction, ids: readonly string[]): Promise<BatchAnswer> => api.batch({ action, ids: [...ids], preview: true });

/**
 * A server batch done: the toast counts what changed and what was left out, its undo takes all of
 * it back in one write. Returns the answer, or undefined when the server refused the batch.
 */
export async function runBatch(nav: Nav, action: BatchAction, ids: readonly string[]): Promise<BatchAnswer | undefined> {
  let answer: BatchAnswer;
  try {
    answer = await api.batch({ action, ids: [...ids] });
  } catch (e) {
    nav.toast(errorText(e));
    return undefined;
  }
  nav.refresh();
  const n = doneIds(answer).length;
  const said = [t('batch.done', { n }), answer.left.length ? t('batch.leftOut', { n: answer.left.length }) : ''].filter(Boolean).join(' · ');
  const batchId = answer.batchId;
  nav.toast(said, batchId ? () => { api.undoBatch(batchId).then(() => { nav.refresh(); nav.toast(t('batch.undone', { n })); }, (e) => nav.toast(errorText(e))); } : undefined);
  return answer;
}

/**
 * A batch of single requests, one object after the other: `step` does one and returns its undo
 * (none: nothing to take back). A refusal stops nothing: that object is named in the toast. The
 * toast's undo runs the undos backwards, as one step.
 */
export async function runEach(nav: Nav, ids: readonly string[], step: (id: string) => Promise<(() => Promise<unknown>) | undefined>, words: { done: (n: number) => string; name: (id: string) => string }): Promise<void> {
  const undos: Array<() => Promise<unknown>> = [];
  const failed: string[] = [];
  let done = 0;
  for (const id of ids) {
    try {
      const undo = await step(id);
      done++;
      if (undo) undos.push(undo);
    } catch (e) {
      failed.push(`${words.name(id)}: ${errorText(e)}`);
    }
  }
  nav.refresh();
  const said = [words.done(done), failed.length ? t('batch.failed', { n: failed.length, names: failed.slice(0, 3).join('; ') + (failed.length > 3 ? ' …' : '') }) : ''].filter(Boolean).join(' · ');
  nav.toast(said, undos.length ? () => {
    void (async () => {
      for (const u of undos.reverse()) { try { await u(); } catch (e) { nav.toast(errorText(e)); return; } }
      nav.refresh();
      nav.toast(t('batch.undone', { n: undos.length }));
    })();
  } : undefined);
}
