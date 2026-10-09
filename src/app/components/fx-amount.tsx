import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { JournalEntry } from '../../types/index.js';
import type { Conversion } from '../../accounting/fx-conversion.js';
import { useFx } from '../hooks/use-fx.js';
import { cn, fmt, formatDate } from '../lib/utils.js';
import { t } from '../i18n/index.js';

const rateText = (rate: number | undefined) => (rate === undefined ? '—' : String(rate));

/** "EUR <amount> × <rate> = CHF <amount>" */
export function conversionText(c: Conversion): string {
  return t('fx.conversion', { currency: c.currency, amount: fmt(c.amount), rate: rateText(c.rate), chf: fmt(c.chf) });
}

/** Where the rate comes from, or why it is not the ESTV rate of the payment date. */
export function checkText(c: Conversion): string {
  const { check } = c;
  if (check.kind === 'unknown') return t('fx.unknown', { currency: c.currency, paymentDate: formatDate(c.paymentDate) });
  if (check.kind === 'differs') {
    return t('fx.differs', { rate: rateText(check.estv.rate), date: formatDate(check.estv.validOn), paymentDate: formatDate(c.paymentDate) });
  }
  return t('fx.estvSource', { date: formatDate(check.estv.validOn) });
}

export const fxTitle = (c: Conversion) => `${conversionText(c)} · ${checkText(c)}`;

/** A warning for a rate that is not the ESTV sell rate of the payment date; nothing when it is. */
export function FxBadge({ conversion }: { conversion: Conversion | undefined }) {
  if (!conversion || conversion.check.kind === 'estv') return null;
  return (
    <span title={checkText(conversion)} data-testid="fx-stale" className="inline-flex shrink-0 align-middle text-amber-600 dark:text-amber-400">
      <AlertTriangle className="h-3 w-3" />
    </span>
  );
}

/** Wraps a figure of a foreign entry so hovering it shows how it became CHF; a CHF entry's figure stays as is. */
function WithFx({ entry, children, className }: { entry: JournalEntry; children: ReactNode; className?: string }) {
  const c = useFx().convert(entry);
  if (!c) return <span className={className}>{children}</span>;
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <span title={fxTitle(c)} className="underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">{children}</span>
      <FxBadge conversion={c} />
    </span>
  );
}

/** An entry's amount as booked: "EUR 12.50" for a foreign one (`currency` false: "12.50"), the CHF figure otherwise. */
export function ForeignAmount({ entry, currency = true, className }: { entry: JournalEntry; currency?: boolean; className?: string }) {
  const foreign = entry.exchangeCurrency && entry.exchangeCurrency !== 'CHF';
  return (
    <WithFx entry={entry} className={className}>
      {foreign && currency ? `${entry.exchangeCurrency} ${entry.amount.toFixed(2)}` : entry.amount.toFixed(2)}
    </WithFx>
  );
}

/** A CHF figure an entry produced (a ledger's Soll or Haben), explained on hover when the entry is foreign. */
export function FxChf({ entry, children }: { entry: JournalEntry | undefined; children: ReactNode }) {
  return entry ? <WithFx entry={entry} className="justify-end">{children}</WithFx> : <>{children}</>;
}

/** The whole conversion, spelled out for a detail view. Nothing for a CHF entry. */
export function FxLine({ entry, className }: { entry: JournalEntry; className?: string }) {
  const c = useFx().convert(entry);
  if (!c) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground', className)} data-testid="fx-line">
      <span className="font-mono tabular-nums whitespace-nowrap">{conversionText(c)}</span>
      <span>·</span>
      <span className={cn(c.check.kind !== 'estv' && 'text-amber-700 dark:text-amber-300')}>{checkText(c)}</span>
      <FxBadge conversion={c} />
    </div>
  );
}
