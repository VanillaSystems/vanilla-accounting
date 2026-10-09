import { useState, useMemo } from 'react';
import type { Index } from '../../types/index.js';
import { computeTrialBalance, computeAccountLedger, openingBalancesAt } from '../../accounting/index.js';
import type { Period } from '../../accounting/periods.js';
import { getAccountMap } from '../lib/accounts.js';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';

interface Props {
  index: Index;
  period: Period;
}

export function TrialBalanceTab({ index, period }: Props) {
  const { from, to } = period;
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);

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

  const ledger = useMemo(() => {
    if (!selectedAccount) return null;
    const ob = openingBalances[selectedAccount] ?? 0;
    return computeAccountLedger(entries, selectedAccount, from, to, ob);
  }, [selectedAccount, entries, from, to, openingBalances]);

  const selectedName = selectedAccount ? (accountNames[selectedAccount] ?? selectedAccount) : '';

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

      <div className="flex-1 flex overflow-hidden">
        {/* Table */}
        <div className="overflow-auto w-[45%] border-r border-border">
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
                const isSelected = row.account === selectedAccount;
                return (
                  <tr
                    key={row.account}
                    className={cn(
                      'cursor-pointer transition-colors',
                      isSelected ? 'bg-accent' : 'hover:bg-accent/50',
                    )}
                    onClick={() => setSelectedAccount(isSelected ? null : row.account)}
                  >
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
        </div>

        {/* Account ledger detail panel */}
        <div className="flex-1 flex flex-col overflow-hidden bg-background">
          {!selectedAccount || !ledger ? (
            <div className="flex-1 flex items-center justify-center text-sm text-dim">
              {t('trial.selectAccount')}
            </div>
          ) : (
          <>
            <div className="bg-muted border-b border-border px-4 py-2 flex items-center gap-2 shrink-0">
              <span className="font-mono text-sm font-semibold text-foreground">{selectedAccount}</span>
              <span className="text-sm text-foreground">{selectedName}</span>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">{t('common.entryCount', { n: ledger.rows.length })}</span>
            </div>
            <div className="flex-1 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-muted border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2 text-left font-semibold w-24">{t('col.date')}</th>
                    <th className="px-3 py-2 text-left font-semibold">{t('col.description')}</th>
                    <th className="px-3 py-2 text-right font-semibold w-24">{t('col.debitChf')}</th>
                    <th className="px-3 py-2 text-right font-semibold w-24">{t('col.creditChf')}</th>
                    <th className="px-3 py-2 text-right font-semibold w-28">{t('col.balanceChf')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  <tr className="bg-muted/50">
                    <td className="px-3 py-1.5 text-muted-foreground"></td>
                    <td className="px-3 py-1.5 text-muted-foreground font-medium">{t('ledger.openingBalance')}</td>
                    <td className="px-3 py-1.5"></td>
                    <td className="px-3 py-1.5"></td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums font-medium">
                      {ledger.openingBalance.toFixed(2)}
                    </td>
                  </tr>
                  {ledger.rows.map((row, i) => (
                    <tr key={row.entryId ?? i} className="hover:bg-accent/50 transition-colors">
                      <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{row.date}</td>
                      <td className="px-3 py-1.5 text-foreground truncate" title={row.description}>
                        {row.description || <span className="text-dim">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground">
                        {row.debit != null ? row.debit.toFixed(2) : ''}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground">
                        {row.credit != null ? row.credit.toFixed(2) : ''}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums font-medium text-foreground">
                        {row.balance.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/50">
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2 font-medium text-foreground">{t('ledger.closingBalance')}</td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums font-bold text-foreground">
                      {(ledger.rows.length > 0
                        ? ledger.rows[ledger.rows.length - 1].balance
                        : ledger.openingBalance
                      ).toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
