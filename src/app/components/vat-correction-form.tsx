import { Fragment, type ReactNode } from 'react';
import { derivePeriod } from '../../accounting/periods.js';
import { roundCHF, taxOf, TAX_RATE_ROWS, type ReturnFigures, type TaxRateRow, type ZifferEffect } from '../../accounting/index.js';
import { cn, fmt } from '../lib/utils.js';
import { useWorkspace } from '../hooks/use-workspace.js';

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
  const basis = row.kind === 'supply' ? 'brutto' : 'netto';
  const optional = row.superseded;
  return [
    { ziffer: row.ziffer, label: `${row.name} ${row.rate} %: Leistungen (${basis})`, value: turnover, optional },
    { ziffer: row.ziffer, label: `${row.name} ${row.rate} %: Steuer`, value: (f) => roundCHF(taxOf(row, turnover(f))), optional, tax: true },
  ];
};

/** Form 0535 (Korrekturabrechnung, effektive Methode), in the ESTV form's order. */
const SECTIONS: { title: string; lines: Line[] }[] = [
  {
    title: 'I. Umsatz',
    lines: [
      plain('200', 'Total der vereinbarten bzw. vereinnahmten Entgelte'),
      plain('205', 'In Ziffer 200 enthaltene Entgelte aus ausgenommenen Leistungen, für die optiert wird'),
      plain('220', 'Von der Steuer befreite Leistungen (u.a. Exporte, Art. 23)'),
      plain('221', 'Leistungen im Ausland'),
      plain('225', 'Übertragung im Meldeverfahren (Art. 38)'),
      plain('230', 'Von der Steuer ausgenommene Inlandleistungen (Art. 21)'),
      plain('235', 'Entgeltsminderungen wie Skonti, Rabatte'),
      plain('280', 'Diverses'),
      plain('289', 'Total Ziff. 220 bis 280', { total: true }),
      plain('299', 'Steuerbarer Gesamtumsatz (Ziff. 200 abzüglich Ziff. 289)', { total: true }),
    ],
  },
  {
    title: 'II. Steuerberechnung',
    lines: [
      ...TAX_RATE_ROWS.flatMap(rateLines),
      plain('399', 'Total geschuldete Steuer', { total: true }),
    ],
  },
  {
    title: 'Vorsteuer',
    lines: [
      plain('400', 'Vorsteuer auf Material- und Dienstleistungsaufwand'),
      plain('405', 'Vorsteuer auf Investitionen und übrigem Betriebsaufwand'),
      plain('410', 'Einlageentsteuerung (Art. 32)'),
      plain('415', 'Vorsteuerkorrekturen: gemischte Verwendung, Eigenverbrauch (–)'),
      plain('420', 'Vorsteuerkürzungen (–)'),
      plain('479', 'Total Ziff. 400 bis 420', { total: true }),
    ],
  },
  {
    title: 'Abrechnung',
    lines: [
      plain('500', 'Zu bezahlender Betrag', { total: true }),
      plain('510', 'Guthaben der steuerpflichtigen Person', { total: true }),
    ],
  },
  {
    title: 'III. Andere Mittelflüsse (Art. 18 Abs. 2)',
    lines: [
      plain('900', 'Subventionen, Tourismusabgaben, Entsorgungsbeiträge u.ä.'),
      plain('910', 'Spenden, Dividenden, Schadenersatz u.ä.'),
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
  return SECTIONS.flatMap((s) => s.lines)
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
          <div className="font-bold text-foreground">Korrekturabrechnung (effektive Methode)</div>
          <div className="text-xs text-muted-foreground">Formular 0535. Diese Abrechnung ersetzt die bereits eingereichte Abrechnung.</div>
        </div>
        <div className="text-xs text-muted-foreground text-right tabular-nums">
          <div>MWST-Nr: {uid} MWST</div>
          <div>Abrechnungsperiode: {filed.period}</div>
          <div>von/bis: {dmy(from)} – {dmy(to)}</div>
          <div>bisher deklarierter Steuerbetrag: <span className="font-semibold text-foreground">CHF {declaredTax.toFixed(2)}</span></div>
        </div>
      </div>

      <table className="w-full table-fixed text-sm border border-border">
        <thead>
          <tr className="text-xs text-muted-foreground border-b border-border bg-muted">
            <th className="px-2 py-1 text-left w-12">Ziffer</th>
            <th className="px-2 py-1 text-left">Bezeichnung</th>
            <th className="px-2 py-1 text-right w-28">bisher eingereicht</th>
            <th className="px-2 py-1 text-right w-32">korrigiert (eintragen)</th>
            <th className="px-2 py-1 text-right w-24">Differenz</th>
          </tr>
        </thead>
        <tbody>
          {SECTIONS.map((section) => (
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
        «korrigiert» ist aus den heutigen Buchungen berechnet: die Buchungen der Periode und die Korrekturbuchungen mit corrects = {filed.period}.
        Geänderte Ziffern sind hervorgehoben. Ziffer anklicken für die Korrekturfälle und Korrekturbuchungen dazu.
      </p>
      {children}
    </div>
  );
}
