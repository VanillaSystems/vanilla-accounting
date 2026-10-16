/**
 * A report spec run against the books (src/reports/spec.ts): every row, group total and overall
 * total comes from here, never from the model. Pure: the books, the invoices and the chart's names
 * in, the result out. Amounts are summed in Rappen per currency, so a payment in EUR is never
 * added to one in CHF.
 *
 * Bookings are read as an account's ledger reads them: with an account filter, each side of a
 * booking that lies on a filtered account is one row, positive on the account's normal side (an
 * expense on debit, a sale on credit), so a refund counts against it. Without one, each booking is
 * one row with its amount.
 */
import type { Index, JournalEntry } from '../types/index.js';
import type { Invoice, Issued } from '../invoices/model.js';
import { chfAmount } from '../accounting/ledger.js';
import { fromRappen, toRappen } from '../accounting/rappen.js';
import type { Period } from '../accounting/periods.js';
import { baseCurrency, chart, vat } from '../engines/index.js';
import { totals as invoiceTotals } from '../invoices/rules.js';
import { ledgerOf as receiptLedger } from '../app/areas/receipts/model.js';
import { vatInFigures, type VatInFigures } from '../app/areas/reports/model.js';
import { inRange, type Grouping, type ReportFilter, type ReportSection, type ReportSpec } from './spec.js';

export interface ReportRow {
  date: string;
  text: string;
  account: string;
  counterAccount: string;
  vatCode: string;
  amount: number;
  net: number;
  tax: number;
  /** The currency of `amount`: a booking's is the books' currency, whatever the payment was paid in. */
  currency: string;
  /** The receipts' file names, ` | ` between them. */
  receipt: string;
  counterparty: string;
  /** What the row is, for a link to it. */
  link: { kind: 'entry' | 'payment' | 'receipt' | 'invoice'; id: string };
}

/** The sums of rows in one currency. */
export interface Totals { currency: string; count: number; amount: number; net: number; tax: number }

export interface ReportGroup {
  /** The month (2026-07), the quarter (2026-Q3), the account, the other party or the VAT code; '' for none of them. */
  key: string;
  /** The account's or the other party's name; '' where the key says it. */
  label: string;
  rows: ReportRow[];
  totals: Totals[];
}

export interface SectionResult {
  section: ReportSection;
  groups: ReportGroup[];
  totals: Totals[];
  count: number;
}

export interface ReportResult {
  spec: ReportSpec;
  period: Period;
  currency: string;
  sections: SectionResult[];
  totals: Totals[];
  count: number;
  /** The VAT the shown bookings hold in their gross amounts, not yet settled (as Bilanz and ER say it); absent when none carries a code. */
  vat?: VatInFigures;
}

export interface ReportInput {
  books: Index;
  invoices: readonly Invoice[];
  names: Record<string, string>;
}

const inside = (p: Period, d: string | undefined) => !!d && d >= p.from && d <= p.to;
const lower = (s: string) => s.toLocaleLowerCase('de-CH');

/** The receipts linked to each payment, as file names. */
function receiptsByRef(books: Index): Map<string, string[]> {
  const byId = new Map(books.receipts.map((r) => [r.id, r.filename]));
  const out = new Map<string, string[]>();
  for (const m of books.mappings) {
    const f = byId.get(m.receiptId);
    if (f) out.set(m.transactionRef, [...(out.get(m.transactionRef) ?? []), f]);
  }
  return out;
}

/** The tax and the net of a booking's amount (signed as the row is), as its VAT code declares them. */
function vatOf(e: JournalEntry, amount: number): { net: number; tax: number } {
  const line = vat().vatLine(e);
  const info = e.vatCode ? vat().codes.parse(e.vatCode) : null;
  if (!line || !info) return { net: amount, tax: 0 };
  const sign = amount < 0 ? -1 : 1;
  if (info.amountIs === 'tax') return { net: 0, tax: amount };
  const tax = sign * Math.abs(line.tax);
  return { net: info.amountIs === 'net' ? amount : fromRappen(toRappen(amount) - toRappen(tax)), tax };
}

function textMatches(f: ReportFilter, ...texts: Array<string | undefined>): boolean {
  return !f.text || texts.some((t) => !!t && lower(t).includes(lower(f.text!)));
}

const onAccounts = (f: ReportFilter, a: string) => !f.accounts || f.accounts.some((r) => inRange(a, r));

