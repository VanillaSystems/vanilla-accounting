/**
 * Where the AI has work (issue #343, docs/0.4.0/ai-setup.md decision 1): receipts whose text no
 * code could read, a photo or a scan, wait for the model's reading (`waitsForReading`,
 * src/parsers/receipt-text.ts: the one answer, which the detail's notice and the list's state
 * «unlesbar» ask too). On a Mac where no AI answers the page says how many wait in the periods not
 * filed, as a fact, with the way to set one up (Firma › KI) and the way by hand beside it: the
 * first of them, opened in its own period, whose detail takes date, amount and VAT. A receipt of a
 * filed period is not counted: nothing reads it again. With an AI the inbox's run reads them: no line.
 */
import { useEffect, useMemo, useState } from 'react';
import { waitsForReading } from '../../../parsers/receipt-text.js';
import { api } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import { useAiOff } from '../../ai/ai-off.js';
import type { AreaProps } from '../index.js';
import type { Ledger, ReceiptView } from './model.js';
import { at } from './view.js';

/** The receipts that wait for the model's reading, outside the filed periods. */
export const readingWaits = (l: Pick<Ledger, 'views' | 'closedThrough'>): ReceiptView[] =>
  l.views.filter((v) => !v.none && !v.locked && !(v.date && l.closedThrough && v.date <= l.closedThrough) && waitsForReading(v.r));

export function ReadingWaits({ l, period, nav }: { l: Ledger } & Pick<AreaProps, 'period' | 'nav'>) {
  const waiting = useMemo(() => readingWaits(l), [l]);
  const off = useAiOff();
  /** Whether an AI answers the app's steps on this Mac; undefined until asked, and asked only once receipts wait. */
  const [available, setAvailable] = useState<boolean>();
  const some = waiting.length > 0;
  useEffect(() => {
    if (!some) return;
    let live = true;
    void api.aiSetup.view().then((v) => { if (live) setAvailable(v.available); }, () => undefined);
    return () => { live = false; };
  }, [some, off]);
  if (!some || available !== false) return null;
  const first = waiting[0];
  return (
    <p className="readwaits" role="status" data-testid="reading-waits">
      <span>{t('receipts.waitRead', { n: waiting.length })}</span>
      <button type="button" className="linkbtn" data-act="ai-set-up" onClick={() => nav.go({ route: { area: 'company', section: 'ai' }, query: {} })}>{t(off ? 'aiOff.line.switchOn' : 'aiSetup.line.setUp')}</button>
      <button type="button" className="linkbtn" data-act="by-hand" onClick={() => nav.go(at({ area: 'receipts', id: first.r.id }, first.day, period))}>{t('aiSetup.line.byHand')}</button>
    </p>
  );
}
