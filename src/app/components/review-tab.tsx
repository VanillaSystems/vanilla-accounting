import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload, Undo2, Trash2, Plus, CheckCircle2 } from 'lucide-react';
import { applyChange } from '../../books/changes.js';
import { quartersOf, vatEffect, type VatDelta } from '../../review/corrections.js';
import type { DecidedReview } from '../../review/package.js';
import type { Target } from '../../review/types.js';
import { derivePeriod, vatQuarterOf } from '../../accounting/periods.js';
import { api, errorText } from '../lib/api.js';
import { useReview } from '../lib/review.js';
import { cn, formatDate } from '../lib/utils.js';
import { entryHref, receiptHref, txHref } from '../lib/location.js';
import { ChangeView, VatDeltaTable } from './change-view.js';
import { EntryForm } from './entry-form.js';
import { t } from '../i18n/index.js';

function targetLabel(target: Target): string {
  switch (target.kind) {
    case 'entry': return t('review.target.entry', { id: target.id });
    case 'receipt': return t('review.target.receipt', { id: target.id });
    case 'transaction': return t('review.target.transaction', { ref: target.ref });
    case 'review': return t('review.target.review');
  }
}

/** The quarters of the review's period and its year: what a sign-off can cover. */
function scopesOf(period: string): string[] {
  const range = derivePeriod(period);
  if (!range) return [period];
  const qs = new Set<string>();
  for (let m = Number(range.from.slice(5, 7)); m <= Number(range.to.slice(5, 7)); m += 3) qs.add(vatQuarterOf(`${range.from.slice(0, 4)}-${String(m).padStart(2, '0')}-01`));
  return [...qs, range.from.slice(0, 4)];
}

