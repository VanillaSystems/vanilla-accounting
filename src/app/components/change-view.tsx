import { ChevronRight } from 'lucide-react';
import type { Index, JournalEntry } from '../../types/index.js';
import { fieldDiffs, type RecordChange } from '../../books/changes.js';
import type { VatDelta } from '../../review/corrections.js';
import { accountTitle } from '../lib/accounts.js';
import { cn, formatDate } from '../lib/utils.js';
import { isKey, t } from '../i18n/index.js';

/** The label of a record field, from the column names where one exists. */
function fieldLabel(field: string): string {
  const col: Record<string, string> = {
    date: 'col.date', accountDebit: 'col.debit', accountCredit: 'col.credit', amount: 'col.amount', vatCode: 'col.vat',
    description: 'col.description', remarks: 'col.remarks', exchangeCurrency: 'col.currency',
  };
  const key = col[field] ?? `change.field.${field}`;
  return isKey(key) ? t(key as 'col.date') : field;
}

function show(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field === 'accountDebit' || field === 'accountCredit') return accountTitle(String(value));
  if (field === 'date') return formatDate(String(value));
  if (field === 'amount' && typeof value === 'number') return value.toFixed(2);
  if (typeof value === 'boolean') return value ? t('change.yes') : t('change.no');
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function EntryLine({ e }: { e: JournalEntry }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="tabular-nums text-muted-foreground">{formatDate(e.date)}</span>
      <span>{accountTitle(e.accountDebit) || '—'}</span>
      <ChevronRight className="h-3 w-3 text-dim" />
      <span>{accountTitle(e.accountCredit) || '—'}</span>
      <span className="font-mono tabular-nums font-semibold">{e.exchangeCurrency ?? 'CHF'} {e.amount.toFixed(2)}</span>
      {e.vatCode && <span className="font-mono text-muted-foreground">{e.vatCode}</span>}
      {e.corrects && <span className="rounded bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200 px-1">{t('change.corrects', { quarter: e.corrects })}</span>}
      {e.description && <span className="text-muted-foreground">«{e.description}»</span>}
    </span>
  );
}

const SIGN = { added: '+', removed: '−', changed: '~' } as const;

/** One record before and after, as a person reads it: a booking line, a receipt link, the fields that changed. */
export function ChangeView({ change, index }: { change: RecordChange; index?: Pick<Index, 'receipts'> }) {
  const how = !change.before ? 'added' : !change.after ? 'removed' : 'changed';
  const tone = { added: 'text-green-700 dark:text-green-400', removed: 'text-red-700 dark:text-red-400', changed: 'text-blue-700 dark:text-blue-400' }[how];
  const head = (
    <span className={cn('font-mono font-bold w-3 shrink-0', tone)}>{SIGN[how]}</span>
  );
  if (change.collection === 'entries' && how !== 'changed') {
    return (
      <div className="flex items-start gap-2 text-xs" data-change={`${change.collection}:${change.key}`}>
        {head}
        <span className="text-muted-foreground shrink-0">{t(how === 'added' ? 'change.entryAdded' : 'change.entryRemoved')}</span>
        <EntryLine e={(change.after ?? change.before)!} />
      </div>
    );
  }
  if (change.collection === 'mappings') {
    const m = (change.after ?? change.before)!;
    const r = index?.receipts.find((x) => x.id === m.receiptId);
    return (
      <div className="flex items-start gap-2 text-xs" data-change={`${change.collection}:${change.key}`}>
        {head}
        <span>{t(how === 'added' ? 'change.linked' : 'change.unlinked', { receipt: r?.description ?? r?.filename ?? m.receiptId, ref: m.transactionRef })}</span>
      </div>
    );
  }
  const what = change.collection === 'entries' ? t('change.entry', { id: change.key }) : change.collection === 'transactions' ? t('change.transaction', { ref: change.key }) : `${change.collection} ${change.key}`;
  const diffs = fieldDiffs(change).filter((d) => d.field !== 'origin');
  return (
    <div className="text-xs space-y-0.5" data-change={`${change.collection}:${change.key}`}>
      <div className="flex items-center gap-2">{head}<span className="text-muted-foreground">{what}</span></div>
      <table className="ml-5">
        <tbody>
          {diffs.map((d) => (
            <tr key={d.field}>
              <td className="pr-3 text-muted-foreground align-top">{fieldLabel(d.field)}</td>
              <td className="pr-2 line-through text-red-700/80 dark:text-red-400/80 align-top">{show(d.field, d.before)}</td>
              <td className="pr-2 text-dim align-top">→</td>
              <td className="text-green-700 dark:text-green-400 font-medium align-top">{show(d.field, d.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The VAT return figures a change moves: quarter, Ziffer, before, after, difference. */
export function VatDeltaTable({ deltas }: { deltas: VatDelta[] }) {
  if (!deltas.length) return <p className="text-xs text-muted-foreground">{t('change.noVatEffect')}</p>;
  return (
    <table className="text-xs tabular-nums" data-testid="vat-effect">
      <thead>
        <tr className="text-muted-foreground">
          <th className="text-left pr-3 font-medium">{t('change.quarter')}</th>
          <th className="text-left pr-3 font-medium">{t('change.ziffer')}</th>
          <th className="text-right pr-3 font-medium">{t('change.before')}</th>
          <th className="text-right pr-3 font-medium">{t('change.after')}</th>
          <th className="text-right font-medium">{t('change.difference')}</th>
        </tr>
      </thead>
      <tbody>
        {deltas.map((d) => (
          <tr key={`${d.quarter}-${d.ziffer}`}>
            <td className="pr-3">{d.quarter}</td>
            <td className="pr-3 font-mono">{d.ziffer}</td>
            <td className="pr-3 text-right font-mono">{d.before.toFixed(2)}</td>
            <td className="pr-3 text-right font-mono">{d.after.toFixed(2)}</td>
            <td className={cn('text-right font-mono font-semibold', d.after - d.before < 0 ? 'text-red-700 dark:text-red-400' : 'text-green-700 dark:text-green-400')}>
              {(d.after - d.before > 0 ? '+' : '') + (d.after - d.before).toFixed(2)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