function entryRows(s: ReportSection, books: Index, period: Period, files: Map<string, string[]>, matched: Set<JournalEntry>): ReportRow[] {
  const f = s.filter;
  const base = baseCurrency();
  const tx = new Map(books.transactions.map((t) => [t.ref, t]));
  const out: ReportRow[] = [];
  for (const e of books.journalEntries ?? []) {
    if (!inside(period, e.date)) continue;
    if (f.vatCodes && !f.vatCodes.includes(e.vatCode ?? '')) continue;
    if (f.origins && !f.origins.includes(e.origin ?? 'other')) continue;
    if (f.currencies && !f.currencies.includes(e.exchangeCurrency || base)) continue;
    const receipts = files.get(e.transactionRef) ?? [];
    if (f.receipt && (f.receipt === 'with') !== receipts.length > 0) continue;
    const t = tx.get(e.transactionRef);
    const counterparty = t?.counterparty || t?.parts?.[0]?.counterparty || t?.description || e.description || '';
    if (!textMatches(f, e.description, counterparty)) continue;
    const legs = f.accounts
      ? [
        ...(e.accountDebit && onAccounts(f, e.accountDebit) ? [{ account: e.accountDebit, counter: e.accountCredit, sign: chart().isDebitNormal(e.accountDebit) ? 1 : -1 }] : []),
        ...(e.accountCredit && onAccounts(f, e.accountCredit) ? [{ account: e.accountCredit, counter: e.accountDebit, sign: chart().isDebitNormal(e.accountCredit) ? -1 : 1 }] : []),
      ]
      : [{ account: e.accountDebit || e.accountCredit, counter: e.accountDebit ? e.accountCredit : '', sign: 1 }];
    if (legs.length) matched.add(e);
    for (const l of legs) {
      const amount = l.sign * chfAmount(e);
      out.push({
        date: e.date, text: e.description || e.id, account: l.account, counterAccount: l.counter, vatCode: e.vatCode ?? '',
        amount, ...vatOf(e, amount), currency: base, receipt: receipts.join(' | '), counterparty, link: { kind: 'entry', id: e.id },
      });
    }
  }
  return out;
}

function paymentRows(s: ReportSection, books: Index, period: Period, files: Map<string, string[]>): ReportRow[] {
  const f = s.filter;
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of books.journalEntries ?? []) byRef.set(e.transactionRef, [...(byRef.get(e.transactionRef) ?? []), e]);
  return books.transactions.flatMap((t): ReportRow[] => {
    if (!inside(period, t.date)) return [];
    if (f.currencies && !f.currencies.includes(t.currency)) return [];
    const receipts = files.get(t.ref) ?? [];
    if (f.receipt && (f.receipt === 'with') !== receipts.length > 0) return [];
    const counterparty = t.counterparty || t.parts?.[0]?.counterparty || t.description;
    if (!textMatches(f, t.description, counterparty)) return [];
    const booked = [...new Set((byRef.get(t.ref) ?? []).flatMap((e) => [e.accountDebit, e.accountCredit]).filter(Boolean))];
    if (f.accounts && !booked.some((a) => onAccounts(f, a))) return [];
    const amount = t.direction === 'DBIT' ? -t.amount : t.amount;
    return [{
      date: t.date, text: t.description, account: t.bank, counterAccount: booked.join(' | '), vatCode: '',
      amount, net: amount, tax: 0, currency: t.currency, receipt: receipts.join(' | '), counterparty, link: { kind: 'payment', id: t.ref },
    }];
  });
}

function receiptRows(s: ReportSection, books: Index, period: Period): ReportRow[] {
  const f = s.filter;
  const base = baseCurrency();
  return receiptLedger(books, period.from).views.flatMap((v): ReportRow[] => {
    if (v.none || !inside(period, v.day)) return [];
    const currency = v.r.currency || base;
    if (f.currencies && !f.currencies.includes(currency)) return [];
    if (!textMatches(f, v.vendor, v.desc, v.r.description)) return [];
    const amount = v.r.amount ?? 0;
    const tax = fromRappen((v.r.vatSummary ?? []).reduce((n, g) => n + toRappen(g.vat), 0));
    return [{
      date: v.day!, text: [v.vendor, v.desc].filter(Boolean).join(' · '), account: '', counterAccount: '', vatCode: '',
      amount, net: fromRappen(toRappen(amount) - toRappen(tax)), tax, currency, receipt: v.r.filename, counterparty: v.vendor, link: { kind: 'receipt', id: v.r.id },
    }];
  });
}

function invoiceRows(s: ReportSection, invoices: readonly Invoice[], period: Period): ReportRow[] {
  const f = s.filter;
  return invoices.filter((i): i is Issued => i.status === 'issued' && !i.deleted && !i.cancelled && inside(period, i.date)).flatMap((i): ReportRow[] => {
    if (f.currencies && !f.currencies.includes(i.currency)) return [];
    const text = [i.number, i.customer.name, i.subject].filter(Boolean).join(' · ');
    if (!textMatches(f, text)) return [];
    const t = invoiceTotals(i.lines);
    return [{
      date: i.date, text, account: '', counterAccount: '', vatCode: '', amount: t.gross, net: t.net, tax: t.vat,
      currency: i.currency, receipt: '', counterparty: i.customer.name, link: { kind: 'invoice', id: i.number },
    }];
  });
}

