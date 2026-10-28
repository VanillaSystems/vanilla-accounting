/**
 * Receipts that are the same document twice: the same invoice once renamed and once as it came,
 * a second download, a scan of a PDF already filed. Not the same bytes (the drop and the read
 * step catch those by their id), the same facts: the same text, or the same total on nearly the
 * same day with a number only these documents carry (an invoice or order number), or the same
 * vendor's VAT number. A document beside an invoice (an order confirmation) is its companion, not
 * a copy. What a person said differs (`distinctFrom`) is never paired again. No model, no
 * language: the words that label an invoice number come from the jurisdiction (documents.yaml).
 */
import type { Receipt, TwinWhy } from '../types/index.js';
import type { DocumentsData } from '../core/modules/schema.js';
import { vatIdIn } from '../parsers/receipt-text.js';

export type Comparable = Pick<Receipt, 'id' | 'extractedText' | 'date' | 'amount' | 'currency' | 'vatId' | 'kind' | 'distinctFrom'> & { indexedAt?: string; filename?: string };

/** `of` is the receipt this one repeats (a duplicate) or accompanies (a companion: an order confirmation beside its invoice). */
export interface Twin { of: string; why: TwinWhy; relation: 'duplicate' | 'companion' }

/** Days apart two copies of one document may be dated (a re-download carries the day it was made). */
const DAYS = 7;
/** A number in more receipts than this belongs to the vendor or to us (a customer number, an account), not to one document. */
const RARE = 3;
/** Words two texts share, of the words either has, from which two same-day documents of one total are taken for one. */
const ALIKE = 0.6;
/** Days apart «same-day» allows: two documents of one total without a number in common are taken for one only by their words, and only this close. */
const ALIKE_DAYS = 1;
/** Days and shared words within which a document beside an invoice belongs to it. */
const COMPANION_DAYS = 31;
const COMPANION_WORDS = 0.4;

const day = (d: string) => Date.parse(d) / 86_400_000;
const near = (a: number, b: number) => Math.abs(a - b) < 0.011;
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The numbers a text carries that could name one document: 6+ characters with 5+ digits, separators removed. */
export function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(/[A-Z0-9][A-Z0-9\-/]{4,}[A-Z0-9]/g)) {
    const t = m[0].replace(/[-/]/g, '');
    if (t.length >= 6 && (t.match(/\d/g)?.length ?? 0) >= 5) out.add(t);
  }
  return out;
}

const labelRes = new WeakMap<DocumentsData, RegExp>();

/** The numbers the text labels as its own (Rechnungsnummer: …, Invoice # …). */
export function labelledNumbers(text: string, words: DocumentsData): Set<string> {
  let re = labelRes.get(words);
  if (!re) {
    const labels = [...words.receipt.number].sort((a, b) => b.length - a.length).map(escape).join('|');
    re = new RegExp(`(?<![\\p{L}])(?:${labels})(?![\\p{L}])[\\s:#.]*(?:no\\.?|nr\\.?|n°|#)?[\\s:#.]*([A-Z0-9][A-Z0-9\\-/]{2,}[A-Z0-9])`, 'giu');
    labelRes.set(words, re);
  }
  const out = new Set<string>();
  // matchAll works on a copy of the pattern: the one kept per jurisdiction's words keeps no position.
  for (const m of text.matchAll(re)) {
    const t = m[1].toUpperCase().replace(/[-/]/g, '');
    if (/\d/.test(t) && t.length >= 4) out.add(t);
  }
  return out;
}

interface Prepared {
  r: Comparable;
  text: string;
  words: Set<string>;
  ids: Set<string>;
  numbers: Set<string>;
  vatId?: string;
  /** The receipt's day as a number of days, read once: NaN for a date Date.parse cannot read. */
  day?: number;
}

const wordSet = (t: string) => new Set(t.split(/[^\p{L}\d]+/u).filter((w) => w.length > 2));
const both = (a: Set<string>, b: Set<string>) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };
/** Of the words either has, the share both have. */
const jaccard = (a: Set<string>, b: Set<string>) => (a.size && b.size ? both(a, b) / (a.size + b.size - both(a, b)) : 0);
/** Of the words the shorter text has, the share the other has too: an order confirmation is a part of its invoice. */
const overlap = (a: Set<string>, b: Set<string>) => (a.size && b.size ? both(a, b) / Math.min(a.size, b.size) : 0);

