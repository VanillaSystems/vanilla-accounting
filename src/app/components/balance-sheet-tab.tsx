import { useMemo } from 'react';
import type { Index } from '../../types/index.js';
import { computeBalanceSheet } from '../../accounting/index.js';
import { localToday, type Period } from '../../accounting/periods.js';
import { getAccountMap } from '../lib/accounts.js';
import { cn, formatDate } from '../lib/utils.js';
import { accountingName, t } from '../i18n/index.js';
import { useUrlParam } from '../hooks/use-url-state.js';
import { SplitPane } from './split-pane.js';
import { AccountPanel, accountRowProps } from './account-panel.js';

interface Props {
  index: Index;
  period: Period;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

export function BalanceSheetTab({ index, period }: Props) {
  const asOfDate = period.kind === 'all' ? localToday() : period.to;
  const [account, setAccount] = useUrlParam('account');

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
        {t('balance.none')}
      </div>
    );
  }

  function renderSection(sections: typeof bs.assets) {
    return sections.map((section) => (
      <div key={section.title} className="mb-4">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted rounded text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <span>{accountingName(section.title)}</span>
          <span className="font-mono tabular-nums">CHF {fmt(section.total)}</span>
        </div>
        {section.rows.length > 0 ? (
          <table className="w-full text-sm mt-1">
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.account || row.name} {...(row.account ? accountRowProps(row.account, account, setAccount, 'border-b border-border/50') : { className: 'border-b border-border/50' })}>
                  <td className="py-1 px-3 text-muted-foreground w-16 font-mono text-xs">{row.account}</td>
                  <td className="py-1 px-1">{row.account ? row.name : accountingName(row.name)}</td>
                  <td className="py-1 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                    {fmt(row.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-3 py-2 text-xs text-muted-foreground">{t('balance.noAccounts')}</div>
        )}
      </div>
    ));
  }

  return (
    <SplitPane
      storageKey="statement-account"
      defaultLeft={55}
      className="flex-1"
      leftClassName="overflow-auto"
      right={account && (
        <AccountPanel index={index} account={account} from={`${year}-01-01`} to={asOfDate} period={period} onClose={() => setAccount(null)} />
      )}
      left={
    <div className="flex flex-col p-6">
      <p className="text-sm text-muted-foreground mb-4" data-testid="balance-as-of">
        {t('balance.asOf', { date: formatDate(asOfDate) })}
        <span className="ml-3 text-xs text-dim">{t('accountPanel.hint')}</span>
      </p>
      <div className="grid grid-cols-2 gap-8 flex-1">
        {/* Assets */}
        <div>
          <h2 className="text-base font-semibold mb-4">{t('balance.assets')} <span className="text-xs font-normal text-muted-foreground">CHF</span></h2>
          {renderSection(bs.assets)}
        </div>

        {/* Liabilities + Equity */}
        <div>
          <h2 className="text-base font-semibold mb-4">{t('balance.liabilities')} <span className="text-xs font-normal text-muted-foreground">CHF</span></h2>
          {renderSection(bs.liabilities)}
        </div>
      </div>

      {/* Footer totals */}
      <div className="border-t border-border mt-4 pt-4">
        <div className="grid grid-cols-2 gap-8">
          <div className="flex items-center justify-between px-3 py-2 bg-muted rounded font-semibold text-sm">
            <span>{t('balance.totalAssets')}</span>
            <span className="font-mono tabular-nums">CHF {fmt(bs.totalAssets)}</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2 bg-muted rounded font-semibold text-sm">
            <span>{t('balance.totalLiabilities')}</span>
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
            {bs.isBalanced ? t('balance.balanced') : t('balance.difference', { amount: fmt(Math.abs(bs.totalAssets - bs.totalLiabilities)) })}
          </span>
        </div>
      </div>
    </div>
      }
    />
  );
}
