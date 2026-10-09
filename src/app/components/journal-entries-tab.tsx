import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Sparkles, Check, X, ExternalLink, ChevronRight, FileText } from 'lucide-react';
import type { Index, JournalEntry, Receipt } from '../../types/index.js';
import { SearchBar } from './search-bar.js';
import { cn, formatDate } from '../lib/utils.js';
import { inPeriod, type Period } from '../../accounting/periods.js';
import { PdfFrame } from './pdf-frame.js';
import { accountTitle } from '../lib/accounts.js';
import { OpenInTabLink } from './open-in-tab-link.js';
import { SplitPane } from './split-pane.js';
import { useAutoSelectFirst } from '../hooks/use-auto-select-first.js';
import { api, orAlert, sources } from '../lib/api.js';
import { receiptHref, setView, txHref, viewParams, viewPath } from '../lib/location.js';
import { t } from '../i18n/index.js';
import { ForeignAmount, FxLine } from './fx-amount.js';
import { VatCode } from './vat-code.js';

interface Props {
  index: Index;
  period: Period;
  onRefresh: () => void;
  /** Show the controls that write: the API runs and is not in audit mode. */
  canEdit: boolean;
}

interface EditState {
  id: string;
  field: 'accountDebit' | 'accountCredit' | 'vatCode' | 'description';
  value: string;
}

type Row =
  | { type: 'entry'; entry: JournalEntry; txDate: string; txRef: string; rowId: string }
  | { type: 'unclassified'; txRef: string; txDate: string; rowId: string };

function rowTxRef(row: Row): string {
  return row.txRef;
}