/** The sums of `rows`, one per currency, the books' currency first. */
export function totalsOf(rows: readonly ReportRow[], first: string): Totals[] {
  const by = new Map<string, { count: number; amount: number; net: number; tax: number }>();
  for (const r of rows) {
    const t = by.get(r.currency) ?? { count: 0, amount: 0, net: 0, tax: 0 };
    t.count++; t.amount += toRappen(r.amount); t.net += toRappen(r.net); t.tax += toRappen(r.tax);
    by.set(r.currency, t);
  }
  return [...by].sort(([a], [b]) => Number(b === first) - Number(a === first) || a.localeCompare(b))
    .map(([currency, t]) => ({ currency, count: t.count, amount: fromRappen(t.amount), net: fromRappen(t.net), tax: fromRappen(t.tax) }));
}

const quarterOf = (d: string) => `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`;

function keyOf(g: Grouping, r: ReportRow): string {
  switch (g) {
    case 'none': return '';
    case 'month': return r.date.slice(0, 7);
    case 'quarter': return quarterOf(r.date);
    case 'account': return r.account;
    case 'counterparty': return r.counterparty;
    case 'vatCode': return r.vatCode;
  }
}

function groupsOf(g: Grouping, rows: ReportRow[], names: Record<string, string>, first: string): ReportGroup[] {
  const by = new Map<string, ReportRow[]>();
  for (const r of rows) { const k = keyOf(g, r); by.set(k, [...(by.get(k) ?? []), r]); }
  const keys = [...by.keys()].sort((a, b) => Number(a === '') - Number(b === '') || (g === 'counterparty' ? a.localeCompare(b, 'de-CH') : a.localeCompare(b)));
  return keys.map((key) => ({ key, label: g === 'account' ? names[key] ?? '' : '', rows: by.get(key)!, totals: totalsOf(by.get(key)!, first) }));
}

/** The spec run on `period` (its own period when none is given). */
export function runReport(spec: ReportSpec, input: ReportInput, period: Period): ReportResult {
  const { books, invoices, names } = input;
  const files = receiptsByRef(books);
  const matched = new Set<JournalEntry>();
  const first = baseCurrency();
  const sections = spec.sections.map((s): SectionResult => {
    const rows = s.source === 'entries' ? entryRows(s, books, period, files, matched)
      : s.source === 'payments' ? paymentRows(s, books, period, files)
        : s.source === 'receipts' ? receiptRows(s, books, period)
          : invoiceRows(s, invoices, period);
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.link.id.localeCompare(b.link.id));
    return { section: s, groups: groupsOf(s.group, rows, names, first), totals: totalsOf(rows, first), count: rows.length };
  });
  const all = sections.flatMap((s) => s.groups.flatMap((g) => g.rows));
  const vatIn = matched.size ? vatInFigures([...matched], period.from, period.to) : undefined;
  return { spec, period, currency: first, sections, totals: totalsOf(all, first), count: all.length, ...(vatIn ? { vat: vatIn } : {}) };
}

/** The result with only the first `n` rows of each section, for a card; every group and total stays that of all the rows. */
export function previewOf(r: ReportResult, n = 5): ReportResult {
  return {
    ...r,
    sections: r.sections.map((s) => {
      let left = n;
      return {
        ...s,
        groups: s.groups.map((g) => {
          const rows = g.rows.slice(0, Math.max(0, left));
          left -= rows.length;
          return { ...g, rows };
        }),
      };
    }),
  };
}

/**
 * The comment with its placeholders filled from the result: `{total}`, `{net}`, `{tax}` as amounts
 * (one per currency), `{count}`, `{period}`, `{from}`, `{to}`, `{title}`, `{sectionN.total}`.
 */
export function fillComment(r: ReportResult, money: (n: number, currency: string) => string, words: { period: string; date(iso: string): string }): string | undefined {
  if (!r.spec.comment) return undefined;
  const figure = (t: Totals[], f: string) => (f === 'count' ? String(t.reduce((n, x) => n + x.count, 0))
    : (t.length ? t : [{ currency: r.currency, amount: 0, net: 0, tax: 0, count: 0 }]).map((x) => money(f === 'total' ? x.amount : f === 'net' ? x.net : x.tax, x.currency)).join(' · '));
  return r.spec.comment.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    if (name === 'period') return words.period;
    if (name === 'from') return words.date(r.period.from);
    if (name === 'to') return words.date(r.period.to);
    if (name === 'title') return r.spec.title;
    const m = /^section(\d+)\.(\w+)$/.exec(name);
    if (m) return figure(r.sections[Number(m[1]) - 1]?.totals ?? [], m[2]);
    return figure(r.totals, name);
  });
}
