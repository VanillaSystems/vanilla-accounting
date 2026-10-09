import { useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { Index, JournalEntry } from '../../types/index.js';
import { VAT_CODE_FAMILIES, VAT_CODES, lookupVatCode, type VatCodeEntry } from '../../accounting/vat-codes.js';
import { inPeriod, type Period } from '../../accounting/periods.js';
import { t } from '../i18n/index.js';
import { cn, fmt } from '../lib/utils.js';
import { SearchBar } from './search-bar.js';
import { EntryDetail } from './vat-entry-table.js';
import { amountText, kindName, kindNotWhen, kindWhen, rateText, zifferText } from './vat-code.js';

interface Props {
  index: Index;
  period: Period;
  /** The selected code, unsigned (?code=). */
  code: string | null;
  onCode: (code: string | null) => void;
  onBack: () => void;
}

const unsigned = (code: string) => code.replace(/^-/, '');

/**
 * The VAT codes explained (MWST tab, ?view=codes): every code by family with its meaning, rate and
 * Ziffern, a search, and for the selected code when to use it, a casebook example and the
 * period's entries that use it.
 */
export function VatCodesView({ index, period, code, onCode, onBack }: Props) {
  const [query, setQuery] = useState('');

  const byCode = useMemo(() => {
    const m = new Map<string, JournalEntry[]>();
    for (const e of index.journalEntries ?? []) {
      if (!e.vatCode || !inPeriod(period, e.date)) continue;
      const key = unsigned(e.vatCode);
      m.set(key, [...(m.get(key) ?? []), e]);
    }
    return m;
  }, [index.journalEntries, period]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return VAT_CODES;
    return VAT_CODES.filter((c) => [c.code, c.bananaText ?? '', kindName(c), kindWhen(c), kindNotWhen(c)].some((s) => s.toLowerCase().includes(q)));
  }, [query]);

  // A code booked in the period but outside the catalogue (I26-2) is still explained when selected.
  const selected = code ? lookupVatCode(code)?.entry ?? null : null;

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="vat-codes">
      <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm px-2 py-1 rounded-md border border-border hover:bg-accent">
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('vatCodes.back')}
        </button>
        <h2 className="text-lg font-bold text-foreground">{t('vatCodes.title')}</h2>
        <SearchBar value={query} onChange={setQuery} placeholder={t('vatCodes.search')} className="ml-auto w-72" />
      </div>
      <div className="flex-1 flex overflow-hidden">
        <div className="overflow-auto w-[55%] border-r border-border p-4 space-y-5">
          <p className="text-xs text-muted-foreground max-w-3xl">{t('vatCodes.intro')}</p>
          {shown.length === 0 && <p className="text-sm text-muted-foreground">{t('vatCodes.noMatch')}</p>}
          {VAT_CODE_FAMILIES.map((family) => {
            const codes = shown.filter((c) => c.family === family);
            if (codes.length === 0) return null;
            return (
              <section key={family}>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  {family} · {t(`vatCodes.family.${family}`)}
                </h3>
                <table className="w-full text-sm border border-border rounded-lg">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="px-2 py-1 text-left w-20">{t('vatCodes.colCode')}</th>
                      <th className="px-2 py-1 text-left">{t('vatCodes.colMeaning')}</th>
                      <th className="px-2 py-1 text-left w-36">{t('vatCodes.colRate')}</th>
                      <th className="px-2 py-1 text-left w-44">{t('vatCodes.colZiffern')}</th>
                      <th className="px-2 py-1 text-right w-20">{t('vatCodes.colUsed')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {codes.map((c) => (
                      <CodeRow key={c.code} entry={c} used={byCode.get(c.code)?.length ?? 0} selected={c.code === selected?.code} onClick={() => onCode(c.code === selected?.code ? null : c.code)} />
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
        </div>
        <div className="flex-1 overflow-auto bg-background">
          {selected ? <CodeDetail entry={selected} entries={byCode.get(selected.code) ?? []} period={period} /> : (
            <div className="h-full flex items-center justify-center text-sm text-dim p-6 text-center">{t('vatCodes.select')}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function CodeRow({ entry, used, selected, onClick }: { entry: VatCodeEntry; used: number; selected: boolean; onClick: () => void }) {
  return (
    <tr className={cn('cursor-pointer hover:bg-accent align-top', selected && 'bg-accent')} onClick={onClick} data-testid={`vat-code-row-${entry.code}`}>
      <td className={cn('px-2 py-1 font-mono', entry.ziffern === null && 'text-amber-700 dark:text-amber-300')}>{entry.code}</td>
      <td className="px-2 py-1">{kindName(entry)}</td>
      <td className="px-2 py-1 text-xs text-muted-foreground">{rateText(entry)}</td>
      <td className={cn('px-2 py-1 text-xs', entry.ziffern === null ? 'text-amber-700 dark:text-amber-300' : 'font-mono')}>
        {entry.ziffern === null ? '—' : entry.ziffern.map((z) => z.ziffer).join(', ') || '—'}
      </td>
      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{used || ''}</td>
    </tr>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{children}</span>
    </div>
  );
}

function CodeDetail({ entry, entries, period }: { entry: VatCodeEntry; entries: JournalEntry[]; period: Period }) {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <div data-testid="vat-code-detail">
      <div className="p-4 space-y-3">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xl font-bold text-foreground">{entry.code}</span>
            <span className="text-xs text-muted-foreground">{entry.family} · {t(`vatCodes.family.${entry.family}`)}</span>
          </div>
          <p className="text-sm font-medium text-foreground">{kindName(entry)}</p>
          <p className="text-xs text-muted-foreground">{entry.bananaText ?? t('vatCodes.notInBanana')}</p>
        </div>
        <div className="space-y-1">
          {entry.rate !== null && <Fact label={t('vatCodes.colRate')}>{rateText(entry)}</Fact>}
          {entry.rate !== 0 && entry.rate !== null && <Fact label={t('col.amount')}>{amountText(entry)}</Fact>}
          <Fact label={t('vatCodes.ziffern')}>
            <span className={cn(entry.ziffern === null && 'text-amber-700 dark:text-amber-300')}>{zifferText(entry)}</span>
            {entry.ziffern === null && entry.bananaZiffern.length > 0 && (
              <span className="block text-xs text-muted-foreground">{t('vatCodes.bananaZiffern', { ziffern: entry.bananaZiffern.join(', ') })}</span>
            )}
          </Fact>
          <Fact label={`-${entry.code}`}>{t('vatCodes.negative', { code: entry.code })}</Fact>
        </div>
        <div className="space-y-2 text-sm">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">{t('vatCodes.when')}</p>
            <p className="text-foreground">{kindWhen(entry)}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground">{t('vatCodes.notWhen')}</p>
            <p className="text-foreground">{kindNotWhen(entry)}</p>
          </div>
          {entry.rules.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('vatCodes.rules')}: <span className="font-mono">{entry.rules.join(', ')}</span>
            </p>
          )}
        </div>
        {entry.examples.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground mb-1">{t('vatCodes.example')}</p>
            <ul className="space-y-1">
              {entry.examples.slice(0, 3).map((ex) => (
                <li key={`${ex.caseId}-${ex.description}`} className="rounded bg-muted px-2 py-1 text-xs">
                  <span className="block text-foreground">{ex.title}</span>
                  <span className="font-mono text-muted-foreground">
                    {ex.debit || '—'} / {ex.credit || '—'} · {ex.currency ?? 'CHF'} {fmt(ex.amount)} · {ex.vatCode} · {ex.description}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <EntryDetail entries={sorted} period={period} title={t('vatCodes.entries', { code: entry.code })} />
    </div>
  );
}
