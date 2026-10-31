/**
 * The receipt's VAT in «Angaben», as the owner reads it off the paper: whether it shows the
 * country's VAT, at which rate (the jurisdiction's, from the VAT engine) and how much, and the
 * supplier's VAT number. One rate is the common case; more can be added. What she sets is hers
 * (vatBy 'human'), marked «von Hand», and the AI never reads it over.
 */
import { useEffect, useRef, useState } from 'react';
import type { Receipt, VatFacts } from '../../../types/index.js';
import { vat as vatEngine } from '../../../engines/index.js';
import { fmt } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import type { ReceiptView } from './model.js';
import { saveVat } from './actions.js';
import { I } from './icons.js';

/** `guess`: the figure was worked out from the amount here, not typed or read off the receipt. */
interface Line { rate: number; vat: string; guess?: boolean }
/** What the fields show: `on` undefined while nobody has read the receipt's VAT. */
interface Draft { on: boolean | undefined; lines: Line[]; id: string }

const parseAmount = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return s.trim() && Number.isFinite(n) ? n : null; };

/** The rates in force, and any other the receipt carries (a superseded one on an old receipt). */
function ratesFor(r: Receipt): number[] {
  const own = vatEngine().rateRows.filter((x) => x.kind === 'supply' && !x.superseded).map((x) => x.rate);
  return [...new Set([...own, ...(r.vatSummary ?? []).map((g) => g.ratePercent).filter((x) => vatEngine().isDomesticRate(x))])];
}

/** The tax a gross amount holds at `rate`, to the cent as a receipt prints it. */
export const taxIn = (amount: number | undefined, rate: number): string =>
  amount == null ? '' : fmt(Math.round(Math.abs(amount) * rate / (100 + rate) * 100) / 100);

const draftOf = (r: Receipt): Draft => ({
  on: r.hasSwissVat,
  lines: r.hasSwissVat ? (r.vatSummary ?? []).filter((g) => vatEngine().isDomesticRate(g.ratePercent)).map((g) => ({ rate: g.ratePercent, vat: fmt(g.vat) })) : [],
  id: r.vatId ?? '',
});

/**
 * The facts the fields say; undefined while they say nothing yet, 'wrong' for an amount that is no
 * number. Rates the fields do not show (0 %, a foreign VAT the AI read) stay as they were.
 */
function factsOf(d: Draft, r: Receipt): VatFacts | 'wrong' | undefined {
  if (d.on === undefined) return undefined;
  const vatId = d.id.trim() || undefined;
  const other = (r.vatSummary ?? []).filter((g) => !vatEngine().isDomesticRate(g.ratePercent));
  if (!d.on) return { hasSwissVat: false, vatSummary: other, ...(vatId && { vatId }) };
  if (!d.lines.length || d.lines.some((l) => !l.vat.trim())) return undefined;
  const amounts = d.lines.map((l) => parseAmount(l.vat));
  if (amounts.some((a) => a == null || a < 0)) return 'wrong';
  // A rate she left as read keeps what the AI read beside it (net, gross).
  const vatSummary = d.lines.map((l, i) => r.vatSummary?.find((g) => g.ratePercent === l.rate && g.vat === amounts[i]) ?? { ratePercent: l.rate, vat: amounts[i]! });
  return { hasSwissVat: true, vatSummary: [...vatSummary, ...other], ...(vatId && { vatId }) };
}

const key = (f: Pick<Receipt, 'hasSwissVat' | 'vatSummary' | 'vatId'>) =>
  JSON.stringify([f.hasSwissVat, (f.vatSummary ?? []).map((g) => [g.ratePercent, g.vat]).sort((a, b) => a[0] - b[0]), f.vatId ?? '']);

export function ByHand() {
  return <span className="byhand" data-tip={t('receipts.byHandTip')}>{t('receipts.byHand')}</span>;
}

