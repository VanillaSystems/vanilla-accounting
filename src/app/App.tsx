import { useState, useEffect, useMemo, useRef } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { ExternalLink, X, Pencil, Wand2, Link2, ScanLine, Plus, Trash2, Sun, Moon, Monitor, ZoomIn, ZoomOut, Calendar } from 'lucide-react';
import type { Receipt } from '../../src/types/index.js';
import { useIndex } from './hooks/use-index.js';
import { useApiStatus } from './hooks/use-api-status.js';
import { useUrlState, type FilterMode } from './hooks/use-url-state.js';
import { useTheme, useZoom, usePersistedFlag } from './hooks/use-display-prefs.js';
import { SearchBar } from './components/search-bar.js';
import { ReceiptsTable, isNonReceipt } from './components/receipts-table.js';
import { TransactionsTable } from './components/transactions-table.js';
import { BankStatementsTab } from './components/bank-statements-tab.js';
import { JournalEntriesTab } from './components/journal-entries-tab.js';
import { TrialBalanceTab } from './components/trial-balance-tab.js';
import { BalanceSheetTab } from './components/balance-sheet-tab.js';
import { IncomeStatementTab } from './components/income-statement-tab.js';
import { VatReportTab } from './components/vat-report-tab.js';
import { AccountLedgerTab } from './components/account-ledger-tab.js';
import { BankReconciliationTab } from './components/bank-reconciliation-tab.js';
import { SplitPane } from './components/split-pane.js';
import { AssignPanel } from './components/assign-panel.js';
import { ManualBatchModal } from './components/manual-batch-modal.js';
import { TransactionDetail } from './components/transaction-detail.js';
import { PdfFrame } from './components/pdf-frame.js';
import { ReceiptEditForm } from './components/receipt-edit-form.js';
import { ManualTransactionForm } from './components/manual-transaction-form.js';
import { cn } from './lib/utils.js';
import { api, orAlert } from './lib/api.js';

