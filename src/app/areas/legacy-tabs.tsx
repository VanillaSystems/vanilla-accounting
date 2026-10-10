import { useState, useEffect, useMemo, useRef } from 'react';
import { ExternalLink, X, Pencil, Wand2, Link2, ScanLine, Plus, Trash2 } from 'lucide-react';
import type { Index, Receipt } from '../../types/index.js';
import type { Period } from '../../accounting/periods.js';
import { FxProvider } from '../hooks/use-fx.js';
import { usePersistedFlag } from '../shell/prefs.js';
import { SearchBar } from '../components/search-bar.js';
import { ReceiptsTable, isNonReceipt } from '../components/receipts-table.js';
import { TransactionsTable } from '../components/transactions-table.js';
import { BankStatementsTab } from '../components/bank-statements-tab.js';
import { JournalEntriesTab } from '../components/journal-entries-tab.js';
import { TrialBalanceTab } from '../components/trial-balance-tab.js';
import { BalanceSheetTab } from '../components/balance-sheet-tab.js';
import { IncomeStatementTab } from '../components/income-statement-tab.js';
import { VatReportTab } from '../components/vat-report-tab.js';
import { AccountLedgerTab } from '../components/account-ledger-tab.js';
import { BankReconciliationTab } from '../components/bank-reconciliation-tab.js';
import { YearCloseTab } from '../components/year-close-tab.js';
import { SplitPane } from '../components/split-pane.js';
import { AssignPanel } from '../components/assign-panel.js';
import { ManualBatchModal } from '../components/manual-batch-modal.js';
import { TransactionDetail } from '../components/transaction-detail.js';
import { PdfFrame } from '../components/pdf-frame.js';
import { ReceiptEditForm } from '../components/receipt-edit-form.js';
import { ManualTransactionForm } from '../components/manual-transaction-form.js';
import { cn } from '../lib/utils.js';
import { api, orAlert, errorText, sources } from '../lib/api.js';
import { t } from '../i18n/index.js';

export type LegacyTab = 'receipts' | 'transactions' | 'bank-statements' | 'journal-entries' | 'trial-balance' | 'balance-sheet'
  | 'income-statement' | 'vat-report' | 'account-ledger' | 'bank-reconciliation' | 'year-close';
type FilterMode = 'all' | 'linked' | 'unlinked';

export interface Selection { receiptId?: string; txRef?: string }

/**
 * The old tabs, one at a time, inside the new shell: the shell owns the period, the language,
 * the theme and the URL. Deleted in phase 10 with the components it renders.
 */
