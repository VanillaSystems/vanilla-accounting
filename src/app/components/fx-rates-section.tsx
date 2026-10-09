import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Index } from '../../types/index.js';
import { ratesUsed, type RateUse } from '../../accounting/fx-conversion.js';
import { inPeriod, type Period } from '../../accounting/periods.js';
import { useFx } from '../hooks/use-fx.js';
import { cn, fmt, formatDate } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { EntryLinks } from './open-in-tab-link.js';
import { FxBadge, checkText } from './fx-amount.js';

/** "datum 2026-08-13" in the rate table: the day the ESTV published the rate. */
const published = (source: string | undefined) => source?.match(/\d{4}-\d{2}-\d{2}/)?.[0];

/**
 * The exchange rates the period's foreign entries were booked at, per currency: each ESTV rate
 * with its validity date, source and entries, and the 31.12. rate for the year-end revaluation.
 */
export function FxRatesSection({ index, period }: { index: Index; period: Period }) {
  const fx = useFx();
  const entries = useMemo(() => (index.journalEntries ?? []).filter((e) => inPeriod(period, e.date)), [index.journalEntries, period]);
  const byCurrency = useMemo(() => (fx.rates ? ratesUsed(entries, fx.paymentDate, fx.rates) : new Map<string, RateUse[]>()), [entries, fx]);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="rounded-lg border border-border overflow-hidden" data-testid="fx-rates">
      <div className="bg-muted px-4 py-2 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">{t('fx.title')}</h2>
        <p className="text-xs text-muted-foreground">
          {t('fx.subtitle', { date: formatDate(fx.rates?.fetchedAt?.slice(0, 10)) })}
        </p>
      </div>
      {byCurrency.size === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('fx.none')}</p>
      ) : [...byCurrency].map(([currency, uses]) => {
        const years = [...new Set(uses.flatMap((u) => u.entries.map(({ entry }) => entry.date.slice(0, 4))))].sort();
        return (
          <div key={currency} className="border-t border-border first:border-t-0" data-currency={currency}>
            <div className="px-4 pt-3 pb-1 flex items-baseline gap-3">
              <span className="font-mono font-semibold text-foreground">{currency}</span>
              {years.map((year) => {
                const end = fx.rates?.yearEnd(currency, year);
                return (
                  <span key={year} className="text-xs text-muted-foreground" data-testid="fx-year-end">
                    {end
                      ? t('fx.yearEnd', { year, rate: String(end.rate), date: formatDate(end.validOn) })
                      : t('fx.yearEndPending', { year })}
                  </span>
                );
              })}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border">
                  <th className="px-4 py-1 text-left w-8" />
                  <th className="px-3 py-1 text-left w-28">{t('fx.colValidOn')}</th>
                  <th className="px-3 py-1 text-right w-28">{t('fx.colRate')}</th>
                  <th className="px-3 py-1 text-right w-24">{t('fx.colEntries')}</th>
                  <th className="px-3 py-1 text-left">{t('fx.colSource')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {uses.map((use) => {
                  const key = `${currency}|${use.date}|${use.rate}`;
                  const expanded = open === key;
                  const first = use.entries[0].conversion;
                  const source = use.check.kind === 'estv' ? published(use.check.estv.source) : undefined;
                  return (
                    <Fragment key={key}>
                      <tr
                        onClick={() => setOpen(expanded ? null : key)}
                        className={cn('cursor-pointer', expanded ? 'bg-accent' : 'hover:bg-accent')}
                        data-testid="fx-rate-row"
                      >
                        <td className="px-4 py-1.5 text-muted-foreground">
                          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </td>
                        <td className="px-3 py-1.5 tabular-nums text-foreground">{formatDate(use.date)}</td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground">
                          <span className="inline-flex items-center gap-1">
                            <FxBadge conversion={first} />
                            {use.rate ?? '—'}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-foreground">{use.entries.length}</td>
                        <td className={cn('px-3 py-1.5 text-xs', use.check.kind === 'estv' ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-300')}>
                          {use.check.kind === 'estv'
                            ? t('fx.source', { date: formatDate(source) })
                            : checkText(first)}
                        </td>
                      </tr>
                      {expanded && use.entries.map(({ entry, conversion }) => (
                        <tr key={entry.id} className="bg-muted/40 text-xs" data-testid="fx-rate-entry">
                          <td />
                          <td className="px-3 py-1 tabular-nums text-muted-foreground">{formatDate(entry.date)}</td>
                          <td className="px-3 py-1 text-right font-mono tabular-nums text-muted-foreground">
                            {`${currency} ${fmt(conversion.amount)}`}
                          </td>
                          <td className="px-3 py-1 text-right font-mono tabular-nums text-foreground">{`CHF ${fmt(conversion.chf)}`}</td>
                          <td className="px-3 py-1">
                            <span className="inline-flex items-center gap-2 min-w-0">
                              <span className="truncate text-foreground" title={entry.description}>{entry.description}</span>
                              <EntryLinks entry={entry} period={period} />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}