/** Receipts that are not candidates for a copy: what is no receipt, and a copy already confirmed. */
const outOfPlay = (r: Comparable) => r.kind === 'noise' || r.kind === 'statement' || r.kind === 'duplicate';

type Match = { why: TwinWhy; score: number };

/** Why `a` and `b` are one document (or, `companion`, a document and its invoice), and how sure: higher is surer. */
function same(a: Prepared, b: Prepared, df: Map<string, number>, companion: boolean): Match | undefined {
  if (a.r.distinctFrom?.includes(b.r.id) || b.r.distinctFrom?.includes(a.r.id)) return undefined;
  const x = a.r.amount, y = b.r.amount;
  // The same text with other facts read off it is no copy: what was read wins.
  if (a.text.length > 40 && a.text === b.text && (x === undefined || y === undefined || near(x, y))) return { why: 'same-text', score: 3 };
  // Asked only once the cheaper facts leave the pair open.
  const sharedRare = () => [...a.ids].some((t) => b.ids.has(t) && (df.get(t) ?? 0) <= RARE);
  const apart = a.r.date && b.r.date ? Math.abs(a.day! - b.day!) : undefined;
  if (companion) {
    // A number only these documents carry ties them whenever they are dated and whatever they
    // total: a reminder comes weeks later, often with a fee on top.
    if (sharedRare()) return { why: 'same-number', score: 2 };
    // An order confirmation comes before its invoice, a delivery note with it; one carries no total.
    if (apart !== undefined && apart > COMPANION_DAYS) return undefined;
    if (x !== undefined && y !== undefined && !near(x, y)) return undefined;
    const o = overlap(a.words, b.words);
    return o >= COMPANION_WORDS ? { why: 'same-facts', score: o } : undefined;
  }
  // Each labels its own number and neither carries the other's: two documents.
  const differ = a.numbers.size > 0 && b.numbers.size > 0 && ![...a.numbers].some((n) => b.ids.has(n) || b.numbers.has(n)) && ![...b.numbers].some((n) => a.ids.has(n));
  if (differ) return undefined;
  if (x === undefined || y === undefined) return sharedRare() && [...a.numbers].some((n) => b.numbers.has(n)) ? { why: 'same-number', score: 2 } : undefined;
  if (!near(x, y) || Math.abs(x) < 0.005) return undefined;
  if (a.r.currency && b.r.currency && a.r.currency !== b.r.currency) return undefined;
  if (apart === undefined || apart > DAYS) return undefined;
  if (sharedRare()) return { why: 'same-number', score: 2 };
  // Each carries a number no other receipt has: two documents of one kind (two postage receipts of a day).
  const ownNumber = (p: Prepared) => [...p.ids].some((t) => df.get(t) === 1);
  if (ownNumber(a) && ownNumber(b) || apart > ALIKE_DAYS) return undefined;
  const j = jaccard(a.words, b.words);
  return j >= ALIKE || (a.vatId && a.vatId === b.vatId && j >= ALIKE / 2) ? { why: 'same-facts', score: j } : undefined;
}

type Entry = { p: Prepared; supporting: boolean };

/** The positions in `list` (sorted by day) whose day lies within `days` of `at`, give or take one. */
function within(list: ReadonlyArray<{ day: number; i: number }>, at: number, days: number): number[] {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].day < at - days - 1) lo = mid + 1; else hi = mid; }
  const out: number[] = [];
  for (let k = lo; k < list.length && list[k].day <= at + days + 1; k++) out.push(list[k].i);
  return out;
}

/**
 * Of `all`, every entry `same` could pair with a receipt, in `all`'s order (which decides between
 * equal matches): the same text, a rare number in common, a day within COMPANION_DAYS of a
 * document of the other kind or within ALIKE_DAYS of one of its own kind, and every entry without
 * a day it can compare. The rest `same` refuses whatever else they carry, so a search over a year
 * of receipts looks at the few near each one instead of all of them.
 */
