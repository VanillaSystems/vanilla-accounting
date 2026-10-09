import { useEffect, useState } from 'react';
import { Check, Wand2 } from 'lucide-react';
import { api, errorText } from '../lib/api.js';
import { t } from '../i18n/index.js';

/**
 * The Transaktionen tab's form for a new manual transaction (an Auslage). Given a receipt, it
 * starts from the KI-Vorschlag for that receipt.
 */
export function ManualTransactionForm({ suggestFromReceiptId, onCreated, onCancel }: {
  suggestFromReceiptId?: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('CHF');
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(!!suggestFromReceiptId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!suggestFromReceiptId) return;
    let live = true;
    api.suggestManualTransaction(suggestFromReceiptId)
      .then((data) => {
        if (!live) return;
        setDate(data.date ?? '');
        setDescription(data.description ?? '');
        setAmount(data.amount != null ? String(data.amount) : '');
        setCurrency(data.currency ?? 'CHF');
      })
      .catch(() => {})
      .finally(() => live && setSuggesting(false));
    return () => { live = false; };
  }, [suggestFromReceiptId]);

  const complete = !!date && !!description.trim() && !!amount;

  async function create() {
    if (!complete) return;
    setSaving(true);
    setError(null);
    try {
      await api.createManualTransaction({ date, description: description.trim(), amount: parseFloat(amount), currency });
      onCreated();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || suggesting;
  return (
    <div className="bg-violet-50 border-b border-violet-200 px-4 py-3 shrink-0 space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-violet-700">{t('manualTx.title')}</p>
        {suggesting && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Wand2 className="h-3 w-3 animate-pulse" />
            {t('assign.aiSuggesting')}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} className="border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50" />
        <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('col.description')} disabled={busy} className="flex-1 min-w-[200px] border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50" />
        <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('col.amount')} min="0" step="0.01" disabled={busy} className="w-28 border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50" />
        <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={busy} className="border border-border rounded px-2 py-1 text-xs bg-background focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50">
          <option>CHF</option>
          <option>EUR</option>
          <option>USD</option>
        </select>
        <button onClick={create} disabled={busy || !complete} className="flex items-center gap-1 px-3 py-1 text-xs bg-violet-700 text-white rounded hover:bg-violet-800 disabled:opacity-50">
          <Check className="h-3 w-3" />
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button onClick={onCancel} className="px-2 py-1 text-xs border border-border rounded hover:bg-accent text-muted-foreground">
          {t('common.cancel')}
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
