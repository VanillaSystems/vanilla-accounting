import { useMemo } from 'react';
import { BookOpen, FileText, X } from 'lucide-react';
import type { Index, Receipt } from '../../types/index.js';
import { computeAccountLedger, openingBalancesAt } from '../../accounting/index.js';
import type { Period } from '../../accounting/periods.js';
import { getAccountMap } from '../lib/accounts.js';
import { accountHref } from '../lib/location.js';
import { cn, fmt, formatDate } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { EntryLinks } from './open-in-tab-link.js';

/** The receipts of each transaction ref: mappings link receipts to transactions, entries reach them through their ref. */
export function useReceiptsByTxRef(index: Index): Map<string, Receipt[]> {
  return useMemo(() => {
    const byId = new Map(index.receipts.map((r) => [r.id, r]));
    const m = new Map<string, Receipt[]>();
    for (const { transactionRef, receiptId } of index.mappings) {
      const r = byId.get(receiptId);
      if (r) m.set(transactionRef, [...(m.get(transactionRef) ?? []), r]);
    }
    return m;
  }, [index.receipts, index.mappings]);
}

/**
 * One account's movements from `from` to `to`, beside a statement (Bilanz, Erfolgsrechnung,
 * Saldobilanz): opening balance, the entries with their running balance and receipts, closing
 * balance. Each entry links to Buchungen; the header links to the full Kontoauszug.
 */
export function AccountPanel({ index, account, from, to, period, onClose, movementsOnly }: {
  index: Index;
  account: string;
  from: string;
  to: string;
  /** The period the links keep. */
  period: Period;
  onClose: () => void;
  /** Start from 0, so the closing balance is the period's figure (Erfolgsrechnung). */
  movementsOnly?: boolean;
}) {
  const entries = index.journalEntries ?? [];
  const name = getAccountMap()[account] ?? '';
  const receiptsByTxRef = useReceiptsByTxRef(index);
  const ledger = useMemo(() => {
    const opening = movementsOnly ? 0 : openingBalancesAt(entries, from, index.config?.openingBalances)[account] ?? 0;
    return computeAccountLedger(entries, account, from, to, opening);
  }, [entries, account, from, to, index.config?.openingBalances, movementsOnly]);
  const refOf = useMemo(() => new Map(entries.map((e) => [e.id, e.transactionRef])), [entries]);
  const closing = ledger.rows.at(-1)?.balance ?? ledger.openingBalance;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background" data-testid="account-panel">
      <div className="shrink-0 bg-muted border-b border-border px-4 py-2 flex items-center gap-2">
        <span className="font-mono text-sm font-semibold text-foreground">{account}</span>
        <span className="text-sm text-foreground truncate">{name}</span>
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{t('common.dateRange', { from: formatDate(from), to: formatDate(to) })}</span>
        <a
          href={accountHref(account, period.token)}
          className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap"
          data-testid="open-ledger"
        >
          <BookOpen className="h-3.5 w-3.5" />
          {t('accountPanel.openLedger')}
        </a>
        <button onClick={onClose} title={t('common.close')} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 text-left font-semibold w-24">{t('col.date')}</th>
              <th className="px-3 py-2 text-left font-semibold">{t('col.description')}</th>
              <th className="px-2 py-2 text-left font-semibold w-12" title={t('tab.receipts')}>{t('tab.receipts')}</th>
              <th className="px-3 py-2 text-right font-semibold w-24">{t('col.debitChf')}</th>
              <th className="px-3 py-2 text-right font-semibold w-24">{t('col.creditChf')}</th>
              <th className="px-3 py-2 text-right font-semibold w-28">{t('col.balanceChf')}</th>
              <th className="w-12" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            <tr className="bg-muted/50">
              <td className="px-3 py-1.5" />
              <td className="px-3 py-1.5 text-muted-foreground font-medium">{t('ledger.openingBalance')}</td>
              <td colSpan={3} />
              <td className="px-3 py-1.5 text-right font-mono tabular-nums font-medium">{fmt(ledger.openingBalance)}</td>
              <td />
            </tr>
            {ledger.rows.map((row) => {
              const count = receiptsByTxRef.get(refOf.get(row.entryId) ?? '')?.length ?? 0;
              return (
                <tr key={row.entryId} data-rowid={row.entryId} className="hover:bg-accent transition-colors">
                  <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{formatDate(row.date)}</td>
                  <td className="px-3 py-1.5 text-foreground truncate max-w-0" title={row.description}>
                    {row.description || <span className="text-dim">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-xs tabular-nums">
                    {count > 0 ? (
                      <span className="inline-flex items-center gap-1 text-foreground" title={t('app.receiptCount', { n: count })}>
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />{count}
                      </span>
                    ) : <span className="text-dim">—</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{row.debit != null ? fmt(row.debit) : ''}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{row.credit != null ? fmt(row.credit) : ''}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{fmt(row.balance)}</td>
                  <td className="pr-2">
                    <EntryLinks entry={{ id: row.entryId, date: row.date, transactionRef: refOf.get(row.entryId) }} period={period} />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className={cn('border-t-2 border-border bg-muted/50')}>
              <td className="px-3 py-2" />
              <td className="px-3 py-2 font-medium text-foreground">{t('ledger.closingBalance')}</td>
              <td colSpan={3} />
              <td className="px-3 py-2 text-right font-mono tabular-nums font-bold" data-testid="closing-balance">{fmt(closing)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** Props that make a statement's account row open its panel: a click, or Enter/Space when focused. */
export function accountRowProps(account: string, selected: string | null, onSelect: (account: string | null) => void, className?: string) {
  const toggle = () => onSelect(selected === account ? null : account);
  return {
    'data-account': account,
    tabIndex: 0,
    'aria-selected': selected === account,
    onClick: toggle,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    },
    className: cn(className, 'cursor-pointer focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring', selected === account ? 'bg-accent' : 'hover:bg-accent'),
  };
}
