/**
 * MWST: one return per page, its Ziffern by part of the form with the result on top; a Ziffer's
 * entries or its sum on the right. A filed quarter keeps its lock, marks every Ziffer that differs
 * from what was filed, and ends with its Korrekturabrechnung (0535).
 */
import { Fragment, useEffect, useState } from 'react';
import './vat.css';
import { localToday, booksOpenPeriod, inPeriod, type Period } from '../../../accounting/periods.js';
import { salesWithoutVat } from '../../../accounting/sales-without-vat.js';
import type { Index } from '../../../types/index.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { at } from '../receipts/view.js';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { WorkflowButtons } from '../../automation/marks.js';
import { moveKey } from '../../shell/keyboard.js';
import { periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem, Nav } from '../index.js';
import {
  FORM_0535, OPEN_ITEMS, SECTIONS, amountOf, filedDiff, formAmount, rateOf, resultZiffer, sectionOf, shownZiffern, sumsOf, ratesRoundedApart, thresholdWatch, vatKeyOf, vatReturn, yearTurnover,
  type Section, type VatReturn,
} from './model.js';
import { correctionDiff, signed, useReturn, zifferLabel, headline, isPending, notFiled } from './view.js';
import { Go, entryAt } from './links.js';
import { Detail } from './Detail.js';
import { issueWords, usePeriodIssues } from '../automation/Issues.js';
import { countIssues } from '../automation/period-issues.js';
import type { ReturnFigures } from '../../../engines/return.js';
import { baseCurrency, chargesVat, filing } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'vat'>>;

const SECTION_LABEL = { turnover: 'vat.partTurnover', tax: 'vat.partTax', input: 'vat.partInput', result: 'vat.partResult' } as const satisfies Record<Section, string>;

const ALL_KEY = 'vat.allZiffern';
const readAll = () => { try { return localStorage.getItem(ALL_KEY) === '1'; } catch { return false; } };

/** The list as last shown, in ↑↓ order, and the return behind it: the keys act on it. */
const listed: { ids: string[]; v?: VatReturn } = { ids: [] };

/** The return of a registered firm; a firm not registered sees that it files none, and its turnover against the threshold. */
function List(props: Props) {
  const setup = useWorkspace()?.company.vat;
  return setup && !setup.registered ? <NotRegistered {...props} /> : <Return {...props} />;
}

/** The turnover against the threshold: «passed» from the limit on, a warning from 90 % reached or projected (r5f-9), else the figure alone. */
function NotRegistered({ period, books, canEdit }: Props) {
  const today = localToday();
  const year = period.kind === 'all' ? today.slice(0, 4) : period.from.slice(0, 4);
  const w = thresholdWatch(books.journalEntries ?? [], year, today);
  const turnover = w?.turnover ?? yearTurnover(books.journalEntries ?? [], year);
  const money = (n: number) => `${baseCurrency()} ${fmt(n)}`;
  const level = w?.level ?? 'ok';
  return (
    <div className="page">
      <ListHead period={period} books={books} canEdit={canEdit} />
      <div className="counts vst"><span>{t('vat.stateNone')}</span></div>
      <div className="notice vnovat" data-testid="not-registered">
        <span className="dot" aria-hidden="true" />
        <span>{t('vat.notRegisteredText', { threshold: w ? money(w.threshold) : '' })}</span>
      </div>
      <div className={`vresult${level === 'passed' ? ' bad' : ''}`} data-testid="year-turnover">
        <span>{t('vat.turnoverYear', { year })}</span>
        <b className="mono"><small>{baseCurrency()}</small>{fmt(turnover)}</b>
      </div>
      {w && (
        <p className={level === 'ok' ? 'm' : 'notice warn'} data-testid="threshold" data-level={level}>
          {level !== 'ok' && <span className="dot" aria-hidden="true" />}
          <span>{level === 'passed' ? t('vat.thresholdPassed', { threshold: money(w.threshold), next: String(Number(year) + 1) })
            : level === 'near' ? t('vat.thresholdNear', { turnover: money(w.turnover), percent: String(w.percent), threshold: money(w.threshold), projected: money(w.projected) })
              : t('vat.thresholdOk', { threshold: money(w.threshold) })}</span>
        </p>
      )}
    </div>
  );
}


