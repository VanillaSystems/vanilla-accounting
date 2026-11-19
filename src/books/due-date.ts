/**
 * The day a bill is due, as its text states it (#571): a date after one of the jurisdiction's due
 * words («zahlbar bis 30.11.2026», «Due date 2026-11-30»), else its terms in days from the bill's own
 * date («zahlbar innert 30 Tagen», «10 Tage 2 % Skonto, 30 Tage netto»). Read by code from the text,
 * on every read of the books, so every receipt has it without a model and without a run; a due date
 * a person set (`Receipt.dueDate`) wins. Words come from documents.yaml (`receipt.due`, `dueTerms`).
 */
import type { Receipt } from '../types/index.js';
import type { DocumentsData } from '../core/modules/schema.js';

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole words of `words`, ignoring case, every match (words.ts wordsRe, global). */
const allWords = (words: readonly string[]) => new RegExp(`(?<![\\p{L}\\d])(?:${[...words].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\p{L}])`, 'giu');

/** 30.11.2026, 30.11.26, 30/11/2026, 2026-11-30. */
const DATE = /(?<!\d)(?:(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})|(\d{4})-(\d{2})-(\d{2}))(?![\d])/g;
/** A bill is due within this many days of its date, or its «due date» is something else (a contract's end, a delivery). */
const MAX_TERM = 400;
const DAY = 864e5;

const iso = (y: number, m: number, d: number): string | undefined => {
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d ? day.toISOString().slice(0, 10) : undefined;
};

const plusDays = (date: string, n: number) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);

/** The dates of a line, each with the column it starts at. */
function datesOf(line: string): Array<{ day: string; at: number }> {
  const out: Array<{ day: string; at: number }> = [];
  for (const m of line.matchAll(DATE)) {
    const day = m[4] ? iso(Number(m[4]), Number(m[5]), Number(m[6])) : iso(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1]));
    if (day) out.push({ day, at: m.index });
  }
  return out;
}

/** The term in days a text after a due word states: the one named net, else the longest (a Skonto's term is the shorter). */
function termOf(rest: string, terms: NonNullable<DocumentsData['dueTerms']>): number | undefined {
  const days = terms.days.map(escape).join('|');
  const net = terms.net.map(escape).join('|');
  if (!days) return undefined;
  const found: Array<{ n: number; net: boolean }> = [];
  const re = new RegExp(`(?<![\\d.,])(\\d{1,3})\\s*(?:${days})(?![\\p{L}])(\\s*(?:${net || '(?!)'})(?![\\p{L}]))?`, 'giu');
  for (const m of rest.matchAll(re)) found.push({ n: Number(m[1]), net: !!m[2] });
  if (net) for (const m of rest.matchAll(new RegExp(`(?<![\\p{L}])(?:${net})\\s*(\\d{1,3})\\s*(?:${days})(?![\\p{L}])`, 'giu'))) found.push({ n: Number(m[1]), net: true });
  const named = found.filter((f) => f.net);
  const pick = (named.length ? named : found).map((f) => f.n);
  return pick.length ? Math.max(...pick) : undefined;
}

/**
 * The due date `text` states, for a bill dated `issued`. A date after a due word on its line wins;
 * a label above its value (a column head) takes the date of the next line nearest its column. Without
 * a date, the terms in days count from `issued`. A day before the bill's date or more than MAX_TERM
 * days after it is no due date of it.
 */
export function dueDateIn(text: string, issued: string | undefined, words: DocumentsData): string | undefined {
  const labels = [...words.receipt.due, ...(words.dueTerms?.labels ?? [])];
  if (!labels.length || !text) return undefined;
  const fits = (day: string) => !issued || (day >= issued && Date.parse(day) - Date.parse(issued) <= MAX_TERM * DAY);
  const lines = text.split('\n');
  let term: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(allWords(labels))) {
      const after = lines[i].slice(m.index + m[0].length);
      // Terms on the label's line win over a date beside them («30 Tage netto, Rechnungsdatum 12.10.2026»).
      const own = words.dueTerms && after.trim() ? termOf(after, words.dueTerms) : undefined;
      if (own !== undefined) { term ??= own; continue; }
      const same = datesOf(after).find((d) => fits(d.day));
      if (same) return same.day;
      const below = datesOf(lines[i + 1] ?? '').filter((d) => fits(d.day)).sort((a, b) => Math.abs(a.at - m.index) - Math.abs(b.at - m.index))[0];
      if (below && !after.trim()) return below.day;
      if (term === undefined && words.dueTerms) term = termOf(after.trim() ? after : lines[i + 1] ?? '', words.dueTerms);
    }
  }
  // «30 Tage netto» without a due word before it is a bill's terms too.
  if (term === undefined && words.dueTerms?.net.length && hasNetTerm(text, words.dueTerms)) term = termOf(text, words.dueTerms);
  if (term === undefined || !issued) return undefined;
  const day = plusDays(issued, term);
  return fits(day) ? day : undefined;
}

/** The text names a term net («30 Tage netto») outside a due word's line. */
function hasNetTerm(text: string, terms: NonNullable<DocumentsData['dueTerms']>): boolean {
  const days = terms.days.map(escape).join('|');
  const net = terms.net.map(escape).join('|');
  // Only «30 Tage netto» closing its phrase: «5 days net weight» or a Skonto table's «Netto 14 Tage» is no bill's term.
  return new RegExp(`\\d{1,3}\\s*(?:${days})\\s*(?:${net})(?=\\s*(?:[.,;)]|$))`, 'imu').test(text);
}

/** Where a receipt's due date comes from: a person's, or its text's. */
export type DueSource = 'hand' | 'read';

/** A receipt's due date and where it comes from, or undefined: hers first, else what its text states. */
export function dueOf(r: Pick<Receipt, 'dueDate' | 'extractedText' | 'date'>, words: DocumentsData): { day: string; by: DueSource } | undefined {
  if (r.dueDate) return { day: r.dueDate, by: 'hand' };
  const day = dueDateIn(r.extractedText ?? '', r.date || undefined, words);
  return day ? { day, by: 'read' } : undefined;
}
