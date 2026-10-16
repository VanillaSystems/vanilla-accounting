/**
 * The export's tables: every report and list as a head and rows, from the same functions the
 * pages use (the reports' and the MWST page's models, src/accounting). CSV, Excel, JSON and the
 * PDFs are written from these rows, so they hold the same figures.
 */
import type { Index } from '../types/index.js';
import type { Key } from '../app/i18n/types.js';
import { chfAmount } from '../accounting/ledger.js';
import { localToday, type FilingLength, type Period } from '../accounting/periods.js';
import { NO_ACCOUNT, ledgerOf, reportView } from '../app/areas/reports/model.js';
import { formAmount, rateOf, shownZiffern, vatReturn } from '../app/areas/vat/model.js';
import { accountsWithActivity, entriesIn, paymentsIn, quartersIn, receiptsIn, type ItemId } from './model.js';
import type { ReturnFigures } from '../engines/return.js';

export type Cell = string | number;
/** How the PDF sets a row: a total whose label spans the row, a bold row, the opening balance. */
export type RowStyle = 'total' | 'strong' | 'open' | undefined;

export interface Table {
  head: string[];
  rows: Cell[][];
  styles: RowStyle[];
  /** The columns that hold amounts: right-aligned, two decimals. */
  money: number[];
  /** A line under the title: the Bilanz and Erfolgsrechnung say that their figures hold the VAT not yet settled (r8c-2). */
  note?: string;
}

export interface Words {
  t(key: Key, vars?: Record<string, string | number>): string;
  accountingName(german: string): string;
}

export interface TableContext {
  books: Index;
  period: Period;
  names: Record<string, string>;
  words: Words;
  /** The returns as filed, by filing period. */
  filed: Record<string, ReturnFigures>;
  /** The firm's filing length: which periods the VAT table lists. */
  filingLength: FilingLength;
  account?: string;
}

const table = (head: string[], money: number[]): Table => ({ head, rows: [], styles: [], money });
const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt2 = (n: number) => r2(n).toFixed(2);

const REPORT_SUM: Record<string, Key> = {
  grossProfit: 'income.grossProfit', operatingResult: 'income.operatingResult', netResult: 'reports.result',
  totalAssets: 'balance.totalAssets', totalLiabilities: 'balance.totalLiabilities',
};

function receiptFiles(books: Index): (ref: string) => string {
  const byId = new Map(books.receipts.map((r) => [r.id, r.filename]));
  const byRef = new Map<string, string[]>();
  for (const m of books.mappings) {
    const f = byId.get(m.receiptId);
    if (f) byRef.set(m.transactionRef, [...(byRef.get(m.transactionRef) ?? []), f]);
  }
  return (ref) => (byRef.get(ref) ?? []).join(' | ');
}

