import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { JournalEntry } from '../../types/index.js';
import { derivePeriod } from '../../accounting/periods.js';
import { applied, quartersOf, vatEffect, type EntryLine, type EntryPatch, type Intent, type Planned } from '../../review/corrections.js';
import { getAccounts, type Account } from '../lib/accounts.js';
import { api, errorText } from '../lib/api.js';
import { ClosedPeriodError, useReview } from '../lib/review.js';
import { AccountCombobox } from './account-combobox.js';
import { ChangeView, VatDeltaTable } from './change-view.js';
import { t } from '../i18n/index.js';

/** The codes offered in the picker; any other code the VAT engine knows can be typed. */
const VAT_CODES = ['', 'I81', 'I26', 'I38', 'I0', 'M81', 'M26', 'M0', 'B81-1', 'K81-B', 'V81', 'V26', 'V38', 'V0', 'V0-E', '-I81', '-V81'];

interface Line { accountDebit: string; accountCredit: string; amount: string; vatCode: string; description: string }

const lineOf = (e: Partial<JournalEntry>): Line => ({
  accountDebit: e.accountDebit ?? '', accountCredit: e.accountCredit ?? '', amount: e.amount?.toFixed(2) ?? '', vatCode: e.vatCode ?? '', description: e.description ?? '',
});
const parseLine = (l: Line): EntryLine => ({
  accountDebit: l.accountDebit, accountCredit: l.accountCredit, amount: Number(l.amount.replace(/'/g, '')),
  ...(l.vatCode ? { vatCode: l.vatCode } : {}), ...(l.description.trim() ? { description: l.description.trim() } : {}),
});

let chartCache: Account[] | undefined;

/** The workspace's accounts first, then every account of the SME chart (data/chart.json) it lacks. */
function useAllAccounts(): Account[] {
  const [chart, setChart] = useState<Account[]>(chartCache ?? []);
  useEffect(() => {
    if (chartCache) return;
    api.chart().then((c) => { chartCache = c; setChart(c); }, () => {});
  }, []);
  return useMemo(() => {
    const own = getAccounts();
    const have = new Set(own.map((a) => a.number));
    return [...own, ...chart.filter((a) => !have.has(a.number))].sort((a, b) => a.number.localeCompare(b.number));
  }, [chart]);
}

/**
 * A new entry, an edit of every field of one, or its split into several lines, in the review
 * package. The preview shows what golden rule 1 makes of it and the VAT figures it moves before
 * anything is recorded.
 */
export function EntryForm({ entry, onClose }: { entry?: JournalEntry; onClose: () => void }) {
  const review = useReview()!;
  const all = useAllAccounts();
  const own = getAccounts();
  const [date, setDate] = useState(entry?.date ?? derivePeriod(review.review.period)?.to ?? '');
  const [rate, setRate] = useState(entry?.exchangeRate?.toString() ?? '');
  const [lines, setLines] = useState<Line[]>([lineOf(entry ?? {})]);
  const [error, setError] = useState<string | null>(null);

  const intent = useMemo((): Intent | null => {
    if (!entry) return { kind: 'addEntry', date, lines: lines.map(parseLine) };
    if (lines.length > 1) return { kind: 'splitEntry', id: entry.id, lines: lines.map(parseLine) };
    const l = parseLine(lines[0]);
    const patch: EntryPatch = {};
    if (date !== entry.date) patch.date = date;
    if (l.accountDebit !== entry.accountDebit) patch.accountDebit = l.accountDebit;
    if (l.accountCredit !== entry.accountCredit) patch.accountCredit = l.accountCredit;
    if (l.amount !== entry.amount) patch.amount = l.amount;
    if ((l.vatCode ?? '') !== (entry.vatCode ?? '')) patch.vatCode = l.vatCode ?? '';
    if ((l.description ?? '') !== (entry.description ?? '')) patch.description = l.description ?? '';
    if (entry.exchangeCurrency && Number(rate) !== entry.exchangeRate) patch.exchangeRate = Number(rate);
    return Object.keys(patch).length ? { kind: 'editEntry', id: entry.id, patch } : null;
  }, [entry, date, lines, rate]);

  const preview = useMemo((): { planned: Planned; vat: ReturnType<typeof vatEffect> } | { problem: string } | null => {
    if (!intent) return null;
    try {
      const planned = review.plan(intent);
      return { planned, vat: vatEffect(review.books, applied(review.books, planned.changes), quartersOf(planned.changes)) };
    } catch (e) {
      if (e instanceof ClosedPeriodError) return { problem: `${t('error.periodClosed', { date: e.closedThrough ?? '' })} ${e.reason ? t(`error.closed.${e.reason}`) : ''}` };
      return { problem: e instanceof Error ? e.message : String(e) };
    }
  }, [intent, review]);

  const sum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (i === j ? { ...l, ...patch } : l)));

  async function save() {
    if (!intent) return;
    setError(null);
    try {
      if (await review.write(intent)) onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const title = !entry ? t('entryForm.newTitle') : lines.length > 1 ? t('entryForm.splitTitle') : t('entryForm.editTitle');
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div role="dialog" aria-label={title} data-testid="entry-form" className="bg-background rounded-lg shadow-xl border border-border p-5 max-w-4xl w-full mx-4 space-y-3 max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="flex items-end gap-3 text-xs">
          <label className="flex flex-col gap-1 text-muted-foreground">
            {t('col.date')}
            <input type="date" name="date" value={date} onChange={(e) => setDate(e.target.value)} className="border border-input rounded px-2 py-1 text-sm bg-background text-foreground" />
          </label>
          {entry?.exchangeCurrency && (
            <label className="flex flex-col gap-1 text-muted-foreground">
              {t('entryForm.rate', { currency: entry.exchangeCurrency })}
              <input name="exchangeRate" value={rate} onChange={(e) => setRate(e.target.value)} className="w-28 border border-input rounded px-2 py-1 text-sm font-mono bg-background text-foreground" />
            </label>
          )}
          {entry && (
            <span className="ml-auto text-muted-foreground">
              {t('entryForm.original', { amount: `${entry.exchangeCurrency ?? 'CHF'} ${entry.amount.toFixed(2)}` })}
              {lines.length > 1 && <> · {t('entryForm.sum', { amount: sum.toFixed(2) })}</>}
            </span>
          )}
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} data-line={i} className="rounded border border-border p-2 space-y-2 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1 text-muted-foreground" data-field="accountDebit">
                  {t('col.debit')}
                  <AccountCombobox accounts={own} allAccounts={all} value={l.accountDebit} onChange={(n) => set(i, { accountDebit: n })} />
                </div>
                <div className="flex flex-col gap-1 text-muted-foreground" data-field="accountCredit">
                  {t('col.credit')}
                  <AccountCombobox accounts={own} allAccounts={all} value={l.accountCredit} onChange={(n) => set(i, { accountCredit: n })} />
                </div>
              </div>
              <div className="flex items-end gap-3">
                <label className="flex flex-col gap-1 text-muted-foreground w-32">
                  {t('col.amount')}
                  <input name="amount" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} className="border border-input rounded px-2 py-1 text-sm font-mono text-right bg-background text-foreground" />
                </label>
                <label className="flex flex-col gap-1 text-muted-foreground w-28">
                  {t('col.vat')}
                  <input name="vatCode" list="vat-codes" value={l.vatCode} onChange={(e) => set(i, { vatCode: e.target.value.trim() })} className="border border-input rounded px-2 py-1 text-sm font-mono bg-background text-foreground" />
                </label>
                <label className="flex flex-col gap-1 text-muted-foreground flex-1">
                  {t('col.description')}
                  <input name="description" value={l.description} onChange={(e) => set(i, { description: e.target.value })} className="border border-input rounded px-2 py-1 text-sm bg-background text-foreground" />
                </label>
                {lines.length > 1 && (
                  <button onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} title={t('entryForm.removeLine')} className="p-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                )}
              </div>
            </div>
          ))}
        </div>
        <datalist id="vat-codes">{VAT_CODES.filter(Boolean).map((c) => <option key={c} value={c} />)}</datalist>
        <button
          onClick={() => setLines((ls) => [...ls, { ...lineOf({}), accountCredit: ls[0]?.accountCredit ?? '', description: ls[0]?.description ?? '' }])}
          data-testid="entry-form-add-line"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />{entry ? t('entryForm.splitLine') : t('entryForm.addLine')}
        </button>

        <div className="rounded border border-border bg-muted p-2 space-y-2" data-testid="entry-form-preview">
          <p className="text-xs font-semibold text-muted-foreground">{t('entryForm.preview')}</p>
          {!preview && <p className="text-xs text-muted-foreground">{t('entryForm.nothingChanged')}</p>}
          {preview && 'problem' in preview && <p className="text-xs text-destructive">{preview.problem}</p>}
          {preview && 'planned' in preview && (
            <>
              {preview.planned.corrects && <p className="text-xs text-violet-800 dark:text-violet-200">{t('review.convertedNote', { quarter: preview.planned.corrects })}</p>}
              <div className="space-y-1">{preview.planned.changes.map((c) => <ChangeView key={`${c.collection}:${c.key}`} change={c} />)}</div>
              <VatDeltaTable deltas={preview.vat} />
            </>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs border border-border rounded hover:bg-accent text-muted-foreground">{t('common.cancel')}</button>
          <button onClick={save} disabled={!preview || 'problem' in preview} data-testid="entry-form-save" className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50">{t('entryForm.save')}</button>
        </div>
      </div>
    </div>
  );
}
