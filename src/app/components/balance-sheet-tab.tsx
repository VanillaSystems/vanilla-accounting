import { useMemo } from 'react';
import type { Index } from '../../types/index.js';
import { computeBalanceSheet } from '../../accounting/index.js';
import { getAccountMap } from '../lib/accounts.js';
import { cn } from '../lib/utils.js';

interface Props {
  index: Index;
  period: string;
}

function parseAsOfDate(period: string): string {
  if (period.includes('-Q')) {
    const [year, q] = period.split('-Q');
    const quarterEnd: Record<string, string> = { '1': '03-31', '2': '06-30', '3': '09-30', '4': '12-31' };
    return `${year}-${quarterEnd[q] ?? '12-31'}`;
  }
  if (/^\d{4}$/.test(period)) {
    return `${period}-12-31`;
  }
  // 'all' or anything else — use current year
  return `${new Date().getFullYear()}-12-31`;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

export function BalanceSheetTab({ index, period }: Props) {
  const asOfDate = useMemo(() => parseAsOfDate(period), [period]);

  const year = asOfDate.slice(0, 4);
  const openingBalances = index.config?.openingBalances?.[year] ?? {};
  const accountNames = getAccountMap();
  const entries = index.journalEntries ?? [];

  const bs = useMemo(
    () => computeBalanceSheet(entries, asOfDate, openingBalances, accountNames),
    [entries, asOfDate, openingBalances, accountNames],
  );

  const hasData = bs.assets.some(s => s.rows.length > 0) || bs.liabilities.some(s => s.rows.length > 0);

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground w-full">
        Keine Bilanzdaten vorhanden.
      </div>
    );
  }

  function renderSection(sections: typeof bs.assets) {
    return sections.map((section) => (
      <div key={section.title} className="mb-4">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted rounded text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <span>{section.title}</span>
          <span className="font-mono tabular-nums">CHF {fmt(section.total)}</span>
        </div>
        {section.rows.length > 0 ? (
          <table className="w-full text-sm mt-1">
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.account} className="border-b border-border/50">
                  <td className="py-1 px-3 text-muted-foreground w-16 font-mono text-xs">{row.account}</td>
                  <td className="py-1 px-1">{row.name}</td>
                  <td className="py-1 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                    {fmt(row.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">Keine Konten</div>
        )}
      </div>
    ));
  }

  return (
    <div className="flex flex-col flex-1 overflow-auto p-6">
      <div className="grid grid-cols-2 gap-8 flex-1">
        {/* Assets */}
        <div>
          <h2 className="text-base font-semibold mb-4">Aktiven <span className="text-xs font-normal text-muted-foreground">CHF</span></h2>
          {renderSection(bs.assets)}
        </div>

        {/* Liabilities + Equity */}
        <div>
          <h2 className="text-base font-semibold mb-4">Passiven <span className="text-xs font-normal text-muted-foreground">CHF</span></h2>
          {renderSection(bs.liabilities)}
        </div>
      </div>

      {/* Footer totals */}
      <div className="border-t border-border mt-4 pt-4">
        <div className="grid grid-cols-2 gap-8">
          <div className="flex items-center justify-between px-3 py-2 bg-muted rounded font-semibold text-sm">
            <span>Total Aktiven</span>
            <span className="font-mono tabular-nums">CHF {fmt(bs.totalAssets)}</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2 bg-muted rounded font-semibold text-sm">
            <span>Total Passiven</span>
            <span className="font-mono tabular-nums">CHF {fmt(bs.totalLiabilities)}</span>
          </div>
        </div>
        <div className="flex justify-center mt-3">
          <span
            className={cn(
              'text-xs font-medium px-3 py-1 rounded-full',
              bs.isBalanced
                ? 'bg-accent text-foreground'
                : 'bg-destructive/10 text-destructive',
            )}
          >
            {bs.isBalanced ? 'Bilanz ausgeglichen' : `Differenz: ${fmt(Math.abs(bs.totalAssets - bs.totalLiabilities))}`}
          </span>
        </div>
      </div>
    </div>
  );
}
