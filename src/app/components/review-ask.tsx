import { useMemo, useState } from 'react';
import { applied, quartersOf, vatEffect } from '../../review/corrections.js';
import { useReview } from '../lib/review.js';
import { ChangeView, VatDeltaTable } from './change-view.js';
import { t } from '../i18n/index.js';

/**
 * The question the review package asks before it records anything: the reason of a correction,
 * shown with what it changes and its VAT effect, or the text of a comment.
 */
export function ReviewAsk() {
  const review = useReview();
  const ask = review?.ask;
  const [text, setText] = useState('');
  const vat = useMemo(() => {
    if (!review || !ask?.planned) return [];
    return vatEffect(review.books, applied(review.books, ask.planned.changes), quartersOf(ask.planned.changes));
  }, [review, ask]);
  if (!review || !ask) return null;

  const done = (value: string | null) => { setText(''); ask.resolve(value); };
  const isReason = ask.kind === 'reason';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => done(null)}>
      <div role="dialog" aria-label={isReason ? t('review.reasonTitle') : t('review.commentTitle')} data-testid="review-ask" className="bg-background rounded-lg shadow-xl border border-border p-5 max-w-2xl w-full mx-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-foreground">{isReason ? t('review.reasonTitle') : t('review.commentTitle')}</h2>
        {ask.planned && (
          <div className="space-y-2">
            {ask.planned.corrects && (
              <p className="text-xs rounded border border-violet-300 bg-violet-50 text-violet-900 dark:bg-violet-950 dark:text-violet-200 dark:border-violet-800 px-2 py-1.5">
                {t('review.convertedNote', { quarter: ask.planned.corrects })}
              </p>
            )}
            <div className="space-y-1 max-h-48 overflow-auto rounded border border-border bg-muted p-2">
              {ask.planned.changes.map((c) => <ChangeView key={`${c.collection}:${c.key}`} change={c} index={review.books} />)}
            </div>
            <div>
              <p className="text-xs font-semibold text-muted-foreground mb-1">{t('review.vatEffect')}</p>
              <VatDeltaTable deltas={vat} />
            </div>
          </div>
        )}
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) done(text); if (e.key === 'Escape') done(null); }}
          placeholder={isReason ? t('review.reasonPlaceholder') : t('review.commentPlaceholder')}
          rows={3}
          className="w-full border border-input rounded px-2 py-1.5 text-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex justify-end gap-2">
          <button onClick={() => done(null)} className="px-3 py-1.5 text-xs border border-border rounded hover:bg-accent text-muted-foreground">{t('common.cancel')}</button>
          <button onClick={() => done(text)} disabled={!text.trim()} data-testid="review-ask-ok" className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground disabled:opacity-50">
            {isReason ? t('review.record') : t('review.addComment')}
          </button>
        </div>
      </div>
    </div>
  );
}
