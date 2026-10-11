import { useState, useEffect } from 'react';
import { X, Plus } from 'lucide-react';
import type { Index, Receipt } from '../../types/index.js';
import type { Period } from '../../accounting/periods.js';
import { FxProvider } from '../hooks/use-fx.js';
import { SearchBar } from '../components/search-bar.js';
import { TransactionsTable } from '../components/transactions-table.js';
import { BankStatementsTab } from '../components/bank-statements-tab.js';
import { JournalEntriesTab } from '../components/journal-entries-tab.js';
import { VatCodesView } from '../components/vat-codes-view.js';
import { useUrlParam } from '../hooks/use-url-state.js';
import { BankReconciliationTab } from '../components/bank-reconciliation-tab.js';
import { YearCloseTab } from '../components/year-close-tab.js';
import { SplitPane } from '../components/split-pane.js';
import { TransactionDetail } from '../components/transaction-detail.js';
import { PdfFrame } from '../components/pdf-frame.js';
import { ManualTransactionForm } from '../components/manual-transaction-form.js';
import { cn } from '../lib/utils.js';
import { api, orAlert, sources } from '../lib/api.js';
import { t } from '../i18n/index.js';

export type LegacyTab = 'transactions' | 'bank-statements' | 'journal-entries' | 'vat-codes' | 'bank-reconciliation' | 'year-close';
type FilterMode = 'all' | 'linked' | 'unlinked';

export interface Selection { txRef?: string }

/**
 * The old tabs, one at a time, inside the new shell: the shell owns the period, the language,
 * the theme and the URL. Deleted in phase 10 with the components it renders.
 */
