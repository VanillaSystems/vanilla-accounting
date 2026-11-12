/**
 * Where the AI has work (issue #343, docs/0.4.0/ai-setup.md decision 1): receipts whose text no
 * code could read, a photo or a scan, wait for the model's reading (`waitsForReading`,
 * src/accounting/receipt-due.ts). On a Mac where no AI answers the page says how many wait, as a
 * fact, with the way to set one up (Firma › KI) and the way by hand beside it (the first of them,
 * whose detail takes date, amount and VAT). With an AI the inbox's run reads them: no line.
 */
import { useEffect, useMemo, useState } from 'react';
import { waitsForReading } from '../../../accounting/receipt-due.js';
import { api } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import { useAiOff } from '../../ai/ai-off.js';
import type { AreaProps } from '../index.js';

export function ReadingWaits({ books, nav }: Pick<AreaProps, 'books' | 'nav'>) {
  const waiting = useMemo(() => books.receipts.filter(waitsForReading), [books.receipts]);
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
  return (
    <p className="readwaits" role="status" data-testid="reading-waits">
      <span>{t('receipts.waitRead', { n: waiting.length })}</span>
      <button type="button" className="linkbtn" data-act="ai-set-up" onClick={() => nav.go({ route: { area: 'company', section: 'ai' }, query: {} })}>{t(off ? 'aiOff.line.switchOn' : 'aiSetup.line.setUp')}</button>
      <button type="button" className="linkbtn" data-act="by-hand" onClick={() => nav.select({ area: 'receipts', id: waiting[0].id })}>{t('aiSetup.line.byHand')}</button>
    </p>
  );
}
