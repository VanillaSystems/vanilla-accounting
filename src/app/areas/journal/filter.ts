/**
 * The fields Buchungen's chip filter offers (#211): account (debit or credit), the VAT code's rate,
 * Geschäftspartner, amount, month or days, currency, who booked it, receipt, correction of a filed
 * period, and text (the search box).
 */
import type { Field, FieldWords, Option } from '../../shell/chips.js';
import { rangeFields } from '../../shell/chips.js';
import { baseCurrency, vat } from '../../../engines/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import type { PartnerIndex } from '../partners/data.js';
import { JOURNAL_ORIGINS, whoOf, type EntryView } from './model.js';

/** Who booked it, as the count line says it; `other`: an entry no writer names (imported). */
export const WHO = [...JOURNAL_ORIGINS, 'other'] as const;
const whoValue = (v: EntryView): string => whoOf(v.e) ?? 'other';

const isOne = <T extends string>(xs: readonly T[], v: string): v is T => (xs as readonly string[]).includes(v);
const distinct = (xs: Iterable<string>) => [...new Set(xs)];

/** The rate of an entry's code, as a number's text («8.1», «0»), or `none` without a code the jurisdiction knows. */
export function rateOf(code: string | undefined): string {
  const rate = code ? vat().codes.parse(code)?.rate : undefined;
  return rate === undefined ? 'none' : String(rate);
}
const currencyOf = (v: EntryView) => v.e.exchangeCurrency || baseCurrency();

const RECEIPT = ['yes', 'no', 'missing'] as const;
const RECEIPT_TEST: Record<typeof RECEIPT[number], (v: EntryView) => boolean> = {
  yes: (v) => v.receipts.length > 0,
  no: (v) => v.receipts.length === 0,
  missing: (v) => v.missing,
};

export function journalFields(accountName: (n: string) => string, partners: PartnerIndex | undefined, { say: t, monthName }: FieldWords): Array<Field<EntryView>> {
  const rateLabel = (v: string) => (v === 'none' ? t('chips.rate.noCode') : `${v.replace('.', t('chips.decimal'))} %`);
  const pick = (id: string, label: () => string, options: (rows: readonly EntryView[]) => Option[], valueLabel: (v: string) => string, test: Field<EntryView>['test'], multi = true): Field<EntryView> =>
    ({ id, label, input: 'pick', multi, options, valueLabel, test });
  const [over, under, amount, month, from, to] = rangeFields<EntryView>((v) => v.e.amount, (v) => v.e.date, {
    over: () => t('chips.field.over'), under: () => t('chips.field.under'), exact: () => t('chips.field.amount'),
    month: () => t('chips.field.month'), from: () => t('chips.field.from'), to: () => t('chips.field.to'),
    money: fmt, day: formatDate, monthName,
  });
  const account = (n: string) => (accountName(n) ? `${n} ${accountName(n)}` : n);
  return [
    pick('account', () => t('chips.field.account'),
      (rows) => distinct(rows.flatMap((v) => [v.e.accountDebit, v.e.accountCredit].filter(Boolean))).sort().map((n) => ({ value: n, label: account(n) })),
      account,
      (n) => (/^[\w.-]+$/.test(n) ? (v) => v.e.accountDebit === n || v.e.accountCredit === n : undefined)),
    pick('rate', () => t('chips.field.rate'),
      (rows) => distinct(rows.map((v) => rateOf(v.e.vatCode))).sort((a, b) => (a === 'none' ? 1 : b === 'none' ? -1 : Number(b) - Number(a))).map((r) => ({ value: r, label: rateLabel(r) })),
      rateLabel,
      (r) => (r === 'none' || /^\d+(\.\d+)?$/.test(r) ? (v) => rateOf(v.e.vatCode) === r : undefined)),
    pick('partner', () => t('chips.field.partner'),
      (rows) => distinct(rows.flatMap((v) => partners?.ofEntry(v.e.id) ?? [])).map((id) => ({ value: id, label: partners?.name(id) ?? id })).sort((a, b) => a.label.localeCompare(b.label)),
      (id) => partners?.name(id) ?? id,
      (id) => (v) => !!partners?.ofEntry(v.e.id).includes(id)),
    month, from, to, over, under, amount,
    pick('currency', () => t('chips.field.currency'),
      (rows) => distinct(rows.map(currencyOf)).sort().map((c) => ({ value: c, label: c })),
      (c) => c,
      (c) => (/^[A-Z]{3}$/.test(c) ? (v) => currencyOf(v) === c : undefined)),
    pick('who', () => t('chips.field.who'),
      (rows) => WHO.filter((w) => rows.some((v) => whoValue(v) === w)).map((w) => ({ value: w, label: t(`journal.origin.${w}`) })),
      (w) => (isOne(WHO, w) ? t(`journal.origin.${w}`) : w),
      (w) => (isOne(WHO, w) ? (v) => whoValue(v) === w : undefined)),
    pick('receipt', () => t('chips.field.receipt'),
      () => RECEIPT.map((r) => ({ value: r, label: t(`chips.receipt.${r}`) })),
      (r) => (isOne(RECEIPT, r) ? t(`chips.receipt.${r}`) : r),
      (r) => (isOne(RECEIPT, r) ? RECEIPT_TEST[r] : undefined), false),
    pick('corrects', () => t('chips.field.corrects'),
      () => [{ value: 'yes', label: t('chips.yes') }, { value: 'no', label: t('chips.no') }],
      (y) => (y === 'yes' ? t('chips.yes') : t('chips.no')),
      (y) => (y === 'yes' ? (v) => !!v.e.corrects : y === 'no' ? (v) => !v.e.corrects : undefined), false),
    { id: 'text', label: () => t('chips.field.text'), input: 'text', multi: false, valueLabel: (v) => v, test: () => undefined },
  ];
}