function candidatePool(all: readonly Entry[]): (me: Prepared, mine: boolean, counts: Map<string, number>) => number[] {
  const byText = new Map<string, number[]>();
  const byId = new Map<string, number[]>();
  const dated = { supporting: [] as Array<{ day: number; i: number }>, plain: [] as Array<{ day: number; i: number }> };
  const undated: number[] = [];
  const add = (index: Map<string, number[]>, key: string, i: number) => { const list = index.get(key); if (list) list.push(i); else index.set(key, [i]); };
  all.forEach(({ p, supporting }, i) => {
    if (p.text.length > 40) add(byText, p.text, i);
    for (const t of p.ids) add(byId, t, i);
    if (p.day === undefined || !Number.isFinite(p.day)) undated.push(i);
    else (supporting ? dated.supporting : dated.plain).push({ day: p.day, i });
  });
  for (const list of [dated.supporting, dated.plain]) list.sort((a, b) => a.day - b.day);
  const everyone = all.map((_, i) => i);
  return (me, mine, counts) => {
    if (me.day === undefined || !Number.isFinite(me.day)) return everyone;
    const found = new Set<number>(undated);
    for (const i of byText.get(me.text) ?? []) found.add(i);
    for (const t of me.ids) if ((counts.get(t) ?? 0) <= RARE) for (const i of byId.get(t) ?? []) found.add(i);
    for (const i of within(mine ? dated.plain : dated.supporting, me.day, COMPANION_DAYS)) found.add(i);
    if (!mine) for (const i of within(dated.plain, me.day, ALIKE_DAYS)) found.add(i);
    return [...found].sort((a, b) => a - b);
  };
}

export interface TwinFinder {
  /** The receipt `r` repeats or accompanies, among the receipts the finder was built on (never itself). */
  find(r: Comparable): Twin | undefined;
}

/**
 * A finder over `receipts`. `supporting(r)` says a receipt is a document beside an invoice (its
 * kind, or what its text says it is): a pair with one is a companion, not a duplicate.
 */
export function twinFinder(receipts: readonly Comparable[], words: DocumentsData, supporting: (r: Comparable) => boolean = (r) => r.kind === 'supporting'): TwinFinder {
  const prep = (r: Comparable): Prepared => {
    const text = norm(r.extractedText ?? '');
    return { r, text, words: wordSet(text), ids: identifiers(r.extractedText ?? ''), numbers: labelledNumbers(r.extractedText ?? '', words), vatId: r.vatId ?? vatIdIn(r.extractedText ?? ''), day: r.date ? day(r.date) : undefined };
  };
  const all = receipts.filter((r) => !outOfPlay(r)).map((r) => ({ p: prep(r), supporting: supporting(r) }));
  const prepared = new Map(all.map(({ p }) => [p.r, p]));
  const ids = new Set(all.map(({ p }) => p.r.id));
  const df = new Map<string, number>();
  for (const { p } of all) for (const t of p.ids) df.set(t, (df.get(t) ?? 0) + 1);
  const pool = candidatePool(all);
  return {
    find(r) {
      const me = prepared.get(r) ?? prep(r);
      const mine = supporting(r);
      const counts = ids.has(r.id) ? df : new Map([...df, ...[...me.ids].map((t) => [t, (df.get(t) ?? 0) + 1] as const)]);
      let best: (Twin & { score: number }) | undefined;
      for (const i of pool(me, mine, counts)) {
        const { p, supporting: theirs } = all[i];
        if (p.r.id === r.id || (mine && theirs)) continue;
        const companion = mine !== theirs;
        const m = same(me, p, counts, companion);
        if (!m) continue;
        const relation = companion ? 'companion' : 'duplicate';
        // A copy outranks a companion; then the surer match.
        if (!best || (best.relation === 'companion' && relation === 'duplicate') || (best.relation === relation && m.score > best.score)) best = { of: p.r.id, why: m.why, relation, score: m.score };
      }
      return best && { of: best.of, why: best.why, relation: best.relation };
    },
  };
}

/**
 * Every receipt of the books that repeats another, with the one it repeats. Of a pair, the copy is
 * the one without a link when the other has one, else the one that came later.
 */
export function duplicatesIn(receipts: readonly Comparable[], linked: ReadonlySet<string>, words: DocumentsData, supporting: (r: Comparable) => boolean = (r) => r.kind === 'supporting'): Map<string, Twin> {
  const finder = twinFinder(receipts, words, supporting);
  const order = (r: Comparable) => `${linked.has(r.id) ? 0 : 1}${r.indexedAt ?? ''}${r.filename ?? ''}`;
  const byId = new Map(receipts.map((r) => [r.id, r]));
  const out = new Map<string, Twin>();
  for (const r of receipts) {
    if (outOfPlay(r)) continue;
    const t = finder.find(r);
    if (!t) continue;
    const other = byId.get(t.of)!;
    const copy = t.relation === 'companion' ? (supporting(r) ? r : other) : order(r) > order(other) ? r : other;
    const original = copy === r ? other : r;
    if (!out.has(copy.id)) out.set(copy.id, { ...t, of: original.id });
  }
  return out;
}
