import { useMemo } from 'react';
import type { Index } from '../../types/index.js';
import { computeTrialBalance, openingBalancesAt } from '../../accounting/index.js';
import type { Period } from '../../accounting/periods.js';
import { getAccountMap } from '../lib/accounts.js';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { useUrlParam } from '../hooks/use-url-state.js';
import { useAutoSelectFirst } from '../hooks/use-auto-select-first.js';
import { SplitPane } from './split-pane.js';
import { AccountPanel, accountRowProps } from './account-panel.js';

interface Props {
  index: Index;
  period: Period;
}

export function TrialBalanceTab({ index, period }: Props) {
  const { from, to } = period;
  const [selectedAccount, setSelectedAccount] = useUrlParam('account');

  const accountNames = useMemo(() => getAccountMap(), []);
  const entries = index.journalEntries ?? [];
  const openingBalances = useMemo(
    () => openingBalancesAt(entries, from, index.config?.openingBalances),
    [entries, from, index.config?.openingBalances],
  );

  const trialBalance = useMemo(() => {
    return computeTrialBalance(entries, from, to, openingBalances, accountNames);
  }, [entries, from, to, openingBalances, accountNames]);

  const totalBalance = trialBalance.totalDebits - trialBalance.totalCredits;
  useAutoSelectFirst(trialBalance.rows.map((r) => r.account), selectedAccount, setSelectedAccount);


  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="bg-muted border-b border-border px-3 py-1.5 flex items-center gap-2 shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('tab.trialBalance')}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('common.dateRange', { from, to })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('trial.accountCount', { n: trialBalance.rows.length })}
          </span>
          <span
            className={cn(
              'text-xs font-semibold px-1.5 py-0.5 rounded',
              trialBalance.isBalanced
                ? 'bg-accent text-foreground'
                : 'bg-destructive/10 text-destructive',
            )}
          >
            {trialBalance.isBalanced ? t('trial.balanced') : t('trial.unbalanced')}
          </span>
        </div>
      </div>

      <SplitPane
        storageKey="statement-account"
        defaultLeft={45}
        className="flex-1"
        leftClassName="overflow-auto"
        right={selectedAccount && (
          <AccountPanel index={index} account={selectedAccount} from={from} to={to} period={period} onClose={() => setSelectedAccount(null)} />
        )}
        left={
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold w-20">{t('col.account')}</th>
                <th className="px-3 py-2 text-left font-semibold">{t('col.name')}</th>
                <th className="px-3 py-2 text-right font-semibold w-28">{t('col.debitChf')}</th>
                <th className="px-3 py-2 text-right font-semibold w-28">{t('col.creditChf')}</th>
                <th className="px-3 py-2 text-right font-semibold w-28">{t('col.balanceChf')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {trialBalance.rows.map((row) => {
                return (
                  <tr key={row.account} {...accountRowProps(row.account, selectedAccount, setSelectedAccount, 'transition-colors')}>
                    <td className="px-3 py-1.5 font-mono tabular-nums text-foreground">{row.account}</td>
                    <td className="px-3 py-1.5 text-foreground truncate">{row.name}</td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground">
                      {row.debitTotal !== 0 ? row.debitTotal.toFixed(2) : ''}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground">
                      {row.creditTotal !== 0 ? row.creditTotal.toFixed(2) : ''}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-1.5 text-right font-mono tabular-nums font-medium',
                        row.balance > 0
                          ? 'text-foreground'
                          : row.balance < 0
                            ? 'text-destructive'
                            : 'text-muted-foreground',
                      )}
                    >
                      {row.balance.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-muted border-t-2 border-border font-semibold">
                <td className="px-3 py-2 text-foreground" colSpan={2}>
                  {t('common.total')}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                  {trialBalance.totalDebits.toFixed(2)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                  {trialBalance.totalCredits.toFixed(2)}
                </td>
                <td
                  className={cn(
                    'px-3 py-2 text-right font-mono tabular-nums',
                    trialBalance.isBalanced
                      ? 'text-foreground'
                      : 'text-destructive',
                  )}
                >
                  {totalBalance.toFixed(2)}
                </td>
              </tr>
            </tfoot>
          </table>
        }
      />
    </div>
  );
}