export function LegacyTabs({ tab, period, index, refresh, canEdit, initial, onSelect }: {
  tab: LegacyTab;
  period: Period;
  index: Index;
  refresh: () => void;
  canEdit: boolean;
  initial: Selection;
  onSelect: (sel: Selection) => void;
}) {
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [search, setSearch] = useState('');

  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
  // The route's payment is the first selection: restoring it in an effect raced the table's own first selection.
  const [selectedTxRef, setSelectedTxRef] = useState<string | null>(initial.txRef ?? null);
  useEffect(() => {
    onSelect({ txRef: selectedTxRef ?? undefined });
  }, [selectedTxRef]);
  useEffect(() => {
    if (selectedTxRef) {
      const firstReceiptId = index.mappings.find((m) => m.transactionRef === selectedTxRef)?.receiptId;
      const firstReceipt = firstReceiptId ? index.receipts.find((r) => r.id === firstReceiptId) : null;
      setSelectedReceipt(firstReceipt ?? null);
    } else {
      setSelectedReceipt(null);
    }
  }, [selectedTxRef]);

  // The open manual-transaction form, and the receipt selected when it opened (its KI-Vorschlag source).
  const [manualTx, setManualTx] = useState<{ receiptId?: string } | null>(null);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-muted overflow-hidden">
        <FxProvider index={index}>

          {/* Transaktionen tab */}
          {tab === 'transactions' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Toolbar */}
            <div className="bg-background border-b border-border px-4 py-2 flex items-center gap-3 shrink-0 flex-wrap">
              <div className="flex rounded-md border border-border overflow-hidden text-sm">
                {(['all', 'linked', 'unlinked'] as FilterMode[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilterMode(f)}
                    className={cn(
                      'px-3 py-1 border-l border-border first:border-l-0 transition-colors',
                      filterMode === f ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {t(`filter.${f}`)}
                  </button>
                ))}
              </div>
              <SearchBar value={search} onChange={setSearch} className="w-72" placeholder={t('transactions.search')} />
              <div className="ml-auto flex items-center gap-3">
                <span className="text-xs text-muted-foreground">{t('app.transactionCount', { n: index.transactions.length })}</span>
                {canEdit && (
                  <button
                    onClick={() => setManualTx(manualTx ? null : { receiptId: selectedReceipt?.id })}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1 text-xs border rounded text-muted-foreground',
                      manualTx ? 'bg-violet-50 border-violet-300 text-violet-700' : 'border-border hover:bg-accent',
                    )}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('transactions.manual')}
                  </button>
                )}
              </div>
            </div>

            {manualTx && (
              <ManualTransactionForm
                suggestFromReceiptId={manualTx.receiptId}
                onCreated={() => { setManualTx(null); refresh(); }}
                onCancel={() => setManualTx(null)}
              />
            )}

            {/* Table + Detail split */}
            <SplitPane
              storageKey="transactions"
              defaultLeft={55}
              leftClassName="overflow-auto"
              left={
                <TransactionsTable
                  index={index}
                  search={search}
                  filter={filterMode}
                  period={period}
                  onSelectReceipt={setSelectedReceipt}
                  selectedTxRef={selectedTxRef}
                  onSelectTx={setSelectedTxRef}
                />
              }
              right={selectedTxRef && (
                <>
                  <div className="flex items-center justify-between px-4 py-2 border-b bg-muted shrink-0">
                    <span className="text-sm font-medium text-foreground">{t('transactions.detail')}</span>
                    <button onClick={() => setSelectedTxRef(null)} title={t('common.close')} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <TransactionDetail
                    key={selectedTxRef}
                    txRef={selectedTxRef}
                    index={index}
                    canEdit={canEdit}
                    onAddReceipt={async (receiptId) => {
                      await orAlert(api.addMapping({ receiptId, transactionRef: selectedTxRef }));
                      refresh();
                    }}
                    onRemoveReceipt={async (receiptId) => {
                      await orAlert(api.removeMapping({ receiptId, transactionRef: selectedTxRef }));
                      refresh();
                    }}
                    onSelectReceipt={setSelectedReceipt}
                    selectedReceiptId={selectedReceipt?.id ?? null}
                    onDelete={async () => {
                      if (!(await orAlert(api.deleteTransaction(selectedTxRef)))) return;
                      setSelectedTxRef(null);
                      refresh();
                    }}
                    onSetDescription={async (description) => {
                      await api.patchTransaction(selectedTxRef, { description });
                      refresh();
                    }}
                    onSetRemarks={async (remarks) => {
                      await api.patchTransaction(selectedTxRef, { remarks });
                      refresh();
                    }}
                    onSetNoReceiptNeeded={async (noReceiptNeeded) => {
                      if (!(await orAlert(api.patchTransaction(selectedTxRef, { noReceiptNeeded })))) return;
                      refresh();
                    }}
                  />
                  {selectedReceipt && (
                    <PdfFrame key={selectedReceipt.id} src={sources.receipt(selectedReceipt.id)} title={selectedReceipt.filename} />
                  )}
                </>
              )}
            />
          </div>)}

          {/* Bank Statements tab */}
          {tab === 'bank-statements' && (<div className="flex-1 flex overflow-hidden min-h-0">
            <BankStatementsTab index={index} />
          </div>)}

          {/* Journal Entries tab */}
          {tab === 'journal-entries' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <JournalEntriesTab index={index} period={period} onRefresh={refresh} canEdit={canEdit} />
          </div>)}

          {tab === 'vat-codes' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <CodesTab index={index} period={period} />
          </div>)}

          {/* Kontenabgleich tab — bank reconciliation proof */}
          {tab === 'bank-reconciliation' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <BankReconciliationTab index={index} period={period} />
          </div>)}

          {tab === 'year-close' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <YearCloseTab period={period} canEdit={canEdit} onRefresh={refresh} />
          </div>)}
        </FxProvider>

    </div>
  );
}

/** The code catalogue until phase 4 builds its area: ?view=codes&code= as the old MWST tab kept them. */
function CodesTab({ index, period }: { index: Index; period: Period }) {
  const [code, setCode] = useUrlParam('code');
  const [, setView] = useUrlParam('view');
  return <VatCodesView index={index} period={period} code={code} onCode={setCode} onBack={() => { setView(null); setCode(null); }} />;
}