export function LegacyTabs({ tab, period, index, refresh, canEdit, onPeriod, initial, onSelect }: {
  tab: LegacyTab;
  period: Period;
  index: Index;
  refresh: () => void;
  canEdit: boolean;
  onPeriod: (token: string) => void;
  initial: Selection;
  onSelect: (sel: Selection) => void;
}) {
  const restoredRef = useRef(false);
  const skipReceiptClearRef = useRef(false);

  const [hideZero, setHideZeroPersist] = usePersistedFlag('hideZeroReceipts', true);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [search, setSearch] = useState('');

  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
  const [selectedTxRef, setSelectedTxRef] = useState<string | null>(null);
  useEffect(() => {
    if (restoredRef.current) onSelect({ receiptId: selectedReceipt?.id, txRef: selectedTxRef ?? undefined });
  }, [selectedReceipt?.id, selectedTxRef]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setEditOpen(false);
    setDeleteConfirmOpen(false);
    setAssignOpen(!!selectedReceipt && canEdit);
  }, [selectedReceipt?.id]);

  useEffect(() => {
    if (skipReceiptClearRef.current) { skipReceiptClearRef.current = false; return; }
    if (selectedTxRef) {
      const firstReceiptId = index.mappings.find((m) => m.transactionRef === selectedTxRef)?.receiptId;
      const firstReceipt = firstReceiptId ? index.receipts.find((r) => r.id === firstReceiptId) : null;
      setSelectedReceipt(firstReceipt ?? null);
    } else {
      setSelectedReceipt(null);
    }
  }, [selectedTxRef]);

  const [visionExtracting, setVisionExtracting] = useState(false);

  async function runVisionExtract() {
    if (!selectedReceipt) return;
    setVisionExtracting(true);
    try {
      await api.visionExtract(selectedReceipt.id);
      refresh();
    } catch (e) {
      alert(errorText(e));
    } finally {
      setVisionExtracting(false);
    }
  }

  const [batchRenaming, setBatchRenaming] = useState(false);
  const [batchStatus, setBatchStatus] = useState<string | null>(null);

  const [manualBatchIds, setManualBatchIds] = useState<Set<string>>(new Set());
  const [manualBatchModalOpen, setManualBatchModalOpen] = useState(false);
  const [manualBatchStatus, setManualBatchStatus] = useState<string | null>(null);

  function toggleManualBatchId(id: string) {
    setManualBatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleManualBatchAll(ids: string[]) {
    setManualBatchIds((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      if (allSelected) {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...ids]);
    });
  }

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteInProgress, setDeleteInProgress] = useState(false);

  async function deleteReceipt() {
    if (!selectedReceipt) return;
    setDeleteInProgress(true);
    try {
      await api.deleteReceipt(selectedReceipt.id);
      setDeleteConfirmOpen(false);
      setSelectedReceipt(null);
      refresh();
    } catch (e) {
      alert(errorText(e));
    } finally {
      setDeleteInProgress(false);
    }
  }

  // The open manual-transaction form, and the receipt selected when it opened (its KI-Vorschlag source).
  const [manualTx, setManualTx] = useState<{ receiptId?: string } | null>(null);

  async function batchRename() {
    setBatchRenaming(true);
    setBatchStatus(null);
    try {
      const data = await api.batchRename();
      setBatchStatus(t('receipts.batchRenameDone', data));
      refresh();
    } catch (e) {
      setBatchStatus(errorText(e));
    } finally {
      setBatchRenaming(false);
    }
  }

  // The route's selection, once.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const { txRef, receiptId } = initial;
    if (txRef) { skipReceiptClearRef.current = true; setSelectedTxRef(txRef); }
    if (receiptId) {
      const r = index.receipts.find((r) => r.id === receiptId);
      if (r) setSelectedReceipt(r);
    }
  }, []);

  const zeroCount = useMemo(() => {
    const linked = new Set(index.mappings.map((m) => m.receiptId));
    return index.receipts.filter((r) => isNonReceipt(r, linked)).length;
  }, [index]);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-muted overflow-hidden">
        <FxProvider index={index}>

          {/* Belege tab */}
          {tab === 'receipts' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
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
              <SearchBar value={search} onChange={setSearch} className="w-72" placeholder={t('receipts.search')} />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none" title={t('receipts.hideNonReceiptsHint')}>
                <input type="checkbox" checked={hideZero} onChange={(e) => setHideZeroPersist(e.target.checked)} />
                {t('receipts.hideNonReceipts', { n: zeroCount })}
              </label>
              <div className="ml-auto flex items-center gap-3">
                {manualBatchStatus && <span className="text-xs text-muted-foreground">{manualBatchStatus}</span>}
                {batchStatus && <span className="text-xs text-muted-foreground">{batchStatus}</span>}
                <span className="text-xs text-muted-foreground">{t('app.receiptCount', { n: index.receipts.length })}</span>
                {canEdit && manualBatchIds.size > 0 && (
                  <>
                    <button
                      onClick={() => setManualBatchIds(new Set())}
                      className="text-xs text-muted-foreground hover:text-foreground underline"
                    >
                      {t('receipts.clearSelection', { n: manualBatchIds.size })}
                    </button>
                    <button
                      onClick={() => setManualBatchModalOpen(true)}
                      className="flex items-center gap-1.5 px-3 py-1 text-xs bg-violet-700 text-white rounded hover:bg-violet-800"
                      title={t('receipts.createManualBatchHint')}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t('receipts.createManualBatch', { n: manualBatchIds.size })}
                    </button>
                  </>
                )}
                {canEdit && (
                  <button
                    onClick={batchRename}
                    disabled={batchRenaming}
                    className="flex items-center gap-1.5 px-3 py-1 text-xs border border-border rounded hover:bg-accent text-muted-foreground disabled:opacity-50"
                    title={t('receipts.batchRenameHint')}
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    {batchRenaming ? t('receipts.batchRenaming') : t('receipts.batchRename')}
                  </button>
                )}
              </div>
            </div>

            {/* Table + Preview split */}
            <SplitPane
              storageKey="receipts"
              defaultLeft={55}
              leftClassName="overflow-auto"
              left={
                <ReceiptsTable
                  index={index}
                  search={search}
                  filter={filterMode}
                  hideZero={hideZero}
                  period={period}
                  onSelectReceipt={setSelectedReceipt}
                  selectedId={selectedReceipt?.id ?? null}
                  selectedIds={manualBatchIds}
                  onToggleSelect={toggleManualBatchId}
                  onToggleSelectAll={toggleManualBatchAll}
                />
              }
              right={selectedReceipt && (
                <>
                  <div className="flex flex-col border-b bg-muted shrink-0">
                    <div className="flex items-center justify-between px-4 py-2">
                      <span className="text-sm font-medium text-foreground truncate max-w-[60%]" title={selectedReceipt.filename}>
                        {selectedReceipt.filename}
                      </span>
                      <div className="flex items-center gap-1">
                        {canEdit && selectedReceipt.needsVisionReview && (
                          <button
                            onClick={runVisionExtract}
                            disabled={visionExtracting}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-amber-50 border border-amber-300 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                            title={t('receipts.visionHint')}
                          >
                            <ScanLine className="h-3.5 w-3.5" />
                            {visionExtracting ? t('receipts.visionRunning') : t('receipts.vision')}
                          </button>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => setEditOpen((o) => !o)}
                            className={cn('p-1 rounded text-muted-foreground hover:text-foreground', editOpen ? 'bg-blue-100 text-blue-700 hover:text-blue-800' : 'hover:bg-accent')}
                            title={t('receipts.edit')}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                        {canEdit && (
                          <button onClick={() => setDeleteConfirmOpen(true)} className="p-1 rounded hover:bg-red-100 text-muted-foreground hover:text-red-600" title={t('receipts.delete')}>
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => setAssignOpen((o) => !o)}
                            className={cn('p-1 rounded text-muted-foreground hover:text-foreground', assignOpen ? 'bg-blue-100 text-blue-700 hover:text-blue-800' : 'hover:bg-accent')}
                            title={t('receipts.assign')}
                          >
                            <Link2 className="h-4 w-4" />
                          </button>
                        )}
                        <a href={sources.receipt(selectedReceipt.id)} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground" title={t('common.openInNewTab')}>
                          <ExternalLink className="h-4 w-4" />
                        </a>
                        <button onClick={() => setSelectedReceipt(null)} title={t('common.close')} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    {editOpen && (
                      <ReceiptEditForm
                        key={selectedReceipt.id}
                        receipt={selectedReceipt}
                        onSaved={(saved) => {
                          setSelectedReceipt(saved);
                          setEditOpen(false);
                          refresh();
                        }}
                        onCancel={() => setEditOpen(false)}
                      />
                    )}
                    {!editOpen && selectedReceipt.description && (
                      <div className="px-4 pb-1">
                        <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-2 py-1 truncate" title={selectedReceipt.description}>{selectedReceipt.description}</p>
                      </div>
                    )}
                    {!editOpen && selectedReceipt.remarks && (
                      <div className="px-4 pb-2">
                        <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-1 whitespace-pre-wrap">{selectedReceipt.remarks}</p>
                      </div>
                    )}
                  </div>
                  {assignOpen && canEdit && (
                    <AssignPanel
                      key={selectedReceipt.id}
                      receipt={selectedReceipt}
                      index={index}
                      variant="strip"
                      onAdd={async (transactionRef) => {
                        await orAlert(api.addMapping({ receiptId: selectedReceipt.id, transactionRef }));
                        refresh();
                      }}
                      onRemove={async (transactionRef) => {
                        await orAlert(api.removeMapping({ receiptId: selectedReceipt.id, transactionRef }));
                        refresh();
                      }}
                      onApproveDuplicate={async () => {
                        await orAlert(api.approveDuplicate(selectedReceipt.id));
                        refresh();
                      }}
                      onCreateManual={async (date, description, amount, currency) => {
                        const ref = await api.createManualTransaction({ date, description, amount, currency });
                        await orAlert(api.addMapping({ receiptId: selectedReceipt.id, transactionRef: ref }));
                        refresh();
                      }}
                    />
                  )}
                  <PdfFrame src={sources.receipt(selectedReceipt.id)} title={selectedReceipt.filename} />
                </>
              )}
            />
          </div>)}

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

          {/* Saldobilanz tab */}
          {tab === 'trial-balance' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <TrialBalanceTab index={index} period={period} />
          </div>)}

          {/* Bilanz tab */}
          {tab === 'balance-sheet' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <BalanceSheetTab index={index} period={period} />
          </div>)}

          {/* Erfolgsrechnung tab */}
          {tab === 'income-statement' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <IncomeStatementTab index={index} period={period} />
          </div>)}

          {/* MWST-Abrechnung tab */}
          {tab === 'vat-report' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <VatReportTab index={index} period={period} onPeriod={onPeriod} />
          </div>)}

          {/* Kontoauszug tab */}
          {tab === 'account-ledger' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <AccountLedgerTab index={index} period={period} />
          </div>)}

          {/* Kontenabgleich tab — bank reconciliation proof */}
          {tab === 'bank-reconciliation' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <BankReconciliationTab index={index} period={period} />
          </div>)}

          {tab === 'year-close' && (<div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <YearCloseTab period={period} canEdit={canEdit} onRefresh={refresh} />
          </div>)}
        </FxProvider>

      {/* Manual transaction batch modal */}
      {manualBatchModalOpen && (
        <ManualBatchModal
          receipts={index.receipts.filter((r) => manualBatchIds.has(r.id))}
          onClose={() => setManualBatchModalOpen(false)}
          onDone={(status) => {
            setManualBatchModalOpen(false);
            setManualBatchIds(new Set());
            setManualBatchStatus(status);
            refresh();
          }}
        />
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirmOpen && selectedReceipt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !deleteInProgress && setDeleteConfirmOpen(false)}>
          <div className="bg-background rounded-lg shadow-xl border border-border p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-foreground mb-1">{t('receipts.deleteConfirmTitle')}</h2>
            <p className="text-xs text-muted-foreground mb-1">
              {t('receipts.deleteConfirmText')}
            </p>
            <p className="text-xs font-mono bg-muted border border-border rounded px-2 py-1 text-foreground truncate mb-4" title={selectedReceipt.filename}>
              {selectedReceipt.filename}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirmOpen(false)}
                disabled={deleteInProgress}
                className="px-3 py-1.5 text-xs border border-border rounded hover:bg-accent text-muted-foreground disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={deleteReceipt}
                disabled={deleteInProgress}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" />
                {deleteInProgress ? t('common.deleting') : t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
