import { Fragment, type ReactNode } from 'react';
import { derivePeriod } from '../../accounting/periods.js';
import { roundCHF, taxOf, TAX_RATE_ROWS, type ReturnFigures, type TaxRateRow, type ZifferEffect } from '../../accounting/index.js';
import { cn, fmt } from '../lib/utils.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { accountingName, t } from '../i18n/index.js';

interface Line {
  ziffer: string;
  label: string;
  value: (f: ReturnFigures) => number;
  /** A derived total: it has no entries of its own to list. */
  total?: boolean;
  /** Shown only when either column is non-zero (superseded rates). */
  optional?: boolean;
  /** The tax line of a rate row: it shares the Ziffer with the turnover line. */
  tax?: boolean;
}

const plain = (ziffer: string, label: string, opts: Partial<Line> = {}): Line =>
  ({ ziffer, label, value: (f) => f.ziffern[ziffer] ?? 0, ...opts });

const rateLines = (row: TaxRateRow): Line[] => {
  const turnover = (f: ReturnFigures) => f.ziffern[row.ziffer] ?? 0;
  const name = accountingName(row.name);
  const optional = row.superseded;
  return [
    { ziffer: row.ziffer, label: t(row.kind === 'supply' ? 'form0535.rateSuppliesGross' : 'form0535.rateSuppliesNet', { name, rate: row.rate }), value: turnover, optional },
    { ziffer: row.ziffer, label: t('form0535.rateTax', { name, rate: row.rate }), value: (f) => roundCHF(taxOf(row, turnover(f))), optional, tax: true },
  ];
};

/** Form 0535 (Korrekturabrechnung, effektive Methode), in the ESTV form's order and the UI's language. */
const sections = (): { title: string; lines: Line[] }[] => [
  {
    title: t('vat.sectionTurnover'),
    lines: [
      plain('200', t('form0535.z200')),
      plain('205', t('form0535.z205')),
      plain('220', t('form0535.z220')),
      plain('221', t('form0535.z221')),
      plain('225', t('form0535.z225')),
      plain('230', t('form0535.z230')),
      plain('235', t('form0535.z235')),
      plain('280', t('form0535.z280')),
      plain('289', t('form0535.z289'), { total: true }),
      plain('299', t('form0535.z299'), { total: true }),
    ],
  },
  {
    title: t('vat.sectionTax'),
    lines: [
      ...TAX_RATE_ROWS.flatMap(rateLines),
      plain('399', t('form0535.z399'), { total: true }),
    ],
  },
  {
    title: t('vat.sectionInputTax'),
    lines: [
      plain('400', t('form0535.z400')),
      plain('405', t('form0535.z405')),
      plain('410', t('form0535.z410')),
      plain('415', t('form0535.z415')),
      plain('420', t('form0535.z420')),
      plain('479', t('form0535.z479'), { total: true }),
    ],
  },
  {
    title: t('vat.sectionSettlement'),
    lines: [
      plain('500', t('form0535.z500'), { total: true }),
      plain('510', t('form0535.z510'), { total: true }),
    ],
  },
  {
    title: t('vat.sectionOtherFlows'),
    lines: [
      plain('900', t('form0535.z900')),
      plain('910', t('form0535.z910')),
    ],
  },
];

export interface EffectLine {
  ziffer: string;
  label: string;
  amount: number;
  tax: boolean;
}

/** The form lines an effect changes, in the form's order and wording; derived totals left out. */
export function effectLines(period: ReturnFigures['period'], effect: ZifferEffect): EffectLine[] {
  const f: ReturnFigures = { period, ziffern: effect };
  return sections().flatMap((s) => s.lines)
    .filter((line) => !line.total)
    .map((line) => ({ ziffer: line.ziffer, label: line.label, amount: line.value(f), tax: !!line.tax }))
    .filter((l) => l.amount !== 0);
}

const orDash = (n: number) => (n === 0 ? '—' : fmt(n));
const dmy = (iso: string) => iso.split('-').reverse().join('.');

export function CorrectionForm({ filed, corrected, selected, onSelect, children }: {
  filed: ReturnFigures;
  corrected: ReturnFigures;
  selected: string | null;
  onSelect: (ziffer: string) => void;
  /** Printed after the form, inside the printed area. */
  children?: ReactNode;
}) {
  const { from, to } = derivePeriod(filed.period)!;
  const declaredTax = (filed.ziffern['500'] ?? 0) - (filed.ziffern['510'] ?? 0);
  const uid = useWorkspace()?.company.uid ?? '';

  return (
    <div className="vat-print max-w-3xl mx-auto">
      <div className="flex justify-between gap-4 border-2 border-foreground rounded px-3 py-2 mb-4">
        <div>
          <div className="font-bold text-foreground">{t('form0535.title')}</div>
          <div className="text-xs text-muted-foreground">{t('form0535.subtitle')}</div>
        </div>
        <div className="text-xs text-muted-foreground text-right tabular-nums">
          <div>{t('form0535.vatNumber', { uid })}</div>
          <div>{t('form0535.period', { period: filed.period })}</div>
          <div>{t('form0535.fromTo', { from: dmy(from), to: dmy(to) })}</div>
          <div>{t('form0535.declaredTax')} <span className="font-semibold text-foreground">CHF {declaredTax.toFixed(2)}</span></div>
        </div>
      </div>

      <table className="w-full table-fixed text-sm border border-border">
        <thead>
          <tr className="text-xs text-muted-foreground border-b border-border bg-muted">
            <th className="px-2 py-1 text-left w-12">{t('vat.colZiffer')}</th>
            <th className="px-2 py-1 text-left">{t('form0535.colLabel')}</th>
            <th className="px-2 py-1 text-right w-28">{t('form0535.colFiled')}</th>
            <th className="px-2 py-1 text-right w-32">{t('form0535.colCorrected')}</th>
            <th className="px-2 py-1 text-right w-24">{t('recon.colDifference')}</th>
          </tr>
        </thead>
        <tbody>
          {sections().map((section) => (
            <Fragment key={section.title}>
              <tr className="bg-muted">
                <td colSpan={5} className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</td>
              </tr>
              {section.lines.map((line) => {
                const before = line.value(filed);
                const after = line.value(corrected);
                if (line.optional && before === 0 && after === 0) return null;
                const diff = roundCHF(after - before);
                const clickable = !line.total;
                return (
                  <tr
                    key={line.label}
                    data-ziffer={line.ziffer}
                    className={cn(
                      'border-t border-border/50',
                      diff !== 0 && 'bg-amber-50 dark:bg-amber-950',
                      line.total && 'font-semibold',
                      clickable && 'cursor-pointer hover:bg-accent',
                      selected === line.ziffer && 'bg-accent',
                    )}
                    onClick={clickable ? () => onSelect(line.ziffer) : undefined}
                  >
                    <td className="px-2 py-1 text-xs text-muted-foreground tabular-nums">{line.ziffer}</td>
                    <td className="px-2 py-1">{line.label}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums">{orDash(before)}</td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums font-bold">{orDash(after)}</td>
                    <td className={cn('px-2 py-1 text-right font-mono tabular-nums', diff !== 0 && 'text-amber-800 dark:text-amber-200 font-semibold')}>
                      {diff === 0 ? '—' : `${diff > 0 ? '+' : ''}${fmt(diff)}`}
                    </td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground mt-2">
        {t('form0535.explanation', { period: filed.period })}
      </p>
      {children}
    </div>
  );
}
