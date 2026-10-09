import { useState, useMemo, useEffect } from 'react';
import type { Index, QuarterKey } from '../../types/index.js';
import {
  computeVatReport, adjustmentsForReturn, entriesForReturn, figuresFromBooks, reportRange,
  parseVatCode, sourceZiffern, type ReturnFigures,
} from '../../accounting/index.js';
import { CorrectionForm } from './vat-correction-form.js';
import { CorrectionCases } from './vat-correction-cases.js';
import { EntryDetail } from './vat-entry-table.js';
import { cn, fmt } from '../lib/utils.js';
import { api } from '../lib/api.js';
import { accountingName, t } from '../i18n/index.js';
import { derivePeriod, localToday, parsePeriod, vatPeriodOf, type Period } from '../../accounting/periods.js';
import { Lock } from 'lucide-react';
import { useUrlParam } from '../hooks/use-url-state.js';
import { useAutoSelectFirst } from '../hooks/use-auto-select-first.js';

interface Props {
  index: Index;
  period: Period;
  onPeriod: (token: string) => void;
}

/** Ziffern the engine does not declare yet: the codes that would feed them, for the detail list. */
const UNDECLARED_ZIFFER_CODES: Record<string, (code: string) => boolean> = {
  '205': (c) => c === 'V81-B' || c === 'V77-B',
  '235': (c) => c === 'VS81' || c === 'VS77' || c === 'VS26',
  '900': (c) => c === 'Z0-A',
  '910': (c) => c === 'Z0',
};

/** Which entries a Ziffer lists: the engine's own assignment, so the list sums to the figure. */
const feeds = (ziffer: string) => UNDECLARED_ZIFFER_CODES[ziffer] ?? ((code: string) => {
  const info = parseVatCode(code);
  return !!info && sourceZiffern(info).includes(ziffer);
});

/** The clickable Ziffern of the return form around its rate rows, in the order the form shows them. */
const ZIFFERN_BEFORE_RATES = ['200', '205', '220', '221', '225', '230', '235', '280'];
const ZIFFERN_AFTER_RATES = ['400', '405', '410', '415', '420', '900', '910'];

/** Clickable row */
function Row({ ziffer, label, amount, indent, bold, large, className, selected, onClick }: {
  ziffer: string;
  label: string;
  amount: number | null;
  indent?: boolean;
  bold?: boolean;
  large?: boolean;
  className?: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  const clickable = !!onClick;
  return (
    <div
      className={cn(
        'flex items-baseline gap-3 px-4 py-2',
        clickable && 'cursor-pointer hover:bg-accent',
        selected && 'bg-accent',
        className,
      )}
      onClick={onClick}
    >
      <span className="text-xs text-muted-foreground tabular-nums w-8 shrink-0">{ziffer}</span>
      <span className={cn(
        'flex-1 text-sm',
        indent && 'pl-4',
        bold && 'font-semibold',
        large && 'text-base font-bold',
      )}>
        {label}
      </span>
      {amount !== null && (
        <span className={cn(
          'tabular-nums text-right shrink-0 w-32 font-mono',
          bold && 'font-bold',
          large && 'text-lg font-bold',
        )}>
          {fmt(amount)}
        </span>
      )}
    </div>
  );
}

function TaxRow({ ziffer, label, taxable, tax, rate, selected, onClick }: {
  ziffer: string;
  label: string;
  taxable: number;
  tax: number;
  rate: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline gap-3 px-4 py-2',
        onClick && 'cursor-pointer hover:bg-accent',
        selected && 'bg-accent',
      )}
      onClick={onClick}
    >
      <span className="text-xs text-muted-foreground tabular-nums w-8 shrink-0">{ziffer}</span>
      <span className="flex-1 text-sm">{label}</span>
      <span className="tabular-nums text-right shrink-0 w-28 font-mono text-sm">{fmt(taxable)}</span>
      <span className="text-muted-foreground text-xs shrink-0">+</span>
      <span className="tabular-nums text-right shrink-0 w-24 font-mono text-sm">{fmt(tax)}</span>
      <span className="text-xs text-muted-foreground shrink-0 w-12 text-right">{rate}</span>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 mt-6 first:mt-0">
      {title}
    </h3>
  );
}

