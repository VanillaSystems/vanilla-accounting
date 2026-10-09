import { useEffect, useRef, useState } from 'react';
import { Check, Trash2, Wand2, X } from 'lucide-react';
import type { Receipt } from '../../../src/types/index.js';
import { api } from '../lib/api.js';

interface BatchRow {
  receiptId: string;
  filename: string;
  date: string;
  description: string;
  amount: string;
  currency: string;
  suggesting: boolean;
  fromCache: boolean;
  suggestError?: string;
}

interface ManualBatchModalProps {
  receipts: Receipt[];
  onClose: () => void;
  onDone: (statusMessage: string) => void;
}

const SUGGEST_CONCURRENCY = 4;

export function ManualBatchModal({ receipts, onClose, onDone }: ManualBatchModalProps) {
  const [rows, setRows] = useState<BatchRow[]>(() =>
    receipts.map((r) => ({
      receiptId: r.id,
      filename: r.filename,
      date: r.date ?? '',
      description: r.description ?? '',
      amount: r.amount != null ? String(r.amount) : '',
      currency: r.currency ?? 'CHF',
      suggesting: !(r.date && r.description && r.amount != null && r.currency),
      fromCache: !!(r.date && r.description && r.amount != null && r.currency),
    })),
  );
  const [saving, setSaving] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    const needsSuggestion = rows.filter((r) => r.suggesting);

    async function fetchOne(receiptId: string) {
      const data = await api.suggestManualTransaction(receiptId).catch(() => null);
      if (cancelledRef.current) return;
      setRows((prev) => prev.map((row) => row.receiptId !== receiptId ? row : {
        ...row,
        date: data?.date || row.date,
        description: data?.description || row.description,
        amount: data?.amount != null ? String(data.amount) : row.amount,
        currency: data?.currency || row.currency,
        suggesting: false,
        suggestError: data ? undefined : 'Kein Vorschlag erhalten',
      }));
    }

    (async () => {
      for (let i = 0; i < needsSuggestion.length; i += SUGGEST_CONCURRENCY) {
        if (cancelledRef.current) return;
        const chunk = needsSuggestion.slice(i, i + SUGGEST_CONCURRENCY);
        await Promise.all(chunk.map((r) => fetchOne(r.receiptId)));
      }
    })();

    return () => { cancelledRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateRow(receiptId: string, patch: Partial<BatchRow>) {
    setRows((prev) => prev.map((r) => r.receiptId === receiptId ? { ...r, ...patch } : r));
  }

  function removeRow(receiptId: string) {
    setRows((prev) => prev.filter((r) => r.receiptId !== receiptId));
  }

  const readyRows = rows.filter((r) => !r.suggesting);
  const allValid = rows.length > 0 && rows.every((r) =>
    !r.suggesting && r.date && r.description.trim() && r.amount && !isNaN(parseFloat(r.amount)),
  );

  async function commit() {
    setSaving(true);
    let created = 0;
    let failed = 0;
    const COMMIT_CONCURRENCY = 4;
    const toCommit = rows;

    async function commitOne(row: BatchRow) {
      try {
        const ref = await api.createManualTransaction({
          date: row.date,
          description: row.description.trim(),
          amount: parseFloat(row.amount),
          currency: row.currency,
        });
        await api.addMapping({ receiptId: row.receiptId, transactionRef: ref });
        created++;
      } catch {
        failed++;
      }
    }

    for (let i = 0; i < toCommit.length; i += COMMIT_CONCURRENCY) {
      const chunk = toCommit.slice(i, i + COMMIT_CONCURRENCY);
      await Promise.all(chunk.map(commitOne));
    }

    setSaving(false);
    onDone(`${created} manuelle Transaktion(en) erstellt${failed > 0 ? `, ${failed} fehlgeschlagen` : ''}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !saving && onClose()}>
      <div
        className="bg-background rounded-lg shadow-xl border border-border p-6 max-w-3xl w-full mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1 shrink-0">
          <h2 className="text-sm font-semibold text-foreground">Manuelle Transaktionen erstellen (Auslagen)</h2>
          <button onClick={() => !saving && onClose()} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground mb-3 shrink-0">
          Für jeden ausgewählten Beleg wird eine manuelle Transaktion erstellt und verknüpft. Bereits im Beleg vorhandene Daten werden übernommen, für die übrigen wird ein KI-Vorschlag geladen.
        </p>

        <div className="flex-1 overflow-y-auto border border-border rounded">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted border-b border-border">
              <tr>
                <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Beleg</th>
                <th className="text-left px-2 py-1.5 font-medium text-muted-foreground w-32">Datum</th>
                <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Beschreibung</th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground w-24">Betrag</th>
                <th className="text-left px-2 py-1.5 font-medium text-muted-foreground w-20">Währung</th>
                <th className="px-2 py-1.5 w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.receiptId} className="border-b border-border last:border-0">
                  <td className="px-2 py-1.5 font-mono text-foreground max-w-[160px] truncate" title={row.filename}>
                    {row.filename}
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="date"
                      value={row.date}
                      onChange={(e) => updateRow(row.receiptId, { date: e.target.value })}
                      disabled={row.suggesting || saving}
                      className="w-full border border-border rounded px-1.5 py-1 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={row.description}
                      onChange={(e) => updateRow(row.receiptId, { description: e.target.value })}
                      placeholder="Beschreibung"
                      disabled={row.suggesting || saving}
                      className="w-full border border-border rounded px-1.5 py-1 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      value={row.amount}
                      onChange={(e) => updateRow(row.receiptId, { amount: e.target.value })}
                      min="0"
                      step="0.01"
                      disabled={row.suggesting || saving}
                      className="w-full border border-border rounded px-1.5 py-1 text-xs bg-background text-right focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      value={row.currency}
                      onChange={(e) => updateRow(row.receiptId, { currency: e.target.value })}
                      disabled={row.suggesting || saving}
                      className="w-full border border-border rounded px-1.5 py-1 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50"
                    >
                      <option>CHF</option>
                      <option>EUR</option>
                      <option>USD</option>
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    {row.suggesting ? (
                      <Wand2 className="h-3.5 w-3.5 text-muted-foreground animate-pulse" />
                    ) : (
                      <button
                        onClick={() => removeRow(row.receiptId)}
                        disabled={saving}
                        className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40"
                        title="Aus Stapel entfernen"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-3 shrink-0">
          <span className="text-xs text-muted-foreground">
            {readyRows.length}/{rows.length} bereit
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => !saving && onClose()}
              disabled={saving}
              className="px-3 py-1.5 text-xs border border-border rounded hover:bg-accent text-muted-foreground disabled:opacity-50"
            >
              Abbrechen
            </button>
            <button
              onClick={commit}
              disabled={saving || !allValid}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-violet-700 text-white rounded hover:bg-violet-800 disabled:opacity-50"
            >
              <Check className="h-3 w-3" />
              {saving ? 'Wird erstellt…' : `${rows.length} Transaktion(en) erstellen`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