export default function App() {
  const { data: index, loading, error, refresh } = useIndex();
  const apiOnline = useApiStatus();
  const restoredRef = useRef(false);
  const skipReceiptClearRef = useRef(false);

  const [theme, setTheme] = useTheme();
  const [zoom, setZoom] = useZoom();
  const [hideZero, setHideZeroPersist] = usePersistedFlag('hideZeroReceipts', true);

  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
  const [selectedTxRef, setSelectedTxRef] = useState<string | null>(null);
  const { tab, setTab, period, setPeriod, filterMode, setFilterMode, search, setSearch, initialSelection } =
    useUrlState({ loading, receiptId: selectedReceipt?.id ?? null, txRef: selectedTxRef });
  const [assignOpen, setAssignOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setEditOpen(false);
    setDeleteConfirmOpen(false);
    setAssignOpen(!!selectedReceipt && apiOnline);
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
      alert(String(e));
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
      alert(String(e));
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
      setBatchStatus(`Done: ${data.renamed} renamed, ${data.skipped} skipped, ${data.failed} failed`);
      refresh();
    } catch (e) {
      setBatchStatus(String(e));
    } finally {
      setBatchRenaming(false);
    }
  }

  // Restore selected receipt/tx from URL after index loads (runs once)
  useEffect(() => {
    if (loading || restoredRef.current) return;
    restoredRef.current = true;
    const { txRef, receiptId } = initialSelection;
    if (txRef) { skipReceiptClearRef.current = true; setSelectedTxRef(txRef); }
    if (receiptId) {
      const r = index.receipts.find((r) => r.id === receiptId);
      if (r) setSelectedReceipt(r);
    }
  }, [loading, index]);

  // Compute available period options from transactions
  const periodOptions = useMemo(() => {
    const years = new Set<string>();
    const quarters = new Set<string>();
    for (const tx of index.transactions) {
      const year = tx.date.slice(0, 4);
      years.add(year);
      quarters.add(`${year}-Q${Math.ceil(parseInt(tx.date.slice(5, 7)) / 3)}`);
    }
    const opts: string[] = ['all'];
    for (const year of [...years].sort()) {
      opts.push(year);
      opts.push(...[...quarters].filter((q) => q.startsWith(year)).sort());
    }
    return opts;
  }, [index.transactions]);

  const linkedCount = new Set(index.mappings.map((m) => m.receiptId)).size;
  const zeroCount = useMemo(() => {
    const linked = new Set(index.mappings.map((m) => m.receiptId));
    return index.receipts.filter((r) => isNonReceipt(r, linked)).length;
  }, [index]);
  const unlinkedCount = index.receipts.length - linkedCount;

  return (
    <div className="h-screen flex flex-col bg-muted overflow-hidden">
      {/* Header */}
      <header className="bg-background border-b border-border px-6 py-3 shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">Vanilla Accounting</h1>
          <span className="text-xs text-muted-foreground">Belegverwaltung</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>{index.receipts.length} Belege</span>
          <span>{index.transactions.length} Transaktionen</span>
          <span className="text-amber-600">{unlinkedCount} nicht zugeordnet</span>
          <div className="flex items-center gap-1.5 ml-2" title="Zeitraum / Quartal wählen">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="border border-border rounded px-2 py-1 text-xs text-foreground bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {periodOptions.map((opt) => (
                <option key={opt} value={opt}>{opt === 'all' ? 'Alle Perioden' : opt.replace('-Q', ' Q')}</option>
              ))}
            </select>
          </div>
          {apiOnline && <span className="text-green-600">● API aktiv</span>}
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            <button onClick={() => setZoom((z) => Math.max(60, z - 10))} title="Verkleinern" className="p-1.5 bg-background text-muted-foreground hover:bg-accent transition-colors">
              <ZoomOut className="h-3 w-3" />
            </button>
            <button onClick={() => setZoom(100)} title={`${zoom}% – Zurücksetzen`} className="px-1 text-[10px] tabular-nums bg-background text-muted-foreground hover:bg-accent border-l border-r border-border transition-colors min-w-[2rem] text-center">
              {zoom}%
            </button>
            <button onClick={() => setZoom((z) => Math.min(200, z + 10))} title="Vergrössern" className="p-1.5 bg-background text-muted-foreground hover:bg-accent transition-colors">
              <ZoomIn className="h-3 w-3" />
            </button>
          </div>
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            {([
              { value: 'light' as const, icon: <Sun className="h-3 w-3" />, title: 'Hell' },
              { value: 'system' as const, icon: <Monitor className="h-3 w-3" />, title: 'System' },
              { value: 'dark' as const, icon: <Moon className="h-3 w-3" />, title: 'Dunkel' },
            ]).map(({ value, icon, title }) => (
              <button
                key={value}
                onClick={() => setTheme(value)}
                title={title}
                className={cn(
                  'p-1.5 border-l border-border first:border-l-0 transition-colors',
                  theme === value ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-accent',
                )}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>
      </header>

      {loading && (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Index wird geladen…
        </div>
      )}

      {error && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2">
            <p className="text-red-600 font-medium">books.json konnte nicht geladen werden</p>
            <p className="text-sm text-muted-foreground">
              <code className="bg-muted px-1 py-0.5 rounded font-mono">npm run extract</code> ausführen, dann neu laden.
            </p>
            <p className="text-xs text-muted-foreground">{error}</p>
          </div>
        </div>
      )}

      {!loading && !error && (
        <Tabs.Root
          value={tab}
          onValueChange={setTab}
          className="flex-1 flex flex-col overflow-hidden"
        >
          {/* Tab bar */}
          <Tabs.List className="bg-background border-b border-border px-6 flex items-center gap-0 shrink-0">
            <TabTrigger value="receipts">Belege</TabTrigger>
            <TabTrigger value="transactions">Transaktionen</TabTrigger>
            <TabTrigger value="bank-statements">Kontoauszüge</TabTrigger>
            <TabTrigger value="journal-entries">
              Buchungen
              {(index.journalEntries?.length ?? 0) > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 text-xs px-1.5 py-0.5 font-medium">
                  {index.journalEntries!.length}
                </span>
              )}
            </TabTrigger>
            <span className="mx-1 text-border">|</span>
            <TabTrigger value="trial-balance">Saldobilanz</TabTrigger>
            <TabTrigger value="balance-sheet">Bilanz</TabTrigger>
            <TabTrigger value="income-statement">Erfolgsrechnung</TabTrigger>
            <TabTrigger value="vat-report">MWST</TabTrigger>
            <TabTrigger value="account-ledger">Kontoauszug</TabTrigger>
            <TabTrigger value="bank-reconciliation">Kontenabgleich</TabTrigger>
          </Tabs.List>

          {/* Belege tab */}
          <Tabs.Content value="receipts" className="flex-1 data-[state=active]:flex flex-col overflow-hidden outline-none">
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
                    {f === 'all' ? 'alle' : f === 'linked' ? 'zugeordnet' : 'nicht zugeordnet'}
                  </button>
                ))}
              </div>
              <SearchBar value={search} onChange={setSearch} className="w-72" placeholder="Dateiname, Text suchen…" />
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none" title="Dokumente ohne eigene Zahlung ausblenden: Begleitdokumente (z.B. Post-Aufgabebestätigungen), Kontoauszüge, Duplikate, sowie Belege mit Betrag 0 ohne MWST und ohne Zuordnung">
                <input type="checkbox" checked={hideZero} onChange={(e) => setHideZeroPersist(e.target.checked)} />
                Nicht-Belege ausblenden ({zeroCount})
              </label>
              <div className="ml-auto flex items-center gap-3">
                {manualBatchStatus && <span className="text-xs text-muted-foreground">{manualBatchStatus}</span>}
                {batchStatus && <span className="text-xs text-muted-foreground">{batchStatus}</span>}
                <span className="text-xs text-muted-foreground">{index.receipts.length} Belege</span>
                {apiOnline && manualBatchIds.size > 0 && (
                  <>
                    <button
                      onClick={() => setManualBatchIds(new Set())}
                      className="text-xs text-muted-foreground hover:text-foreground underline"
                    >
                      Auswahl aufheben ({manualBatchIds.size})
                    </button>
                    <button
                      onClick={() => setManualBatchModalOpen(true)}
                      className="flex items-center gap-1.5 px-3 py-1 text-xs bg-violet-700 text-white rounded hover:bg-violet-800"
                      title="Für ausgewählte Belege manuelle Transaktionen (Auslagen) erstellen"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Manuelle Transaktionen erstellen ({manualBatchIds.size})
                    </button>
                  </>
                )}
                {apiOnline && (
                  <button
                    onClick={batchRename}
                    disabled={batchRenaming}
                    className="flex items-center gap-1.5 px-3 py-1 text-xs border border-border rounded hover:bg-accent text-muted-foreground disabled:opacity-50"
                    title="Dateinamen für alle unbenannten Belege generieren und anwenden"
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    {batchRenaming ? 'Umbenennen…' : 'Stapelumbenennung'}
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
                        {apiOnline && selectedReceipt.needsVisionReview && (
                          <button
                            onClick={runVisionExtract}
                            disabled={visionExtracting}
                            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-amber-50 border border-amber-300 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                            title="Text mit KI-Bilderkennung extrahieren (sendet die Seite an Claude)"
                          >
                            <ScanLine className="h-3.5 w-3.5" />
                            {visionExtracting ? 'Extrahieren…' : 'KI-Texterkennung'}
                          </button>
                        )}
                        {apiOnline && (
                          <button
                            onClick={() => setEditOpen((o) => !o)}
                            className={cn('p-1 rounded text-muted-foreground hover:text-foreground', editOpen ? 'bg-blue-100 text-blue-700 hover:text-blue-800' : 'hover:bg-accent')}
                            title="Beleg bearbeiten"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                        {apiOnline && (
                          <button onClick={() => setDeleteConfirmOpen(true)} className="p-1 rounded hover:bg-red-100 text-muted-foreground hover:text-red-600" title="Beleg löschen">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                        {apiOnline && (
                          <button
                            onClick={() => setAssignOpen((o) => !o)}
                            className={cn('p-1 rounded text-muted-foreground hover:text-foreground', assignOpen ? 'bg-blue-100 text-blue-700 hover:text-blue-800' : 'hover:bg-accent')}
                            title="Transaktion zuordnen"
                          >
                            <Link2 className="h-4 w-4" />
                          </button>
                        )}
                        <a href={`/api/receipts/${selectedReceipt.id}`} target="_blank" rel="noopener noreferrer" className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground" title="In neuem Tab öffnen">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                        <button onClick={() => setSelectedReceipt(null)} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
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
                  {assignOpen && apiOnline && (
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
                  <PdfFrame src={`/api/receipts/${selectedReceipt.id}`} title={selectedReceipt.filename} />
                </>
              )}
            />
          </Tabs.Content>

          {/* Transaktionen tab */}
          <Tabs.Content value="transactions" className="flex-1 data-[state=active]:flex flex-col overflow-hidden outline-none">
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
                    {f === 'all' ? 'alle' : f === 'linked' ? 'zugeordnet' : 'nicht zugeordnet'}
                  </button>
                ))}
              </div>
              <SearchBar value={search} onChange={setSearch} className="w-72" placeholder="Ref, Beschreibung suchen…" />
              <div className="ml-auto flex items-center gap-3">
                <span className="text-xs text-muted-foreground">{index.transactions.length} Transaktionen</span>
                {apiOnline && (
                  <button
                    onClick={() => setManualTx(manualTx ? null : { receiptId: selectedReceipt?.id })}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1 text-xs border rounded text-muted-foreground',
                      manualTx ? 'bg-violet-50 border-violet-300 text-violet-700' : 'border-border hover:bg-accent',
                    )}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Manuelle Transaktion
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
                    <span className="text-sm font-medium text-foreground">Transaktionsdetail</span>
                    <button onClick={() => setSelectedTxRef(null)} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <TransactionDetail
                    key={selectedTxRef}
                    txRef={selectedTxRef}
                    index={index}
                    apiOnline={apiOnline}
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
                    <PdfFrame key={selectedReceipt.id} src={`/api/receipts/${selectedReceipt.id}`} title={selectedReceipt.filename} />
                  )}
                </>
              )}
            />
          </Tabs.Content>

          {/* Bank Statements tab */}
          <Tabs.Content
            value="bank-statements"
            className="flex-1 data-[state=active]:flex overflow-hidden outline-none"
          >
            <BankStatementsTab index={index} />
          </Tabs.Content>

          {/* Journal Entries tab */}
          <Tabs.Content
            value="journal-entries"
            className="flex-1 data-[state=active]:flex flex-col overflow-hidden outline-none"
          >
            <JournalEntriesTab index={index} period={period} onRefresh={refresh} apiOnline={apiOnline} />
          </Tabs.Content>

          {/* Saldobilanz tab */}
          <Tabs.Content
            value="trial-balance"
            className="flex-1 data-[state=active]:flex flex-col overflow-hidden outline-none"
          >
            <TrialBalanceTab index={index} period={period} />
          </Tabs.Content>

          {/* Bilanz tab */}
          <Tabs.Content
            value="balance-sheet"
            className="flex-1 data-[state=active]:flex flex-col overflow-hidden outline-none"
          >
            <BalanceSheetTab index={index} period={period} />
          </Tabs.Content>

          {/* Erfolgsrechnung tab */}
          <Tabs.Content
            value="income-statement"
            className="flex-1 data-[state=active]:flex flex-col overflow-hidden outline-none"
          >
            <IncomeStatementTab index={index} period={period} />
          </Tabs.Content>

          {/* MWST-Abrechnung tab */}
          <Tabs.Content
            value="vat-report"
            className="flex-1 data-[state=active]:flex flex-col overflow-hidden outline-none"
          >
            <VatReportTab index={index} period={period} />
          </Tabs.Content>

          {/* Kontoauszug tab */}
          <Tabs.Content
            value="account-ledger"
            className="flex-1 data-[state=active]:flex flex-col overflow-hidden outline-none"
          >
            <AccountLedgerTab index={index} period={period} />
          </Tabs.Content>

          {/* Kontenabgleich tab — bank reconciliation proof */}
          <Tabs.Content
            value="bank-reconciliation"
            className="flex-1 data-[state=active]:flex flex-col overflow-hidden outline-none"
          >
            <BankReconciliationTab index={index} />
          </Tabs.Content>
        </Tabs.Root>
      )}

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
            <h2 className="text-sm font-semibold text-foreground mb-1">Beleg löschen?</h2>
            <p className="text-xs text-muted-foreground mb-1">
              Die Datei wird unwiderruflich vom Datenträger gelöscht und aus dem Index entfernt.
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
                Abbrechen
              </button>
              <button
                onClick={deleteReceipt}
                disabled={deleteInProgress}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" />
                {deleteInProgress ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TabTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className="px-4 py-3 text-sm font-medium text-muted-foreground border-b-2 border-transparent transition-colors data-[state=active]:text-foreground data-[state=active]:border-foreground data-[state=active]:font-semibold hover:text-foreground"
    >
      {children}
    </Tabs.Trigger>
  );
}
