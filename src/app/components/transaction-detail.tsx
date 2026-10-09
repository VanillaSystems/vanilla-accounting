import { useState, useMemo } from 'react';
import { X, Plus, Trash2, AlertTriangle, Check, MessageSquare, AlignLeft, ShieldCheck } from 'lucide-react';
import type { Index, Receipt } from '../../../src/types/index.js';
import { cn, formatDate, buildTxUrl, buildReceiptUrl } from '../lib/utils.js';
import { OpenInTabLink } from './open-in-tab-link.js';
import { errorText } from '../lib/api.js';
import { t } from '../i18n/index.js';

interface TransactionDetailProps {
  txRef: string;
  index: Index;
  /** Show the controls that write: the API runs and is not in audit mode. */
  canEdit: boolean;
  onAddReceipt: (receiptId: string) => Promise<void>;
  onRemoveReceipt: (receiptId: string) => Promise<void>;
  onSelectReceipt: (r: Receipt | null) => void;
  selectedReceiptId: string | null;
  onDelete?: () => Promise<void>;
  onSetRemarks?: (remarks: string) => Promise<void>;
  onSetDescription?: (description: string) => Promise<void>;
  onSetNoReceiptNeeded?: (value: boolean) => Promise<void>;
}

export function TransactionDetail({
  txRef,
  index,
  canEdit,
  onAddReceipt,
  onRemoveReceipt,
  onSelectReceipt,
  selectedReceiptId,
  onDelete,
  onSetRemarks,
  onSetDescription,
  onSetNoReceiptNeeded,
}: TransactionDetailProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [remarksOpen, setRemarksOpen] = useState(false);
  const [remarksValue, setRemarksValue] = useState('');
  const [remarksSaving, setRemarksSaving] = useState(false);
  const [remarksError, setRemarksError] = useState<string | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  const [descValue, setDescValue] = useState('');
  const [descSaving, setDescSaving] = useState(false);
  const [descError, setDescError] = useState<string | null>(null);
  const [noReceiptSaving, setNoReceiptSaving] = useState(false);

  const tx = index.transactions.find((t) => t.ref === txRef);
  if (!tx) return null;

  const linkedReceiptIds = index.mappings
    .filter((m) => m.transactionRef === txRef)
    .map((m) => m.receiptId);
  const linkedIdSet = new Set(linkedReceiptIds);
  const linkedReceipts = linkedReceiptIds
    .map((id) => index.receipts.find((r) => r.id === id))
    .filter(Boolean) as Receipt[];

  const q = query.toLowerCase().trim();
  const searchResults = useMemo(() => {
    if (!q) return [];
    return index.receipts
      .filter((r) => {
        if (linkedIdSet.has(r.id)) return false;
        return (
          r.filename.toLowerCase().includes(q) ||
          (r.description ?? '').toLowerCase().includes(q) ||
          (r.amount != null && r.amount.toFixed(2).includes(q)) ||
          (r.currency != null && r.currency.toLowerCase().includes(q))
        );
      })
      .slice(0, 8);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, index.receipts, index.mappings]);

  async function handleAdd(receiptId: string) {
    setBusy(receiptId);
    await onAddReceipt(receiptId);
    setBusy(null);
    setQuery('');
  }

  async function handleRemove(receiptId: string) {
    setBusy(receiptId);
    await onRemoveReceipt(receiptId);
    if (selectedReceiptId === receiptId) onSelectReceipt(null);
    setBusy(null);
  }

  return (
    <div className="shrink-0 border-b border-border bg-background">
      {/* Transaction info */}
      <div className="px-4 py-2.5 border-b border-border bg-muted flex items-center gap-3 flex-wrap">
        <span className="font-mono text-sm font-semibold text-foreground inline-flex items-center gap-1">
          {tx.ref}
          <OpenInTabLink href={buildTxUrl(tx.ref)} size="xs" />
        </span>
        <span className="text-xs text-muted-foreground">{formatDate(tx.date)}</span>
        {tx.source === 'manual'
          ? <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-violet-100 text-violet-700">{t('transactions.manualBadge')}</span>
          : <>
              <span className={cn(
                'text-xs px-1.5 py-0.5 rounded font-medium',
                tx.direction === 'DBIT' ? 'bg-red-50 dark:bg-red-900 text-red-600 dark:text-red-400' : 'bg-green-50 dark:bg-green-900 text-green-700 dark:text-green-300',
              )}>
                {tx.direction}
              </span>
              <span className="text-xs text-muted-foreground">{tx.bank}</span>
            </>
        }
        <span className="text-sm font-medium text-foreground tabular-nums ml-auto">
          {tx.currency} {tx.amount.toFixed(2)}
        </span>
        {canEdit && onSetDescription && (
          <button
            onClick={() => { setDescOpen((o) => !o); setDescValue(tx.description ?? ''); setDescError(null); }}
            className={cn('p-1 rounded text-muted-foreground hover:text-foreground', descOpen ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 hover:text-blue-800' : 'hover:bg-accent')}
            title={t('transactions.editDescription')}
          >
            <AlignLeft className="h-3.5 w-3.5" />
          </button>
        )}
        {canEdit && onSetRemarks && (
          <button
            onClick={() => { setRemarksOpen((o) => !o); setRemarksValue(tx.remarks ?? ''); setRemarksError(null); }}
            className={cn('p-1 rounded text-muted-foreground hover:text-foreground', remarksOpen ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 hover:text-yellow-800' : 'hover:bg-accent')}
            title={t('transactions.editRemarks')}
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
        )}
        {canEdit && onSetNoReceiptNeeded && (
          <button
            onClick={async () => {
              setNoReceiptSaving(true);
              try { await onSetNoReceiptNeeded(!tx.noReceiptNeeded); }
              finally { setNoReceiptSaving(false); }
            }}
            disabled={noReceiptSaving}
            className={cn(
              'flex items-center gap-1 p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-50',
              tx.noReceiptNeeded ? 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:text-slate-800' : 'hover:bg-accent',
            )}
            title={tx.noReceiptNeeded ? t('transactions.noReceiptNeededReset') : t('transactions.noReceiptNeededConfirm')}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
          </button>
        )}
        {canEdit && onDelete && (
          <button
            onClick={async () => {
              if (!confirm(t('transactions.deleteConfirm', { ref: tx.ref }))) return;
              setDeleting(true);
              await onDelete();
              setDeleting(false);
            }}
            disabled={deleting}
            className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40"
            title={t('transactions.delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {tx.noReceiptNeeded && (
        <div className="px-4 py-1.5 border-t border-border bg-slate-50 dark:bg-slate-900 flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-slate-500 shrink-0" />
          <p className="text-xs text-slate-600 dark:text-slate-300">{t('transactions.noReceiptNeeded')}</p>
        </div>
      )}
      {!descOpen && tx.description && (
        <div className="px-4 py-1.5 border-t border-border">
          <p className="text-xs text-foreground whitespace-pre-wrap">{tx.description}</p>
        </div>
      )}
      {descOpen && (
        <div className="px-4 py-2 border-t border-border space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={descValue}
              onChange={(e) => setDescValue(e.target.value)}
              disabled={descSaving}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (!onSetDescription || !descValue.trim()) return;
                  setDescSaving(true);
                  setDescError(null);
                  onSetDescription(descValue.trim())
                    .then(() => setDescOpen(false))
                    .catch((e) => setDescError(errorText(e)))
                    .finally(() => setDescSaving(false));
                }
                if (e.key === 'Escape') setDescOpen(false);
              }}
              placeholder={t('transactions.descriptionPlaceholder')}
              className="flex-1 border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:bg-muted"
              autoFocus
            />
            <button
              onClick={async () => {
                if (!onSetDescription || !descValue.trim()) return;
                setDescSaving(true);
                setDescError(null);
                try { await onSetDescription(descValue.trim()); setDescOpen(false); }
                catch (e) { setDescError(errorText(e)); }
                finally { setDescSaving(false); }
              }}
              disabled={descSaving || !descValue.trim()}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/80 disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              {t('common.save')}
            </button>
            <button onClick={() => setDescOpen(false)} className="px-2 py-1 text-xs border border-border rounded hover:bg-accent text-muted-foreground">
              {t('common.cancel')}
            </button>
          </div>
          {descError && <p className="text-xs text-red-500 dark:text-red-400">{descError}</p>}
        </div>
      )}
      {remarksOpen && (
        <div className="px-4 py-2 border-t border-border space-y-1.5">
          <div className="flex items-start gap-2">
            <textarea
              value={remarksValue}
              onChange={(e) => setRemarksValue(e.target.value)}
              disabled={remarksSaving}
              onKeyDown={(e) => { if (e.key === 'Escape') setRemarksOpen(false); }}
              placeholder={t('transactions.remarksPlaceholder')}
              rows={2}
              className="flex-1 border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 resize-none disabled:opacity-50 disabled:bg-muted"
              autoFocus
            />
            <div className="flex flex-col gap-1">
              <button
                onClick={async () => {
                  if (!onSetRemarks) return;
                  setRemarksSaving(true);
                  setRemarksError(null);
                  try { await onSetRemarks(remarksValue); setRemarksOpen(false); }
                  catch (e) { setRemarksError(errorText(e)); }
                  finally { setRemarksSaving(false); }
                }}
                disabled={remarksSaving}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/80 disabled:opacity-50"
              >
                <Check className="h-3 w-3" />
                {t('common.save')}
              </button>
              <button onClick={() => setRemarksOpen(false)} className="px-2 py-1 text-xs border border-border rounded hover:bg-accent text-muted-foreground">
                {t('common.cancel')}
              </button>
            </div>
          </div>
          {remarksError && <p className="text-xs text-red-500 dark:text-red-400">{remarksError}</p>}
        </div>
      )}
      {!remarksOpen && tx.remarks && (
        <div className="px-4 py-1.5 border-t border-border">
          <p className="text-xs text-yellow-700 dark:text-yellow-300 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded px-2 py-1 whitespace-pre-wrap">{tx.remarks}</p>
        </div>
      )}

      {/* Zugeordnete Belege */}
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">{t('transactions.linkedReceipts')}</p>
          {linkedReceipts.length > 0 && (() => {
            const totals = linkedReceipts.reduce<Record<string, number>>((acc, r) => {
              if (r.amount != null && r.currency) {
                acc[r.currency] = (acc[r.currency] ?? 0) + r.amount;
              }
              return acc;
            }, {});
            const parts = Object.entries(totals).map(([cur, amt]) => `${cur} ${amt.toFixed(2)}`);
            return parts.length > 0 ? (
              <span className="text-xs text-muted-foreground tabular-nums">{parts.join(' + ')}</span>
            ) : null;
          })()}
        </div>

        {linkedReceipts.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">{t('transactions.noLinkedReceipts')}</p>
        ) : (
          <div className="space-y-1">
            {linkedReceipts.map((r) => {
              const receiptMappings = index.mappings.filter((m) => m.receiptId === r.id);
              const isDuplicate = receiptMappings.filter((m) => index.transactions.find((t) => t.ref === m.transactionRef)?.type !== 'wise-fee').length > 1;
              const isDupApproved = isDuplicate && receiptMappings.every((m) => m.approvedDuplicate);
              return (
                <div
                  key={r.id}
                  onClick={() => onSelectReceipt(r)}
                  className={cn(
                    'flex items-center gap-2 text-xs rounded px-2 py-1.5 cursor-pointer',
                    selectedReceiptId === r.id ? 'bg-blue-50 dark:bg-blue-950' : 'bg-green-50 dark:bg-green-900 hover:bg-green-100 dark:hover:bg-green-800',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    {r.description ? (
                      <>
                        <div className="text-foreground truncate font-medium" title={r.description}>{r.description}</div>
                        <div className="font-mono text-muted-foreground truncate text-[10px]" title={r.filename}>{r.filename}</div>
                      </>
                    ) : (
                      <div className="font-mono text-foreground truncate" title={r.filename}>{r.filename}</div>
                    )}
                  </div>
                  {r.date && <span className="text-muted-foreground shrink-0">{r.date.substring(0, 10)}</span>}
                  {r.amount != null && (
                    <span className="text-muted-foreground tabular-nums shrink-0">{r.currency} {r.amount.toFixed(2)}</span>
                  )}
                  {isDuplicate && !isDupApproved && (
                    <span title={t('receipts.duplicateUnapproved')}><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" /></span>
                  )}
                  {isDuplicate && isDupApproved && (
                    <span title={t('receipts.duplicateApproved')}><Check className="h-3.5 w-3.5 shrink-0 text-green-500" /></span>
                  )}
                  <OpenInTabLink href={buildReceiptUrl(r.id)} size="xs" />
                  {canEdit && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRemove(r.id); }}
                      disabled={busy === r.id}
                      className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 shrink-0"
                      title={t('assign.remove')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {canEdit && (
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('transactions.searchReceipt')}
            className="w-full border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
        )}
        {canEdit && searchResults.length > 0 && (
          <div className="space-y-0.5 max-h-36 overflow-y-auto border border-border rounded bg-background">
            {searchResults.map((r) => {
              const isAssigned = index.mappings.some((m) => m.receiptId === r.id);
              return (
                <button
                  key={r.id}
                  onClick={() => handleAdd(r.id)}
                  disabled={busy === r.id}
                  className="w-full flex items-center gap-2 text-xs px-2 py-1.5 hover:bg-green-50 dark:hover:bg-green-900 disabled:opacity-40 text-left"
                  title={t('assign.add')}
                >
                  <div className="flex-1 min-w-0">
                    {r.description ? (
                      <>
                        <div className="text-foreground truncate font-medium" title={r.description}>{r.description}</div>
                        <div className="font-mono text-muted-foreground truncate text-[10px]" title={r.filename}>{r.filename}</div>
                      </>
                    ) : (
                      <div className="font-mono text-foreground truncate" title={r.filename}>{r.filename}</div>
                    )}
                  </div>
                  {r.date && <span className="text-muted-foreground shrink-0">{r.date.substring(0, 10)}</span>}
                  {r.amount != null && (
                    <span className="text-muted-foreground tabular-nums shrink-0">{r.currency} {r.amount.toFixed(2)}</span>
                  )}
                  {isAssigned
                    ? <span className="shrink-0 text-blue-500 dark:text-blue-400 font-medium">{t('filter.linked')}</span>
                    : <Plus className="h-3 w-3 text-green-600 dark:text-green-400 shrink-0" />
                  }
                </button>
              );
            })}
          </div>
        )}
        {canEdit && q && searchResults.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('receipts.none')}</p>
        )}
      </div>
    </div>
  );
}
