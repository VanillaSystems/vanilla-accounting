/**
 * Zahlung verknüpfen: the payments ranked for this receipt (best first), a search over all of
 * them, and "paid privately or in cash" last. ↑↓ pick, ↵ links the picked row (with nothing
 * picked it only picks the first: a stray ↵ links nothing, r8h-21), Esc closes. The chosen payment
 * says when its amount is off the receipt's, before it is linked; a collective payment's row names
 * the part that pays the receipt (r8k-5). A receipt that has a payment says so at the top, and a
 * second payment is linked only after ↵ a second time. «Privat oder bar bezahlt» opens its form
 * (PrivateForm): the whole receipt or only its business part (#87). A payment of a filed quarter is marked:
 * ↵ on it opens its correction in the open quarter and links nothing (corner-33).
 */
import { useMemo, useState } from 'react';
import type { RouteOf } from '../../shell/route.js';
import { useFx } from '../../hooks/use-fx.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import type { BankTransaction } from '../../../types/index.js';
import { candidates, chfOf, linkKey, type Candidate, type Ledger, type ReceiptView } from './model.js';
import { bankOf, dayText, fitText, signed, txLine } from './view.js';
import { correctFiled, linkPayment } from './actions.js';
import { PrivateForm } from './PrivateForm.js';
import { Kbd } from './commands.js';
import { withoutInputTax, baseCurrency } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'receipts'>> & { v: ReceiptView; l: Ledger; onClose(): void };

function why(c: Candidate): string {
  return [
    c.part ? t('receipts.whyPart', { amount: `${c.part.currency} ${fmt(Math.abs(c.part.amount))}`, who: c.part.counterparty })
      : c.sameAmount ? t('receipts.whySameAmount') : c.otherCurrency ? t('receipts.whyAccount', { currency: c.tx.currency }) : '',
    c.fit?.kind === 'skonto' ? fitText(c.fit) : '',
    c.days !== undefined ? dayText(c.days) : '',
    c.taken ? t('receipts.whyTaken', { n: c.taken }) : '',
    c.filed ? t(noCorrection(c) ? 'receipts.whyFiledNoInputTax' : 'receipts.whyFiled') : '',
  ].filter(Boolean).join(' · ');
}

/** A payment of a filed period in a firm without input tax (r8f-34): a receipt changes nothing on it, there is no input tax to claim in a correction. */
const noCorrection = (c: Candidate): boolean => !!c.filed && !!withoutInputTax() && c.tx.direction === 'DBIT';