export function JournalEntriesTab({ index, period, onRefresh, canEdit }: Props) {
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'classified' | 'unclassified'>('all');
  const [editState, setEditState] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [classifyingRef, setClassifyingRef] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(() => {
    const params = viewParams();
    const utx = params.get('utx');
    return params.get('je') ?? (utx ? `u:${utx}` : null);
  });
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(() => {
    const params = viewParams();
    return params.get('receipt') ?? null;
  });
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const defaults: Record<string, number> = { datum: 90, beschreibung: 200, soll: 160, haben: 160, betrag: 90, whg: 44, mwst: 60, actions: 52 };
    try {
      const raw = localStorage.getItem('je-col-widths');
      if (raw) return { ...defaults, ...JSON.parse(raw) };
    } catch {}
    return defaults;
  });
  const tableRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef<{ col: string; startX: number; startW: number } | null>(null);

  function onResizeStart(col: string, e: React.MouseEvent) {
    e.preventDefault();
    resizingRef.current = { col, startX: e.clientX, startW: colWidths[col as keyof typeof colWidths] };
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = ev.clientX - resizingRef.current.startX;
      const newW = Math.max(40, resizingRef.current.startW + delta);
      setColWidths((prev) => {
        const next = { ...prev, [resizingRef.current!.col]: newW };
        localStorage.setItem('je-col-widths', JSON.stringify(next));
        return next;
      });
    };
    const onUp = () => {
      resizingRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const journalEntries = index.journalEntries ?? [];
  const txByRef = useMemo(() => new Map(index.transactions.map((tx) => [tx.ref, tx])), [index.transactions]);
  const classifiedRefs = useMemo(() => new Set(journalEntries.map((je) => je.transactionRef)), [journalEntries]);

  const receiptById = useMemo(() => new Map(index.receipts.map((r) => [r.id, r])), [index.receipts]);
  const txReceiptIds = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const mapping of index.mappings) {
      const existing = m.get(mapping.transactionRef) ?? [];
      existing.push(mapping.receiptId);
      m.set(mapping.transactionRef, existing);
    }
    return m;
  }, [index.mappings]);

  const rows = useMemo(() => {
    const result: Row[] = [];
    for (const je of journalEntries) {
      const tx = txByRef.get(je.transactionRef);
      result.push({ type: 'entry', entry: je, txDate: je.date ?? tx?.date ?? '', txRef: je.transactionRef, rowId: je.id });
    }
    for (const tx of index.transactions) {
      if (!classifiedRefs.has(tx.ref)) {
        result.push({ type: 'unclassified', txRef: tx.ref, txDate: tx.date, rowId: `u:${tx.ref}` });
      }
    }
    result.sort((a, b) => a.txDate.localeCompare(b.txDate));
    return result;
  }, [journalEntries, index.transactions, txByRef, classifiedRefs]);

  const periodFiltered = useMemo(() => rows.filter((r) => inPeriod(period, r.txDate)), [rows, period]);

  const modeFiltered = useMemo(() => {
    if (filterMode === 'classified') return periodFiltered.filter((r) => r.type === 'entry');
    if (filterMode === 'unclassified') return periodFiltered.filter((r) => r.type === 'unclassified');
    return periodFiltered;
  }, [periodFiltered, filterMode]);

  const filtered = useMemo(() => {
    if (!search) return modeFiltered;
    const q = search.toLowerCase();
    return modeFiltered.filter((r) => {
      if (r.type === 'entry') {
        const tx = txByRef.get(r.entry.transactionRef);
        return (
          r.entry.description?.toLowerCase().includes(q) ||
          r.entry.accountDebit.includes(q) ||
          accountTitle(r.entry.accountDebit).toLowerCase().includes(q) ||
          r.entry.accountCredit.includes(q) ||
          accountTitle(r.entry.accountCredit).toLowerCase().includes(q) ||
          r.entry.vatCode?.toLowerCase().includes(q) ||
          r.entry.transactionRef.toLowerCase().includes(q) ||
          tx?.description.toLowerCase().includes(q)
        );
      }
      const tx = txByRef.get(r.txRef);
      return tx?.description.toLowerCase().includes(q) || r.txRef.toLowerCase().includes(q);
    });
  }, [modeFiltered, search, txByRef]);

  // The counts are the rows each filter shows for the selected period.
  const classifiedCount = periodFiltered.filter((r) => r.type === 'entry').length;
  const unclassifiedCount = periodFiltered.filter((r) => r.type === 'unclassified').length;

  const selectedRow = useMemo(() => {
    if (!selectedRowId) return null;
    return filtered.find((r) => r.rowId === selectedRowId) ?? rows.find((r) => r.rowId === selectedRowId) ?? null;
  }, [selectedRowId, filtered, rows]);
  const selectedTxRef = selectedRow ? rowTxRef(selectedRow) : null;
  const selectedTx = selectedTxRef ? txByRef.get(selectedTxRef) : null;

  useEffect(() => {
    const params = viewParams();
    params.delete('je');
    params.delete('utx');
    params.delete('receipt');
    if (selectedRow) {
      if (selectedRow.type === 'entry') params.set('je', selectedRow.entry.id);
      else params.set('utx', selectedRow.txRef);
    }
    if (selectedReceiptId) params.set('receipt', selectedReceiptId);
    setView(viewPath(), params);
  }, [selectedRow, selectedReceiptId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      const currentIdx = selectedRowId ? filtered.findIndex((r) => r.rowId === selectedRowId) : -1;
      let nextIdx: number;
      if (e.key === 'ArrowDown') {
        nextIdx = currentIdx < filtered.length - 1 ? currentIdx + 1 : currentIdx;
      } else {
        nextIdx = currentIdx > 0 ? currentIdx - 1 : 0;
      }
      if (nextIdx >= 0 && nextIdx < filtered.length) {
        const nextRow = filtered[nextIdx];
        setSelectedRowId(nextRow.rowId);
        const receiptIds = txReceiptIds.get(rowTxRef(nextRow)) ?? [];
        setSelectedReceiptId(receiptIds[0] ?? null);
        const el = tableRef.current?.querySelector(`[data-rowid="${CSS.escape(nextRow.rowId)}"]`);
        el?.scrollIntoView({ block: 'nearest' });
      }
    },
    [filtered, selectedRowId, txReceiptIds],
  );

  useEffect(() => {
    if (!selectedRowId) return;
    tableRef.current?.querySelector(`[data-rowid="${CSS.escape(selectedRowId)}"]`)?.scrollIntoView({ block: 'center' });
  }, []); // mount only: bring the row restored from ?je= / ?utx= into view

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  function selectRow(row: Row) {
    setSelectedRowId(row.rowId);
    const receiptIds = txReceiptIds.get(rowTxRef(row)) ?? [];
    setSelectedReceiptId(receiptIds[0] ?? null);
  }

  useAutoSelectFirst(filtered.map((r) => r.rowId), selectedRowId, (rowId) => {
    const row = filtered.find((r) => r.rowId === rowId);
    if (row) selectRow(row);
    else { setSelectedRowId(null); setSelectedReceiptId(null); }
  });

  // Auto-select first receipt when row is selected but no receipt is (e.g. URL restore)
  useEffect(() => {
    if (selectedRowId && !selectedReceiptId) {
      const txRef = selectedRow ? rowTxRef(selectedRow) : null;
      if (txRef) {
        const receiptIds = txReceiptIds.get(txRef) ?? [];
        if (receiptIds.length > 0) setSelectedReceiptId(receiptIds[0]);
      }
    }
  }, [selectedRowId, selectedReceiptId, selectedRow, txReceiptIds]);

  const selectedReceipts = useMemo(() => {
    if (!selectedTxRef) return [];
    const ids = txReceiptIds.get(selectedTxRef) ?? [];
    return ids.map((id) => receiptById.get(id)).filter(Boolean) as Receipt[];
  }, [selectedTxRef, txReceiptIds, receiptById]);

  const siblingEntries = useMemo(() => {
    if (!selectedTxRef) return [];
    return journalEntries.filter((je) => je.transactionRef === selectedTxRef);
  }, [selectedTxRef, journalEntries]);

  async function saveEdit() {
    if (!editState) return;
    setSaving(true);
    if (await orAlert(api.patchJournalEntry(editState.id, { [editState.field]: editState.value }))) {
      setEditState(null);
      onRefresh();
    }
    setSaving(false);
  }

  async function classifyTransaction(txRef: string) {
    setClassifyingRef(txRef);
    if (await orAlert(api.classifyTransaction(txRef))) onRefresh();
    setClassifyingRef(null);
  }

  async function deleteEntry(je: JournalEntry, date: string) {
    const amount = `${je.exchangeCurrency ?? 'CHF'} ${je.amount.toFixed(2)}`;
    if (!confirm(t('journal.deleteConfirm', { date, amount, description: je.description ?? '' }))) return;
    if (await orAlert(api.deleteJournalEntry(je.id))) onRefresh();
  }

  function startEdit(id: string, field: EditState['field'], currentValue: string) {
    setEditState({ id, field, value: currentValue });
  }

  function EditableCell({ entry, field, value }: { entry: JournalEntry; field: EditState['field']; value: string }) {
    const isEditing = editState?.id === entry.id && editState.field === field;
    if (isEditing) {
      return (
        <div className="flex items-center gap-px">
          <input
            type="text"
            value={editState.value}
            onChange={(e) => setEditState({ ...editState, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveEdit();
              if (e.key === 'Escape') setEditState(null);
            }}
            disabled={saving}
            className="w-full border border-ring rounded-sm px-1.5 py-0.5 text-sm font-mono bg-background text-foreground focus:outline-none"
            autoFocus
          />
          <button onClick={saveEdit} disabled={saving} title={t('common.save')} className="p-px text-green-600 hover:text-green-800">
            <Check className="h-3 w-3" />
          </button>
          <button onClick={() => setEditState(null)} title={t('common.cancel')} className="p-px text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </div>
      );
    }
    const isAccount = field === 'accountDebit' || field === 'accountCredit';
    const display = isAccount && value ? accountTitle(value) : value;
    return (
      <span
        className={cn('truncate block', canEdit && 'cursor-pointer hover:underline hover:decoration-dotted')}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (canEdit) startEdit(entry.id, field, value);
        }}
        title={canEdit ? t('journal.doubleClickEdit') : undefined}
      >
        {field === 'vatCode' && value ? <VatCode code={value} link={!canEdit} /> : display || <span className="text-dim">—</span>}
      </span>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="bg-muted border-b border-border px-3 py-1.5 flex items-center gap-2 shrink-0">
        <div className="flex text-xs font-medium">
          {(['all', 'classified', 'unclassified'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilterMode(f)}
              className={cn(
                'px-2.5 py-1 border transition-colors first:rounded-l last:rounded-r',
                filterMode === f
                  ? 'bg-primary text-primary-foreground border-primary z-10'
                  : 'bg-background text-muted-foreground border-border hover:bg-accent -ml-px first:ml-0',
              )}
            >
              {f === 'all' ? t('journal.filterAll', { n: periodFiltered.length }) : f === 'classified' ? t('journal.filterClassified', { n: classifiedCount }) : t('journal.filterOpen', { n: unclassifiedCount })}
            </button>
          ))}
        </div>
        <SearchBar value={search} onChange={setSearch} className="w-64" placeholder={t('common.search')} />
        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          {t('journal.rowCount', { n: filtered.length })}
        </div>
      </div>

      {/* Main content: table + preview */}
      <SplitPane
        storageKey="journal-entries"
        defaultLeft={45}
        leftRef={tableRef}
        leftClassName="overflow-auto"
        left={
          <table className="text-sm" style={{ tableLayout: 'fixed', width: Object.values(colWidths).reduce((a, b) => a + b, 0) }}>
            <colgroup>
              <col style={{ width: colWidths.datum }} />
              <col style={{ width: colWidths.beschreibung }} />
              <col style={{ width: colWidths.soll }} />
              <col style={{ width: colWidths.haben }} />
              <col style={{ width: colWidths.betrag }} />
              <col style={{ width: colWidths.whg }} />
              <col style={{ width: colWidths.mwst }} />
              <col style={{ width: colWidths.actions }} />
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                {([
                  ['datum', 'col.date', 'text-left'],
                  ['beschreibung', 'col.description', 'text-left'],
                  ['soll', 'col.debit', 'text-left'],
                  ['haben', 'col.credit', 'text-left'],
                  ['betrag', 'col.amount', 'text-right'],
                  ['whg', 'col.currencyShort', 'text-center'],
                  ['mwst', 'col.vat', 'text-left'],
                ] as const).map(([key, label, align]) => (
                  <th key={key} className={cn('px-3 py-2 font-semibold relative select-none', align)}>
                    {t(label)}
                    <span
                      onMouseDown={(e) => onResizeStart(key, e)}
                      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize group flex justify-center"
                    >
                      <span className="w-px h-full bg-muted-foreground/40 group-hover:w-0.5 group-hover:bg-ring group-active:w-0.5 group-active:bg-ring transition-colors" />
                    </span>
                  </th>
                ))}
                <th className="px-2 py-2 text-center font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {filtered.map((row) => {
                const isSelected = row.rowId === selectedRowId;

                if (row.type === 'unclassified') {
                  const tx = txByRef.get(row.txRef)!;
                  return (
                    <tr
                      key={row.rowId}
                      data-rowid={row.rowId}
                      onClick={() => selectRow(row)}
                      className={cn(
                        'cursor-pointer transition-colors',
                        isSelected
                          ? 'bg-blue-50 dark:bg-blue-950'
                          : 'bg-amber-50/40 dark:bg-amber-950/20 hover:bg-amber-50 dark:hover:bg-amber-950/40',
                      )}
                    >
                      <td className="px-3 py-2 text-foreground truncate">{tx.date}</td>
                      <td className="px-3 py-2 text-foreground truncate" title={tx.description}>{tx.description}</td>
                      <td className="px-3 py-2 text-dim">—</td>
                      <td className="px-3 py-2 text-dim">—</td>
                      <td className="px-3 py-2 text-right font-mono text-foreground tabular-nums">{tx.amount.toFixed(2)}</td>
                      <td className="px-3 py-2 text-center text-muted-foreground">{tx.currency}</td>
                      <td className="px-3 py-2 text-dim">—</td>
                      <td className="px-2 py-2 text-center">
                        {canEdit && (
                          <button
                            onClick={(e) => { e.stopPropagation(); classifyTransaction(tx.ref); }}
                            disabled={classifyingRef === tx.ref}
                            className="p-0.5 text-amber-500 hover:text-amber-600 disabled:opacity-40"
                            title={t('journal.classify')}
                          >
                            <Sparkles className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                }

                const je = row.entry;
                return (
                  <tr
                    key={row.rowId}
                    data-rowid={row.rowId}
                    onClick={() => selectRow(row)}
                    className={cn(
                      'cursor-pointer transition-colors',
                      isSelected
                        ? 'bg-blue-50 dark:bg-blue-950'
                        : 'hover:bg-accent',
                    )}
                  >
                    <td className="px-3 py-2 text-foreground truncate tabular-nums">{row.txDate}</td>
                    <td className="px-3 py-2 text-foreground truncate">
                      <EditableCell entry={je} field="description" value={je.description ?? ''} />
                    </td>
                    <td className="px-3 py-2 font-mono truncate text-foreground">
                      <EditableCell entry={je} field="accountDebit" value={je.accountDebit} />
                    </td>
                    <td className="px-3 py-2 font-mono truncate text-foreground">
                      <EditableCell entry={je} field="accountCredit" value={je.accountCredit} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-foreground tabular-nums"><ForeignAmount entry={je} currency={false} /></td>
                    <td className="px-3 py-2 text-center text-muted-foreground">{je.exchangeCurrency ?? 'CHF'}</td>
                    <td className="px-3 py-2 font-mono text-foreground">
                      <EditableCell entry={je} field="vatCode" value={je.vatCode ?? ''} />
                    </td>
                    <td className="px-2 py-2 text-center">
                      {canEdit && (
                        <div className="flex items-center justify-center gap-0">
                          <button
                            onClick={(e) => { e.stopPropagation(); classifyTransaction(je.transactionRef); }}
                            disabled={classifyingRef === je.transactionRef}
                            className="p-0.5 text-muted-foreground hover:text-amber-600 disabled:opacity-40"
                            title={t('journal.reclassify')}
                          >
                            <Sparkles className="h-3 w-3" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteEntry(je, row.txDate); }}
                            className="p-0.5 text-muted-foreground hover:text-destructive"
                            title={t('common.delete')}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        }
        right={
          !selectedRow || !selectedTx ? (
            <div className="flex-1 flex items-center justify-center text-sm text-dim">
              {t('journal.selectRow')}
            </div>
          ) : (
          <>
            {/* Tx header */}
            <div className="shrink-0 bg-muted border-b border-border px-4 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className={cn(
                  'shrink-0 text-xs font-bold px-1.5 py-0.5 rounded',
                  selectedTx.source === 'manual'
                    ? 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300'
                    : selectedTx.direction === 'DBIT'
                      ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                      : 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
                )}>
                  {selectedTx.source === 'manual' ? t('journal.manualShort') : selectedTx.direction}
                </span>
                <span className="text-base font-bold tabular-nums text-foreground">{selectedTx.currency} {selectedTx.amount.toFixed(2)}</span>
                <span className="text-sm text-muted-foreground">{formatDate(selectedTx.date)}</span>
                {selectedTx.source !== 'manual' && <span className="text-xs text-muted-foreground">{selectedTx.bank}</span>}
                <button
                  onClick={() => { setSelectedRowId(null); setSelectedReceiptId(null); }}
                  title={t('common.close')}
                  className="ml-auto p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-sm text-foreground mt-1 truncate" title={selectedTx.description}>{selectedTx.description}</p>
              {selectedTx.remarks && (
                <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 rounded px-2 py-1 mt-1 whitespace-pre-wrap">{selectedTx.remarks}</p>
              )}
              <div className="text-xs font-mono text-muted-foreground mt-0.5 inline-flex items-center gap-1">
                {selectedTx.ref}
                <OpenInTabLink href={txHref(selectedTx.ref, selectedTx.date, period)} size="xs" />
              </div>
            </div>

            {/* Journal entries for this tx */}
            <div className="shrink-0 border-b border-border px-4 py-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('tab.journalEntries')}</span>
                <span className="text-xs text-muted-foreground">({siblingEntries.length})</span>
              </div>
              {siblingEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">{t('journal.noEntries')}</p>
              ) : (
                <div className="space-y-0.5">
                  {(() => {
                    const hasMixedDates = siblingEntries.some((je) => je.date && je.date !== selectedTx?.date);
                    return siblingEntries.map((je) => (
                      <div key={je.id}>
                        <div
                          onClick={() => setSelectedRowId(je.id)}
                          className={cn(
                            'flex items-center gap-1.5 text-sm rounded px-2 py-1.5 cursor-pointer font-mono',
                            je.id === selectedRowId
                              ? 'bg-blue-100 dark:bg-blue-900 ring-1 ring-blue-300 dark:ring-blue-700'
                              : 'bg-muted hover:bg-accent',
                          )}
                        >
                          {hasMixedDates && <span className="text-muted-foreground shrink-0 text-xs">{je.date ?? selectedTx?.date}</span>}
                          <span className="truncate text-foreground">{accountTitle(je.accountDebit)}</span>
                          <ChevronRight className="h-3 w-3 text-dim shrink-0" />
                          <span className="truncate text-foreground">{accountTitle(je.accountCredit)}</span>
                          <span className="ml-auto tabular-nums font-bold text-foreground shrink-0">{je.amount.toFixed(2)}</span>
                          {je.exchangeCurrency && je.exchangeCurrency !== 'CHF' && (
                            <span className="text-muted-foreground text-xs shrink-0">{je.exchangeCurrency}</span>
                          )}
                          {je.vatCode && <VatCode code={je.vatCode} className="text-muted-foreground text-xs shrink-0" />}
                        </div>
                        <FxLine entry={je} className="px-2 pb-1" />
                      </div>
                    ));
                  })()}
                </div>
              )}
            </div>

            {/* Receipts */}
            <div className="shrink-0 border-b border-border px-4 py-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('tab.receipts')}</span>
                <span className="text-xs text-muted-foreground">({selectedReceipts.length})</span>
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
                      <div className="flex-1 min-w-0 truncate">
                        {r.description ? (
                          <span className="text-foreground" title={r.description}>{r.description}</span>
                        ) : (
                          <span className="font-mono text-muted-foreground" title={r.filename}>{r.filename}</span>
                        )}
                      </div>
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

            {/* PDF viewer */}
            {selectedReceiptId ? (
              <PdfFrame
                key={selectedReceiptId}
                src={sources.receipt(selectedReceiptId)}
                title={t('journal.receiptPreview')}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-dim">
                {t('journal.noReceipt')}
              </div>
            )}
          </>
          )
        }
      />
    </div>
  );
}
