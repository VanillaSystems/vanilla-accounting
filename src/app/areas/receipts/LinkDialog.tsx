/**
 * Zahlung verknüpfen: the open-period payments ranked for this receipt (best first), a search
 * over all of them, and "paid privately or in cash" last. ↑↓ choose, ↵ links, Esc closes.
 */
import { useMemo, useState } from 'react';
import type { RouteOf } from '../../shell/route.js';
import { useFx } from '../../hooks/use-fx.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { candidates, chfOf, type Candidate, type Ledger, type ReceiptView } from './model.js';
import { bankOf, dayText, signed, txLine } from './view.js';
import { linkPayment, privateOutlay } from './actions.js';
import { Kbd } from './commands.js';

type Props = AreaProps<RouteOf<'receipts'>> & { v: ReceiptView; l: Ledger; onClose(): void };

function why(c: Candidate): string {
  return [
    c.sameAmount ? t('receipts.whySameAmount') : c.otherCurrency ? t('receipts.whyAccount', { currency: c.tx.currency }) : '',
    c.days !== undefined ? dayText(c.days) : '',
    c.taken ? t('receipts.whyTaken', { n: c.taken }) : '',
  ].filter(Boolean).join(' · ');
}

export function LinkDialog({ v, l, nav, onClose }: Props) {
  const { r } = v;
  const { rates } = useFx();
  const owner = useWorkspace()?.bankAccounts.find((b) => b.bank === 'manual')?.account;
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const { best, more } = useMemo(() => candidates(v, l, chfOf(rates), q), [v, l, rates, q]);
  const items: Array<Candidate | 'private'> = [...best, ...more, 'private'];
  const at = Math.min(idx, items.length - 1);

  function choose(item: Candidate | 'private' | undefined) {
    if (!item) return;
    onClose();
    if (item === 'private') privateOutlay(nav, v);
    else linkPayment(nav, v, item.tx.ref, txLine(item.tx));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((at + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((at - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[at]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
  }

  let k = 0;
  const row = (c: Candidate) => {
    const i = k++;
    const w = why(c);
    return (
      <div key={c.tx.ref} className={`o tx2${i === at ? ' on' : ''}`} role="option" aria-selected={i === at} data-ref={c.tx.ref} onMouseMove={() => i !== at && setIdx(i)} onClick={() => choose(c)}>
        <span className="d mono">{formatDate(c.tx.date)}</span>
        <span className="t"><span>{c.tx.description}</span><small>{bankOf(c.tx)}{w && ` · ${w}`}</small></span>
        <span className="a mono">{c.tx.currency !== 'CHF' && <i>{c.tx.currency}</i>}{fmt(signed(c.tx))}</span>
      </div>
    );
  };
  const privateAt = k + best.length + more.length;

  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 40%, transparent)' }} onClick={onClose} />
      <div className="palette linkdlg" role="dialog" aria-label={t('receipts.linkPayment')}>
        <div className="ctx">
          <div><span className="lbl">{t('receipts.linkPayment')}</span><b>{v.vendor}</b> <span className="m">{v.desc}</span></div>
          <div className="mono">{v.date ? formatDate(v.date) : t('receipts.noDate')} · <b>{r.currency || 'CHF'} {r.amount != null ? fmt(r.amount) : '—'}</b></div>
        </div>
        <input autoFocus value={q} placeholder={t('receipts.linkSearch')} aria-label={t('receipts.linkSearch')} autoComplete="off" onChange={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKeyDown} />
        <div className="res" role="listbox">
          {best.length > 0 && <div className="gh">{t('receipts.bestFit')}</div>}
          {best.map(row)}
          {more.length > 0 && <div className="gh">{q ? t('receipts.hits') : t('receipts.morePayments')}</div>}
          {more.map(row)}
          {!best.length && !more.length && <div className="none">{q ? t('receipts.noPaymentFits', { q }) : t('receipts.noOpenPayment')}</div>}
          <div className="gh">{t('receipts.withoutBank')}</div>
          <div className={`o tx2${privateAt === at ? ' on' : ''}`} role="option" aria-selected={privateAt === at} data-ref="private" onMouseMove={() => privateAt !== at && setIdx(privateAt)} onClick={() => choose('private')}>
            <span className="d mono">{owner}</span>
            <span className="t"><span>{t('receipts.privatePaid')}</span><small>{t('receipts.privatePaidHint')}</small></span>
            <span className="a" />
          </div>
        </div>
        <div className="foot">
          <Kbd keys={['↑', '↓']} tip={t('receipts.pickTip')} /> {t('keys.select')}
          <Kbd keys={['↵']} tip={t('receipts.linkTip')} /> {t('receipts.linkVerbShort')}
          <Kbd keys={[t('receipts.escKey')]} tip={t('receipts.closeTip')} /> {t('receipts.close')}
        </div>
      </div>
    </>
  );
}
