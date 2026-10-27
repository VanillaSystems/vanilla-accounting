/**
 * The fields Belege's chip filter offers (#211): Geschäftspartner, state, month or days, amount,
 * currency, the VAT rate the receipt shows, kind, linked or not, text (the search box). Where a receipt came from (drop,
 * mail, phone, collection) is not kept on a receipt, so it is no field.
 */
import type { Field, FieldWords, Option } from '../../shell/chips.js';
import { rangeFields } from '../../shell/chips.js';
import { RECEIPT_KINDS } from '../../../types/index.js';
import { isUnreadable } from '../../../accounting/receipt-due.js';
import { baseCurrency } from '../../../engines/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import type { PartnerIndex } from '../partners/data.js';
import { isOpen, needsYou, type Ledger, type ReceiptView } from './model.js';

export const RECEIPT_STATES = ['linked', 'open', 'noDate', 'needsYou', 'unreadable', 'notReceipt', 'quarantine'] as const;
export type ReceiptState = typeof RECEIPT_STATES[number];

/** A state of a receipt in the books; `quarantine` is files the books do not hold, shown below the list. */
const STATE: Record<ReceiptState, (v: ReceiptView, l: Ledger) => boolean> = {
  linked: (v) => !v.none && !isOpen(v),
  open: (v) => !v.none && isOpen(v),
  noDate: (v) => !v.none && !v.date,
  needsYou: (v, l) => needsYou(v, l),
  unreadable: (v) => !v.none && isUnreadable(v.r),
  notReceipt: (v) => v.none,
  quarantine: () => false,
};

const isOne = <T extends string>(xs: readonly T[], v: string): v is T => (xs as readonly string[]).includes(v);
const distinct = (xs: Iterable<string>) => [...new Set(xs)];
export const kindOf = (v: ReceiptView): string => v.r.kind ?? 'invoice';
const currencyOf = (v: ReceiptView) => v.r.currency || baseCurrency();

export function receiptFields(l: Ledger, partners: PartnerIndex | undefined, { say: t, monthName }: FieldWords): Array<Field<ReceiptView>> {
  const rateLabel = (v: string) => (v === 'none' ? t('chips.rate.none') : `${v.replace('.', t('chips.decimal'))} %`);
  const pick = (id: string, label: () => string, options: (rows: readonly ReceiptView[]) => Option[], valueLabel: (v: string) => string, test: Field<ReceiptView>['test'], multi = true): Field<ReceiptView> =>
    ({ id, label, input: 'pick', multi, options, valueLabel, test });
  const [over, under, amount, month, from, to] = rangeFields<ReceiptView>((v) => v.r.amount, (v) => v.date, {
    over: () => t('chips.field.over'), under: () => t('chips.field.under'), exact: () => t('chips.field.amount'),
    month: () => t('chips.field.month'), from: () => t('chips.field.from'), to: () => t('chips.field.to'),
    money: fmt, day: formatDate, monthName,
  });
  return [
    pick('partner', () => t('chips.field.partner'),
      (rows) => distinct(rows.flatMap((v) => partners?.ofReceipt(v.r.id) ?? [])).map((id) => ({ value: id, label: partners?.name(id) ?? id })).sort((a, b) => a.label.localeCompare(b.label)),
      (id) => partners?.name(id) ?? id,
      (id) => (v) => partners?.ofReceipt(v.r.id) === id),
    pick('state', () => t('chips.field.state'),
      () => RECEIPT_STATES.map((s) => ({ value: s, label: t(`chips.state.${s}`) })),
      (s) => (isOne(RECEIPT_STATES, s) ? t(`chips.state.${s}`) : s),
      (s) => (isOne(RECEIPT_STATES, s) ? (v) => STATE[s](v, l) : undefined)),
    month, from, to, over, under, amount,
    pick('currency', () => t('chips.field.currency'),
      (rows) => distinct(rows.map(currencyOf)).sort().map((c) => ({ value: c, label: c })),
      (c) => c,
      (c) => (/^[A-Z]{3}$/.test(c) ? (v) => currencyOf(v) === c : undefined)),
    pick('rate', () => t('chips.field.rate'),
      (rows) => [
        ...distinct(rows.flatMap((v) => (v.r.vatSummary ?? []).map((g) => String(g.ratePercent)))).sort((a, b) => Number(b) - Number(a)),
        ...(rows.some((v) => v.r.hasSwissVat === false) ? ['none'] : []),
      ].map((r) => ({ value: r, label: rateLabel(r) })),
      rateLabel,
      (r) => (r === 'none' ? (v) => v.r.hasSwissVat === false : /^\d+(\.\d+)?$/.test(r) ? (v) => (v.r.vatSummary ?? []).some((g) => g.ratePercent === Number(r)) : undefined)),
    pick('kind', () => t('chips.field.kind'),
      (rows) => RECEIPT_KINDS.filter((k) => rows.some((v) => kindOf(v) === k)).map((k) => ({ value: k, label: t(`chips.kind.${k}`) })),
      (k) => (isOne(RECEIPT_KINDS, k) ? t(`chips.kind.${k}`) : k),
      (k) => (isOne(RECEIPT_KINDS, k) ? (v) => kindOf(v) === k : undefined)),
    pick('linked', () => t('chips.field.linked'),
      () => [{ value: 'yes', label: t('chips.yes') }, { value: 'no', label: t('chips.no') }],
      (y) => (y === 'yes' ? t('chips.yes') : t('chips.no')),
      (y) => (y === 'yes' ? (v) => v.links.length > 0 : y === 'no' ? (v) => v.links.length === 0 : undefined), false),
    { id: 'text', label: () => t('chips.field.text'), input: 'text', multi: false, valueLabel: (v) => v, test: () => undefined },
  ];
}
