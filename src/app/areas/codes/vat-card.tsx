/**
 * A VAT code explained where it is booked. Any element with `data-vat="<code>"` shows the hover
 * card (after a short rest, or on focus): what the code means, its rate, its Ziffern, how many
 * entries carry it, and links to its explanation, to only its entries, and to the histogram of all
 * codes. A page that shows codes renders <VatCards> once; Buchungen, MWST and the catalogue do.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { vat } from '../../../engines/index.js';
import { lookupVatCode, vatCodeRateName, type VatCodeEntry } from '../../../accounting/vat-codes.js';
import { accountingName, isKey, t, tWith } from '../../i18n/index.js';
import { periodName } from '../../lib/period-label.js';
import { fmt } from '../../lib/utils.js';
import type { AreaProps } from '../index.js';
import { NO_VAT, codeExplanation, ownNetRate, vatStats, type CodeStat, type CodeExplanation, type Words } from './model.js';
import { setCodesUi, useCodesUi } from './state.js';
import './codes.css';

export const kindName = (e: VatCodeEntry) => t(`vatCodes.kind.${e.kind}.name`);

/** A code as the person reads it: the firm's own rate («1. Saldosteuersatz (Schreinerei) 4.5 %», r6f-25), else the code list's text, else what kind of code it is. */
export const codeText = (code: string): string => {
  const x = codeExplanation(code);
  if (x.own) return explainedName(x);
  const found = lookupVatCode(code);
  return found ? found.entry.bananaText ?? kindName(found.entry) : t('vatCodes.unknown');
};

/** The words of an explanation, rendered. */
export const words = (w: Words): string => tWith(w.key, w.vars ?? {});

/** The code's name for the firm: its own rate with its percent, else the catalogue's kind. */
export const explainedName = (x: CodeExplanation): string => (x.own ? `${accountingName(x.own.name)} ${x.own.rate} %` : words(x.name));

/** "Vorsteuer auf Investitionen/übrigem Betriebsaufwand"; a rate row: "Normalsatz 8.1 %". */
export function zifferName(z: string): string {
  const key = `vat.z${z}`;
  if (isKey(key)) return t(key as 'vat.z200');
  const row = vat().rateRows.find((r) => r.ziffer === z);
  return row ? `${accountingName(row.name)} ${row.rate} %` : t('vat.ziffer', { ziffer: z });
}

export const rateOf = (e: VatCodeEntry) => { const own = ownNetRate(e.code); return own ? `${own.rate} %` : e.rate ? `${e.rate} %` : '0 %'; };

export const amountText = (e: VatCodeEntry) =>
  t(e.amountIs === 'tax' ? 'vatCodes.amountTax' : e.amountIs === 'net' ? 'vatCodes.amountNet' : 'vatCodes.amountGross');

export const rateName = (e: VatCodeEntry) => (e.rate ? accountingName(vatCodeRateName(e.rate) ?? '') : '');

/** To the catalogue's page of a code. */
export function explain(p: AreaProps, code: string) {
  p.nav.go({ route: { area: 'codes', code }, query: { period: p.query.period } });
}

/** To Buchungen with only the entries of this code (NO_VAT: those without one). */
export function showOnly(p: AreaProps, code: string) {
  setCodesUi({ histogram: false });
  p.nav.go({ route: { area: 'journal' }, query: { period: p.query.period, vat: code } });
}

interface Shown { code: string; rect: DOMRect }

export function VatCards(p: AreaProps) {
  const [shown, setShown] = useState<Shown | null>(null);
  const timers = useRef({ show: 0, hide: 0 });
  const ui = useCodesUi();

  useEffect(() => {
    const t0 = timers.current;
    const target = (e: Event) => (e.target as Element | null)?.closest?.<HTMLElement>('[data-vat]');
    const hide = () => { clearTimeout(t0.show); clearTimeout(t0.hide); t0.hide = window.setTimeout(() => setShown(null), 220); };
    const show = (el: HTMLElement, delay: number) => {
      clearTimeout(t0.show); clearTimeout(t0.hide);
      t0.show = window.setTimeout(() => { if (el.isConnected) setShown({ code: el.dataset.vat!, rect: el.getBoundingClientRect() }); }, delay);
    };
    const over = (e: MouseEvent) => { const el = target(e); if (el && !el.contains(e.relatedTarget as Node | null)) show(el, 280); };
    const out = (e: MouseEvent) => { const el = target(e); if (el && !el.contains(e.relatedTarget as Node | null)) hide(); };
    const focus = (e: FocusEvent) => { const el = target(e); if (el) show(el, 0); };
    document.addEventListener('mouseover', over);
    document.addEventListener('mouseout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', out as unknown as (e: FocusEvent) => void);
    return () => {
      document.removeEventListener('mouseover', over);
      document.removeEventListener('mouseout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', out as unknown as (e: FocusEvent) => void);
      clearTimeout(t0.show); clearTimeout(t0.hide);
    };
  }, []);

  // A route change (a click in the card, a key) leaves the card behind otherwise.
  useEffect(() => setShown(null), [p.route, p.query]);

  return (
    <>
      {shown && (
        <Card
          {...p}
          shown={shown}
          onEnter={() => clearTimeout(timers.current.hide)}
          onLeave={() => { timers.current.hide = window.setTimeout(() => setShown(null), 220); }}
          onDone={() => setShown(null)}
        />
      )}
      {ui.histogram && <Histogram {...p} />}
    </>
  );
}

