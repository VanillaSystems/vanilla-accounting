import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, GitBranch, GitMerge, Upload, X } from 'lucide-react';
import type { Index } from '../../types/index.js';
import type { ReviewView } from '../../review/git.js';
import type { CorrectionPlan } from '../../review/plan.js';
import { api, errorText } from '../lib/api.js';
import { cn, formatDate } from '../lib/utils.js';
import { ChangeView, VatDeltaTable } from './change-view.js';
import { t } from '../i18n/index.js';

const TONE: Record<string, string> = {
  applicable: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  closedPeriod: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  alreadySo: 'bg-muted text-muted-foreground',
  conflict: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  refused: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  merged: 'bg-green-600 text-white',
  rejected: 'bg-red-600 text-white',
};

const mergeable = (p: CorrectionPlan) => p.status === 'applicable' || p.status === 'closedPeriod' || p.status === 'alreadySo';

/** One review as a pull request: its commits with before and after, VAT effect and status against today's books. */
function ReviewPr({ view, index, onDecided }: { view: ReviewView; index: Index; onDecided: (message: string) => void }) {
  const plans = new Map(view.plans.map((p) => [p.correction.id, p]));
  const decisions = new Map(view.decisions.map((d) => [d.correctionId, d]));
  const open = view.plans.filter(mergeable).map((p) => p.correction.id);
  const [picked, setPicked] = useState<Set<string>>(new Set(open));
  const [rejecting, setRejecting] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { file } = view;

  async function decide(accept: string[] | 'all', reject: Record<string, string> = {}) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.decideReview(view.branch, { accept, reject });
      setRejecting({});
      onDecided(t('reviews.decided', { merged: r.merged.length, rejected: r.rejected.length, skipped: r.skipped.length }));
    } catch (e) {
      setMessage(errorText(e));
    }
    setBusy(false);
  }

  return (
    <section className="rounded-lg border border-border bg-background" data-review={view.branch}>
      <div className="flex items-start gap-3 p-4 border-b border-border">
        <GitBranch className="h-5 w-5 text-violet-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{t('reviews.prTitle', { name: file.reviewer.name, period: file.base.period })}</h3>
          <p className="text-xs text-muted-foreground font-mono">{view.branch} · {t('reviews.base', { commit: view.base.slice(0, 8), date: formatDate(file.base.createdAt.slice(0, 10)) })}</p>
          {file.message && <p className="mt-1 text-sm text-foreground whitespace-pre-wrap">{file.message}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => decide([...picked].filter((id) => open.includes(id)))}
            disabled={busy || ![...picked].some((id) => open.includes(id))}
            className="px-3 py-1.5 text-xs border border-border rounded hover:bg-accent text-muted-foreground disabled:opacity-50"
          >
            {t('reviews.mergePicked', { n: [...picked].filter((id) => open.includes(id)).length })}
          </button>
          <button onClick={() => decide('all')} disabled={busy || !open.length} data-testid="reviews-merge-all" className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50">
            <GitMerge className="h-3.5 w-3.5" />{t('reviews.mergeAll')}
          </button>
        </div>
      </div>
      {message && <p className="px-4 pt-3 text-xs text-destructive">{message}</p>}
      <ol className="divide-y divide-border">
        {file.corrections.map((c) => {
          const plan = plans.get(c.id);
          const decision = decisions.get(c.id);
          const status = decision ? decision.decision : plan!.status;
          const canPick = !decision && plan && mergeable(plan);
          return (
            <li key={c.id} data-correction={c.id} data-status={status} className="p-4 space-y-2">
              <div className="flex items-start gap-2">
                <input type="checkbox" disabled={!canPick} checked={!!canPick && picked.has(c.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} className="mt-1" />
                <span className="font-mono text-xs text-muted-foreground shrink-0 mt-0.5">{c.id}</span>
                <span className="font-mono text-xs text-dim shrink-0 mt-0.5">{(view.commits[c.id] ?? '').slice(0, 8)}</span>
                <span className="text-xs rounded bg-muted px-1.5 py-0.5 text-muted-foreground shrink-0">{t(`review.kind.${c.kind}`)}</span>
                <span className="text-sm text-foreground flex-1">{c.reason}</span>
                <span className={cn('text-xs rounded px-1.5 py-0.5 shrink-0', TONE[status])}>{t(`reviews.status.${status}`)}</span>
                {!decision && rejecting[c.id] === undefined && (
                  <button onClick={() => setRejecting((r) => ({ ...r, [c.id]: '' }))} title={t('reviews.reject')} className="p-1 text-muted-foreground hover:text-destructive shrink-0"><X className="h-3.5 w-3.5" /></button>
                )}
              </div>
              {decision?.reason && <p className="text-xs text-muted-foreground ml-6">{t('reviews.rejectedBecause', { reason: decision.reason })}</p>}
              {plan?.problem && <p className="text-xs text-amber-800 dark:text-amber-200 ml-6">{plan.problem}</p>}
              {plan?.status === 'closedPeriod' && <p className="text-xs text-violet-800 dark:text-violet-200 ml-6">{t('reviews.closedNote')}</p>}
              <div className="ml-6 space-y-1">
                {(plan?.changes.length ? plan.changes : c.changes).map((ch) => <ChangeView key={`${ch.collection}:${ch.key}`} change={ch} index={index} />)}
              </div>
              {plan && plan.vat.length > 0 && <div className="ml-6"><VatDeltaTable deltas={plan.vat} /></div>}
              {rejecting[c.id] !== undefined && (
                <div className="ml-6 flex items-center gap-2">
                  <input autoFocus name="rejectReason" value={rejecting[c.id]} onChange={(e) => setRejecting((r) => ({ ...r, [c.id]: e.target.value }))} placeholder={t('reviews.rejectReason')} className="flex-1 border border-input rounded px-2 py-1 text-sm bg-background text-foreground" />
                  <button onClick={() => decide([], { [c.id]: rejecting[c.id] })} disabled={busy || !rejecting[c.id]?.trim()} className="px-3 py-1 text-xs rounded bg-destructive text-white disabled:opacity-50">{t('reviews.reject')}</button>
                  <button onClick={() => setRejecting(({ [c.id]: _, ...r }) => r)} className="px-2 py-1 text-xs text-muted-foreground">{t('common.cancel')}</button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {(file.comments.length > 0 || file.signOffs.length > 0) && (
        <div className="border-t border-border p-4 space-y-2">
          {file.comments.map((k) => (
            <p key={k.id} className="text-sm text-foreground" data-comment={k.id}>
              <span className="text-xs text-muted-foreground mr-2">{k.target.kind === 'review' ? t('review.target.review') : k.target.kind === 'transaction' ? t('review.target.transaction', { ref: k.target.ref }) : t(`review.target.${k.target.kind}`, { id: k.target.id })}</span>
              {k.text}
            </p>
          ))}
          {file.signOffs.map((s) => (
            <p key={s.id} className="flex items-center gap-2 text-sm text-foreground" data-sign-off={s.scope}>
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              {t('reviews.signedOff', { scope: s.scope, name: file.reviewer.name, date: formatDate(s.at.slice(0, 10)) })}: {s.statement}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

/** The owner's side of a review: drop the Treuhänder's file here, look at it as a pull request, merge or reject. */
export function ReviewsTab({ index, onRefresh }: { index: Index; onRefresh: () => void }) {
  const [reviews, setReviews] = useState<ReviewView[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(() => { api.reviews().then(setReviews, (e) => setMessage(errorText(e))); }, []);
  useEffect(load, [load]);

  async function importFile(file: File) {
    setMessage(null);
    try {
      const r = await api.importReview(JSON.parse(await file.text()));
      setMessage(r.created ? t('reviews.imported', { branch: r.branch, n: r.commits }) : t('reviews.alreadyImported', { branch: r.branch }));
      load();
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  return (
    <div className="flex-1 overflow-auto p-6" data-testid="reviews-tab">
      <div className="max-w-5xl mx-auto space-y-4">
        <h2 className="text-base font-semibold text-foreground">{t('reviews.title')}</h2>
        <label
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void importFile(f); }}
          className={cn('flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-6 text-sm cursor-pointer', dragging ? 'border-ring bg-accent' : 'border-border text-muted-foreground')}
        >
          <Upload className="h-5 w-5" />
          {t('reviews.drop')}
          <input type="file" accept="application/json,.json" className="hidden" data-testid="reviews-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
        </label>
        {message && <p className="text-sm text-foreground" data-testid="reviews-message">{message}</p>}
        {reviews?.length === 0 && <p className="text-sm text-muted-foreground">{t('reviews.none')}</p>}
        {reviews?.map((v) => <ReviewPr key={`${v.branch}-${v.decisions.length}`} view={v} index={index} onDecided={(text) => { setMessage(text); load(); onRefresh(); }} />)}
      </div>
    </div>
  );
}
