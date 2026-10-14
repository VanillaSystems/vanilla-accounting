/**
 * The export: what can be exported, in which formats, the presets, and the request the dialog
 * sends to POST /api/export. Pure, so the dialog (counts, presets) and the server (the bundle)
 * read the same lists.
 */
import type { Index } from '../types/index.js';
import { localToday, parsePeriod, type IsoDate, type Period } from '../accounting/periods.js';
import { ledgerOf as receiptLedger } from '../app/areas/receipts/model.js';
import { NO_ACCOUNT, openingOf } from '../app/areas/reports/model.js';

export const FORMATS = ['pdf', 'csv', 'xlsx', 'json', 'banana', 'orig'] as const;
export type Format = typeof FORMATS[number];

export const GROUPS = ['reports', 'data', 'documents'] as const;
export type Group = typeof GROUPS[number];

export const ITEM_IDS = [
  'income', 'balance', 'trial', 'vat', 'ledger', 'ledgers',
  'journal', 'payments', 'receiptList', 'chart',
  'receipts', 'statements', 'filings',
] as const;
export type ItemId = typeof ITEM_IDS[number];

export interface ItemDef { id: ItemId; group: Group; formats: readonly Format[] }

const TABLE: readonly Format[] = ['csv', 'xlsx', 'json'];
const REPORT: readonly Format[] = ['pdf', ...TABLE];

/** In the dialog's order; the first format is the one a tick chooses. */
export const ITEMS: readonly ItemDef[] = [
  { id: 'income', group: 'reports', formats: REPORT },
  { id: 'balance', group: 'reports', formats: REPORT },
  { id: 'trial', group: 'reports', formats: REPORT },
  { id: 'vat', group: 'reports', formats: REPORT },
  { id: 'ledger', group: 'reports', formats: REPORT },
  { id: 'ledgers', group: 'reports', formats: REPORT },
  { id: 'journal', group: 'data', formats: [...TABLE, 'banana'] },
  { id: 'payments', group: 'data', formats: TABLE },
  { id: 'receiptList', group: 'data', formats: TABLE },
  { id: 'chart', group: 'data', formats: TABLE },
  { id: 'receipts', group: 'documents', formats: ['orig'] },
  { id: 'statements', group: 'documents', formats: ['orig'] },
  { id: 'filings', group: 'documents', formats: ['orig'] },
];

export type Selection = Partial<Record<ItemId, Format[]>>;

/** What the dialog sends: a period token, what to export, and how. */
export interface ExportRequest {
  period: string;
  items: Selection;
  /** SHA256SUMS.txt and manifest.json beside the files. */
  sums: boolean;
  /** Every Excel table as a sheet of one workbook. */
  oneBook: boolean;
  /** The account of the `ledger` item. */
  account?: string;
  /** The language of the LIESMICH, the folders, the file names and the columns. */
  language: string;
}

export type PresetId = 'treuhand' | 'audit' | 'excel' | 'archive';

export interface Preset {
  id: PresetId;
  items: Selection;
  sums: boolean;
  oneBook: boolean;
  /** Which period it exports: the open quarter, the open quarter's year, or the page's period. */
  period: 'open' | 'year' | 'page';
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'treuhand', period: 'open', sums: true, oneBook: false,
    items: { income: ['pdf'], balance: ['pdf'], trial: ['pdf'], vat: ['pdf'], journal: ['banana', 'csv'], payments: ['csv'], receipts: ['orig'], statements: ['orig'], filings: ['orig'] },
  },
  {
    id: 'audit', period: 'year', sums: true, oneBook: false,
    items: { income: ['pdf'], balance: ['pdf'], trial: ['pdf'], vat: ['pdf', 'csv'], ledgers: ['pdf', 'csv'], journal: ['csv', 'json'], payments: ['csv', 'json'], receiptList: ['csv'], chart: ['csv'], receipts: ['orig'], statements: ['orig'], filings: ['orig'] },
  },
  {
    id: 'excel', period: 'page', sums: false, oneBook: true,
    items: { trial: ['xlsx'], ledgers: ['xlsx'], journal: ['xlsx'], payments: ['xlsx'], receiptList: ['xlsx'] },
  },
  {
    id: 'archive', period: 'year', sums: true, oneBook: false,
    items: { income: ['pdf', 'csv'], balance: ['pdf', 'csv'], trial: ['pdf', 'csv'], vat: ['pdf', 'csv'], ledgers: ['pdf', 'csv'], journal: ['csv', 'json'], payments: ['csv', 'json'], receiptList: ['csv', 'json'], chart: ['csv'], receipts: ['orig'], statements: ['orig'], filings: ['orig'] },
  },
];