function Card(p: AreaProps & { shown: Shown; onEnter(): void; onLeave(): void; onDone(): void }) {
  const { shown: { code, rect }, books, period } = p;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const found = lookupVatCode(code);
  const stat = useMemo(() => vatStats(books.journalEntries ?? [], period).find((s) => s.code === code), [books, period, code]);

  useEffect(() => {
    const c = ref.current!;
    // The anchor's rect is in zoomed pixels, the card's position in page pixels.
    const z = Number(document.documentElement.style.zoom) || 1;
    const left = Math.max(16, Math.min(rect.left / z - 20, innerWidth / z - c.offsetWidth - 16));
    const below = rect.bottom / z + 8;
    setPos({ left, top: below + c.offsetHeight > innerHeight / z - 16 ? rect.top / z - c.offsetHeight - 8 : below });
  }, [rect]);

  const act = (run: () => void) => () => { p.onDone(); run(); };
  const e = found?.entry;
  return createPortal(
    <div
      ref={ref}
      className="vcard"
      role="tooltip"
      data-testid="vat-card"
      style={pos ?? { visibility: 'hidden' }}
      onMouseEnter={p.onEnter}
      onMouseLeave={p.onLeave}
    >
      <div className="vh"><span className="mono code">{code}</span><span className="mono rate">{e ? rateOf(e) : ''}</span></div>
      <p>{found?.negative && <><b>{t('codes.reversed')}</b> {t('codes.reversedText', { code: e!.code })} </>}{codeText(code)}</p>
      {e && codeExplanation(code).ziffern?.length
        ? <dl>{codeExplanation(code).ziffern!.map((z) => <div key={z} style={{ display: 'contents' }}><dt className="mono">{z}</dt><dd>{zifferName(z)}</dd></div>)}</dl>
        : <p className="m">{!e || codeExplanation(code).ziffern === null ? t('vatCodes.notDeclared') : t('codes.noZiffer')}</p>}
      {e?.rate ? <p className="m">{amountText(e)}</p> : null}
      <div className="vf">
        <span className="m">{stat ? t('codes.entriesIn', { n: stat.n, period: periodName(period) }) : t('codes.noEntriesIn', { period: periodName(period) })}</span>
        <button type="button" onClick={act(() => explain(p, code))}>{t('codes.explain')}</button>
        {stat && <button type="button" onClick={act(() => showOnly(p, code))}>{t('codes.only')}</button>}
        <button type="button" onClick={act(() => setCodesUi({ histogram: true }))}>{t('codes.histogram')}</button>
      </div>
    </div>,
    document.body,
  );
}

function Histogram(p: AreaProps) {
  const { books, period } = p;
  const [by, setBy] = useState<'n' | 'chf'>('n');
  const [idx, setIdx] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const size = (s: CodeStat) => (by === 'n' ? s.n : Math.abs(s.chf));
  const xs = useMemo(() => vatStats(books.journalEntries ?? [], period).sort((a, b) => size(b) - size(a)), [books, period, by]);
  const max = Math.max(1, ...xs.map(size));
  const total = xs.reduce((s, x) => s + x.n, 0);
  const at = Math.min(idx, xs.length - 1);
  const close = () => setCodesUi({ histogram: false });

  useEffect(() => { box.current?.focus(); }, []);
  useEffect(() => { box.current?.querySelector('.hr.on')?.scrollIntoView({ block: 'nearest' }); }, [at, by]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'j', 'k'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'j') setIdx(Math.min(xs.length - 1, at + 1));
    if (e.key === 'ArrowUp' || e.key === 'k') setIdx(Math.max(0, at - 1));
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && xs[at]) showOnly(p, xs[at].code);
  }

  return (
    <>
      <div className="scrim" onClick={close} />
      <div ref={box} className="palette vhist" role="dialog" aria-label={t('codes.histogramTitle')} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="ctx">
          <div><span className="lbl">{t('codes.histogramLabel', { period: periodName(period) })}</span>{t('codes.nEntries', { n: total })}, {t('codes.nCodes', { n: xs.length })}</div>
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={by === 'n'} className={by === 'n' ? 'on' : ''} onClick={() => setBy('n')}>{t('codes.byCount')}</button>
            <button type="button" role="tab" aria-selected={by === 'chf'} className={by === 'chf' ? 'on' : ''} onClick={() => setBy('chf')}>{t('codes.byChf')}</button>
          </div>
        </div>
        <div className="res" role="listbox">
          {xs.map((x, i) => {
            const none = x.code === NO_VAT;
            const text = none ? t('codes.noVat') : codeText(x.code);
            return (
              <div key={x.code} className={`o hr${i === at ? ' on' : ''}`} role="option" aria-selected={i === at} data-tip={none ? t('codes.noVatTip') : text} data-code={x.code} onMouseMove={() => i !== at && setIdx(i)} onClick={() => showOnly(p, x.code)}>
                <span className="mono code">{none ? '·' : <button type="button" className="clink" data-tip={t('codes.explainCode', { code: x.code })} onClick={(e) => { e.stopPropagation(); close(); explain(p, x.code); }}>{x.code}</button>}</span>
                <span className="bar"><i style={{ width: `${(size(x) / max * 100).toFixed(1)}%` }} /><em>{text}</em></span>
                <span className="mono num">{x.n}</span>
                <span className="mono num">{fmt(x.chf)}</span>
                <span className="mono num tax">{x.tax ? fmt(x.tax) : ''}</span>
              </div>
            );
          })}
        </div>
        <div className="foot">
          <span className="mono">{t('codes.histogramColumns')}</span>
          <span>
            <span className="k" data-tip={t('codes.pickTip')}><span className="cap">↑</span><span className="cap">↓</span></span> {t('codes.pick')}{' '}
            <span className="k" data-tip={t('codes.showTip')}><span className="cap">↵</span></span> {t('codes.show')}{' '}
            <span className="k" data-tip={t('common.close')}><span className="cap">{t('codes.escKey')}</span></span>
          </span>
        </div>
      </div>
    </>
  );
}
