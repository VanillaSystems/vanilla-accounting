import { useState, useMemo, useEffect } from 'react';
import { ExternalLink, FileText } from 'lucide-react';
import type { Index, Receipt } from '../../types/index.js';
import { computeAccountLedger, openingBalancesAt } from '../../accounting/index.js';
import { getAccounts } from '../lib/accounts.js';
import { cn } from '../lib/utils.js';
import type { Period } from '../../accounting/periods.js';
import { PdfFrame } from './pdf-frame.js';
import { AccountCombobox } from './account-combobox.js';
import { SplitPane } from './split-pane.js';
import { useAutoSelectFirst } from '../hooks/use-auto-select-first.js';
import { EntryLinks, OpenInTabLink } from './open-in-tab-link.js';
import { t } from '../i18n/index.js';
import { FxChf } from './fx-amount.js';
import { sources } from '../lib/api.js';
import { receiptHref, setView, viewParams } from '../lib/location.js';

interface Props {
  index: Index;
  period: Period;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

const urlParam = (name: string) => viewParams().get(name);

export function AccountLedgerTab({ index, period }: Props) {
  const [selectedAccount, setSelectedAccountState] = useState<string>(() => urlParam('account') ?? '');
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(() => urlParam('je'));
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(() => urlParam('receipt'));

  function setSelectedAccount(account: string) {
    setSelectedAccountState(account);
    setSelectedEntryId(null);
    setSelectedReceiptId(null);
  }

  const journalEntries = index.journalEntries ?? [];

  // Receipts reach an entry through its transaction: mappings link receipts to transaction refs.
  const receiptsByTxRef = useMemo(() => {
    const byId = new Map(index.receipts.map((r) => [r.id, r]));
    const m = new Map<string, Receipt[]>();
    for (const { transactionRef, receiptId } of index.mappings) {
      const r = byId.get(receiptId);
      if (r) m.set(transactionRef, [...(m.get(transactionRef) ?? []), r]);
    }
    return m;
  }, [index.receipts, index.mappings]);
  const entryById = useMemo(() => new Map(journalEntries.map((e) => [e.id, e])), [journalEntries]);
  const receiptsOf = (entryId: string) => receiptsByTxRef.get(entryById.get(entryId)?.transactionRef ?? '') ?? [];
  const selectedReceipts = selectedEntryId ? receiptsOf(selectedEntryId) : [];

  function selectEntry(entryId: string) {
    setSelectedEntryId(entryId);
    setSelectedReceiptId(receiptsOf(entryId)[0]?.id ?? null);
  }

  useEffect(() => {
    const params = viewParams();
    for (const [k, v] of [['account', selectedAccount], ['je', selectedEntryId], ['receipt', selectedReceiptId]] as const) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    setView(params);
  }, [selectedAccount, selectedEntryId, selectedReceiptId]);

  const { from, to } = period;
  const allAccounts = useMemo(() => [...getAccounts()].sort((a, b) => a.number.localeCompare(b.number)), []);

  // The accounts with an entry in the period, offered first.
  const activeAccounts = useMemo(() => {
    const used = new Set<string>();
    for (const je of journalEntries) {
      if (!je.date || je.date < from || je.date > to) continue;
      used.add(je.accountDebit);
      used.add(je.accountCredit);
    }
    return allAccounts.filter((a) => used.has(a.number));
  }, [journalEntries, allAccounts, from, to]);

  const picker = (
    <AccountCombobox accounts={activeAccounts} allAccounts={allAccounts} value={selectedAccount} onChange={setSelectedAccount} />
  );
  const openingBalance = useMemo(
    () => (selectedAccount ? openingBalancesAt(journalEntries, from, index.config?.openingBalances)[selectedAccount] ?? 0 : 0),
    [selectedAccount, journalEntries, from, index.config?.openingBalances],
  );

  const ledger = useMemo(() => {
    if (!selectedAccount) return null;
    return computeAccountLedger(journalEntries, selectedAccount, from, to, openingBalance);
  }, [journalEntries, selectedAccount, from, to, openingBalance]);

  useAutoSelectFirst(ledger?.rows.map((r) => r.entryId) ?? [], selectedEntryId, (entryId) => {
    if (entryId) selectEntry(entryId);
    else { setSelectedEntryId(null); setSelectedReceiptId(null); }
  }, !!selectedAccount);

  const closingBalance = ledger
    ? ledger.rows.length > 0
      ? ledger.rows[ledger.rows.length - 1].balance
      : ledger.openingBalance
    : 0;

  if (!selectedAccount) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Toolbar */}
        <div className="bg-muted border-b border-border px-3 py-1.5 flex items-center gap-2 shrink-0">
          {picker}
        </div>
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {t('ledger.chooseAccount')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="bg-muted border-b border-border px-3 py-1.5 flex items-center gap-2 shrink-0">
          {picker}
        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          {t('common.entryCount', { n: ledger?.rows.length ?? 0 })}
        </div>
      </div>

      <SplitPane
        storageKey="account-ledger"
        defaultLeft={55}
        leftClassName="overflow-auto"
        left={
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 text-left font-semibold w-28">{t('col.date')}</th>
              <th className="px-3 py-2 text-left font-semibold">{t('col.description')}</th>
              <th className="px-2 py-2 text-left font-semibold w-14" title={t('tab.receipts')}>{t('tab.receipts')}</th>
              <th className="px-3 py-2 text-right font-semibold w-28">{t('col.debitChf')}</th>
              <th className="px-3 py-2 text-right font-semibold w-28">{t('col.creditChf')}</th>
              <th className="px-3 py-2 text-right font-semibold w-32">{t('col.balanceChf')}</th>
              <th className="w-12" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {/* Opening balance row */}
            <tr className="bg-muted/50">
              <td className="px-3 py-2 text-muted-foreground"></td>
              <td className="px-3 py-2 text-muted-foreground font-medium">{t('ledger.openingBalance')}</td>
              <td className="px-2 py-2"></td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground font-medium">
                {fmt(ledger!.openingBalance)}
              </td>
              <td />
            </tr>

            {/* Entry rows */}
            {ledger!.rows.map((row, i) => {
              const count = receiptsOf(row.entryId).length;
              return (
              <tr
                key={row.entryId ?? i}
                data-rowid={row.entryId}
                onClick={() => selectEntry(row.entryId)}
                className={cn(
                  'cursor-pointer transition-colors',
                  selectedEntryId === row.entryId ? 'bg-blue-50 dark:bg-blue-950' : 'hover:bg-accent',
                )}
              >
                <td className="px-3 py-2 text-foreground tabular-nums">{row.date}</td>
                <td className="px-3 py-2 text-foreground truncate max-w-0" title={row.description}>
                  {row.description || <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-2 py-2 text-xs tabular-nums">
                  {count > 0 ? (
                    <span className="inline-flex items-center gap-1 text-foreground" title={t('app.receiptCount', { n: count })}>
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />{count}
                    </span>
                  ) : (
                    <span className="text-dim">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                  {row.debit != null && <FxChf entry={entryById.get(row.entryId)}>{fmt(row.debit)}</FxChf>}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                  {row.credit != null && <FxChf entry={entryById.get(row.entryId)}>{fmt(row.credit)}</FxChf>}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                  {fmt(row.balance)}
                </td>
                <td className="px-1"><EntryLinks entry={{ id: row.entryId, date: row.date, transactionRef: entryById.get(row.entryId)?.transactionRef }} period={period} /></td>
              </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className={cn('border-t-2 border-border bg-muted/50')}>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2 font-medium text-foreground">{t('ledger.closingBalance')}</td>
              <td className="px-2 py-2"></td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground font-bold">
                {fmt(closingBalance)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
        }
        right={selectedEntryId && (
          <>
            <div className="shrink-0 border-b border-border px-4 py-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('tab.receipts')}</span>
                <span className="text-xs text-muted-foreground">({selectedReceipts.length})</span>
                <span className="ml-auto truncate text-xs text-muted-foreground" title={entryById.get(selectedEntryId)?.transactionRef}>
                  {entryById.get(selectedEntryId)?.transactionRef}
                </span>
              </div>
              {selectedReceipts.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">{t('journal.noReceipts')}</p>
              ) : (
                <div className="space-y-0.5">
                  {selectedReceipts.map((r) => (
                    <div
                      key={r.id}
                      onClick={() => setSelectedReceiptId(r.id)}
                      className={cn(
                        'flex items-center gap-2 text-sm rounded px-2 py-1.5 cursor-pointer',
                        selectedReceiptId === r.id
                          ? 'bg-blue-50 dark:bg-blue-900 ring-1 ring-blue-200 dark:ring-blue-700'
                          : 'bg-muted hover:bg-accent',
                      )}
                    >
                      <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="flex-1 min-w-0 truncate text-foreground" title={r.filename}>{r.description || r.filename}</span>
                      {r.amount != null && (
                        <span className="text-foreground tabular-nums font-mono shrink-0 text-xs">
                          {r.currency} {r.amount.toFixed(2)}
                        </span>
                      )}
                      <a
                        href={sources.receipt(r.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
                        title={t('journal.pdfInNewTab')}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      <OpenInTabLink href={receiptHref(r.id, r.date, period)} size="xs" title={t('journal.openInReceipts')} />
                    </div>
                  ))}
                </div>
              )}
            </div>
            {selectedReceiptId ? (
              <PdfFrame key={selectedReceiptId} src={sources.receipt(selectedReceiptId)} title={t('col.receipt')} />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-dim">{t('journal.noReceipt')}</div>
            )}
          </>
        )}
      />
    </div>
  );
}
