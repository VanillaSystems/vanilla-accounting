/**
 * The runs that worked on one object (#215): a receipt's, a payment's or a journal entry's «Verlauf».
 * Read from the run log (runlog.ts), which travels with the books and outlives the run store: a run
 * belongs to an object when the object is its item or when it wrote something that concerns the
 * object (#233). One row per run, its lines folded together: the latest event says where it stands,
 * `wrote` keeps of every line's records only those that concern the object, and `rest` counts the
 * others, so a batch run that read a whole drop shows on one receipt only that receipt's part.
 */
import type { ItemRef } from './model.js';
import type { LeftPayment, RunLogLine } from './runlog.js';

export const HISTORY_KINDS = ['receipt', 'payment', 'entry'] as const;

/** The object a detail shows. */
export interface HistoryObject { kind: typeof HISTORY_KINDS[number]; id: string }

/**
 * The object, with the books' facts the log cannot know: a receipt's linked payments and their
 * entries, a payment's entries and linked receipts, the payment an entry books.
 */
export type HistoryTarget =
  | { kind: 'receipt'; id: string; entries: string[] }
  | { kind: 'payment'; id: string; entries: string[]; receipts: string[] }
  | { kind: 'entry'; id: string; payment?: string };

type Wrote = { entries: string[]; mappings: string[]; receipts: string[] };

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
  /** A stuck run's refusal, in the screens' words (#482). */
  why?: RunLogLine['why'];
  /** What the run wrote that concerns the object (#233): a receipt's own record, its links and its payments' entries; a payment's entries, links and linked receipts; an entry itself and its payment's links. */
  wrote: Wrote;
  /** How many other receipts (written or linked) and entries the run wrote: counted, not listed. */
  rest: { receipts: number; entries: number };
  /** The run tried to book the payment and left it unbooked (#470): why, when the screens have words for it. */
  refused?: LeftPayment;
  /** Whether the object is the run's item, or only something it wrote or left. */
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

/** Of what a run wrote, the part that concerns `t`. */
function concerning(w: Wrote, t: HistoryTarget): Wrote {
  switch (t.kind) {
    case 'receipt': return {
      entries: w.entries.filter((e) => t.entries.includes(e)),
      mappings: w.mappings.filter((m) => mappingOf(m).receipt === t.id),
      receipts: w.receipts.filter((r) => r === t.id),
    };
    case 'payment': {
      const mappings = w.mappings.filter((m) => mappingOf(m).payment === t.id);
      const linked = new Set([...t.receipts, ...mappings.map((m) => mappingOf(m).receipt)]);
      return { entries: w.entries.filter((e) => t.entries.includes(e)), mappings, receipts: w.receipts.filter((r) => linked.has(r)) };
    }
    case 'entry': return {
      entries: w.entries.filter((e) => e === t.id),
      mappings: t.payment ? w.mappings.filter((m) => mappingOf(m).payment === t.payment) : [],
      receipts: [],
    };
  }
}

/** The receipts a record set names: written ones and the receipt side of its links. */
const receiptsIn = (w: Wrote) => new Set([...w.receipts, ...w.mappings.map((m) => mappingOf(m).receipt)]);

/** The runs of `lines` that worked on `target`, newest first, the first `limit` of them (Infinity: all); `stored` says whose details the run store still has. */
export function historyOf(lines: RunLogLine[], target: HistoryTarget, stored: (run: string) => boolean, limit = HISTORY_LIMIT): ObjectHistory {
  const byRun = new Map<string, RunLogLine[]>();
  for (const l of lines) byRun.set(l.run, [...(byRun.get(l.run) ?? []), l]);
  const runs: HistoryRun[] = [];
  for (const [run, ls] of byRun) {
    const item = isItem(ls[0].item, target);
    const all = (k: keyof Wrote) => [...new Set(ls.flatMap((l) => l.wrote?.[k] ?? []))];
    const whole: Wrote = { entries: all('entries'), mappings: all('mappings'), receipts: all('receipts') };
    const wrote = concerning(whole, target);
    const refused = target.kind === 'payment' ? leftIn(ls, target.id) : undefined;
    if (!item && !refused && !wrote.entries.length && !wrote.mappings.length && !wrote.receipts.length) continue;
    const mine = receiptsIn(wrote);
    const last = ls.reduce((a, b) => (b.at >= a.at ? b : a));
    runs.push({
      run, workflow: last.workflow, item: ls[0].item, event: last.event, at: last.at,
      ...(last.step ? { step: last.step } : {}), ...(last.reason ? { reason: last.reason } : {}), ...(last.why ? { why: last.why } : {}),
      wrote,
      ...(refused ? { refused } : {}),
      rest: { receipts: [...receiptsIn(whole)].filter((r) => !mine.has(r)).length, entries: whole.entries.length - wrote.entries.length },
      via: item ? 'item' : 'wrote', stored: stored(run),
    });
  }
  runs.sort((a, b) => b.at.localeCompare(a.at) || b.run.localeCompare(a.run));
  return { runs: runs.slice(0, limit), total: runs.length };
}

/** The newest of `lines` that left payment `ref` unbooked (#470). */
function leftIn(lines: readonly RunLogLine[], ref: string): LeftPayment | undefined {
  let found: { at: string; left: LeftPayment } | undefined;
  for (const l of lines) {
    const left = l.refused?.find((r) => r.ref === ref);
    if (left && (!found || l.at >= found.at)) found = { at: l.at, left };
  }
  return found?.left;
}

/** Why a run left a payment unbooked (#470): the run, when, and the refusal the screens have words for. */
export interface PaymentRefusal { ref: string; run: string; at: string; refusal?: LeftPayment['refusal'] }

/**
 * The payments of `open` (still unbooked) whose newest run left them unbooked (#470): the one source
 * of why such a payment waits, for its page, the lists and the AI's facts. A run that came later and
 * worked on the payment as its item without leaving it so (it now waits for a receipt, a rule asks)
 * takes the word.
 */
export function refusalsOf(lines: readonly RunLogLine[], open: ReadonlySet<string>): PaymentRefusal[] {
  const newest = new Map<string, { at: string; refusal?: PaymentRefusal }>();
  const see = (ref: string, at: string, refusal?: PaymentRefusal) => {
    const was = newest.get(ref);
    if (!was || at >= was.at) newest.set(ref, { at, ...(refusal && { refusal }) });
  };
  for (const l of lines) {
    if (l.item.kind === 'transaction' && open.has(l.item.id) && !l.refused?.some((r) => r.ref === l.item.id)) see(l.item.id, l.at);
    for (const r of l.refused ?? []) if (open.has(r.ref)) see(r.ref, l.at, { ref: r.ref, run: l.run, at: l.at, ...(r.refusal && { refusal: r.refusal }) });
  }
  return [...newest.values()].flatMap((n) => (n.refusal ? [n.refusal] : []));
}

/** One run's lines, oldest first: what the run view shows of a run whose details the store no longer has. */
export const linesOfRun = (lines: RunLogLine[], run: string): RunLogLine[] => lines.filter((l) => l.run === run);
