/**
 * The runs that worked on one object (#215): a receipt's, a payment's or a journal entry's «Verlauf».
 * Read from the run log (runlog.ts), which travels with the books and outlives the run store: a run
 * belongs to an object when the object is its item or when it wrote the object. One row per run,
 * its lines folded together: the latest event says where it stands, `wrote` adds up every line's.
 */
import type { ItemRef } from './model.js';
import type { RunLogLine } from './runlog.js';

export const HISTORY_KINDS = ['receipt', 'payment', 'entry'] as const;

/** The object a detail shows. */
export interface HistoryObject { kind: typeof HISTORY_KINDS[number]; id: string }

/** The object, with the books' facts the log cannot know: which entries book a payment. */
export type HistoryTarget =
  | { kind: 'receipt'; id: string }
  | { kind: 'payment'; id: string; entries: string[] }
  | { kind: 'entry'; id: string };

/** The newest this many runs are listed; the rest are counted and shown on request. */
export const HISTORY_LIMIT = 20;

export interface HistoryRun {
  run: string;
  workflow: string;
  item: ItemRef;
  /** The latest line's event, time, step and reason. */
  event: RunLogLine['event'];
  at: string;
  step?: string;
  reason?: string;
  wrote: { entries: string[]; mappings: string[]; receipts: string[] };
  /** Whether the object is the run's item, or only something it wrote. */
  via: 'item' | 'wrote';
  /** The run store still holds its steps (inputs, the model's answers, errors). */
  stored: boolean;
}

export interface ObjectHistory {
  runs: HistoryRun[];
  /** How many runs worked on the object in all; more than `runs.length` when the list is cut. */
  total: number;
}

/** A mapping's id in the log is `<transactionRef>:<receiptId>` (engine.ts booksPort). */
const mappingOf = (key: string) => { const i = key.lastIndexOf(':'); return { payment: key.slice(0, i), receipt: key.slice(i + 1) }; };

function isItem(item: ItemRef, t: HistoryTarget): boolean {
  if (t.kind === 'payment') return item.kind === 'transaction' && item.id === t.id;
  return item.kind === t.kind && item.id === t.id;
}

function wroteIt(w: NonNullable<RunLogLine['wrote']>, t: HistoryTarget): boolean {
  switch (t.kind) {
    case 'receipt': return !!w.receipts?.includes(t.id) || !!w.mappings?.some((m) => mappingOf(m).receipt === t.id);
    case 'payment': return !!w.entries?.some((e) => t.entries.includes(e)) || !!w.mappings?.some((m) => mappingOf(m).payment === t.id);
    case 'entry': return !!w.entries?.includes(t.id);
  }
}

/** The runs of `lines` that worked on `target`, newest first, the first `limit` of them (Infinity: all); `stored` says whose details the run store still has. */
export function historyOf(lines: RunLogLine[], target: HistoryTarget, stored: (run: string) => boolean, limit = HISTORY_LIMIT): ObjectHistory {
  const byRun = new Map<string, RunLogLine[]>();
  for (const l of lines) byRun.set(l.run, [...(byRun.get(l.run) ?? []), l]);
  const runs: HistoryRun[] = [];
  for (const [run, ls] of byRun) {
    const item = isItem(ls[0].item, target);
    if (!item && !ls.some((l) => l.wrote && wroteIt(l.wrote, target))) continue;
    const last = ls.reduce((a, b) => (b.at >= a.at ? b : a));
    const all = (k: 'entries' | 'mappings' | 'receipts') => [...new Set(ls.flatMap((l) => l.wrote?.[k] ?? []))];
    runs.push({
      run, workflow: last.workflow, item: ls[0].item, event: last.event, at: last.at,
      ...(last.step ? { step: last.step } : {}), ...(last.reason ? { reason: last.reason } : {}),
      wrote: { entries: all('entries'), mappings: all('mappings'), receipts: all('receipts') },
      via: item ? 'item' : 'wrote', stored: stored(run),
    });
  }
  runs.sort((a, b) => b.at.localeCompare(a.at) || b.run.localeCompare(a.run));
  return { runs: runs.slice(0, limit), total: runs.length };
}

/** One run's lines, oldest first: what the run view shows of a run whose details the store no longer has. */
export const linesOfRun = (lines: RunLogLine[], run: string): RunLogLine[] => lines.filter((l) => l.run === run);
