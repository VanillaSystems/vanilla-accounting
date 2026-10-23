/**
 * A report the owner asks for (docs/reports.md): a spec, never figures. The AI or the form of
 * Bilanz & ER › Eigene Berichte writes it; code runs it against the books (src/reports/run.ts) and
 * fills every figure, also the ones its comment names as placeholders. One data shape for every
 * report: sections, each a query over one source with filters, a grouping and columns.
 *
 * Parsed here at the boundary twice: `parseSpec` checks the shape (what the AI's block, a saved
 * file and the form send), `checkSpec` the facts of this firm (its chart, its VAT codes). Both
 * answer a typed refusal the UI says in the person's words.
 */
import { localToday, parsePeriod, type IsoDate } from '../accounting/periods.js';
import { DIMENSION_ID, tagValue, type TagFilter } from '../books/tags.js';

export const SOURCES = ['entries', 'payments', 'receipts', 'invoices'] as const;
export type Source = typeof SOURCES[number];

export const GROUPINGS = ['none', 'month', 'quarter', 'account', 'counterparty', 'vatCode'] as const;
/** By the value of a reporting dimension the bookings carry (#127): `tag:projekt`. */
export type TagGrouping = `tag:${string}`;
export type Grouping = typeof GROUPINGS[number] | TagGrouping;
export const isTagGrouping = (g: string): g is TagGrouping => g.startsWith('tag:') && DIMENSION_ID.test(g.slice(4));
/** The dimension a tag grouping groups by. */
export const groupDimension = (g: Grouping): string | undefined => (isTagGrouping(g) ? g.slice(4) : undefined);

export const COLUMNS = ['date', 'text', 'account', 'counterAccount', 'vatCode', 'amount', 'net', 'tax', 'currency', 'receipt'] as const;
export type Column = typeof COLUMNS[number];

/** Who wrote a booking (JournalEntry.origin), `other` for a booking without one. */
export const ORIGINS = ['classify', 'manual', 'invoice', 'year-close', 'other'] as const;
export type Origin = typeof ORIGINS[number];

export const FILTERS = ['accounts', 'vatCodes', 'text', 'origins', 'receipt', 'currencies', 'tags'] as const;
export type FilterKey = typeof FILTERS[number];

/** One account (`from === to`) or a range of them, both ends included: "6510", "6000-6999". */
export interface AccountRange { from: string; to: string }

export interface ReportFilter {
  /** Bookings on one of these accounts, either side; a payment's bookings for a payment. */
  accounts?: AccountRange[];
  vatCodes?: string[];
  /** A part of the text or the other party's name, any case. */
  text?: string;
  origins?: Origin[];
  /** With or without a receipt linked to the payment. */
  receipt?: 'with' | 'without';
  currencies?: string[];
  /** Bookings that carry one of these values per dimension named (#127); '' the bookings without a value. */
  tags?: TagFilter;
}

export interface ReportSection {
  title?: string;
  source: Source;
  filter: ReportFilter;
  group: Grouping;
  columns: Column[];
}

export interface ReportSpec {
  title: string;
  /** A period token of src/accounting/periods.ts: 2026, 2026-H1, 2026-Q3, 2026-09, 2026-01-01..2026-03-31, last-quarter, ytd. */
  period: string;
  sections: ReportSection[];
  /** Words around the figures: only placeholders (`{total}`, `{section1.count}`) carry numbers, filled by code. */
  comment?: string;
}

/** What each source can be asked: the filters, groupings and columns that mean something for it. */
export const SOURCE_TAKES: Record<Source, { filters: readonly FilterKey[]; groups: readonly Grouping[]; columns: readonly Column[]; default: readonly Column[]; tags?: true }> = {
  // Only bookings carry tags: they alone are grouped by a dimension (`tags`).
  entries: { filters: FILTERS, groups: GROUPINGS, columns: COLUMNS, default: ['date', 'text', 'account', 'counterAccount', 'vatCode', 'amount'], tags: true },
  payments: {
    filters: ['accounts', 'text', 'receipt', 'currencies'],
    groups: ['none', 'month', 'quarter', 'account', 'counterparty'],
    columns: ['date', 'text', 'account', 'counterAccount', 'amount', 'currency', 'receipt'],
    default: ['date', 'text', 'account', 'amount', 'currency', 'receipt'],
  },
  receipts: {
    filters: ['text', 'currencies'],
    groups: ['none', 'month', 'quarter', 'counterparty'],
    columns: ['date', 'text', 'amount', 'net', 'tax', 'currency', 'receipt'],
    default: ['date', 'text', 'amount', 'tax', 'currency', 'receipt'],
  },
  invoices: {
    filters: ['text', 'currencies'],
    groups: ['none', 'month', 'quarter', 'counterparty'],
    columns: ['date', 'text', 'amount', 'net', 'tax', 'currency'],
    default: ['date', 'text', 'net', 'tax', 'amount', 'currency'],
  },
};

