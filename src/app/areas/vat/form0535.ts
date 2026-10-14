/**
 * Form 0535 (Korrekturabrechnung, effective method): its lines in the ESTV form's order, and what
 * a correction case changes on them. Figures come from figuresFromBooks and the filed XML.
 */
import { roundCHF, type ZifferEffect } from '../../../accounting/index.js';
import { taxOfRow, type RateRowAt } from '../../../engines/return.js';
import { vat } from '../../../engines/index.js';
import { accountingName, t } from '../../i18n/index.js';
import type { ReturnFigures } from '../../../engines/return.js';

export interface FormLine {
  ziffer: string;
  label: string;
  value(f: ReturnFigures): number;
  /** A derived total: it has no entries of its own. */
  total?: boolean;
  /** Shown only with a figure on either side (a superseded rate). */
  optional?: boolean;
  /** The tax line of a rate row: it shares the Ziffer with the turnover line. */
  tax?: boolean;
}

const plain = (ziffer: string, opts: Partial<FormLine> = {}): FormLine =>
  ({ ziffer, label: t(`form0535.z${ziffer}` as 'form0535.z200'), value: (f) => f.ziffern[ziffer] ?? 0, ...opts });

function rateLines(row: RateRowAt): FormLine[] {
  const turnover = (f: ReturnFigures) => f.ziffern[row.ziffer] ?? 0;
  const name = accountingName(row.name);
  const optional = row.superseded;
  return [
    { ziffer: row.ziffer, label: t(row.kind === 'supply' ? 'form0535.rateSuppliesGross' : 'form0535.rateSuppliesNet', { name, rate: row.rate }), value: turnover, optional },
    { ziffer: row.ziffer, label: t('form0535.rateTax', { name, rate: row.rate }), value: (f) => roundCHF(taxOfRow(row, turnover(f))), optional, tax: true },
  ];
}

export function formSections(): Array<{ title: string; lines: FormLine[] }> {
  return [
    { title: t('vat.sectionTurnover'), lines: [...['200', '205', '220', '221', '225', '230', '235', '280'].map((n) => plain(n)), plain('289', { total: true }), plain('299', { total: true })] },
    { title: t('vat.sectionTax'), lines: [...vat().rateRows.flatMap(rateLines), plain('399', { total: true })] },
    { title: t('vat.sectionInputTax'), lines: [...['400', '405', '410', '415', '420'].map((n) => plain(n)), plain('479', { total: true })] },
    { title: t('vat.sectionSettlement'), lines: [plain('500', { total: true }), plain('510', { total: true })] },
    { title: t('vat.sectionOtherFlows'), lines: [plain('900'), plain('910')] },
  ];
}

export interface EffectLine {
  ziffer: string;
  label: string;
  amount: number;
  tax: boolean;
}

/** The form lines an effect changes, in the form's order and wording; derived totals left out. */
export function effectLines(period: ReturnFigures['period'], effect: ZifferEffect): EffectLine[] {
  const f: ReturnFigures = { period, ziffern: effect };
  return formSections().flatMap((s) => s.lines)
    .filter((line) => !line.total)
    .map((line) => ({ ziffer: line.ziffer, label: line.label, amount: line.value(f), tax: !!line.tax }))
    .filter((l) => l.amount !== 0);
}
