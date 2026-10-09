import { useMemo, useState } from 'react';
import type { CorrectionCase, JournalEntry, Receipt } from '../../types/index.js';
import { caseEffect, reconcileCases, roundCHF, type ReturnFigures } from '../../accounting/index.js';
import { effectLines, type EffectLine } from './vat-correction-form.js';
import { EntryDetail } from './vat-entry-table.js';
import { cn, fmt } from '../lib/utils.js';
import { t } from '../i18n/index.js';

const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;
const tone = (n: number) => n < 0 && 'text-red-600 dark:text-red-400';
const short = (l: EffectLine) => (l.tax ? t('cases.zifferTax', { ziffer: l.ziffer }) : l.ziffer);

/**
 * Why a filed quarter is corrected, case by case: what was wrong, the fix, the entries
 * before and after, and the Ziffern each case changes. Above them, the check that the
 * cases explain the whole Korrekturabrechnung.
 */
export function CorrectionCases({ cases, entries, receipts, filed, corrected, ziffer, print }: {
  cases: CorrectionCase[];
  entries: JournalEntry[];
  receipts: Receipt[];
  filed: ReturnFigures;
  corrected: ReturnFigures;
  /** Show only the cases that change this Ziffer. */
  ziffer?: string | null;
  /** Every case expanded, no controls. */
  print?: boolean;
}) {
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const mine = useMemo(() => cases.filter((c) => c.period === filed.period).map((c) => {
    const effect = caseEffect(c, entries);
    return { c, effect, lines: effectLines(c.period, effect.contribution) };
  }), [cases, entries, filed.period]);
  const reconciliation = useMemo(() => reconcileCases(cases, entries, filed, corrected), [cases, entries, filed, corrected]);
  const shown = ziffer ? mine.filter((m) => (m.effect.contribution[ziffer] ?? 0) !== 0) : mine;

  const [open, setOpen] = useState<Set<string>>(new Set());
  const allOpen = shown.length > 0 && shown.every((m) => open.has(m.c.id));
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((e): e is JournalEntry => !!e);
  const receiptLink = (source: string) => {
    const name = source.startsWith('receipts/') ? source.slice('receipts/'.length) : null;
    return name && receipts.find((r) => r.filename === name);
  };

  return (
    <div className={cn(print ? 'mt-8' : 'p-4')}>
      <div className="flex items-baseline gap-3 mb-2">
        <h3 className="text-sm font-bold text-foreground">
          {print ? t('cases.printTitle') : t('cases.title')}
          {ziffer ? `, ${t('vat.ziffer', { ziffer })}` : ''}: {t('cases.shownOf', { shown: shown.length, total: mine.length })}
        </h3>
        {!print && shown.length > 0 && (
          <button type="button" className="ml-auto text-xs px-2 py-0.5 rounded border border-border hover:bg-accent"
            onClick={() => setOpen(allOpen ? new Set() : new Set(shown.map((m) => m.c.id)))}>
            {allOpen ? t('cases.collapseAll') : t('cases.expandAll')}
          </button>
        )}
      </div>

      <Reconciliation count={mine.length} reconciliation={reconciliation} />

      <div className="space-y-2 mt-3">
        {shown.map(({ c, lines }) => {
          const expanded = print || open.has(c.id);
          const receipt = c.source ? receiptLink(c.source) : null;
          return (
            <div key={c.id} data-case={c.id} className="border border-border rounded break-inside-avoid">
              <button type="button" disabled={print} onClick={() => toggle(c.id)}
                className={cn('w-full flex items-baseline gap-2 px-3 py-2 text-left', !print && 'hover:bg-accent')}>
                {!print && <span className="text-xs text-muted-foreground w-3">{expanded ? '▾' : '▸'}</span>}
                <span className="font-semibold text-sm text-foreground flex-1">{c.title}</span>
                <span className="text-xs font-mono tabular-nums text-muted-foreground text-right">
                  {lines.length === 0 ? t('cases.noEffectShort')
                    : lines.map((l) => <span key={l.label} className={cn('ml-2', tone(l.amount))}>{short(l)} {signed(l.amount)}</span>)}
                </span>
              </button>
              {expanded && (
                <div className="border-t border-border text-sm">
                  <dl className="px-3 py-2 space-y-1">
                    <div><dt className="inline font-semibold">{t('cases.wrong')} </dt><dd className="inline">{c.wrong}</dd></div>
                    <div><dt className="inline font-semibold">{t('cases.fix')} </dt><dd className="inline">{c.fix}</dd></div>
                    {c.source && (
                      <div className="text-xs text-muted-foreground">
                        <dt className="inline">{t('cases.source')} </dt>
                        <dd className="inline font-mono">
                          {receipt ? <a className="underline hover:text-foreground" href={`/receipts?receipt=${receipt.id}`}>{c.source}</a> : c.source}
                        </dd>
                      </div>
                    )}
                  </dl>
                  <EntryDetail entries={pick(c.originalEntryIds)} title={t('cases.before')} />
                  <EntryDetail entries={pick(c.correctionEntryIds)} title={t('cases.correctionEntries')} />
                  <div className="border-t border-border">
                    <div className="px-4 py-2 bg-muted text-xs font-semibold text-muted-foreground">
                      {c.correctionEntryIds.length ? t('cases.effect') : t('cases.effectRedeclared')}
                    </div>
                    {lines.length === 0 ? (
                      <div className="px-4 py-2 text-muted-foreground">{t('cases.noEffect')}</div>
                    ) : (
                      <table className="w-full text-sm">
                        <tbody className="divide-y divide-border/50">
                          {lines.map((l) => (
                            <tr key={l.label}>
                              <td className="px-3 py-1 w-14 text-xs text-muted-foreground tabular-nums">{l.ziffer}</td>
                              <td className="px-3 py-1">{l.label}</td>
                              <td className={cn('px-3 py-1 w-28 text-right font-mono tabular-nums', tone(l.amount))}>{signed(l.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Reconciliation({ count, reconciliation: { unexplained, orphans } }: {
  count: number;
  reconciliation: ReturnType<typeof reconcileCases>;
}) {
  if (unexplained.length === 0 && orphans.length === 0) {
    return (
      <div data-reconciliation="ok" className="px-3 py-2 text-xs rounded border border-border bg-green-50 dark:bg-green-950 text-green-800 dark:text-green-200">
        {t('cases.reconciled', { n: count })}
      </div>
    );
  }
  return (
    <div data-reconciliation="unexplained" className="px-3 py-2 text-xs rounded border border-border bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200 space-y-1">
      {unexplained.length > 0 && <div className="font-semibold">{t('cases.unexplained')}</div>}
      {unexplained.map((u) => (
        <div key={u.ziffer} className="font-mono tabular-nums">
          {t('cases.unexplainedLine', { ziffer: u.ziffer, difference: signed(u.difference), explained: signed(u.explained), open: signed(roundCHF(u.difference - u.explained)) })}
        </div>
      ))}
      {orphans.length > 0 && (
        <div>
          <div className="font-semibold">{t('cases.orphans', { n: orphans.length })}</div>
          {orphans.map((e) => <div key={e.id} className="font-mono">{e.id} {e.date} {e.description}</div>)}
        </div>
      )}
    </div>
  );
}
