import { useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import type { Index, Receipt } from '../../../src/types/index.js';
import { cn, formatDate, formatAmount, dateFromFilename, labelFromFilename } from '../lib/utils.js';
import { receiptHref } from '../lib/location.js';
import { inPeriod, type Period } from '../../accounting/periods.js';
import { OpenInTabLink } from './open-in-tab-link.js';
import { t } from '../i18n/index.js';

/** The kinds of document that are not a receipt of their own, each with a badge. */
const NON_RECEIPT_KINDS = ['supporting', 'statement', 'noise', 'duplicate'] as const;
type NonReceiptKind = (typeof NON_RECEIPT_KINDS)[number];
const isNonReceiptKind = (kind: Receipt['kind']): kind is NonReceiptKind => NON_RECEIPT_KINDS.includes(kind as NonReceiptKind);

/**
 * A document that needs no payment: typed as supporting/statement/noise/duplicate, or worth
 * exactly 0 (not merely unread) with no VAT and no link (brochures, labels, blank captures).
 */
export function isNonReceipt(r: Receipt, linkedIds: Set<string>): boolean {
  if (isNonReceiptKind(r.kind)) return true;
  return r.amount === 0 && !(r.vatSummary ?? []).some((g) => g.vat > 0) && !linkedIds.has(r.id);
}

interface ReceiptsTableProps {
  index: Index;
  search: string;
  filter: 'all' | 'linked' | 'unlinked';
  /** Hide documents that need no payment (see isNonReceipt). */
  hideZero?: boolean;
  period: Period;
  onSelectReceipt: (r: Receipt) => void;
  selectedId: string | null;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAll?: (ids: string[]) => void;
}

export function ReceiptsTable({
  index,
  search,
  filter,
  hideZero = false,
  period,
  onSelectReceipt,
  selectedId,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
}: ReceiptsTableProps) {
  const [noDateOnly, setNoDateOnly] = useState(false);
  const txByRef = new Map(index.transactions.map((t) => [t.ref, t]));

  // A receipt is "linked" if it has at least one mapping (wise-fee mappings count too)
  const linkedIds = new Set(index.mappings.map((m) => m.receiptId));

  // Build lookup: receiptId → transaction refs
  const receiptTxRefs = new Map<string, string[]>();
  // Build lookup: receiptId → whether all duplicate mappings are approved
  const receiptDupApproved = new Map<string, boolean>();
  for (const m of index.mappings) {
    const existing = receiptTxRefs.get(m.receiptId) ?? [];
    existing.push(m.transactionRef);
    receiptTxRefs.set(m.receiptId, existing);
  }
  // Build lookup: receiptId → count of non-wise-fee transaction refs (to detect true duplicates)
  const receiptNonFeeRefCount = new Map<string, number>();
  for (const [receiptId, refs] of receiptTxRefs) {
    const nonFeeCount = refs.filter((ref) => txByRef.get(ref)?.type !== 'wise-fee').length;
    receiptNonFeeRefCount.set(receiptId, nonFeeCount);
    if (nonFeeCount > 1) {
      const mappings = index.mappings.filter((m) => m.receiptId === receiptId);
      receiptDupApproved.set(receiptId, mappings.every((m) => m.approvedDuplicate));
    }
  }

  const q = search.toLowerCase();

  const rows = index.receipts
    .filter((r) => {
      if (filter === 'linked' && !linkedIds.has(r.id)) return false;
      if (filter === 'unlinked' && linkedIds.has(r.id)) return false;
      if (hideZero && isNonReceipt(r, linkedIds)) return false;
      if (!inPeriod(period, r.date ?? dateFromFilename(r.filename))) return false;
      if (noDateOnly && (r.date || dateFromFilename(r.filename))) return false;
      if (q) {
        const txRefs = receiptTxRefs.get(r.id) ?? [];
        const txHay = txRefs.map((ref) => {
          const tx = txByRef.get(ref);
          return `${ref} ${tx?.description ?? ''} ${tx?.remarks ?? ''}`;
        }).join(' ');
        const hay = `${r.filename} ${r.description ?? ''} ${r.extractedText} ${txHay}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const da = a.date ?? dateFromFilename(a.filename) ?? a.indexedAt;
      const db = b.date ?? dateFromFilename(b.filename) ?? b.indexedAt;
      return da.localeCompare(db);
    });

  return (
    <div className="flex flex-col overflow-hidden h-full">
      <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={noDateOnly}
            onChange={(e) => setNoDateOnly(e.target.checked)}
            className="rounded"
          />
          {t('receipts.noDateOnly', { n: index.receipts.filter((r) => !r.date && !dateFromFilename(r.filename)).length })}
        </label>
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
          {t('receipts.none')}
        </div>
      ) : (
      <div className="overflow-auto flex-1">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted border-b border-border z-10">
          <tr>
            {onToggleSelectAll && (
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  className="rounded"
                  checked={rows.length > 0 && rows.every((r) => selectedIds?.has(r.id))}
                  onChange={() => onToggleSelectAll(rows.map((r) => r.id))}
                />
              </th>
            )}
            <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">{t('col.filename')}</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap w-28">{t('col.date')}</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground">{t('col.description')}</th>
            <th className="text-right px-3 py-2 font-medium text-muted-foreground whitespace-nowrap w-32">{t('col.amount')}</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap w-36">{t('col.transactionRef')}</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap w-24">{t('col.status')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isLinked = linkedIds.has(r.id);
            const txRefs = receiptTxRefs.get(r.id) ?? [];
            const isDuplicate = (receiptNonFeeRefCount.get(r.id) ?? 0) > 1;
            const isDupApproved = receiptDupApproved.get(r.id) ?? false;
            const date = r.date ?? dateFromFilename(r.filename);
            const description = r.description ?? labelFromFilename(r.filename);
            const isSelected = r.id === selectedId;

            return (
              <tr
                key={r.id}
                onClick={() => onSelectReceipt(r)}
                className={cn(
                  'cursor-pointer border-b border-border',
                  isSelected
                    ? 'bg-blue-50 dark:bg-blue-950'
                    : i % 2 === 0
                    ? 'bg-background hover:bg-accent'
                    : 'bg-muted/50 hover:bg-accent/50',
                )}
              >
                {onToggleSelect && (
                  <td className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="rounded"
                      checked={selectedIds?.has(r.id) ?? false}
                      onChange={() => onToggleSelect(r.id)}
                    />
                  </td>
                )}
                <td className="px-3 py-2 font-mono text-xs text-foreground max-w-[220px]">
                  <span className="flex items-center gap-1 min-w-0">
                    <span className="truncate" title={r.filename}>{r.filename}</span>
                    {isNonReceiptKind(r.kind) && (
                      <span className="shrink-0 rounded px-1 py-px text-[10px] font-sans bg-muted text-muted-foreground border border-border" title={r.kindRule ? t('receipts.kindRule', { rule: r.kindRule }) : undefined}>
                        {t(`receipts.kind.${r.kind}`)}
                      </span>
                    )}
                    <OpenInTabLink href={receiptHref(r.id)} size="xs" />
                  </span>
                </td>
                <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{formatDate(date)}</td>
                <td className="px-3 py-2 text-foreground max-w-[280px] truncate" title={description}>
                  {description}
                </td>
                <td className="px-3 py-2 text-right text-foreground whitespace-nowrap tabular-nums">
                  {formatAmount(r.amount, r.currency)}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground max-w-[180px]">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono truncate" title={txRefs.join(', ')}>
                      {txRefs.length > 0 ? txRefs.join(', ') : '—'}
                    </span>
                    {isDuplicate && !isDupApproved && (
                      <span title={t('receipts.duplicateUnapproved')}><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" /></span>
                    )}
                    {isDuplicate && isDupApproved && (
                      <span title={t('receipts.duplicateApproved')}><Check className="h-3.5 w-3.5 shrink-0 text-green-500" /></span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge linked={isLinked} duplicate={isDuplicate} approved={isDupApproved} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      )}
    </div>
  );
}

function StatusBadge({ linked, duplicate, approved }: { linked: boolean; duplicate?: boolean; approved?: boolean }) {
  if (duplicate && !approved) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300">
        <AlertTriangle className="h-3 w-3" />
        {t('receipts.statusDuplicate')}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
        linked
          ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
          : 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300',
      )}
    >
      {linked ? t('filter.linked') : t('filter.unlinked')}
    </span>
  );
}