/** The figures a comment may name: overall, or of one section (`section2.total`). */
export const FIGURES = ['total', 'net', 'tax', 'count'] as const;
export type Figure = typeof FIGURES[number];
/** Words a comment may name besides the figures. */
const WORDS = ['period', 'from', 'to', 'title'] as const;

export type ReportRefusal =
  /** The spec is not what the app reads: `what` names the field. */
  | { code: 'shape'; params: { what: string } }
  | { code: 'period'; params: { period: string } }
  | { code: 'unknownAccount'; params: { account: string } }
  | { code: 'unknownVatCode'; params: { code: string } }
  /** A tag filter or grouping names a dimension the workspace does not declare (#127). */
  | { code: 'unknownDimension'; params: { dimension: string } }
  /** A filter, grouping or column that the section's source does not have. */
  | { code: 'notForSource'; params: { source: Source; what: string } }
  | { code: 'placeholder'; params: { name: string } }
  /** A number written into the comment: figures come from code only. */
  | { code: 'figureInComment'; params: { text: string } };

export type Parsed<T> = { ok: true; value: T } | { ok: false; refusal: ReportRefusal };

class Refused extends Error {
  constructor(readonly refusal: ReportRefusal) { super(refusal.code); }
}
const refuse = (r: ReportRefusal): never => { throw new Refused(r); };
const shape = (what: string): never => refuse({ code: 'shape', params: { what } });

const isOneOf = <T extends string>(xs: readonly T[], v: unknown): v is T => typeof v === 'string' && (xs as readonly string[]).includes(v);
const ACCOUNT = /^\s*(\d{3,6})\s*(?:[-–]\s*(\d{3,6})\s*)?$/;

/** "6510" or "6000-6999", or the object form; the lower end first. */
export function parseAccountRange(v: unknown): AccountRange {
  if (typeof v === 'number' && Number.isInteger(v)) return { from: String(v), to: String(v) };
  if (v && typeof v === 'object' && 'from' in v && 'to' in v) return parseAccountRange(`${String((v as AccountRange).from)}-${String((v as AccountRange).to)}`);
  const m = typeof v === 'string' ? ACCOUNT.exec(v) : null;
  if (!m) return shape(`accounts: ${JSON.stringify(v)}`);
  const [a, b] = [m[1], m[2] ?? m[1]];
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

export const accountRangeText = (r: AccountRange): string => (r.from === r.to ? r.from : `${r.from}-${r.to}`);

const list = (v: unknown, what: string): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : typeof v === 'string' || typeof v === 'number' ? [v] : shape(what));
const words = (v: unknown, what: string): string[] => list(v, what).map((x) => (typeof x === 'string' && x.trim() ? x.trim() : shape(what)));

function filterOf(v: unknown): ReportFilter {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return shape('filter');
  const f = v as Record<string, unknown>;
  for (const k of Object.keys(f)) if (!isOneOf(FILTERS, k)) shape(`filter.${k}`);
  const out: ReportFilter = {};
  const accounts = list(f.accounts, 'filter.accounts').map(parseAccountRange);
  if (accounts.length) out.accounts = accounts;
  const codes = words(f.vatCodes, 'filter.vatCodes');
  if (codes.length) out.vatCodes = codes;
  if (typeof f.text === 'string' && f.text.trim()) out.text = f.text.trim();
  else if (f.text !== undefined && f.text !== '') shape('filter.text');
  const origins = list(f.origins, 'filter.origins').map((o) => (isOneOf(ORIGINS, o) ? o : shape(`filter.origins: ${String(o)}`)));
  if (origins.length) out.origins = origins;
  if (f.receipt !== undefined) out.receipt = f.receipt === 'with' || f.receipt === 'without' ? f.receipt : shape('filter.receipt');
  const currencies = words(f.currencies, 'filter.currencies').map((c) => (/^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : shape(`filter.currencies: ${c}`)));
  if (currencies.length) out.currencies = currencies;
  if (f.tags !== undefined && f.tags !== null) {
    if (typeof f.tags !== 'object' || Array.isArray(f.tags)) shape('filter.tags');
    const tags: TagFilter = {};
    for (const [d, v] of Object.entries(f.tags as Record<string, unknown>)) {
      if (!DIMENSION_ID.test(d)) shape(`filter.tags.${d}`);
      // '' asks for the bookings without a value of the dimension.
      const values = list(v, `filter.tags.${d}`).map((x) => (x === '' ? '' : tagValue(x) ?? shape(`filter.tags.${d}`)));
      if (values.length) tags[d] = [...new Set(values)];
    }
    if (Object.keys(tags).length) out.tags = tags;
  }
  return out;
}