export function LinkDialog({ v, l, nav, books, onClose }: Props) {
  const { r } = v;
  const { rates } = useFx();
  const owner = useWorkspace()?.bankAccounts.find((b) => b.bank === 'manual')?.account;
  const [q, setQ] = useState('');
  /** undefined: nothing picked yet; ↓ or ↵ picks the first row. */
  const [idx, setIdx] = useState<number | undefined>();
  /** A second payment for a receipt that has one: picked once, linked on the next ↵ or click. */
  const [second, setSecond] = useState<Candidate>();
  /** «Privat oder bar bezahlt» picked: its form replaces the list. */
  const [privately, setPrivately] = useState(false);
  const { best, more } = useMemo(() => candidates(v, l, chfOf(rates), q), [v, l, rates, q]);
  const items: Array<Candidate | 'private'> = [...best, ...more, 'private'];
  const at = idx === undefined ? -1 : Math.min(idx, items.length - 1);
  const paid = v.links.map((ref) => l.txByRef.get(ref)).filter((tx): tx is BankTransaction => !!tx);

  function choose(item: Candidate | 'private' | undefined) {
    if (!item) return;
    if (item === 'private') { setPrivately(true); return; }
    if (noCorrection(item)) return;
    if (item.filed) { onClose(); correctFiled(nav, books, l, item.tx.ref, r.id); return; }
    if (paid.length && second !== item) { setSecond(item); return; }
    onClose();
    linkPayment(nav, v, item.tx.ref, txLine(item.tx), item.fit, paid.length > 0);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const k = linkKey(idx, e.key, items.length);
    if (!k) return;
    e.preventDefault();
    if (k.kind === 'close') { e.stopPropagation(); onClose(); }
    else if (k.kind === 'pick') { setIdx(k.idx); setSecond(undefined); }
    else choose(items[k.idx]);
  }
  const pick = (i: number) => { if (i !== at) { setIdx(i); setSecond(undefined); } };

  let k = 0;
  const row = (c: Candidate) => {
    const i = k++;
    const w = why(c);
    return (
      <div key={c.tx.ref} className={`o tx2${i === at ? ' on' : ''}${c.filed ? ' filed' : ''}`} role="option" aria-selected={i === at} data-ref={c.tx.ref} data-filed={c.filed ? '' : undefined} onMouseMove={() => pick(i)} onClick={() => choose(c)}>
        <span className="d mono">{formatDate(c.tx.date)}</span>
        <span className="t"><span>{c.tx.description}</span><small>{bankOf(c.tx)}{w && ` · ${w}`}{i === at && c.fit?.kind === 'off' && <> · <b className="off">{fitText(c.fit)}</b></>}</small></span>
        <span className="a mono">{c.tx.currency !== baseCurrency() && <i>{c.tx.currency}</i>}{fmt(signed(c.tx))}</span>
      </div>
    );
  };
  const privateAt = k + best.length + more.length;
  const picked = at >= 0 ? items[at] : undefined;
  const enterDoes = at < 0 ? t('receipts.pickFirst')
    : picked !== 'private' && picked && noCorrection(picked) ? t('receipts.noCorrection')
      : picked !== 'private' && picked?.filed ? t('receipts.toCorrection')
      : second && second === picked ? t('receipts.confirmVerb') : t('receipts.linkVerbShort');

  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 40%, transparent)' }} onClick={onClose} />
      <div className="palette linkdlg" role="dialog" aria-label={t('receipts.linkPayment')}>
        <div className="ctx">
          <div><span className="lbl">{t('receipts.linkPayment')}</span><b>{v.vendor}</b> <span className="m">{v.desc}</span></div>
          <div className="mono">{v.date ? formatDate(v.date) : t('receipts.noDate')} · <b>{r.currency || baseCurrency()} {r.amount != null ? fmt(r.amount) : '—'}</b></div>
        </div>
        {paid.length > 0 && (
          <p className="warnline" data-testid="has-payment" style={{ margin: '8px 20px 0' }}>
            {second ? t('receipts.secondPaymentAsk', { what: txLine(second.tx) }) : t('receipts.hasPaymentAlready', { what: paid.map(txLine).join(', ') })}
          </p>
        )}
        {privately ? <PrivateForm v={v} nav={nav} onBack={() => setPrivately(false)} onDone={onClose} /> : <>
        <input autoFocus value={q} placeholder={t('receipts.linkSearch')} aria-label={t('receipts.linkSearch')} autoComplete="off" onChange={(e) => { setQ(e.target.value); setIdx(undefined); setSecond(undefined); }} onKeyDown={onKeyDown} />
        <div className="res" role="listbox">
          {best.length > 0 && <div className="gh">{t('receipts.bestFit')}</div>}
          {best.map(row)}
          {more.length > 0 && <div className="gh">{q ? t('receipts.hits') : t('receipts.morePayments')}</div>}
          {more.map(row)}
          {!best.length && !more.length && <div className="none">{q ? t('receipts.noPaymentFits', { q }) : t('receipts.noOpenPayment')}</div>}
          <div className="gh">{t('receipts.withoutBank')}</div>
          <div className={`o tx2${privateAt === at ? ' on' : ''}`} role="option" aria-selected={privateAt === at} data-ref="private" onMouseMove={() => pick(privateAt)} onClick={() => choose('private')}>
            <span className="d mono">{owner}</span>
            <span className="t"><span>{t('receipts.privatePaid')}</span><small>{t('receipts.privatePaidHint')}</small></span>
            <span className="a" />
          </div>
        </div>
        <div className="foot">
          <Kbd keys={['↑', '↓']} tip={t('receipts.pickTip')} /> {t('keys.select')}
          <Kbd keys={['↵']} tip={t('receipts.linkTip')} /> {enterDoes}
          <Kbd keys={[t('receipts.escKey')]} tip={t('receipts.closeTip')} /> {t('receipts.close')}
        </div>
        </>}
      </div>
    </>
  );
}
