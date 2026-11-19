/**
 * What never reaches a model (docs/specs/payroll.md §11, #508, §22 decision 108): before every prompt, system text and
 * judged state leaves the app, whatever kind the text has (a payslip, a fund's document, a receipt read before code told
 * them apart, a person's linked certificate):
 * - a social security number, found by the jurisdiction's pattern (payroll.yaml `socialSecurityNumber`), masked;
 * - the name of a person of payroll.json (`setMaskPeople`, set where the books are opened), as «[Person n]», given back in
 *   the model's answer (`unmaskFromModel`), so a rule or a booking that names her still reads as it was;
 * - on a line (a line of text, one written as `\n` inside a JSON string, never across a quote): what follows a
 *   person's label («Versicherte Person:»), a date beside a word of a birth date, and, once the text names a person,
 *   carries a social security number or a person's label, an amount beside a word of a wage (payroll.yaml
 *   `setupDocuments.personLabels`, `birth`, `wage`).
 * Without a jurisdiction loaded nothing is known to mask. An image or a PDF attached to a call is not masked: a picture
 * named as a fund's document is not read by vision (src/intake/read.ts), and payroll attaches none.
 */
import { payroll } from '../engines/index.js';

let cached: { source: string; re: RegExp; masked: string } | undefined;

function rule(): { re: RegExp; masked: string } | undefined {
  let p;
  try { p = payroll()?.socialSecurityNumber; } catch { return undefined; }
  if (!p?.pattern) return undefined;
  if (cached?.source !== p.pattern) cached = { source: p.pattern, re: new RegExp(p.pattern, 'g'), masked: p.masked };
  return cached;
}

/** Where the people of the open books' payroll.json come from: their full names, as each was written. */
let people: () => readonly string[] = () => [];
export function setMaskPeople(source: () => readonly string[]): void { people = source; }

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsRe = (list: readonly string[] | undefined) => (list?.length ? new RegExp(`(?<![\\p{L}\\d])(?:${[...list].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\p{L}\\d])`, 'iu') : undefined);
const DATE = /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g;
/** An amount: with thousands separators or two decimals («92'000.00», «300.00», «45'300»), never a year or a rate. */
const AMOUNT = /\d{1,3}(?:['’]\d{3})+(?:[.,]\d{1,2})?|\d+[.,]\d{2}(?!\d)/g;
const placeholder = (n: number) => `[Person ${n}]`;

/** A name's ways of being written: «First Last», «Last First», «Last, First», any space and case. */
function nameRe(full: string): RegExp | undefined {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  const [first, ...rest] = parts;
  const last = rest.map(escape).join('\\s+');
  return new RegExp(`(?<![\\p{L}])(?:${escape(first)}\\s+${last}|${last},?\\s+${escape(first)})(?![\\p{L}])`, 'giu');
}

function namesOf(): Array<{ re: RegExp; name: string; n: number }> {
  let list: readonly string[] = [];
  try { list = people(); } catch { list = []; }
  return [...new Set(list.map((n) => n.trim()).filter(Boolean))].flatMap((name, i) => { const re = nameRe(name); return re ? [{ re, name, n: i + 1 }] : []; });
}

let wordsCache: { of: unknown; label?: RegExp; birth?: RegExp; wage?: RegExp } | undefined;
function setupWords(): { label?: RegExp; birth?: RegExp; wage?: RegExp } | undefined {
  let sd;
  try { sd = payroll()?.setupDocuments; } catch { return undefined; }
  if (!sd) return undefined;
  // A label counts with its colon («Versicherte Person: …»): an instruction that speaks of «the insured person» is none.
  const label = sd.personLabels?.length ? new RegExp(`(?<![\\p{L}\\d])(?:${sd.personLabels.map(escape).join('|')})\\s*:`, 'iu') : undefined;
  if (wordsCache?.of !== sd) wordsCache = { of: sd, label, birth: wordsRe(sd.birth), wage: wordsRe(sd.wage) };
  return wordsCache;
}

/** `text` with every social security number, payroll person, person's label, birth date and (where a person is named) wage amount masked. */
export function maskForModel(text: string): string {
  const r = rule();
  let named = !!r && new RegExp(r.re.source).test(text);
  let out = r ? text.replace(r.re, r.masked) : text;
  for (const p of namesOf()) out = out.replace(p.re, () => { named = true; return placeholder(p.n); });
  const sd = setupWords();
  if (!sd) return out;
  const { label, birth, wage } = sd;
  // Segments: lines of text, the lines a JSON string writes as `\n`, and what stands between quotes: a JSON key, its number
  // and a string are each a segment of its own, so a prompt's own structure is never a receipt's line.
  const segments = out.split(/(\n|\\n|")/);
  if (label && segments.some((s) => label.test(s))) named = true;
  return segments.map((s, i) => {
    if (i % 2 === 1) return s;
    let t = s;
    const m = label?.exec(t);
    if (m) t = `${t.slice(0, m.index + m[0].length)} [Person]`;
    if (birth?.test(t)) t = t.replace(DATE, '[Datum]');
    if (named && wage?.test(t)) t = t.replace(AMOUNT, '[Betrag]');
    return t;
  }).join('');
}

/** A model's answer with the payroll's people named again where maskForModel's placeholders stand for them. */
export function unmaskFromModel(text: string): string {
  const byN = new Map(namesOf().map((p) => [p.n, p.name]));
  return byN.size ? text.replace(/\[Person (\d+)\]/g, (m, n: string) => byN.get(Number(n)) ?? m) : text;
}

/** A judged state (text or a plain object) with every number masked in its strings. */
export function maskState<T extends string | Record<string, unknown>>(state: T): T {
  if (typeof state === 'string') return maskForModel(state) as T;
  return JSON.parse(JSON.stringify(state), (_k, v) => (typeof v === 'string' ? maskForModel(v) : v)) as T;
}
