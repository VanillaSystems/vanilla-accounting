/**
 * MWST: one return per page, its Ziffern by part of the form with the result on top; a Ziffer's
 * entries or its sum on the right. A filed quarter keeps its lock, marks every Ziffer that differs
 * from what was filed, and ends with its Korrekturabrechnung (0535).
 */
import { Fragment, useEffect, useState } from 'react';
import './vat.css';
import type { ReturnFigures } from '../../../accounting/index.js';
import { localToday, openQuarter } from '../../../accounting/periods.js';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { moveKey } from '../../shell/keyboard.js';
import { periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import {
  FORM_0535, SECTIONS, SUMS, amountOf, filedDiff, formAmount, rateOf, resultZiffer, sectionOf, shownZiffern, vatKeyOf, vatReturn,
  type Section, type VatReturn,
} from './model.js';
import { correctionDiff, signed, useReturn, zifferLabel } from './view.js';
import { entryAt } from './links.js';
import { Detail } from './Detail.js';

type Props = AreaProps<RouteOf<'vat'>>;

const SECTION_LABEL = { turnover: 'vat.partTurnover', tax: 'vat.partTax', input: 'vat.partInput', result: 'vat.partResult' } as const satisfies Record<Section, string>;

const ALL_KEY = 'vat.allZiffern';
const readAll = () => { try { return localStorage.getItem(ALL_KEY) === '1'; } catch { return false; } };

/** The list as last shown, in ↑↓ order, and the return behind it: the keys act on it. */
const listed: { ids: string[]; v?: VatReturn } = { ids: [] };

function List({ route, period, books, nav, canEdit }: Props) {
  const { v, filed } = useReturn({ books, period });
  const [all, setAll] = useState(readAll);
  const rows = shownZiffern(v, filed, all);
  const ids = [...rows, ...(filed ? [FORM_0535] : [])];
  listed.ids = ids;
  listed.v = v;

  // A list with no Ziffer selected selects the result; so does a Ziffer the form does not have.
  const known = route.ziffer === FORM_0535 ? v.state.kind === 'filed' : v.report.ziffern.some((z) => z.number === route.ziffer);
  useEffect(() => {
    if (!route.ziffer || !known) nav.select({ area: 'vat', ziffer: resultZiffer(v) });
  }, [route.ziffer, known, v]);

  const toggleAll = () => {
    setAll(!all);
    try { localStorage.setItem(ALL_KEY, all ? '' : '1'); } catch { /* per viewer only */ }
  };
  const select = (n: string) => nav.select({ area: 'vat', ziffer: n });
  const corrections = v.corrections.length;
  const result = resultZiffer(v);

  return (
    <div className="page">
      <ListHead route={route} period={v.period} books={books} canEdit={canEdit} />
      <div className="counts vst">
        {v.state.kind === 'filed' ? (
          <>
            <span>{t('vat.stateFiled')}</span>
            {corrections > 0 && <span className="warn"><span className="dot" aria-hidden="true" />{t('vat.correctionsSince', { n: corrections })}</span>}
          </>
        ) : v.state.kind === 'open' ? (
          <span className={v.state.overdue ? 'warn' : ''}>{t(v.state.overdue ? 'vat.stateOverdue' : 'vat.stateOpen', { date: formatDate(v.state.due) })}</span>
        ) : <span>{t('vat.stateOverview')}</span>}
        <button type="button" className="clink2" onClick={() => nav.go({ route: { area: 'codes' }, query: {} })}>{t('vatCodes.open')}</button>
      </div>
      <button type="button" className="vresult" onClick={() => select(result)}>
        <span>{t(result === '510' ? 'vat.credit' : 'vat.toPay')}</span>
        <b className="mono"><small>CHF</small>{fmt(v.report.credit || v.report.toPay)}</b>
      </button>
      <div className="rows vz" role="listbox" aria-label={t('vat.ziffern')}>
        {SECTIONS.map((s) => {
          const ns = rows.filter((n) => sectionOf(Number(n)) === s);
          if (!ns.length) return null;
          return (
            <Fragment key={s}>
              <div className="group"><span>{t(SECTION_LABEL[s])}</span>{s === 'tax' && <span className="cap2">{t('vat.turnoverTax')}</span>}</div>
              {ns.map((n) => <ZifferRow key={n} v={v} n={n} filed={filed} sel={n === route.ziffer} onSelect={select} />)}
            </Fragment>
          );
        })}
        {filed && (
          <>
            <div className="group"><span>{t('vat.partCorrection')}</span></div>
            <div className={`row sum${route.ziffer === FORM_0535 ? ' sel' : ''}`} role="option" aria-selected={route.ziffer === FORM_0535} tabIndex={route.ziffer === FORM_0535 ? 0 : -1} data-z={FORM_0535} onClick={() => select(FORM_0535)}>
              <span className="d mono">{FORM_0535}</span>
              <span className="t">{t('vat.form0535')}</span>
              <span className="a mono">{signed(correctionDiff(books, filed))}</span>
            </div>
          </>
        )}
      </div>
      <div className="hidden-note"><button type="button" onClick={toggleAll}>{all ? t('vat.hideEmpty') : t('vat.showAll')}</button></div>
    </div>
  );
}


function ZifferRow({ v, n, filed, sel, onSelect }: { v: VatReturn; n: string; filed?: ReturnFigures; sel: boolean; onSelect(n: string): void }) {
  const r = rateOf(v, n);
  const was = filedDiff(v, filed, n);
  const sum = n in SUMS;
  return (
    <div className={`row${sel ? ' sel' : ''}${sum ? ' sum' : ''}${amountOf(v, n) || sum ? '' : ' zero'}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-z={n} onClick={() => onSelect(n)}>
      <span className="d mono">{n}</span>
      <span className="t">{zifferLabel(v, n)}</span>
      <span className="a mono">
        {r ? <><span className="tv">{fmt(r.row.kind === 'supply' ? r.base + r.tax : r.base)}</span>{fmt(r.tax)}</> : fmt(formAmount(v, n))}
        {was != null && <span className="was" title={t('vat.filedValue', { amount: fmt(was) })}><span className="dot" aria-hidden="true" /></span>}
      </span>
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('vat.keyZiffer'), t('vat.keyZifferTip')],
  [['↵'], t('vat.keyEntry'), t('vat.keyEntryTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const vat: Area<RouteOf<'vat'>> = {
  id: 'vat',
  label: () => t('area.vat'),
  dock: { key: 'm', icon: ICONS.vat, tip: () => t('area.vat.tip') },
  List,
  Detail,
  legend,
  title: (r) => r.ziffer && (r.ziffer === FORM_0535 ? t('vat.form0535') : t('vat.zifferN', { n: r.ziffer })),
  keys(e, p) {
    const d = moveKey(e);
    if (d) {
      const i = p.route.ziffer ? listed.ids.indexOf(p.route.ziffer) : -1;
      const next = listed.ids[Math.min(listed.ids.length - 1, Math.max(0, i + d))];
      if (next) p.nav.select({ area: 'vat', ziffer: next });
      return true;
    }
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || !p.route.ziffer || !listed.v) return false;
    const first = listed.v.lines[p.route.ziffer]?.[0];
    if (!first) return false;
    p.nav.go(entryAt(first.entry, p.period));
    return true;
  },
  palette: ({ books, nav, period }) => {
    const v = vatReturn(books, vatKeyOf(period, openQuarter(books.config?.closedThrough, localToday())));
    return shownZiffern(v, undefined, false).map((n) => ({
      label: `${n} ${zifferLabel(v, n)}`,
      side: `${periodName(v.period)}  ${fmt(formAmount(v, n))}`,
      run: () => nav.go({ route: { area: 'vat', ziffer: n }, query: { period: v.period } }),
    }));
  },
};