/** A preset's period token: `open` is the open quarter, `year` its year, `page` the page's period. */
export function presetPeriod(p: Preset, open: Period, page: Period): string {
  return p.period === 'open' ? open.token : p.period === 'year' ? open.token.slice(0, 4) : page.token;
}

/** The quarters a period holds whole and that have ended by `today`: their returns go into the export. */
export function quartersIn(period: Period, today: IsoDate = localToday()): string[] {
  const out: string[] = [];
  const first = Number((period.kind === 'all' ? '2000' : period.from).slice(0, 4));
  const last = Number((period.kind === 'all' ? today : period.to).slice(0, 4));
  for (let y = first; y <= last; y++) {
    for (let q = 1; q <= 4; q++) {
      const p = parsePeriod(`${y}-Q${q}`, today)!;
      if (p.from >= period.from && p.to <= period.to && p.to < today) out.push(p.token);
    }
  }
  return out;
}

/** The receipts of a period as the Belege list holds them: dated (or read) in it, and a receipt of their own. */
export function receiptsIn(books: Index, period: Period) {
  return receiptLedger(books, period.from).views.filter((v) => !v.none && !!v.day && v.day >= period.from && v.day <= period.to);
}

export const statementsIn = (books: Index, period: Period) =>
  books.bankStatements.filter((s) => s.toDate >= period.from && s.fromDate <= period.to);

export const entriesIn = (books: Index, period: Period) =>
  (books.journalEntries ?? []).filter((e) => e.date >= period.from && e.date <= period.to);

/** Every account with an opening balance or an entry in the period, the one-sided entries' last. */
export function accountsWithActivity(books: Index, period: Period): string[] {
  const entries = books.journalEntries ?? [];
  const opening = openingOf(books, entries, period.from);
  const seen = new Set(Object.keys(opening).filter((a) => opening[a]));
  for (const e of entriesIn(books, period)) { seen.add(e.accountDebit || NO_ACCOUNT); seen.add(e.accountCredit || NO_ACCOUNT); }
  return [...seen].sort((a, b) => Number(a === NO_ACCOUNT) - Number(b === NO_ACCOUNT) || a.localeCompare(b));
}

export const paymentsIn = (books: Index, period: Period) =>
  books.transactions.filter((t) => t.date >= period.from && t.date <= period.to);

/** How many of an item a period holds: the dialog's hint and whether a tick is possible. Filings are counted by the server. */
export function countOf(id: ItemId, books: Index, period: Period, names: Record<string, string>, account?: string): number {
  switch (id) {
    case 'income': case 'balance': case 'trial': return 1;
    case 'vat': return quartersIn(period).length;
    case 'ledger': return account === undefined ? 0 : 1;
    case 'ledgers': return accountsWithActivity(books, period).length;
    case 'journal': return entriesIn(books, period).length;
    case 'payments': return paymentsIn(books, period).length;
    case 'receiptList': case 'receipts': return receiptsIn(books, period).length;
    case 'chart': return Object.keys(names).length;
    case 'statements': return statementsIn(books, period).length;
    case 'filings': return quartersIn(period).filter((q) => !!books.config?.closedThrough && parsePeriod(q, localToday())!.to <= books.config.closedThrough).length;
  }
}

export class BadRequest extends Error {}

/** The request body, checked at the boundary: only known items and formats, a period the app can read. */
export function parseRequest(body: unknown, today: IsoDate = localToday()): ExportRequest & { range: Period } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('JSON-Objekt erwartet.');
  const b = body as Record<string, unknown>;
  const range = typeof b.period === 'string' ? parsePeriod(b.period, today) : null;
  if (!range) throw new BadRequest(`Unbekannter Zeitraum: ${String(b.period)}`);
  if (!b.items || typeof b.items !== 'object') throw new BadRequest('items fehlt.');
  const items: Selection = {};
  for (const [id, formats] of Object.entries(b.items as Record<string, unknown>)) {
    const def = ITEMS.find((i) => i.id === id);
    if (!def) throw new BadRequest(`Unbekannter Teil: ${id}`);
    if (!Array.isArray(formats) || formats.some((f) => !def.formats.includes(f as Format))) throw new BadRequest(`Unbekanntes Format für ${id}: ${String(formats)}`);
    if (formats.length) items[def.id] = [...new Set(formats as Format[])];
  }
  if (!Object.keys(items).length) throw new BadRequest('Nichts gewählt.');
  if (items.ledger && typeof b.account !== 'string') throw new BadRequest('Für das Kontoblatt fehlt das Konto.');
  return {
    period: range.token, range, items, sums: b.sums === true, oneBook: b.oneBook === true,
    account: typeof b.account === 'string' ? b.account : undefined,
    language: typeof b.language === 'string' ? b.language : 'de',
  };
}