function Return(props: Props) {
  const { route, period, books, nav, canEdit } = props;
  const { v, filed, key } = useReturn({ books, period });
  // What is still open in a return not filed: its figure is not final while any of it is (#341).
  const issues = countIssues(usePeriodIssues(books, v.period.from, v.period.to));
  const pending = isPending(v, books, issues.total);
  const [all, setAll] = useState(readAll);
  const rows = shownZiffern(v, filed, all);
  const ids = [...rows, ...(filed ? [FORM_0535] : [])];
  listed.ids = ids;
  listed.v = v;

  // A list with no Ziffer selected selects the result; so does the 0535 of a quarter not filed (a
  // period switch keeps the Ziffer). A Ziffer the form does not have stays: the detail says so.
  // The open list belongs to a return still worked on; it stays while the stores load, also when it is empty (the detail says so).
  const noForm = (route.ziffer === FORM_0535 && v.state.kind !== 'filed') || (route.ziffer === OPEN_ITEMS && !notFiled(v));
  useEffect(() => {
    if (!route.ziffer || noForm) nav.select({ area: 'vat', ziffer: resultZiffer(v) });
  }, [route.ziffer, noForm, v]);

  const toggleAll = () => {
    setAll(!all);
    try { localStorage.setItem(ALL_KEY, all ? '' : '1'); } catch { /* per viewer only */ }
  };
  const select = (n: string) => nav.select({ area: 'vat', ziffer: n });
  const corrections = v.corrections.length;
  const result = resultZiffer(v);
  const head = headline(v, filed, books);

  return (
    <div className="page">
      <ListHead period={v.period} books={books} canEdit={canEdit}>
        {v.state.kind === 'open' ? <WorkflowButtons kind="period" id={String(key)} nav={nav} canEdit={canEdit} /> : null}
      </ListHead>
      <div className="counts vst">
        {v.state.kind === 'filed' ? (
          <>
            <span>{t('vat.stateFiled')}</span>
            {corrections > 0 && <span className="warn"><span className="dot" aria-hidden="true" />{t('vat.correctionsSince', { n: corrections })}</span>}
          </>
        ) : v.state.kind === 'open' && v.state.before ? (
          <span data-testid="period-before">{v.state.before.first ? t('vat.stateBefore', { date: formatDate(v.state.before.first) }) : t('vat.stateBeforeEmpty')}</span>
        ) : v.state.kind === 'open' ? (
          <span className={v.state.overdue ? 'warn' : ''}>{t(v.state.overdue ? 'vat.stateOverdue' : 'vat.stateOpen', { date: formatDate(v.state.due) })}</span>
        ) : v.state.kind === 'running' ? (
          <span data-testid="period-running">{t('vat.stateRunning', { ends: formatDate(v.state.ends), from: formatDate(v.state.from) })}</span>
        ) : <span>{t('vat.stateOverview')}</span>}
        <EarlierOpen books={books} shown={v.period} nav={nav} />
        <button type="button" className="clink2" onClick={() => nav.go({ route: { area: 'codes' }, query: {} })}>{t('vatCodes.open')}</button>
      </div>
      <SalesWithoutVat books={books} period={period} nav={nav} />
      <button type="button" className="vresult" data-filed={head.filed || undefined} onClick={() => select(result)}>
        <span>{t(head.kind === 'credit' ? 'vat.credit' : 'vat.toPay')}{head.filed ? ` · ${t('vat.asFiled')}` : pending ? ` · ${t('vat.notFinal')}` : ''}</span>
        <b className="mono"><small>CHF</small>{fmt(head.amount)}</b>
        {head.corrected ? <span className="m" data-testid="corrected-now">{t(head.corrected.kind === 'credit' ? 'vat.nowCredit' : 'vat.nowToPay', { amount: fmt(head.corrected.amount), diff: signed(head.corrected.diff) })}</span> : null}
        {head.rounding ? <span className="m" data-testid="rounding-note">{t('vat.headRounding', { ziffern: fmt(head.rounding.ziffern) })}</span> : null}
      </button>
      {pending ? (
        <button type="button" className={`notice vpending${route.ziffer === OPEN_ITEMS ? ' sel' : ''}`} data-testid="vat-pending" aria-pressed={route.ziffer === OPEN_ITEMS} onClick={() => select(OPEN_ITEMS)}>
          <span className="dot" aria-hidden="true" />
          <span>{t('vat.pending', { period: periodName(v.period) })} {issueWords(issues).join(' · ')}. <u>{t('vat.pendingOpen')}</u></span>
        </button>
      ) : null}
      {ratesRoundedApart(v) ? <p className="m" data-testid="rate-rounding-note">{t('vat.rateRounding')}</p> : null}
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

/**
 * The page shows the period of the newest data (F10); the return the work is due on may be an
 * earlier one, not filed yet. Said as a fact beside the state, a link to that return.
 */
function EarlierOpen({ books, shown, nav }: { books: Index; shown: Period; nav: Nav }) {
  const oldest = booksOpenPeriod(books, localToday(), filing().length);
  if (shown.kind === 'all' || oldest.to >= shown.from) return null;
  const { state, period } = vatReturn(books, oldest.token);
  if (state.kind !== 'open' || state.before) return null;
  return (
    <button type="button" className={`clink2${state.overdue ? ' warn' : ''}`} data-testid="earlier-open" onClick={() => nav.go({ route: { area: 'vat' }, query: { period } })}>
      {t(state.overdue ? 'vat.earlierOverdue' : 'vat.earlierOpen', { period: periodName(period), date: formatDate(state.due) })}
    </button>
  );
}

/** The period's customer payments booked without output tax for want of an invoice, each a link to the payment. */
function SalesWithoutVat({ books, period, nav }: { books: Index; period: Period; nav: Nav }) {
  const sales = salesWithoutVat(books, useWorkspace()?.company.vat.registered ?? true).filter((s) => inPeriod(period, s.payment.date));
  if (!sales.length) return null;
  return (
    <div className="notice warn vnovat" data-testid="sales-without-vat">
      <span className="dot" aria-hidden="true" />
      <span>
        {t('sales.noVat', { n: sales.length })} {t('sales.noVatDo')}{' '}
        {sales.map(({ payment: p }, i) => (
          <Fragment key={p.ref}>{i > 0 && ', '}<Go to={at({ area: 'bank', payment: p.ref }, p.date, period)} nav={nav}>{formatDate(p.date)} · {p.currency} {fmt(p.amount)}</Go></Fragment>
        ))}
      </span>
    </div>
  );
}

function ZifferRow({ v, n, filed, sel, onSelect }: { v: VatReturn; n: string; filed?: ReturnFigures; sel: boolean; onSelect(n: string): void }) {
  const r = rateOf(v, n);
  const was = filedDiff(v, filed, n);
  const sum = n in sumsOf();
  return (
    <div className={`row${sel ? ' sel' : ''}${sum ? ' sum' : ''}${amountOf(v, n) || sum ? '' : ' zero'}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-z={n} onClick={() => onSelect(n)}>
      <span className="d mono">{n}</span>
      <span className="t">{zifferLabel(v, n)}</span>
      <span className="a mono">
        {r ? <><span className="tv">{fmt(formAmount(v, n))}</span>{fmt(r.tax)}</> : fmt(formAmount(v, n))}
        {was != null && <span className="was" data-tip={t('vat.filedValue', { amount: fmt(was) })}><span className="dot" aria-hidden="true" /></span>}
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
  dock: { key: 'm', icon: ICONS.vat, tip: () => t(!chargesVat() ? 'area.vat.tip.none' : filing().length === 'half' ? 'area.vat.tip.half' : 'area.vat.tip') },
  List,
  Detail,
  legend,
  title: (r) => r.ziffer && (r.ziffer === FORM_0535 ? t('vat.form0535') : r.ziffer === OPEN_ITEMS ? t('vat.openItems') : t('vat.zifferN', { n: r.ziffer })),
  // The return's work is in the oldest return not filed, not where the newest file is dated (#341).
  home: (books, today) => (chargesVat() ? booksOpenPeriod(books, today, filing().length) : undefined),
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
    const v = vatReturn(books, vatKeyOf(period, booksOpenPeriod(books, localToday(), filing().length)));
    return shownZiffern(v, undefined, false).map((n) => ({
      label: `${n} ${zifferLabel(v, n)}`,
      side: `${periodName(v.period)}  ${fmt(formAmount(v, n))}`,
      run: () => nav.go({ route: { area: 'vat', ziffer: n }, query: { period: v.period } }),
    }));
  },
};
