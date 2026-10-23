/**
 * «Privat oder bar bezahlt» in the link dialog (#87): the whole receipt, or only its business part
 * (an amount in the receipt's currency and what it was); a receipt that shows several Swiss VAT
 * rates asks the rate line the part falls under. A booking by hand that books the receipt already
 * holds the payment; the form names it and offers to replace it. ↵ books, Esc goes back to the list.
 */
import { useState } from 'react';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { baseCurrency, vat } from '../../../engines/index.js';
import type { PrivatePart } from '../../../types/assistant.js';
import type { Nav } from '../index.js';
import type { ReceiptView } from './model.js';
import { privateOutlay, type HeldByHand } from './actions.js';

/** A typed amount: «17.99», «17,99», «1'250.50». */
const parseAmount = (s: string): number => Number(s.replace(/['’\s]/g, '').replace(',', '.'));

export function PrivateForm({ v, nav, onBack, onDone }: { v: ReceiptView; nav: Nav; onBack(): void; onDone(): void }) {
  const { r } = v;
  const currency = r.currency || baseCurrency();
  const total = Math.abs(r.amount ?? 0);
  const rates = r.hasSwissVat ? [...new Set((r.vatSummary ?? []).map((g) => g.ratePercent).filter((x) => x > 0 && vat().isDomesticRate(x)))].sort((a, b) => a - b) : [];
  const [whole, setWhole] = useState(true);
  const [amount, setAmount] = useState('');
  const [what, setWhat] = useState('');
  const [rate, setRate] = useState<number>();
  const [held, setHeld] = useState<HeldByHand>();
  const value = parseAmount(amount);
  const fits = whole || (value > 0 && value <= total);
  const needsRate = !whole && rates.length > 1 && value < total;
  const ready = fits && (!needsRate || rate !== undefined);

  async function book(replace?: string) {
    if (!ready) return;
    const part: PrivatePart = {
      ...(!whole && { amount: value, ...(what.trim() && { part: what.trim() }), ...(needsRate && { rate }) }),
      ...(replace && { replace }),
    };
    if (await privateOutlay(nav, v, part, setHeld)) onDone();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onBack(); }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLSelectElement)) { e.preventDefault(); void book(held?.entry); }
  }

  return (
    <div className="privform" role="group" aria-label={t('receipts.privatePaid')} onKeyDown={onKeyDown}>
      <div className="lbl">{t('receipts.privatePaid')}</div>
      <label className="opt">
        <input type="radio" name="privpart" checked={whole} onChange={() => { setWhole(true); setHeld(undefined); }} autoFocus />
        <span>{t('receipts.privateWhole')}</span>
        <b className="mono">{currency} {fmt(total)}</b>
      </label>
      <label className="opt">
        <input type="radio" name="privpart" checked={!whole} onChange={() => { setWhole(false); setHeld(undefined); }} />
        <span>{t('receipts.privatePart')}</span>
        <span className="part" onClick={() => setWhole(false)}>
          <input className="mono amt" inputMode="decimal" aria-label={t('receipts.privatePartAmount')} placeholder="0.00" value={amount} onFocus={() => setWhole(false)} onChange={(e) => { setAmount(e.target.value); setHeld(undefined); }} />
          <span className="m">{currency}</span>
          <span>{t('receipts.privatePartFor')}</span>
          <input className="what" aria-label={t('receipts.privatePartWhat')} placeholder={t('receipts.privatePartWhatHint')} maxLength={80} value={what} onFocus={() => setWhole(false)} onChange={(e) => setWhat(e.target.value)} />
        </span>
      </label>
      {needsRate && (
        <label className="opt rate">
          <span>{t('receipts.privatePartRate')}</span>
          <select aria-label={t('receipts.privatePartRate')} value={rate ?? ''} onChange={(e) => setRate(e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">{t('receipts.privatePartRatePick')}</option>
            {rates.map((x) => <option key={x} value={x}>{x} %</option>)}
          </select>
        </label>
      )}
      <p className="hint">{whole ? t('receipts.privatePaidHint') : t('receipts.privatePartHint')}</p>
      {!fits && amount.trim() !== '' && <p className="warnline" data-testid="part-too-much">{t('error.partAmount', { total: `${currency} ${fmt(total)}` })}</p>}
      {held && (
        <p className="warnline" data-testid="booked-by-hand">
          {t('error.bookedByHand', { entry: held.entry, date: formatDate(held.date), amount: `${held.currency} ${fmt(held.amount)}` })}
        </p>
      )}
      <div className="acts">
        <button type="button" className="btn ghost" onClick={onBack}>{t('receipts.privateBack')} <span className="k">{t('receipts.escKey')}</span></button>
        <button type="button" className="btn primary" disabled={!ready} data-testid="private-book" onClick={() => void book(held?.entry)}>
          {held ? t('receipts.privateReplace', { entry: held.entry }) : t('receipts.privateBook')} <span className="k">↵</span>
        </button>
      </div>
    </div>
  );
}
