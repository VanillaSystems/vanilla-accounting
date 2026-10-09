import { useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Index, Receipt } from '../../../src/types/index.js';
import { cn, formatDate, formatAmount, periodMatchesDate, buildTxUrl } from '../lib/utils.js';
import { OpenInTabLink } from './open-in-tab-link.js';
import { t } from '../i18n/index.js';

const COLUMNS = [
  ['ref', 'col.ref', 'text-left'],
  ['datum', 'col.date', 'text-left'],
  ['beschreibung', 'col.description', 'text-left'],
  ['betrag', 'col.amount', 'text-right'],
  ['richtung', 'col.direction', 'text-left'],
  ['bank', 'col.bank', 'text-left'],
  ['beleg', 'col.receipts', 'text-left'],
  ['status', 'col.status', 'text-left'],
] as const;

const DEFAULT_COL_WIDTHS: Record<string, number> = {
  ref: 110, datum: 90, beschreibung: 280, betrag: 100, richtung: 70, bank: 90, beleg: 220, status: 90,
};

interface TransactionsTableProps {
  index: Index;
  search: string;
  filter: 'all' | 'linked' | 'unlinked';
  period: string;
  onSelectReceipt: (r: Receipt) => void;
  selectedTxRef: string | null;
  onSelectTx: (ref: string) => void;
}

export function TransactionsTable({
  index,
  search,
  filter,
  period,
  onSelectReceipt,
  selectedTxRef,
  onSelectTx,
}: TransactionsTableProps) {
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem('tx-col-widths');
      if (raw) return { ...DEFAULT_COL_WIDTHS, ...JSON.parse(raw) };
    } catch {}
    return DEFAULT_COL_WIDTHS;
  });
  const resizingRef = useRef<{ col: string; startX: number; startW: number } | null>(null);

  function onResizeStart(col: string, e: React.MouseEvent) {
    e.preventDefault();
    resizingRef.current = { col, startX: e.clientX, startW: colWidths[col] };
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = ev.clientX - resizingRef.current.startX;
      const newW = Math.max(40, resizingRef.current.startW + delta);
      setColWidths((prev) => {
        const next = { ...prev, [resizingRef.current!.col]: newW };
        localStorage.setItem('tx-col-widths', JSON.stringify(next));
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

  // Build lookup: transactionRef → receipt IDs
  const txReceiptIds = new Map<string, string[]>();
  for (const m of index.mappings) {
    const existing = txReceiptIds.get(m.transactionRef) ?? [];
    existing.push(m.receiptId);
    txReceiptIds.set(m.transactionRef, existing);
  }

  // Build lookup: receiptId → all transaction refs (to detect receipts shared across transactions)
  const receiptTxRefs = new Map<string, string[]>();
  for (const m of index.mappings) {
    const existing = receiptTxRefs.get(m.receiptId) ?? [];
    existing.push(m.transactionRef);
    receiptTxRefs.set(m.receiptId, existing);
  }

  const txByRef = new Map(index.transactions.map((t) => [t.ref, t]));

  const receiptById = new Map(index.receipts.map((r) => [r.id, r]));

  const q = search.toLowerCase();

  const rows = index.transactions
    .filter((tx) => {
      const receiptIds = txReceiptIds.get(tx.ref) ?? [];
      const isLinked = receiptIds.length > 0;
      if (filter === 'linked' && !isLinked) return false;
      if (filter === 'unlinked' && (isLinked || tx.type === 'wise-fee' || tx.noReceiptNeeded)) return false;
      if (!periodMatchesDate(period, tx.date)) return false;
      if (q) {
        const hay = `${tx.ref} ${tx.description} ${tx.bank} ${tx.currency}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
        {t('transactions.none')}
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="text-sm" style={{ tableLayout: 'fixed', width: Object.values(colWidths).reduce((a, b) => a + b, 0) }}>
        <colgroup>
          {COLUMNS.map(([key]) => (
            <col key={key} style={{ width: colWidths[key] }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 bg-muted border-b border-border z-10">
          <tr>
            {COLUMNS.map(([key, label, align]) => (
              <th key={key} className={cn('px-3 py-2 font-medium text-muted-foreground relative select-none', align)}>
                {t(label)}
                <span
                  onMouseDown={(e) => onResizeStart(key, e)}
                  className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize group flex justify-center"
                >
                  <span className="w-px h-full bg-muted-foreground/40 group-hover:w-0.5 group-hover:bg-ring group-active:w-0.5 group-active:bg-ring transition-colors" />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((tx, i) => {
            const receiptIds = txReceiptIds.get(tx.ref) ?? [];
            const receipts = receiptIds.map((id) => receiptById.get(id)).filter(Boolean) as Receipt[];
            const isLinked = receipts.length > 0;
            const isSelected = tx.ref === selectedTxRef;
            // Warn if any receipt linked to this transaction is also linked to >1 non-wise-fee transaction
            const hasDuplicateReceipt = receipts.some((r) => {
              const refs = receiptTxRefs.get(r.id) ?? [];
              const nonFeeRefs = refs.filter((ref) => txByRef.get(ref)?.type !== 'wise-fee');
              return nonFeeRefs.length > 1;
            });

            return (
              <tr
                key={`${tx.ref}|${tx.date}|${tx.amount}|${tx.currency}|${tx.direction}|${i}`}
                onClick={() => {
                  onSelectTx(tx.ref);
                  if (receipts.length > 0) onSelectReceipt(receipts[0]);
                }}
                className={cn(
                  'cursor-pointer border-b border-border',
                  isSelected
                    ? 'bg-blue-50 dark:bg-blue-950'
                    : i % 2 === 0
                    ? 'bg-background hover:bg-accent'
                    : 'bg-muted/50 hover:bg-accent/50',
                )}
              >
                <td className="px-3 py-2 font-mono text-xs text-foreground">
                  <span className="flex items-center gap-1 min-w-0">
                    <span className="truncate">{tx.ref}</span>
                    <OpenInTabLink href={buildTxUrl(tx.ref)} size="xs" />
                  </span>
                </td>
                <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{formatDate(tx.date)}</td>
                <td className="px-3 py-2 text-foreground truncate" title={tx.description}>
                  {tx.description}
                </td>
                <td className="px-3 py-2 text-right text-foreground whitespace-nowrap tabular-nums">
                  {formatAmount(tx.amount, tx.currency)}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {tx.source === 'manual' ? '—' : tx.direction}
                </td>
                <td className="px-3 py-2 text-xs">
                  {tx.source === 'manual'
                    ? <span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 font-medium">{t('transactions.manualBadge')}</span>
                    : <span className="text-muted-foreground">{tx.bank}</span>}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1 min-w-0">
                    <span className="truncate">
                      {receipts.length > 0
                        ? receipts.map((r) => r.filename).join(', ')
                        : '—'}
                    </span>
                    {hasDuplicateReceipt && (
                      <span title={t('transactions.sharedReceipt')} className="shrink-0">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
                      isLinked
                        ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                        : tx.type === 'wise-fee'
                        ? 'bg-muted text-muted-foreground'
                        : tx.noReceiptNeeded
                        ? 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200'
                        : 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300',
                    )}
                  >
                    {isLinked ? t('filter.linked') : tx.type === 'wise-fee' ? t('transactions.statusFee') : tx.noReceiptNeeded ? t('transactions.statusNoReceiptNeeded') : t('transactions.statusMissing')}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
