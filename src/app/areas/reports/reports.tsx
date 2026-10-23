/**
 * Bilanz & ER: Erfolgsrechnung, Bilanz and Saldobilanz of any period as lists of accounts, with
 * the selected account's ledger on the right. A search finds an account by number or name in
 * whichever report holds it.
 */
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import './reports.css';
import { localToday, parsePeriod } from '../../../accounting/periods.js';
import type { Report, RouteOf } from '../../shell/route.js';
import { REPORT_LABEL, Tabs } from './Tabs.js';
import { CustomDetail, CustomList, customKeys } from './custom/Custom.js';
import { ListHead } from '../../shell/ListHead.js';
import { moveKey } from '../../shell/keyboard.js';
import { getAccountMap } from '../../lib/accounts.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { accountingName, t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { entryAt } from '../vat/links.js';
import {
  NO_ACCOUNT, NO_ACCOUNT_SLUG, accountsOf, filterBlocks, incomeColumns, ledgerOf, reportOfAccount, reportView, searchReport,
  type AccountRow, type Block, type ReportView,
} from './model.js';
import { SliceBar } from './SliceBar.js';
import { setSlice, useSliced } from './slice.js';
import { valueLabel } from '../../../books/tags.js';
import { Detail } from './Detail.js';
import { vatParts } from '../../../accounting/vat-in-figures.js';
import { causeText } from '../close/steps.js';
import type { DifferenceCause } from '../../../accounting/year-close.js';
import { accountName, accountOfRoute, routeAccount } from './view.js';
import { missingOpenings } from '../../../accounting/opening-balance.js';
import { useWorkspace } from '../../hooks/use-workspace.js';

/** The route of one of the books' three reports (not Eigene Berichte). */
export type BooksRoute = Extract<RouteOf<'reports'>, { report: Report }>;
type Props = AreaProps<BooksRoute>;
const SUM_LABEL = {
  grossProfit: 'income.grossProfit', operatingResult: 'income.operatingResult', netResult: 'reports.result',
  totalAssets: 'balance.totalAssets', totalLiabilities: 'balance.totalLiabilities',
} as const;
const HEADLINE = { result: 'reports.result', balanceTotal: 'reports.balanceTotal', balanced: 'reports.balanced', difference: 'reports.difference' } as const;
const CLASS = { 1: 'reports.class1', 2: 'reports.class2', 3: 'reports.class3', 4: 'reports.class4', 5: 'reports.class5', 6: 'reports.class6', 7: 'reports.class7', 8: 'reports.class8', 9: 'reports.class9' } as const;


function groupTitle(b: Extract<Block, { kind: 'group' }>): string {
  if (b.title === NO_ACCOUNT) return t('reports.noAccount');
  if (b.title in CLASS) return `${b.title} · ${t(CLASS[b.title as unknown as keyof typeof CLASS])}`;
  return accountingName(b.title);
}

/** Per viewer: all accounts of the chart or only those with an amount, and the collapsed groups. */
const ALL_KEY = 'reports.all';
const SHUT_KEY = 'reports.collapsed';
const read = <T,>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* per viewer only */ } };

/** The list as last shown, in ↑↓ order: the keys act on it. */
const listed: { ids: string[] } = { ids: [] };

function useView({ route, query, books, period }: Pick<Props, 'route' | 'query' | 'books' | 'period'>, all: boolean): ReportView {
  const names = getAccountMap();
  const q = query.q ?? '';
  return useMemo(() => {
    const view = reportView(route.report, books, period, names, all || !!q.trim());
    return filterBlocks(view, q, names, t('reports.vatOnly'));
  }, [route.report, books, period, names, all, q]);
}