export function tableOf(id: Exclude<ItemId, 'receipts' | 'statements' | 'filings'>, c: TableContext): Table {
  const { t } = c.words;
  const accName = (a: string) => (a === NO_ACCOUNT ? t('reports.noAccount') : c.names[a] ?? a);
  switch (id) {
    case 'income': case 'balance': {
      const out = table([t('export.colGroup'), t('col.account'), t('col.name'), t('col.amount')], [3]);
      const view = reportView(id, c.books, c.period, c.names, false);
      let side = '';
      for (const b of view.blocks) {
        if (b.kind === 'head') { side = t(b.title === 'assets' ? 'balance.assets' : 'balance.liabilities'); continue; }
        if (b.kind === 'sum') { out.rows.push([t(REPORT_SUM[b.title]), '', '', b.value]); out.styles.push('total'); continue; }
        const group = [side, c.words.accountingName(b.title)].filter(Boolean).join(' · ');
        for (const r of b.rows) { out.rows.push([group, r.account, accName(r.account), r.value]); out.styles.push(undefined); }
        if (b.plain) { out.rows.push([group, '', c.words.accountingName(b.plain.name), b.plain.value]); out.styles.push(undefined); }
        if (b.total != null) { out.rows.push([`${t('common.total')} ${c.words.accountingName(b.title)}`, '', '', b.total]); out.styles.push('total'); }
      }
      if (view.vat) {
        const vars = { net: fmt2(view.vat.net), owed: fmt2(view.vat.owed), input: fmt2(view.vat.input) };
        out.rows.push([t(id === 'income' ? 'reports.vatRowIncome' : 'reports.vatRowBalance', vars), '', '', view.vat.net]);
        out.styles.push('open');
        out.note = t(id === 'income' ? 'reports.vatMetaIncome' : 'reports.vatMetaBalance', vars);
      }
      return out;
    }
    case 'trial': {
      const out = table([t('col.account'), t('col.name'), t('reports.opening'), t('reports.debit'), t('reports.credit'), t('reports.balance')], [2, 3, 4, 5]);
      for (const b of reportView('trial', c.books, c.period, c.names, false).blocks) {
        if (b.kind !== 'group') continue;
        for (const r of b.rows) { out.rows.push([r.account, accName(r.account), r.open ?? 0, r.debit ?? 0, r.credit ?? 0, r.value]); out.styles.push(undefined); }
      }
      return out;
    }
    case 'vat': {
      const out = table([t('export.colQuarter'), t('export.colZiffer'), t('col.description'), t('col.amount'), t('export.colTax'), t('export.colFiled')], [3, 4, 5]);
      for (const q of quartersIn(c.period, localToday(), c.filingLength)) {
        const v = vatReturn(c.books, q);
        const filed = c.filed[q];
        for (const n of shownZiffern(v, filed, false)) {
          const rate = rateOf(v, n);
          const label = rate ? t(rate.row.kind === 'supply' ? 'vat.nSupply' : 'vat.nAcquisition', { rate: rate.row.rate }) : t(`vat.n${n}` as Key);
          out.rows.push([q, n, label, formAmount(v, n), rate ? r2(rate.tax) : '', filed?.ziffern[n] ?? '']);
          out.styles.push(['289', '299', '399', '479', '500', '510'].includes(n) ? 'strong' : undefined);
        }
      }
      return out;
    }
    case 'ledger': case 'ledgers': {
      const out = table([t('col.account'), t('export.colAccountName'), t('col.date'), t('vat.colEntry'), t('reports.counter'), t('export.colVat'), t('reports.debit'), t('reports.credit'), t('reports.balance'), t('export.colReceipt')], [6, 7, 8]);
      const files = receiptFiles(c.books);
      const accounts = id === 'ledger' ? (c.account === undefined ? [] : [c.account]) : accountsWithActivity(c.books, c.period);
      for (const a of accounts) {
        const l = ledgerOf(c.books, a, c.period);
        out.rows.push([a, accName(a), c.period.from, t('reports.openingBalance'), '', '', '', '', l.opening, '']);
        out.styles.push('open');
        for (const r of [...l.rows].reverse()) {
          out.rows.push([a, accName(a), r.date, r.description || r.entryId, r.other, r.entry?.vatCode ?? '', r.debit ?? '', r.credit ?? '', r.balance, r.entry ? files(r.entry.transactionRef) : '']);
          out.styles.push(undefined);
        }
      }
      return out;
    }
    case 'journal': {
      const out = table([t('col.date'), t('export.colEntryId'), t('col.ref'), t('col.description'), t('reports.debit'), t('reports.credit'), t('export.colVat'), t('col.amount'), t('export.colCurrency'), t('export.colRate'), 'CHF', t('export.colCorrects')], [7, 10]);
      const sorted = entriesIn(c.books, c.period).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
      for (const e of sorted) {
        const foreign = !!e.exchangeCurrency && e.exchangeCurrency !== 'CHF';
        out.rows.push([e.date, e.id, e.transactionRef, e.description ?? '', e.accountDebit, e.accountCredit, e.vatCode ?? '', e.amount, e.exchangeCurrency ?? 'CHF', foreign ? e.exchangeRate ?? '' : '', chfAmount(e), e.corrects ?? '']);
        out.styles.push(undefined);
      }
      return out;
    }
    case 'payments': {
      const out = table([t('col.date'), t('export.colBank'), t('col.amount'), t('export.colCurrency'), t('col.description'), t('col.ref'), t('export.colReceipts')], [2]);
      const files = receiptFiles(c.books);
      for (const x of paymentsIn(c.books, c.period).sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref))) {
        out.rows.push([x.date, x.bank, x.direction === 'DBIT' ? -x.amount : x.amount, x.currency, x.description, x.ref, files(x.ref)]);
        out.styles.push(undefined);
      }
      return out;
    }
    case 'receiptList': {
      const out = table([t('col.date'), t('export.colVendor'), t('col.description'), t('col.amount'), t('export.colCurrency'), t('export.colTax'), t('export.colVatId'), t('export.colFile'), t('export.colPayments')], [3, 5]);
      for (const v of receiptsIn(c.books, c.period).sort((a, b) => (a.day ?? '').localeCompare(b.day ?? ''))) {
        const tax = (v.r.vatSummary ?? []).reduce((s, g) => s + g.vat, 0);
        out.rows.push([v.date ?? '', v.vendor, v.desc, v.r.amount ?? '', v.r.currency ?? '', tax ? r2(tax) : '', v.r.vatId ?? '', v.r.filename, v.links.join(' | ')]);
        out.styles.push(undefined);
      }
      return out;
    }
    case 'chart': {
      const out = table([t('col.account'), t('col.name')], []);
      for (const [a, n] of Object.entries(c.names).sort(([a], [b]) => a.localeCompare(b))) { out.rows.push([a, n]); out.styles.push(undefined); }
      return out;
    }
  }
}
