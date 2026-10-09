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

interface Props {
  index: Index;
  period: string;
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

export function VatReportTab({ index, period }: Props) {
  const entries = index.journalEntries ?? [];
  const { from, to } = useMemo(() => reportRange(period), [period]);
  const adjustments = useMemo(() => index.config?.vatAdjustments ?? [], [index.config?.vatAdjustments]);
  const report = useMemo(() => computeVatReport(entries, period, adjustments), [entries, period, adjustments]);
  const closedThrough = index.config?.closedThrough;
  const filed = !!closedThrough && to <= closedThrough;
  const [selectedZiffer, setSelectedZiffer] = useState<string | null>(null);

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {filed && (
        <div className="shrink-0 px-4 py-2 text-xs border-b border-border bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200">
          Eingereicht — diese Periode ist abgeschlossen. Massgebend ist die eingereichte Abrechnung in filings/{from.slice(0, 4)}/.
          Die Zahlen hier sind aus den heutigen Buchungen neu berechnet und können abweichen; Abweichungen eines Quartals werden mit seiner Korrekturabrechnung (Formular 0535) deklariert.
        </div>
      )}
      {filedReturn && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border">
          <div className="inline-flex rounded-md border border-border overflow-hidden text-sm">
            {([['return', 'Abrechnung'], ['correction', 'Korrekturabrechnung (0535)']] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={cn('px-3 py-1', view === v ? 'bg-primary text-primary-foreground' : 'hover:bg-accent text-muted-foreground')}
                onClick={() => { setView(v); setSelectedZiffer(null); }}
              >
                {label}
              </button>
            ))}
          </div>
          {correcting && (
            <button type="button" className="ml-auto text-sm px-3 py-1 rounded-md border border-border hover:bg-accent" onClick={() => window.print()}>
              Drucken
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
              <h2 className="text-lg font-bold text-foreground">MWST-Abrechnung</h2>
              <span className="text-xs text-muted-foreground">{from} bis {to}</span>
            </div>

            <div className="text-xs text-muted-foreground mb-4">
              Alle Umsatzangaben sind Brutto (inkl. MWST) — Ziffer anklicken für Details
            </div>

            {/* I. Umsatz */}
            <SectionHeader title="I. Umsatz" />
            <div className="bg-background border border-border rounded-lg divide-y divide-border/50">
              <div className="flex items-baseline gap-3 px-4 py-1 text-xs text-muted-foreground">
                <span className="w-8 shrink-0">Ziffer</span>
                <span className="flex-1">Entgelte</span>
                <span className="w-32 text-right">Umsatz CHF</span>
              </div>
              <Row ziffer="200" label="Total der vereinbarten bzw. vereinnahmten Entgelte (weltweiter Umsatz)" amount={z('200')} bold onClick={toggle('200')} selected={sel('200')} />
              <Row ziffer="205" label="Entgelte optiert (Art. 22)" amount={z('205') || null} indent onClick={toggle('205')} selected={sel('205')} />
              <Row ziffer="220" label="Von der Steuer befreite Leistungen (Exporte, Art. 23)" amount={z('220') || null} indent onClick={toggle('220')} selected={sel('220')} />
              <Row ziffer="221" label="Leistungen im Ausland" amount={z('221') || null} indent onClick={toggle('221')} selected={sel('221')} />
              <Row ziffer="225" label="Übertragungen im Meldeverfahren (Art. 38)" amount={z('225') || null} indent onClick={toggle('225')} selected={sel('225')} />
              <Row ziffer="230" label="Von der Steuer ausgenommene Inlandleistungen (Art. 21)" amount={z('230') || null} indent onClick={toggle('230')} selected={sel('230')} />
              <Row ziffer="235" label="Entgeltsminderungen (Skonti, Rabatte)" amount={z('235') || null} indent onClick={toggle('235')} selected={sel('235')} />
              <Row ziffer="280" label="Diverses" amount={z('280') || null} indent onClick={toggle('280')} selected={sel('280')} />
              <Row ziffer="289" label="Total Abzüge" amount={z('289')} className="border-t border-border" />
              <Row ziffer="299" label="Steuerbarer Gesamtumsatz" amount={z('299')} bold className="bg-muted/50" />
            </div>

            {/* II. Steuerberechnung */}
            <SectionHeader title="II. Steuerberechnung" />
            <div className="bg-background border border-border rounded-lg divide-y divide-border/50">
              <div className="flex items-baseline gap-3 px-4 py-1 text-xs text-muted-foreground">
                <span className="w-8 shrink-0">Ziffer</span>
                <span className="flex-1"></span>
                <span className="w-28 text-right">Leistungen CHF</span>
                <span className="w-4"></span>
                <span className="w-24 text-right">Steuer CHF</span>
                <span className="w-12 text-right">Satz</span>
              </div>
              {rateRows.filter((r) => r.row.kind === 'supply').map(({ row, base, tax }) => (
                <TaxRow key={row.ziffer} ziffer={row.ziffer} label={row.name} taxable={base} tax={tax} rate={`${row.rate.toFixed(2)}%`} onClick={toggle(row.ziffer)} selected={sel(row.ziffer)} />
              ))}
              <Row ziffer="379" label="Steuerbarer Gesamtumsatz (wie Ziff. 299)" amount={z('299')} className="border-t border-border" />
              {rateRows.filter((r) => r.row.kind === 'acquisition').map(({ row, base, tax }) => (
                <TaxRow key={row.ziffer} ziffer={row.ziffer} label={`${row.name} (netto, exkl. MWST)`} taxable={base} tax={tax} rate={`${row.rate.toFixed(2)}%`} onClick={toggle(row.ziffer)} selected={sel(row.ziffer)} />
              ))}
              <Row ziffer="399" label="Total geschuldete Steuer" amount={z('399')} bold className="bg-muted/50" />
            </div>

            {/* Vorsteuer */}
            <SectionHeader title="Vorsteuer" />
            <div className="bg-background border border-border rounded-lg divide-y divide-border/50">
              <div className="flex items-baseline gap-3 px-4 py-1 text-xs text-muted-foreground">
                <span className="w-8 shrink-0">Ziffer</span>
                <span className="flex-1"></span>
                <span className="w-32 text-right">Steuer CHF</span>
              </div>
              <Row ziffer="400" label="Vorsteuer auf Material-/Dienstleistungsaufwand" amount={z('400')} onClick={toggle('400')} selected={sel('400')} />
              <Row ziffer="405" label="Vorsteuer auf Investitionen/übrigem Betriebsaufwand" amount={z('405')} onClick={toggle('405')} selected={sel('405')} />
              <Row ziffer="410" label="Einlageentsteuerung (Art. 32)" amount={z('410') || null} onClick={toggle('410')} selected={sel('410')} />
              <Row ziffer="415" label="Vorsteuerkorrekturen (Art. 30, 31)" amount={z('415') || null} onClick={toggle('415')} selected={sel('415')} />
              <Row ziffer="420" label="Vorsteuerkürzungen (Art. 33 Abs. 2)" amount={z('420') || null} onClick={toggle('420')} selected={sel('420')} />
              <Row ziffer="479" label="Total Vorsteuer" amount={z('479')} bold className="bg-muted/50" />
            </div>

            {/* Abrechnung */}
            <SectionHeader title="Abrechnung" />
            <div className="bg-background border border-border rounded-lg divide-y divide-border/50">
              <Row ziffer="500" label="Zu bezahlender Betrag" amount={z('500')} large className="bg-primary/5" />
              <Row ziffer="510" label="Guthaben der steuerpflichtigen Person" amount={z('510')} large className="bg-primary/5" />
            </div>

            {/* III. Andere Mittelflüsse */}
            <SectionHeader title="III. Andere Mittelflüsse (Art. 18 Abs. 2)" />
            <div className="bg-background border border-border rounded-lg divide-y divide-border/50">
              <Row ziffer="900" label="Subventionen, Tourismusabgaben, Entsorgungsbeiträge (Bst. a-c)" amount={z('900') || null} onClick={toggle('900')} selected={sel('900')} />
              <Row ziffer="910" label="Spenden, Dividenden, Schadenersatz (Bst. d-l)" amount={z('910') || null} onClick={toggle('910')} selected={sel('910')} />
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
                  <span className="font-semibold">Nachdeklaration CHF {a.amount.toFixed(2)}</span> — {a.reason}
                  <span className="block text-muted-foreground font-mono mt-0.5">Buchungen: {a.entryIds.join(', ')}</span>
                </div>
              ))}
              <EntryDetail entries={selectedEntries} title={correcting ? `Ziffer ${selectedZiffer}, Korrekturbuchungen` : `Ziffer ${selectedZiffer}`} />
            </>
          ) : correcting ? null : (
            <div className="flex-1 flex items-center justify-center text-sm text-dim">
              Ziffer auswählen für Details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