function List(props: Props) {
  const { route, query, period, nav, canEdit } = props;
  const names = getAccountMap();
  const [all, setAll] = useState(() => read(ALL_KEY, false));
  const [shut, setShut] = useState(() => new Set(read<string[]>(SHUT_KEY, [])));
  const q = query.q ?? '';
  const { dimensions, slice, books } = useSliced(route.report, props.books);
  const view = useView({ ...props, books }, all);
  const by = dimensions.find((d) => d.id === slice.by);
  const columns = useMemo(() => (by ? incomeColumns(books, period, names, by) : undefined), [by, books, period, names]);
  const cols = columns && columnsOf(columns);
  const ids = accountsOf(view);
  listed.ids = ids;
  const account = accountOfRoute(route);

  const target = searchReport(route.report, q, names, t('reports.vatOnly'));
  const [switched, setSwitched] = useState<Report>();
  useEffect(() => {
    if (target !== route.report) { setSwitched(target); nav.select({ area: 'reports', report: target }); }
    else if (!q) setSwitched(undefined);
  }, [target, route.report, q]);

  // Nothing selected, an account the search left out, or no account at all: the first one.
  // A known account without an amount stays: a link may name it.
  const keepsAccount = account !== undefined && (ids.includes(account) || (!q && (account in names || account === NO_ACCOUNT)));
  useEffect(() => {
    if (target === route.report && !keepsAccount && ids[0] !== undefined) nav.select({ area: 'reports', report: route.report, account: routeAccount(ids[0]) });
  }, [target, route.report, keepsAccount, ids[0]]);

  const toggleAll = () => { setAll(!all); write(ALL_KEY, !all); };
  const toggleGroup = (key: string) => {
    const next = new Set(shut);
    if (!next.delete(key)) next.add(key);
    setShut(next);
    write(SHUT_KEY, [...next]);
  };
  const inTrial = (account: string) => nav.go({
    route: { area: 'reports', report: 'trial', account },
    query: { period: parsePeriod(`${period.to.slice(0, 4)}-01-01..${period.to}`, localToday()) ?? undefined },
  });
  /** Where a cause of the gap is looked at: the one-sided entries, the account, or the year's opening. */
  const goCause = (c: DifferenceCause) => (c.code === 'oneLeg' ? inTrial(NO_ACCOUNT_SLUG)
    : c.code === 'openingUnbalanced' ? nav.go({ route: { area: 'company', section: 'opening' }, query: {} })
      : inTrial(c.account));
  const sb = route.report === 'trial';
  const ws = useWorkspace();
  const year = period.to.slice(0, 4);
  const unopened = useMemo(() => (ws && route.report !== 'income' ? missingOpenings(props.books, ws.bankAccounts, year) : []), [ws, props.books, year, route.report]);

  return (
    <div className="page">
      <ListHead period={period} books={props.books} canEdit={canEdit} />
      <Tabs route={route} nav={nav}>
        <span className="rnote">{switched && q ? `→ ${t(REPORT_LABEL[switched])}` : view.asOf ? t('balance.asOf', { date: formatDate(view.asOf) }) : ''}</span>
        <button type="button" className={`rall${all ? ' on' : ''}`} aria-pressed={all} title={all ? t('reports.onlyWithAmountTip') : t('reports.allAccountsTip')} onClick={toggleAll}>
          {all ? t('reports.allAccounts') : t('reports.onlyWithAmount')}
        </button>
      </Tabs>
      <label className="search rsearch">
        {ICONS.search}
        <span className="sr">{t('reports.searchLabel')}</span>
        <input
          type="search"
          placeholder={t('reports.searchPlaceholder')}
          value={q}
          className={q ? 'has' : ''}
          autoComplete="off"
          onChange={(e) => nav.setQuery({ q: e.target.value || undefined })}
          onKeyDown={(e) => { if (e.key === 'Escape') nav.setQuery({ q: undefined }); }}
        />
      </label>
      {route.report === 'income' && dimensions.length > 0 && <SliceBar dimensions={dimensions} slice={slice} entries={props.books.journalEntries ?? []} onChange={setSlice} />}
      {q && !ids.length && <div className="empty"><h2>{t('reports.nothingFound', { q })}</h2></div>}
      <div className={`vresult static${view.balanced === false ? ' bad' : ''}`}>
        <span>{t(HEADLINE[view.headline.label])}</span>
        <b className="mono"><small>CHF</small>{fmt(view.headline.value)}</b>
      </div>
      {view.vat?.shown === 'net' && (
        <p className="m rvat" data-testid="vat-note" data-shown="net">{t('reports.vatNet', { account: view.vat.account })}</p>
      )}
      {view.vat?.shown === 'gross' && (
        <p className="m rvat" data-testid="vat-note" data-shown="gross" data-net={view.vat.figures.net}>
          {t(route.report === 'income' ? 'reports.vatNoteIncome' : 'reports.vatNoteBalance', { net: fmt(view.vat.figures.net), parts: vatParts(view.vat.figures).map((x) => t(x.key, { amount: fmt(x.amount) })).join(', ') })}
        </p>
      )}
      {view.gap && (
        <div className="notice warn rgap">
          <span className="dot" aria-hidden="true" />
          <span>
            {t('reports.gap', { liabilities: fmt(view.gap.liabilities), gap: fmt(view.gap.value) })}
            {view.gap.causes.map((c, i) => (
              <span key={i} className="cause" data-cause={c.code}>{' '}{causeText(c)}{' '}<button type="button" onClick={() => goCause(c)}>{t('reports.show')}</button></span>
            ))}
            {!view.gap.causes.length && <span>{' '}{t('reports.gapUnknown')}</span>}
          </span>
        </div>
      )}
      {unopened.map((m) => (
        <div key={m.account} className="notice warn rgap" data-testid="opening-missing" data-account={m.account}>
          <span className="dot" aria-hidden="true" />
          <span>
            {t('reports.openingMissing', { account: `${m.account} ${m.label}`, year: m.year, amount: fmt(m.amount) })}{' '}
            {m.canType && <button type="button" onClick={() => nav.go({ route: { area: 'company', section: 'opening' }, query: {} })}>{t('reports.openingSet')}</button>}
          </span>
        </div>
      ))}
      <div className={`rows rep${sb ? ' sbal' : ''}${cols ? ' cols' : ''}`} role="listbox" aria-label={t('reports.accounts')} data-columns={cols?.values.length} style={cols ? ({ '--cols': cols.values.length } as CSSProperties) : undefined}>
        {sb && <div className="group sbh"><span>{t('col.account')}</span><span /><span className="r">{t('reports.opening')}</span><span className="r">{t('reports.debit')}</span><span className="r">{t('reports.credit')}</span><span className="r">{t('reports.balance')}</span></div>}
        {cols && by && <div className="group sbh" data-testid="slice-head"><span>{t('col.account')}</span><span>{by.label}</span>{cols.values.map((v) => <span key={v} className="r" title={v}>{v ? valueLabel(by, v) : t('tags.without')}</span>)}<span className="r">{t('common.total')}</span></div>}
        {view.blocks.map((b, i) => {
          if (b.kind === 'head') return <div key={i} className="rhead">{t(b.title === 'assets' ? 'balance.assets' : 'balance.liabilities')}</div>;
          if (b.kind === 'sum') return <div key={i} className={`rsum${b.strong ? ' strong' : ''}`}><span>{t(SUM_LABEL[b.title])}</span>{cols?.sum(b.title).map((x, j) => <span key={j} className="mono f">{fmt(x)}</span>)}<span className="mono">{fmt(b.value)}</span></div>;
          const key = `${route.report}:${b.title}`;
          const closed = shut.has(key) && !q;
          return (
            <Fragment key={key}>
              <button type="button" className={`group${closed ? ' shut' : ''}`} aria-expanded={!closed} onClick={() => toggleGroup(key)}>
                <span><svg className="gch" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>{groupTitle(b)}</span>
                {cols?.total(b.title).map((x, j) => <span key={j} className="mono f">{fmt(x)}</span>)}
                <span className="mono">{b.total != null ? fmt(b.total) : ''}</span>
              </button>
              {!closed && b.rows.map((r) => <Row key={r.account} r={r} sb={sb} cols={cols?.row(r.account)} sel={r.account === account} names={names} onSelect={(a) => nav.select({ area: 'reports', report: route.report, account: routeAccount(a) })} />)}
              {!closed && b.plain && <div className="row plain"><span className="d" /><span className="t">{accountingName(b.plain.name)}</span><span className="a mono">{fmt(b.plain.value)}</span></div>}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** The columns of the Erfolgsrechnung per value of a dimension, looked up by account, by group and by sum. */
function columnsOf(columns: ReturnType<typeof incomeColumns>) {
  const groups = (v: ReportView) => v.blocks.filter((b): b is Extract<Block, { kind: 'group' }> => b.kind === 'group');
  const sumOf = (v: ReportView, title: string) => v.blocks.find((b): b is Extract<Block, { kind: 'sum' }> => b.kind === 'sum' && b.title === title)?.value ?? 0;
  return {
    values: columns.map((c) => c.value),
    row: (account: string) => columns.map((c) => groups(c.view).flatMap((b) => b.rows).find((r) => r.account === account)?.value ?? 0),
    total: (title: string) => columns.map((c) => groups(c.view).find((b) => b.title === title)?.total ?? 0),
    sum: (title: string) => columns.map((c) => sumOf(c.view, title)),
  };
}

function Row({ r, sb, cols, sel, names, onSelect }: { r: AccountRow; sb: boolean; cols?: number[]; sel: boolean; names: Record<string, string>; onSelect(a: string): void }) {
  const zero = !r.value && !r.open && !r.debit && !r.credit;
  return (
    <div className={`row${sel ? ' sel' : ''}${zero ? ' zero' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-acct={routeAccount(r.account)} onClick={() => onSelect(r.account)}>
      <span className="d mono">{r.account === NO_ACCOUNT ? '·' : r.account}</span>
      <span className="t">{accountName(r.account, names)}</span>
      {cols?.map((x, j) => <span key={j} className="a mono f">{x ? fmt(x) : ''}</span>)}
      {sb && (
        <>
          <span className="a mono f">{r.open ? fmt(r.open) : ''}</span>
          <span className="a mono f">{r.debit ? fmt(r.debit) : ''}</span>
          <span className="a mono f">{r.credit ? fmt(r.credit) : ''}</span>
        </>
      )}
      <span className="a mono">{fmt(r.value)}</span>
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('reports.keyAccount'), t('reports.keyAccountTip')],
  [['↵'], t('vat.keyEntry'), t('reports.keyEntryTip')],
  [['/'], t('keys.search'), t('reports.searchTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const reports: Area<RouteOf<'reports'>> = {
  id: 'reports',
  label: () => t('area.reports'),
  dock: { key: 'r', icon: ICONS.reports, tip: () => t('area.reports.tip') },
  List: (p) => (p.route.report === 'custom' ? <CustomList {...p} route={p.route} /> : <List {...p} route={p.route} />),
  Detail: (p) => (p.route.report === 'custom' ? <CustomDetail {...p} route={p.route} /> : <Detail {...p} route={p.route} />),
  legend,
  wide: true,
  title: (r) => { if (r.report === 'custom') return t('custom.tab'); const a = accountOfRoute(r); return a === undefined ? t(REPORT_LABEL[r.report]) : a === NO_ACCOUNT ? t('reports.noAccount') : `${a} ${accountName(a)}`; },
  keys(e, p) {
    if (p.route.report === 'custom') return customKeys(e, { ...p, route: p.route });
    const route = p.route;
    const d = moveKey(e);
    if (d) {
      const a = accountOfRoute(route);
      const i = a === undefined ? -1 : listed.ids.indexOf(a);
      const next = listed.ids[Math.min(listed.ids.length - 1, Math.max(0, i + d))];
      if (next !== undefined) p.nav.select({ area: 'reports', report: route.report, account: routeAccount(next) });
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === 'Escape' && p.query.q) { p.nav.setQuery({ q: undefined }); return true; }
    if (e.key === 'd') { document.querySelector<HTMLElement>('[data-dlpop]')?.click(); return true; }
    if (e.key !== 'Enter') return false;
    const a = accountOfRoute(route);
    const first = a === undefined ? undefined : ledgerOf(p.books, a, p.period, getAccountMap()).rows[0]?.entry;
    if (!first) return false;
    p.nav.go(entryAt(first, p.period));
    return true;
  },
  palette: ({ nav, query }) => Object.entries(getAccountMap()).map(([a, name]) => ({
    label: `${a} ${name}`,
    side: t(REPORT_LABEL[reportOfAccount(a)]),
    run: () => nav.go({ route: { area: 'reports', report: reportOfAccount(a), account: a }, query: query.period ? { period: query.period } : {} }),
  })),
};