function sectionOf(v: unknown, i: number): ReportSection {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return shape(`sections[${i}]`);
  const s = v as Record<string, unknown>;
  const source = isOneOf(SOURCES, s.source) ? s.source : shape(`sections[${i}].source`);
  const takes = SOURCE_TAKES[source];
  const filter = filterOf(s.filter);
  for (const k of Object.keys(filter)) if (!takes.filters.includes(k as FilterKey)) refuse({ code: 'notForSource', params: { source, what: k } });
  const group: Grouping = s.group === undefined ? 'none' : isOneOf(GROUPINGS, s.group) || (typeof s.group === 'string' && isTagGrouping(s.group)) ? s.group : shape(`sections[${i}].group`);
  if (isTagGrouping(group) ? !takes.tags : !takes.groups.includes(group)) refuse({ code: 'notForSource', params: { source, what: group } });
  const asked = list(s.columns, `sections[${i}].columns`).map((c) => (isOneOf(COLUMNS, c) ? c : shape(`sections[${i}].columns: ${String(c)}`)));
  for (const c of asked) if (!takes.columns.includes(c)) refuse({ code: 'notForSource', params: { source, what: c } });
  const columns = asked.length ? [...new Set(asked)] : [...takes.default];
  const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim() : undefined;
  return { ...(title ? { title } : {}), source, filter, group, columns };
}

/** The placeholders a comment may hold for a spec of `sections` sections. */
export function placeholderNames(sections: number): string[] {
  return [...WORDS, ...FIGURES, ...Array.from({ length: sections }, (_, i) => FIGURES.map((f) => `section${i + 1}.${f}`)).flat()];
}

function commentOf(v: unknown, sections: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return shape('comment');
  const known = new Set(placeholderNames(sections));
  for (const m of v.matchAll(/\{([^{}]*)\}/g)) if (!known.has(m[1])) refuse({ code: 'placeholder', params: { name: m[1] } });
  const bare = v.replace(/\{[^{}]*\}/g, '');
  const digit = /\S*\d\S*/.exec(bare);
  if (digit) refuse({ code: 'figureInComment', params: { text: digit[0] } });
  return v.trim();
}

/** The spec as the AI, a saved file or the form gives it: its shape checked, defaults filled in. */
export function parseSpec(raw: unknown, today: IsoDate = localToday()): Parsed<ReportSpec> {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return shape('spec');
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 120) : shape('title');
    const period = typeof r.period === 'string' && r.period.trim() ? r.period.trim() : shape('period');
    if (!parsePeriod(period, today)) refuse({ code: 'period', params: { period } });
    const raws = Array.isArray(r.sections) ? r.sections : shape('sections');
    if (!raws.length || raws.length > 12) shape('sections');
    const sections = raws.map(sectionOf);
    const comment = commentOf(r.comment, sections.length);
    return { ok: true, value: { title, period, sections, ...(comment ? { comment } : {}) } };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, refusal: e.refusal };
    throw e;
  }
}

/** What a spec is checked against: the firm's chart and whether its form takes a VAT code. */
export interface SpecFacts { accounts: Record<string, string>; takesCode(code: string): boolean; dimensions?: readonly { id: string }[] }

/**
 * The firm's facts: an account a filter names is in the chart (a range holds one of its accounts),
 * a VAT code is one the firm's form knows, a dimension one it declares. A workspace without a chart has no accounts to check.
 */
export function checkSpec(spec: ReportSpec, facts: SpecFacts): ReportRefusal | undefined {
  const chart = Object.keys(facts.accounts);
  for (const s of spec.sections) {
    for (const r of chart.length ? s.filter.accounts ?? [] : []) {
      if (!chart.some((a) => inRange(a, r))) return { code: 'unknownAccount', params: { account: accountRangeText(r) } };
    }
    for (const c of s.filter.vatCodes ?? []) if (!facts.takesCode(c)) return { code: 'unknownVatCode', params: { code: c } };
    for (const d of [...Object.keys(s.filter.tags ?? {}), ...[groupDimension(s.group)].filter((x): x is string => !!x)]) {
      if (!facts.dimensions?.some((x) => x.id === d)) return { code: 'unknownDimension', params: { dimension: d } };
    }
  }
  return undefined;
}

/** An account inside a range: numbers of the same length compare as text, of different lengths by their leading digits. */
export function inRange(account: string, r: AccountRange): boolean {
  if (!account) return false;
  const width = Math.max(r.from.length, r.to.length);
  const a = account.length >= width ? account.slice(0, width) : account.padEnd(width, '0');
  return a >= r.from.padEnd(width, '0') && a <= r.to.padEnd(width, '9');
}

/** The spec as saved and sent: accounts as "6510" or "6000-6999", nothing that is a default left out. */
export function specData(spec: ReportSpec): Record<string, unknown> {
  return {
    title: spec.title,
    period: spec.period,
    sections: spec.sections.map((s) => ({
      ...(s.title ? { title: s.title } : {}),
      source: s.source,
      ...(Object.keys(s.filter).length ? { filter: { ...s.filter, ...(s.filter.accounts ? { accounts: s.filter.accounts.map(accountRangeText) } : {}) } } : {}),
      group: s.group,
      columns: s.columns,
    })),
    ...(spec.comment ? { comment: spec.comment } : {}),
  };
}
