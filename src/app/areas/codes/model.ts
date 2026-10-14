/**
 * The VAT codes as the catalogue, the hover card and the histogram show them: the app's catalogue
 * (src/accounting/vat-codes.ts) grouped by family, and per code the period's entries with their
 * CHF and the VAT in them (vatLine, the figures the return counts). Pure.
 */
import type { JournalEntry } from '../../../types/index.js';
import type { Period } from '../../../accounting/periods.js';
import { chfAmount } from '../../../accounting/index.js';
import { vatCodes, VAT_CODE_FAMILIES, VAT_CODE_KINDS, lookupVatCode, type VatCodeEntry, type VatCodeFamily } from '../../../accounting/vat-codes.js';
import { vat } from '../../../engines/index.js';

/** The `?vat=` of the entries without a code. */
export const NO_VAT = 'none';

export interface CodeStat {
  /** As booked, with its minus; NO_VAT for the entries without one. */
  code: string;
  n: number;
  chf: number;
  /** The VAT in them, signed as the return counts it. */
  tax: number;
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Each code booked in the period, most used first. */
export function vatStats(entries: readonly JournalEntry[], period: Period): CodeStat[] {
  const by = new Map<string, CodeStat>();
  for (const e of entries) {
    if (e.date < period.from || e.date > period.to) continue;
    const code = e.vatCode || NO_VAT;
    const s = by.get(code) ?? by.set(code, { code, n: 0, chf: 0, tax: 0 }).get(code)!;
    s.n++;
    s.chf = round(s.chf + chfAmount(e));
    s.tax = round(s.tax + (vat().vatLine(e)?.tax ?? 0));
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.code.localeCompare(b.code));
}

/** The entries a `?vat=` keeps. */
export const hasVat = (vat: string) => (e: JournalEntry) => (vat === NO_VAT ? !e.vatCode : e.vatCode === vat);

export interface CodeRow {
  /** As booked: a minus code that was used gets a row of its own beside its code. */
  code: string;
  entry: VatCodeEntry;
  negative: boolean;
  /** Entries of the period with this code. */
  n: number;
}

export interface CodeGroup { family: VatCodeFamily; rows: CodeRow[] }

const kindIndex = (e: VatCodeEntry) => VAT_CODE_KINDS.findIndex((k) => k.kind === e.kind && k.family === e.family);
const unsigned = (code: string) => code.replace(/^-/, '');

/**
 * The catalogue and every code used in the period, by family in the form's order; within a
 * family by kind, then by code (I0 before I26 before I81, -I81 after I81). `text` gives the words a
 * search looks in beside the code.
 */
export function codeGroups(stats: readonly CodeStat[], text: (r: CodeRow) => string, q?: string, usedOnly?: boolean): CodeGroup[] {
  const used = new Map(stats.map((s) => [s.code, s.n]));
  const codes = [...new Set([...vatCodes().map((c) => c.code), ...stats.map((s) => s.code).filter((c) => c !== NO_VAT)])];
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const rows = codes.flatMap((code): CodeRow[] => {
    const found = lookupVatCode(code);
    return found ? [{ code, entry: found.entry, negative: found.negative, n: used.get(code) ?? 0 }] : [];
  })
    .filter((r) => !usedOnly || r.n > 0)
    .filter((r) => { const h = `${r.code} ${text(r)}`.toLowerCase(); return words.every((w) => h.includes(w)); })
    .sort((a, b) => kindIndex(a.entry) - kindIndex(b.entry)
      || unsigned(a.code).localeCompare(unsigned(b.code), 'de', { numeric: true })
      || a.code.length - b.code.length);
  return VAT_CODE_FAMILIES.map((family) => ({ family, rows: rows.filter((r) => r.entry.family === family) })).filter((g) => g.rows.length);
}

/** Codes named in a text (the catalogue's "Nicht wenn"), split out so each can link: ['Kunde im Ausland (', 'V0-E', ')…']. */
export function splitCodes(text: string): Array<{ text: string; code?: string }> {
  const out: Array<{ text: string; code?: string }> = [];
  const re = /(^|[\s(:,])(-?(?:VS|[VBMIKZF])\d*(?:-[A-Z12])?)(?=[\s).,:;]|$)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const code = m[2];
    if (!lookupVatCode(code)?.entry.bananaText) continue;
    const at = m.index! + m[1].length;
    out.push({ text: text.slice(last, at) }, { text: code, code });
    last = at + code.length;
  }
  out.push({ text: text.slice(last) });
  return out.filter((p) => p.text);
}
