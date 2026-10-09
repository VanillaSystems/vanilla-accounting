import { useState } from 'react';
import { Check, Wand2 } from 'lucide-react';
import type { Receipt, ReceiptPatch } from '../../types/index.js';
import { api } from '../lib/api.js';
import { cn } from '../lib/utils.js';

type Draft = { filename: string; date: string; amount: string; currency: string; description: string; remarks: string };

function draftOf(receipt: Receipt): Draft {
  return {
    filename: receipt.filename,
    date: receipt.date ?? '',
    amount: receipt.amount != null ? String(receipt.amount) : '',
    currency: receipt.currency ?? 'CHF',
    description: receipt.description ?? '',
    remarks: receipt.remarks ?? '',
  };
}

/** Only the fields that differ from the receipt; an empty filename, date or amount is left alone. */
function patchOf(receipt: Receipt, draft: Draft): ReceiptPatch {
  const patch: ReceiptPatch = {};
  const filename = draft.filename.trim();
  if (filename && filename !== receipt.filename) patch.filename = filename;
  const date = draft.date.trim();
  if (date && date !== (receipt.date ?? '')) patch.date = date;
  const amount = draft.amount.trim();
  const currency = draft.currency.trim().toUpperCase();
  if (amount && currency && (parseFloat(amount) !== receipt.amount || currency !== receipt.currency)) {
    patch.amount = parseFloat(amount);
    patch.currency = currency;
  }
  if (draft.description !== (receipt.description ?? '')) patch.description = draft.description;
  if (draft.remarks !== (receipt.remarks ?? '')) patch.remarks = draft.remarks;
  return patch;
}

/** The receipt's edit form. Speichern sends every changed field in one PATCH. */
export function ReceiptEditForm({ receipt, onSaved, onCancel }: {
  receipt: Receipt;
  onSaved: (receipt: Receipt) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(receipt));
  const [filenameSuggesting, setFilenameSuggesting] = useState(false);
  const [dateSuggesting, setDateSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (field: keyof Draft) => (value: string) => setDraft((d) => ({ ...d, [field]: value }));

  async function suggest(field: 'filename' | 'date', setBusy: (b: boolean) => void, call: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      set(field)((await call()) ?? '');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const patch = patchOf(receipt, draft);
      onSaved(Object.keys(patch).length > 0 ? await api.patchReceipt(receipt.id, patch) : receipt);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-4 pb-3 space-y-2">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Dateiname</label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft.filename}
            onChange={(e) => set('filename')(e.target.value)}
            disabled={filenameSuggesting || saving}
            className="flex-1 border border-border rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:bg-muted"
            autoFocus
          />
          <button onClick={() => suggest('filename', setFilenameSuggesting, () => api.suggestFilename(receipt.id))} disabled={filenameSuggesting || saving} title="KI-Vorschlag" className="p-1.5 border border-border rounded hover:bg-accent text-muted-foreground disabled:opacity-50">
            <Wand2 className={cn('h-3.5 w-3.5', filenameSuggesting && 'animate-pulse')} />
          </button>
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Datum</label>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={draft.date}
            onChange={(e) => set('date')(e.target.value)}
            disabled={dateSuggesting || saving}
            className="border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:bg-muted"
          />
          <button onClick={() => suggest('date', setDateSuggesting, () => api.suggestDate(receipt.id))} disabled={dateSuggesting || saving} title="KI-Vorschlag" className="p-1.5 border border-border rounded hover:bg-accent text-muted-foreground disabled:opacity-50">
            <Wand2 className={cn('h-3.5 w-3.5', dateSuggesting && 'animate-pulse')} />
          </button>
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Betrag</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            step="0.01"
            value={draft.amount}
            onChange={(e) => set('amount')(e.target.value)}
            disabled={saving}
            placeholder="Betrag…"
            className="w-28 border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:bg-muted"
          />
          <input
            type="text"
            value={draft.currency}
            onChange={(e) => set('currency')(e.target.value)}
            disabled={saving}
            placeholder="Währung"
            maxLength={3}
            className="w-16 border border-border rounded px-2 py-1 text-xs uppercase focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:bg-muted"
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Beschreibung</label>
        <input
          type="text"
          value={draft.description}
          onChange={(e) => set('description')(e.target.value)}
          disabled={saving}
          placeholder="Beschreibung…"
          className="w-full border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50 disabled:bg-muted"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Notiz</label>
        <textarea
          value={draft.remarks}
          onChange={(e) => set('remarks')(e.target.value)}
          disabled={saving}
          placeholder="Notiz…"
          rows={3}
          className="w-full border border-border rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400 resize-none disabled:opacity-50 disabled:bg-muted"
        />
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button onClick={save} disabled={saving || filenameSuggesting || dateSuggesting || !draft.filename.trim()} className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/80 disabled:opacity-50">
          <Check className="h-3 w-3" />
          Speichern
        </button>
        <button onClick={onCancel} className="px-2 py-1 text-xs border border-border rounded hover:bg-accent text-muted-foreground">
          Abbrechen
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