/** The review package's own tab: the corrections so far, comments, sign-off, and "Review abschicken". */
export function ReviewTab() {
  const review = useReview()!;
  const { state, broken, base } = review;
  const [scope, setScope] = useState(() => scopesOf(state.base.period)[0]);
  const [statement, setStatement] = useState('');
  const [newEntry, setNewEntry] = useState(false);
  const [decided, setDecided] = useState<DecidedReview[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { api.reviewDecisions().then(setDecided, () => setDecided([])); }, []);

  /** Each correction's VAT effect, against the books as the corrections before it left them. */
  const effects = useMemo(() => {
    const out = new Map<string, VatDelta[]>();
    let books = structuredClone(base);
    for (const c of state.corrections) {
      if (broken.includes(c.id)) continue;
      const next = structuredClone(books);
      for (const ch of c.changes) applyChange(next, ch);
      out.set(c.id, vatEffect(books, next, quartersOf(c.changes)));
      books = next;
    }
    return out;
  }, [base, state.corrections, broken]);

  async function load(file: File) {
    setLoadError(null);
    try {
      review.load(JSON.parse(await file.text()));
    } catch (e) {
      setLoadError(errorText(e));
    }
  }

  const hrefOf = (target: Target): string | undefined => {
    if (target.kind === 'entry') { const e = review.books.journalEntries.find((x) => x.id === target.id); return e ? entryHref(e.id, e.date) : undefined; }
    if (target.kind === 'receipt') { const r = review.books.receipts.find((x) => x.id === target.id); return r ? receiptHref(r.id, r.date) : undefined; }
    if (target.kind === 'transaction') { const x = review.books.transactions.find((y) => y.ref === target.ref); return x ? txHref(x.ref, x.date) : undefined; }
    return undefined;
  };

  return (
    <div className="flex-1 overflow-auto p-6" data-testid="review-tab">
      <div className="max-w-5xl mx-auto space-y-6">
        <section className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-foreground">{t('review.title', { name: state.reviewer.name, period: state.base.period })}</h2>
              <p className="text-xs text-muted-foreground">{t('review.intro', { date: formatDate(state.base.createdAt.slice(0, 10)) })}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => fileInput.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded hover:bg-accent text-muted-foreground" title={t('review.loadHint')}>
                <Upload className="h-3.5 w-3.5" />{t('review.load')}
              </button>
              <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ''; }} />
              <button onClick={() => review.download()} data-testid="review-submit" className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground">
                <Download className="h-3.5 w-3.5" />{t('review.submit')}
              </button>
            </div>
          </div>
          {loadError && <p className="text-xs text-destructive">{loadError}</p>}
          <label className="block text-xs text-muted-foreground">
            {t('review.message')}
            <textarea
              value={state.message}
              onChange={(e) => review.setMessage(e.target.value)}
              rows={2}
              placeholder={t('review.messagePlaceholder')}
              className="mt-1 w-full border border-input rounded px-2 py-1.5 text-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </label>
          <p className="text-xs text-muted-foreground">{t('review.submitHint')}</p>
        </section>

        <section className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">{t('review.corrections', { n: state.corrections.length })}</h3>
            <button onClick={() => setNewEntry(true)} data-testid="review-new-entry" className="flex items-center gap-1.5 px-3 py-1 text-xs border border-border rounded hover:bg-accent text-muted-foreground">
              <Plus className="h-3.5 w-3.5" />{t('entryForm.newTitle')}
            </button>
          </div>
          {state.corrections.length === 0 && <p className="text-xs text-muted-foreground">{t('review.noCorrections')}</p>}
          <ol className="space-y-3">
            {state.corrections.map((c) => (
              <li key={c.id} data-correction={c.id} className={cn('rounded border p-3 space-y-2', broken.includes(c.id) ? 'border-amber-400 bg-amber-50 dark:bg-amber-950/40' : 'border-border')}>
                <div className="flex items-start gap-2">
                  <span className="font-mono text-xs text-muted-foreground shrink-0">{c.id}</span>
                  <span className="text-xs rounded bg-muted px-1.5 py-0.5 text-muted-foreground shrink-0">{t(`review.kind.${c.kind}`)}</span>
                  <span className="text-sm text-foreground flex-1">{c.reason}</span>
                  <button onClick={() => review.undo(c.id)} title={t('review.undo')} className="p-1 text-muted-foreground hover:text-destructive shrink-0"><Undo2 className="h-3.5 w-3.5" /></button>
                </div>
                {broken.includes(c.id) && <p className="text-xs text-amber-800 dark:text-amber-200">{t('review.broken')}</p>}
                {c.corrects && <p className="text-xs text-violet-800 dark:text-violet-200">{t('review.convertedNote', { quarter: c.corrects })}</p>}
                <div className="space-y-1">{c.changes.map((ch) => <ChangeView key={`${ch.collection}:${ch.key}`} change={ch} index={review.books} />)}</div>
                {effects.has(c.id) && <VatDeltaTable deltas={effects.get(c.id)!} />}
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-lg border border-border bg-background p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">{t('review.comments', { n: state.comments.length })}</h3>
            <button onClick={() => void review.comment({ kind: 'review' })} className="flex items-center gap-1.5 px-3 py-1 text-xs border border-border rounded hover:bg-accent text-muted-foreground">
              <Plus className="h-3.5 w-3.5" />{t('review.generalComment')}
            </button>
          </div>
          {state.comments.length === 0 && <p className="text-xs text-muted-foreground">{t('review.noComments')}</p>}
          <ul className="space-y-1.5">
            {state.comments.map((c) => (
              <li key={c.id} data-comment={c.id} className="flex items-start gap-2 text-sm">
                {hrefOf(c.target) ? <a href={hrefOf(c.target)} className="text-xs text-blue-700 dark:text-blue-400 hover:underline shrink-0">{targetLabel(c.target)}</a> : <span className="text-xs text-muted-foreground shrink-0">{targetLabel(c.target)}</span>}
                <span className="flex-1 text-foreground whitespace-pre-wrap">{c.text}</span>
                <button onClick={() => review.removeComment(c.id)} title={t('common.delete')} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-lg border border-border bg-background p-4 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">{t('review.signOff')}</h3>
          <div className="flex items-end gap-2">
            <select value={scope} onChange={(e) => setScope(e.target.value)} name="scope" className="border border-input rounded px-2 py-1 text-sm bg-background text-foreground">
              {scopesOf(state.base.period).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input value={statement} onChange={(e) => setStatement(e.target.value)} name="statement" placeholder={t('review.signOffPlaceholder')} className="flex-1 border border-input rounded px-2 py-1 text-sm bg-background text-foreground" />
            <button
              onClick={() => { review.signOff(scope, statement); setStatement(''); }}
              disabled={!statement.trim()}
              data-testid="review-sign-off"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />{t('review.signOffButton')}
            </button>
          </div>
          <ul className="space-y-1">
            {state.signOffs.map((s) => (
              <li key={s.id} data-sign-off={s.scope} className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                <span className="font-medium">{s.scope}</span>
                <span className="flex-1 text-foreground">{s.statement}</span>
                <span className="text-xs text-muted-foreground">{formatDate(s.at.slice(0, 10))}</span>
                <button onClick={() => review.removeSignOff(s.id)} title={t('common.delete')} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>
        </section>

        {decided.length > 0 && (
          <section className="rounded-lg border border-border bg-background p-4 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">{t('review.earlier')}</h3>
            {decided.map((r) => (
              <div key={r.branch} className="space-y-1">
                <p className="text-xs text-muted-foreground">{t('review.earlierOne', { name: r.reviewer, period: r.period, date: formatDate(r.createdAt.slice(0, 10)) })}</p>
                <ul className="space-y-0.5">
                  {r.corrections.map((c) => (
                    <li key={c.id} className="flex gap-2 text-xs">
                      <span className={cn('shrink-0 rounded px-1.5', c.decision === 'merged' ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200' : c.decision === 'rejected' ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200' : 'bg-muted text-muted-foreground')}>
                        {c.decision ? t(`review.decision.${c.decision}`) : t('review.decision.open')}
                      </span>
                      <span className="text-foreground">{c.reason}</span>
                      {c.ownerReason && <span className="text-muted-foreground">· {c.ownerReason}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
      {newEntry && <EntryForm onClose={() => setNewEntry(false)} />}
    </div>
  );
}