/** The return filed for a quarter (filings/<year>/), or null when none was filed. */
function useFiledReturn(quarter: QuarterKey | null): ReturnFigures | null {
  const [filed, setFiled] = useState<ReturnFigures[]>([]);
  const year = quarter?.slice(0, 4);
  useEffect(() => {
    if (!year) return;
    let live = true;
    api.filedReturns(year)
      .then((list) => { if (live) setFiled(list); })
      .catch(() => { if (live) setFiled([]); });
    return () => { live = false; };
  }, [year]);
  return filed.find((f) => f.period === quarter) ?? null;
}

/**
 * A VAT return exists only for an ESTV reporting period (quarter, half-year, year). Any other range
 * gets a notice with the quarters it touches, never a "return" computed for arbitrary dates.
 */
export function VatReportTab({ index, period, onPeriod }: Props) {
  const key = vatPeriodOf(period);
  return key ? <VatReturn index={index} period={key} /> : <QuarterChoice index={index} period={period} onPeriod={onPeriod} />;
}

function QuarterChoice({ index, period, onPeriod }: Props) {
  const closedThrough = index.config?.closedThrough;
  const quarters = useMemo(() => {
    const keys = new Set(index.transactions.map((tx) => `${tx.date.slice(0, 4)}-Q${Math.ceil(+tx.date.slice(5, 7) / 3)}`));
    return [...keys].sort().filter((q) => {
      const r = derivePeriod(q)!;
      return r.from <= period.to && r.to >= period.from;
    });
  }, [index.transactions, period]);
  return (
    <div className="flex-1 flex items-start justify-center p-10" data-testid="vat-range-notice">
      <div className="max-w-md rounded-lg border border-border bg-background p-5 space-y-3">
        <p className="text-sm text-foreground">{t('vat.rangeNotice')}</p>
        {quarters.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">{t('vat.rangeQuarters')}</p>
            <div className="flex flex-wrap gap-2">
              {quarters.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => onPeriod(q)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1 text-sm hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {!!closedThrough && derivePeriod(q)!.to <= closedThrough && <Lock className="h-3 w-3 text-muted-foreground" />}
                  {t('period.quarter', { quarter: q.slice(-1), year: q.slice(0, 4) })}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function VatReturn({ index, period }: { index: Index; period: string }) {
  const entries = index.journalEntries ?? [];
  const { from, to } = useMemo(() => reportRange(period), [period]);
  const adjustments = useMemo(() => index.config?.vatAdjustments ?? [], [index.config?.vatAdjustments]);
  const report = useMemo(() => computeVatReport(entries, period, adjustments), [entries, period, adjustments]);
  const closedThrough = index.config?.closedThrough;
  const filed = !!closedThrough && to <= closedThrough;
  const [selectedZiffer, setSelectedZiffer] = useUrlParam('ziffer');

  const filtered = useMemo(() => entriesForReturn(entries, period), [entries, period]);

  const quarter = /^\d{4}-Q[1-4]$/.test(period) ? period as QuarterKey : null;
  const filedReturn = useFiledReturn(quarter);
  const [view, setView] = useState<'return' | 'correction'>('return');
  const correcting = view === 'correction' && !!filedReturn;
  const corrected = useMemo(
    () => (correcting && quarter ? figuresFromBooks(entries, quarter, adjustments) : null),
    [correcting, quarter, entries, adjustments],
  );
  const corrections = useMemo(() => entries.filter((e) => quarter && e.corrects === quarter), [entries, quarter]);
  const correctionCases = index.config?.correctionCases ?? [];

  const z = useMemo(() => {
    const m = new Map<string, number>();
    for (const zi of report.ziffern) m.set(zi.number, zi.amount);
    return (num: string) => m.get(num) ?? 0;
  }, [report]);

  const selectedEntries = useMemo(() => {
    if (!selectedZiffer) return [];
    const matches = feeds(selectedZiffer);
    return (correcting ? corrections : filtered)
      .filter(e => e.vatCode && matches(e.vatCode))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [selectedZiffer, filtered, corrections, correcting]);

  const toggle = (ziffer: string) => () => setSelectedZiffer(prev => prev === ziffer ? null : ziffer);

  const sel = (ziffer: string) => selectedZiffer === ziffer;

  const rateRows = report.rates.filter((r) => !r.row.superseded || r.base !== 0 || r.tax !== 0);
  const valuedRates = rateRows.filter((r) => r.base !== 0 || r.tax !== 0);
  const valuedZiffern = [
    ...ZIFFERN_BEFORE_RATES.filter((n) => z(n) !== 0),
    ...valuedRates.filter((r) => r.row.kind === 'supply').map((r) => r.row.ziffer),
    ...valuedRates.filter((r) => r.row.kind === 'acquisition').map((r) => r.row.ziffer),
    ...ZIFFERN_AFTER_RATES.filter((n) => z(n) !== 0),
  ];
  useAutoSelectFirst(valuedZiffern, selectedZiffer, setSelectedZiffer, !correcting);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {filed && (
        <div className="shrink-0 px-4 py-2 text-xs border-b border-border bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200">
          {t('vat.filedNotice', { folder: `filings/${from.slice(0, 4)}/` })}
        </div>
      )}
      {filedReturn && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border">
          <div className="inline-flex rounded-md border border-border overflow-hidden text-sm">
            {([['return', 'vat.viewReturn'], ['correction', 'vat.viewCorrection']] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={cn('px-3 py-1', view === v ? 'bg-primary text-primary-foreground' : 'hover:bg-accent text-muted-foreground')}
                onClick={() => { setView(v); setSelectedZiffer(null); }}
              >
                {t(label)}
              </button>
            ))}
          </div>
          {correcting && (
            <button type="button" className="ml-auto text-sm px-3 py-1 rounded-md border border-border hover:bg-accent" onClick={() => window.print()}>
              {t('vat.print')}
            </button>
          )}
        </div>
      )}
      <div className="flex-1 flex overflow-hidden">
        {/* Form */}
        <div className="overflow-auto p-6 w-[45%] border-r border-border">
          {correcting && corrected && (
            <CorrectionForm filed={filedReturn} corrected={corrected} selected={selectedZiffer} onSelect={(z) => setSelectedZiffer((prev) => (prev === z ? null : z))}>
              <div className="hidden print:block">
                <CorrectionCases cases={correctionCases} entries={entries} receipts={index.receipts} filed={filedReturn} corrected={corrected} print />
              </div>
            </CorrectionForm>
          )}
          <div className={cn('max-w-3xl mx-auto', correcting && 'hidden')}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-foreground">{t('vat.title')}</h2>
              <span className="text-xs text-muted-foreground">{t('common.dateRange', { from, to })}</span>
            </div>

            <div className="text-xs text-muted-foreground mb-4">
              {t('vat.grossHint')}
            </div>

            <SectionHeader title={t('vat.sectionTurnover')} />
            <div className="bg-background border border-border rounded-lg divide-y divide-border/50">
              <div className="flex items-baseline gap-3 px-4 py-1 text-xs text-muted-foreground">
                <span className="w-8 shrink-0">{t('vat.colZiffer')}</span>
                <span className="flex-1">{t('vat.colConsideration')}</span>
                <span className="w-32 text-right">{t('vat.colTurnoverChf')}</span>
              </div>
              <Row ziffer="200" label={t('vat.z200')} amount={z('200')} bold onClick={toggle('200')} selected={sel('200')} />
              <Row ziffer="205" label={t('vat.z205')} amount={z('205') || null} indent onClick={toggle('205')} selected={sel('205')} />
              <Row ziffer="220" label={t('vat.z220')} amount={z('220') || null} indent onClick={toggle('220')} selected={sel('220')} />
              <Row ziffer="221" label={t('vat.z221')} amount={z('221') || null} indent onClick={toggle('221')} selected={sel('221')} />
              <Row ziffer="225" label={t('vat.z225')} amount={z('225') || null} indent onClick={toggle('225')} selected={sel('225')} />
              <Row ziffer="230" label={t('vat.z230')} amount={z('230') || null} indent onClick={toggle('230')} selected={sel('230')} />
              <Row ziffer="235" label={t('vat.z235')} amount={z('235') || null} indent onClick={toggle('235')} selected={sel('235')} />
              <Row ziffer="280" label={t('vat.z280')} amount={z('280') || null} indent onClick={toggle('280')} selected={sel('280')} />
              <Row ziffer="289" label={t('vat.z289')} amount={z('289')} className="border-t border-border" />
              <Row ziffer="299" label={t('vat.z299')} amount={z('299')} bold className="bg-muted/50" />
            </div>

            <SectionHeader title={t('vat.sectionTax')} />
            <div className="bg-background border border-border rounded-lg divide-y divide-border/50">
              <div className="flex items-baseline gap-3 px-4 py-1 text-xs text-muted-foreground">
                <span className="w-8 shrink-0">{t('vat.colZiffer')}</span>
                <span className="flex-1"></span>
                <span className="w-28 text-right">{t('vat.colSuppliesChf')}</span>
                <span className="w-4"></span>
                <span className="w-24 text-right">{t('vat.colTaxChf')}</span>
                <span className="w-12 text-right">{t('vat.colRate')}</span>
              </div>
              {rateRows.filter((r) => r.row.kind === 'supply').map(({ row, base, tax }) => (
                <TaxRow key={row.ziffer} ziffer={row.ziffer} label={accountingName(row.name)} taxable={base} tax={tax} rate={`${row.rate.toFixed(2)}%`} onClick={toggle(row.ziffer)} selected={sel(row.ziffer)} />
              ))}
              <Row ziffer="379" label={t('vat.z379')} amount={z('299')} className="border-t border-border" />
              {rateRows.filter((r) => r.row.kind === 'acquisition').map(({ row, base, tax }) => (
                <TaxRow key={row.ziffer} ziffer={row.ziffer} label={t('vat.acquisitionNet', { name: accountingName(row.name) })} taxable={base} tax={tax} rate={`${row.rate.toFixed(2)}%`} onClick={toggle(row.ziffer)} selected={sel(row.ziffer)} />
              ))}
              <Row ziffer="399" label={t('vat.z399')} amount={z('399')} bold className="bg-muted/50" />
            </div>

            <SectionHeader title={t('vat.sectionInputTax')} />
            <div className="bg-background border border-border rounded-lg divide-y divide-border/50">
              <div className="flex items-baseline gap-3 px-4 py-1 text-xs text-muted-foreground">
                <span className="w-8 shrink-0">{t('vat.colZiffer')}</span>
                <span className="flex-1"></span>
                <span className="w-32 text-right">{t('vat.colTaxChf')}</span>
              </div>
              <Row ziffer="400" label={t('vat.z400')} amount={z('400')} onClick={toggle('400')} selected={sel('400')} />
              <Row ziffer="405" label={t('vat.z405')} amount={z('405')} onClick={toggle('405')} selected={sel('405')} />
              <Row ziffer="410" label={t('vat.z410')} amount={z('410') || null} onClick={toggle('410')} selected={sel('410')} />
              <Row ziffer="415" label={t('vat.z415')} amount={z('415') || null} onClick={toggle('415')} selected={sel('415')} />
              <Row ziffer="420" label={t('vat.z420')} amount={z('420') || null} onClick={toggle('420')} selected={sel('420')} />
              <Row ziffer="479" label={t('vat.z479')} amount={z('479')} bold className="bg-muted/50" />
            </div>

            <SectionHeader title={t('vat.sectionSettlement')} />
            <div className="bg-background border border-border rounded-lg divide-y divide-border/50">
              <Row ziffer="500" label={t('vat.z500')} amount={z('500')} large className="bg-primary/5" />
              <Row ziffer="510" label={t('vat.z510')} amount={z('510')} large className="bg-primary/5" />
            </div>

            <SectionHeader title={t('vat.sectionOtherFlows')} />
            <div className="bg-background border border-border rounded-lg divide-y divide-border/50">
              <Row ziffer="900" label={t('vat.z900')} amount={z('900') || null} onClick={toggle('900')} selected={sel('900')} />
              <Row ziffer="910" label={t('vat.z910')} amount={z('910') || null} onClick={toggle('910')} selected={sel('910')} />
            </div>
          </div>
        </div>

        {/* Detail panel */}
        <div className="flex-1 flex flex-col overflow-auto bg-background">
          {correcting && corrected && (
            <CorrectionCases cases={correctionCases} entries={entries} receipts={index.receipts} filed={filedReturn} corrected={corrected} ziffer={selectedZiffer} />
          )}
          {selectedZiffer ? (
            <>
              {!correcting && adjustmentsForReturn(adjustments, entries, period).filter((a) => a.ziffer === selectedZiffer).map((a) => (
                <div key={a.id} className="mx-4 mt-3 px-3 py-2 text-xs rounded border border-border bg-blue-50 dark:bg-blue-950 text-foreground">
                  <span className="font-semibold">{t('vat.adjustment', { amount: a.amount.toFixed(2) })}</span> — {a.reason}
                  <span className="block text-muted-foreground font-mono mt-0.5">{t('vat.adjustmentEntries', { ids: a.entryIds.join(', ') })}</span>
                </div>
              ))}
              <EntryDetail period={parsePeriod(period, localToday()) ?? undefined} entries={selectedEntries} title={correcting ? t('vat.zifferCorrections', { ziffer: selectedZiffer }) : t('vat.ziffer', { ziffer: selectedZiffer })} />
            </>
          ) : correcting ? null : (
            <div className="flex-1 flex items-center justify-center text-sm text-dim">
              {t('vat.selectZiffer')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
