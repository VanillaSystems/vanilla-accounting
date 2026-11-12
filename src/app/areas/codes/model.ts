/**
 * The VAT codes as the catalogue, the hover card and the histogram show them: the app's catalogue
 * (src/accounting/vat-codes.ts) grouped by family, and per code the period's entries with their
 * CHF and the VAT in them (vatLine, the figures the return counts). Pure.
 */
import type { JournalEntry } from '../../../types/index.js';
import type { Period } from '../../../accounting/periods.js';
import { chfAmount } from '../../../accounting/index.js';
import { codeForRate, parseRate, firmCodes, VAT_CODE_FAMILIES, VAT_CODE_GROUPS, VAT_CODE_KINDS, lookupVatCode, vatCodeGroup, type VatCodeEntry, type VatCodeFamily, type VatCodeGroup } from '../../../accounting/vat-codes.js';
import { invoicing, vat } from '../../../engines/index.js';
import type { Key } from '../../i18n/types.js';

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
  const codes = [...new Set([...firmCodes().map((c) => c.code), ...stats.map((s) => s.code).filter((c) => c !== NO_VAT)])];
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

export interface PickOption { code: string; name: string }
export interface PickGroup { group: VatCodeGroup; options: PickOption[] }

/**
 * The code picker's list (issue #224): the codes the firm's form takes (firmCodes), grouped by what
 * the person is doing, in VAT_CODE_GROUPS order; current rates before the ones that ended in 2023,
 * then the kinds the booking guide chooses (V81) before the rare ones (V81-B), else catalogue order. A
 * query keeps the codes whose code or plain name (`name`) holds every word of it; one that starts
 * with «-» lists the minus codes, a refund or reversal. `fit` is the group the line's accounts take
 * (fittingGroup): its codes come first, and a typed rate («8.1») lists only them.
 */
export function pickGroups(q: string, name: (code: string) => string, fit?: VatCodeGroup): PickGroup[] {
  const typed = q.trim().toLowerCase();
  const minus = typed.startsWith('-');
  const words = typed.replace(/^-/, '').split(/\s+/).filter(Boolean);
  const options = firmCodes()
    .map((entry, i) => { const code = minus ? `-${entry.code}` : entry.code; return { entry, i, code, name: name(code) }; })
    .filter((o) => { const hay = `${o.code} ${o.name}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
    .sort((a, b) => Number(a.entry.superseded) - Number(b.entry.superseded) || Number(!a.entry.rules.length) - Number(!b.entry.rules.length) || a.i - b.i);
  const groups = VAT_CODE_GROUPS
    .map((group) => ({ group, options: options.filter((o) => vatCodeGroup(o.entry) === group).map(({ code, name }) => ({ code, name })) }))
    .filter((g) => g.options.length);
  const fitting = fit ? groups.filter((g) => g.group === fit) : [];
  if (!fitting.length) return groups;
  // A typed rate on a chosen account: the few codes of its kind (#344); anything else lists them first.
  return parseRate(typed) ? fitting : [...fitting, ...groups.filter((g) => g.group !== fit)];
}

/**
 * The group of codes a line's accounts take (issue #64: the account gives the code): a sale's for a
 * revenue account, material's or operating expenses' for an expense account. Undefined while the
 * accounts say neither or one side is still empty, so the picker lists every group.
 */
export function fittingGroup(accountDebit: string, accountCredit: string): VatCodeGroup | undefined {
  const rate = invoicing().rates.find((r) => r > 0);
  const code = rate === undefined || !accountDebit || !accountCredit ? null : codeForRate(rate, accountDebit, accountCredit);
  const found = code ? lookupVatCode(code) : null;
  return found ? vatCodeGroup(found.entry) : undefined;
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

/** The firm's own net tax rate row for `code` (F1, F2, or their minus), when the firm books at that rate. */
export const ownNetRate = (code: string) => vat().rateRows.find((r) => r.kind === 'net-rate' && r.code === code.replace(/^-/, ''));

/** A text of the dictionary with its variables; the UI renders it with `t`. */
export interface Words { key: Key; vars?: Record<string, string> }

export interface CodeExplanation {
  /** The firm's own rate, named as its row names it («1. Saldosteuersatz (Schreinerei)», German, for accountingName) with its percent; absent for a catalogue code. */
  own?: { name: string; rate: number };
  rate: number | null;
  name: Words;
  when: Words;
  notWhen: Words;
  /** In form order; null when this firm's return never declares the code. */
  ziffern: string[] | null;
}

/**
 * A code explained for this firm (r9n-25): a net tax rate the firm books at is its own code, named
 * with its label and rate, declared in the turnover box and its rate row of form 0553, explained as
 * the sale it books; any other code reads as the catalogue explains its kind. Pure: the words are
 * keys of the dictionary.
 */
export function codeExplanation(code: string): CodeExplanation {
  const found = lookupVatCode(code);
  const own = ownNetRate(code);
  if (own) {
    const form = vat().form;
    const vars = { code: own.code, turned: `-${own.code}`, rate: String(own.rate), ziffer: own.ziffer, form: form.form ?? '' };
    return { own: { name: own.name, rate: own.rate }, rate: own.rate, name: { key: 'vatCodes.kind.flatRate.name' }, when: { key: 'vatCodes.netRate.when', vars }, notWhen: { key: 'vatCodes.netRate.notWhen', vars }, ziffern: [form.turnoverBox, own.ziffer] };
  }
  if (!found) return { rate: null, name: { key: 'vatCodes.unknown' }, when: { key: 'vatCodes.unknown' }, notWhen: { key: 'vatCodes.unknown' }, ziffern: null };
  const e = found.entry;
  return { rate: e.rate, name: { key: `vatCodes.kind.${e.kind}.name` }, when: { key: `vatCodes.kind.${e.kind}.when` }, notWhen: { key: `vatCodes.kind.${e.kind}.notWhen` }, ziffern: e.ziffern ? e.ziffern.map((z) => z.ziffer) : null };
}