export function VatFields({ v, nav, edit, title }: { v: ReceiptView; nav: Nav; edit: boolean; title?: string }) {
  const { r } = v;
  const [d, setD] = useState(() => draftOf(r));
  const [err, setErr] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const rates = ratesFor(r);

  // A receipt saved, undone or read again shows its facts, unless she changed the fields and the change is not saved yet: what she typed stays.
  const shown = useRef(key(r));
  useEffect(() => {
    const was = shown.current;
    shown.current = key(r);
    setD((cur) => {
      const f = factsOf(cur, r);
      const typed = !f || f === 'wrong' || key(f) !== was;
      return f && f !== 'wrong' && key(f) === key(r) ? cur : typed && box.current?.contains(document.activeElement) ? cur : draftOf(r);
    });
  }, [key(r)]);

  function commit(next: Draft) {
    const f = factsOf(next, r);
    setD(f && f !== 'wrong' && f.hasSwissVat ? { ...next, lines: next.lines.map((l, i) => ({ ...l, vat: fmt(f.vatSummary[i].vat) })) } : next);
    setErr(f === 'wrong' ? t('receipts.errVat') : '');
    if (!f || f === 'wrong' || key(f) === key(r)) return;
    void saveVat(nav, v, f);
  }

  const choose = (on: boolean) => commit({ ...d, on, lines: on && !d.lines.length ? [{ rate: rates[0], vat: taxIn(r.amount, rates[0]), guess: r.amount != null }] : d.lines });
  const line = (i: number, l: Partial<Line>) => ({ ...d, lines: d.lines.map((x, j) => (j === i ? { ...x, ...l } : x)) });
  /** A new rate takes its share of the amount when the old figure was the old rate's share (or empty). */
  const rateOf = (i: number, rate: number) => {
    const was = d.lines[i];
    const derived = d.lines.length === 1 && r.amount != null && (!was.vat.trim() || was.guess);
    commit(line(i, { rate, ...(derived && { vat: taxIn(r.amount, rate), guess: true }) }));
  };
  const free = rates.find((x) => !d.lines.some((l) => l.rate === x));
  /**
   * The two radios are one Tab stop (treuhaender-6): ←/→ (↑/↓) choose the other, Space or Enter the
   * focused one, so the area's keys (Space: the quick view) never take them.
   */
  function onRadioKey(e: React.KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (!edit || el.getAttribute('role') !== 'radio') return;
    const focused = el.dataset.on === 'true';
    let next: boolean | undefined;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) next = !focused;
    else if (e.key === ' ' || e.key === 'Enter') next = focused;
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (d.on !== next) choose(next);
    (el.parentElement?.querySelector(`[data-on="${next}"]`) as HTMLElement | null)?.focus();
  }
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(d); } };

  return (
    <div className="vatf" ref={box} role="group" aria-label={t('receipts.field.vat')} data-tip={title}>
      <div className="lbl">{t('receipts.field.vat')}{r.vatBy === 'human' && <ByHand />}</div>
      <span className="seg2" role="radiogroup" aria-label={t('receipts.field.vat')} onKeyDown={onRadioKey}>
        {([false, true] as const).map((on) => (
          <button key={String(on)} type="button" role="radio" aria-checked={d.on === on} className={d.on === on ? 'on' : ''} disabled={!edit}
            tabIndex={(d.on ?? false) === on ? 0 : -1} data-on={String(on)} onClick={() => d.on !== on && choose(on)}>
            {t(on ? 'receipts.vatYes' : 'receipts.vatNone')}
          </button>
        ))}
      </span>
      {d.on && d.lines.map((l, i) => (
        <div className="vline" key={i}>
          <select aria-label={t('receipts.vatRate')} value={l.rate} disabled={!edit} onChange={(e) => rateOf(i, Number(e.target.value))}>
            {rates.filter((x) => x === l.rate || !d.lines.some((o) => o.rate === x)).map((x) => <option key={x} value={x}>{t('receipts.ratePct', { rate: x })}</option>)}
          </select>
          <input className="mono" aria-label={t('receipts.vatAmount')} value={l.vat} readOnly={!edit} style={{ textAlign: 'right' }}
            onChange={(e) => setD(line(i, { vat: e.target.value, guess: false }))} onBlur={() => commit(d)} onKeyDown={onEnter} />
          {edit && d.lines.length > 1
            ? <button type="button" className="rm" aria-label={t('receipts.vatRemoveRate')} onClick={() => commit({ ...d, lines: d.lines.filter((_, j) => j !== i) })}>×</button>
            : <span />}
        </div>
      ))}
      {err && <div className="err" role="alert">{err}</div>}
      {edit && d.on && d.lines.length === 1 && d.lines[0].guess && <div className="fhint">{t('receipts.vatFromAmount')}</div>}
      {d.on && edit && free !== undefined && (
        <button type="button" className="addlink" onClick={() => commit({ ...d, lines: [...d.lines, { rate: free, vat: '' }] })}>{I.plus}{t('receipts.vatAddRate')}</button>
      )}
      {d.on !== undefined && (
        <label>{t('receipts.vatId')}
          <input className="mono" value={d.id} readOnly={!edit} onChange={(e) => setD({ ...d, id: e.target.value })} onBlur={() => commit(d)} onKeyDown={onEnter} />
        </label>
      )}
    </div>
  );
}
