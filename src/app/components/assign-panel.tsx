import { useState, useMemo } from 'react';
import { X, Plus, Wand2, Check, AlertTriangle, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import type { Index, Receipt, BankTransaction } from '../../../src/types/index.js';
import { cn } from '../lib/utils.js';
import { txHref } from '../lib/location.js';
import { OpenInTabLink } from './open-in-tab-link.js';
import { api, errorText } from '../lib/api.js';
import { t } from '../i18n/index.js';

function DirectionBadge({ direction }: { direction: BankTransaction['direction'] }) {
  const isCredit = direction === 'CRDT';
  const Icon = isCredit ? ArrowDownLeft : ArrowUpRight;
  return (
    <span
      title={isCredit ? t('direction.credit') : t('direction.debit')}
      className={cn(
        'shrink-0 inline-flex items-center justify-center h-4 w-4 rounded-sm',
        isCredit
          ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950'
          : 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950',
      )}
    >
      <Icon className="h-3 w-3" />
    </span>
  );
}

function ReceiptCountBadge({ count, title }: { count: number; title: string }) {
  if (count === 0) return null;
  return (
    <span title={title} className="shrink-0 text-[10px] font-medium px-1 rounded bg-accent text-muted-foreground tabular-nums">
      ×{count}
    </span>
  );
}

interface AssignPanelProps {
  receipt: Receipt;
  index: Index;
  onAdd: (transactionRef: string) => Promise<void>;
  onRemove: (transactionRef: string) => Promise<void>;
  onApproveDuplicate?: () => Promise<void>;
  onCreateManual?: (date: string, description: string, amount: number, currency: string) => Promise<void>;
  variant?: 'strip' | 'full';
}

export function AssignPanel({ receipt, index, onAdd, onRemove, onApproveDuplicate, onCreateManual, variant = 'strip' }: AssignPanelProps) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [approvingDuplicate, setApprovingDuplicate] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [form, setForm] = useState({ date: '', description: '', amount: '', currency: 'CHF' });
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function openCreate() {
    setCreateOpen(true);
    setCreateError(null);
    setSuggesting(true);
    const data = await api.suggestManualTransaction(receipt.id).catch(() => null);
    if (data) {
      setForm({
        date: data.date ?? '',
        description: data.description ?? '',
        amount: data.amount != null ? String(data.amount) : '',
        currency: data.currency ?? 'CHF',
      });
    }
    setSuggesting(false);
  }

  async function handleCreateManual() {
    if (!onCreateManual || !form.date || !form.description.trim() || !form.amount) return;
    setCreateSaving(true);
    setCreateError(null);
    try {
      await onCreateManual(form.date, form.description.trim(), parseFloat(form.amount), form.currency);
      setCreateOpen(false);
      setForm({ date: '', description: '', amount: '', currency: 'CHF' });
    } catch (e) {
      setCreateError(errorText(e));
    } finally {
      setCreateSaving(false);
    }
  }

  const linkedMappings = index.mappings.filter((m) => m.receiptId === receipt.id);
  const linkedRefs = new Set(linkedMappings.map((m) => m.transactionRef));
  const linkedTxs = index.transactions.filter((t) => linkedRefs.has(t.ref));
  const isDuplicate = linkedTxs.filter((t) => t.type !== 'wise-fee').length > 1;
  const isApproved = isDuplicate && linkedMappings.every((m) => m.approvedDuplicate);

  const receiptCountByRef = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of index.mappings) {
      counts.set(m.transactionRef, (counts.get(m.transactionRef) ?? 0) + 1);
    }
    return counts;
  }, [index.mappings]);

  const q = query.toLowerCase().trim();
  const searchResults = useMemo(() => {
    if (!q) return [];
    return index.transactions
      .filter((t) => {
        if (linkedRefs.has(t.ref)) return false;
        return (
          t.ref.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          (t.remarks ?? '').toLowerCase().includes(q) ||
          t.date.includes(q) ||
          t.amount.toFixed(2).includes(q) ||
          t.currency.toLowerCase().includes(q)
        );
      })
;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, index.transactions, index.mappings]);

  async function handleAdd(ref: string) {
    setBusy(ref);
    await onAdd(ref);
    setBusy(null);
    setQuery('');
  }

  async function handleRemove(ref: string) {
    setBusy(ref);
    await onRemove(ref);
    setBusy(null);
  }

  return (
    <div className={cn(
      'bg-background px-4 space-y-3',
      variant === 'strip' ? 'border-b border-border py-3 shrink-0' : 'flex-1 overflow-y-auto py-5',
    )}>
      {/* Currently linked */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1.5">{t('assign.linkedTransactions')}</p>
        {linkedTxs.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">{t('transactions.noLinkedReceipts')}</p>
        ) : (
          <div className="space-y-1">
            {linkedTxs.map((tx) => (
              <div key={tx.ref} className="flex items-center gap-2 text-xs bg-green-50 dark:bg-green-900 rounded px-2 py-1">
                <DirectionBadge direction={tx.direction} />
                <span className="font-mono text-foreground w-28 shrink-0">{tx.ref}</span>
                <span className="text-muted-foreground shrink-0">{tx.date.substring(0, 10)}</span>
                <span className="text-muted-foreground truncate flex-1" title={tx.remarks ? `${tx.description}\n${tx.remarks}` : tx.description}>{tx.description}</span>
                <span className="text-muted-foreground shrink-0">{tx.bank}</span>
                <span className="text-muted-foreground tabular-nums shrink-0">{tx.currency} {tx.amount.toFixed(2)}</span>
                <ReceiptCountBadge
                  count={(receiptCountByRef.get(tx.ref) ?? 1) - 1}
                  title={t('assign.alsoLinkedTo', { n: (receiptCountByRef.get(tx.ref) ?? 1) - 1 })}
                />
                <OpenInTabLink href={txHref(tx.ref)} size="xs" />
                <button
                  onClick={() => handleRemove(tx.ref)}
                  disabled={busy === tx.ref}
                  className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40 shrink-0"
                  title={t('assign.remove')}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Duplicate assignment warning */}
      {isDuplicate && (
        <div className={cn(
          'flex items-start gap-2 rounded px-2 py-2 text-xs',
          isApproved ? 'bg-green-50 dark:bg-green-900 text-green-700 dark:text-green-300' : 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800',
        )}>
          {isApproved
            ? <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            : <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          }
          <span className="flex-1">
            {isApproved
              ? t('receipts.duplicateApproved')
              : t('assign.duplicateWarning')
            }
          </span>
          {!isApproved && onApproveDuplicate && (
            <button
              onClick={async () => {
                setApprovingDuplicate(true);
                await onApproveDuplicate();
                setApprovingDuplicate(false);
              }}
              disabled={approvingDuplicate}
              className="shrink-0 px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 font-medium"
            >
              {approvingDuplicate ? t('assign.approving') : t('assign.approve')}
            </button>
          )}
        </div>
      )}

      {/* Search to add */}
      <div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          placeholder={t('assign.search')}
          className="w-full border border-border rounded px-2 py-1 text-xs bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          autoFocus
        />
        {searchResults.length > 0 && (
          <div className="mt-1 space-y-0.5 max-h-36 overflow-y-auto border border-border rounded bg-background">
            {searchResults.map((tx) => (
              <div
                key={tx.ref}
                role="button"
                tabIndex={0}
                onClick={() => busy !== tx.ref && handleAdd(tx.ref)}
                onKeyDown={(e) => e.key === 'Enter' && busy !== tx.ref && handleAdd(tx.ref)}
                aria-disabled={busy === tx.ref}
                className={cn(
                  'w-full flex items-center gap-2 text-xs px-2 py-1.5 hover:bg-green-50 dark:hover:bg-green-900 text-left cursor-pointer',
                  busy === tx.ref && 'opacity-40 pointer-events-none',
                )}
              >
                <DirectionBadge direction={tx.direction} />
                <span className="font-mono text-foreground w-28 shrink-0">{tx.ref}</span>
                <span className="text-muted-foreground shrink-0">{tx.date.substring(0, 10)}</span>
                <span className="text-muted-foreground truncate flex-1" title={tx.remarks ? `${tx.description}\n${tx.remarks}` : tx.description}>{tx.description}</span>
                <span className="text-muted-foreground shrink-0">{tx.bank}</span>
                <span className="text-muted-foreground tabular-nums shrink-0">{tx.currency} {tx.amount.toFixed(2)}</span>
                <ReceiptCountBadge
                  count={receiptCountByRef.get(tx.ref) ?? 0}
                  title={t('assign.alreadyLinked', { n: receiptCountByRef.get(tx.ref) ?? 0 })}
                />
                <OpenInTabLink href={txHref(tx.ref)} size="xs" />
              </div>
            ))}
          </div>
        )}
        {q && searchResults.length === 0 && (
          <p className="text-xs text-muted-foreground mt-1">{t('transactions.none')}</p>
        )}
      </div>

      {/* Create manual transaction */}
      {onCreateManual && (
        <div className="border-t border-border pt-3">
          {!createOpen ? (
            <button
              onClick={openCreate}
              className="flex items-center gap-1.5 text-xs text-violet-600 hover:text-violet-800 font-medium"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('assign.createManual')}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <p className="text-xs font-medium text-violet-700">{t('assign.newManual')}</p>
                {suggesting && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Wand2 className="h-3 w-3 animate-pulse" />
                    {t('assign.aiSuggesting')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  disabled={suggesting || createSaving}
                  className="border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50"
                />
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder={t('col.description')}
                  disabled={suggesting || createSaving}
                  className="flex-1 min-w-[140px] border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50"
                />
                <input
                  type="number"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  placeholder={t('col.amount')}
                  min="0"
                  step="0.01"
                  disabled={suggesting || createSaving}
                  className="w-24 border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50"
                />
                <select
                  value={form.currency}
                  onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                  disabled={suggesting || createSaving}
                  className="border border-border rounded px-2 py-1 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50"
                >
                  <option>CHF</option>
                  <option>EUR</option>
                  <option>USD</option>
                </select>
                <button
                  onClick={handleCreateManual}
                  disabled={suggesting || createSaving || !form.date || !form.description.trim() || !form.amount}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-violet-700 text-white rounded hover:bg-violet-800 disabled:opacity-50"
                >
                  <Check className="h-3 w-3" />
                  {createSaving ? t('common.saving') : t('common.save')}
                </button>
                <button
                  onClick={() => setCreateOpen(false)}
                  className="px-2 py-1 text-xs border border-border rounded hover:bg-accent text-muted-foreground"
                >
                  {t('common.cancel')}
                </button>
              </div>
              {createError && <p className="text-xs text-red-500">{createError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
