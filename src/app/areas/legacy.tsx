/**
 * The old tabs inside the new shell until each area is built (phases 2–9): one adapter turns an
 * area's route into the old tab, its selection and its period, and the old tab's selection back
 * into the route. Deleted in phase 10 with legacy-tabs.tsx.
 */
import { useRef, useState } from 'react';
import type { Index } from '../../types/index.js';
import { isNonReceipt } from '../components/receipts-table.js';
import { seedLegacyParams } from '../lib/location.js';
import { fmt, formatAmount, formatDate } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { localToday, openQuarter, parsePeriod, periodContaining, type Period } from '../../accounting/periods.js';
import { ListHead } from '../shell/ListHead.js';
import type { AreaId, Route, RouteOf } from '../shell/route.js';
import type { Area, AreaProps, PaletteItem } from './index.js';
import { LegacyTabs, type LegacyTab } from './legacy-tabs.js';

type LegacyArea = Exclude<AreaId, 'company' | 'invoices'>;

/** Each area's old tabs; the first is shown unless the route names another. */
const TABS: Record<LegacyArea, LegacyTab[]> = {
  receipts: ['receipts'],
  bank: ['bank-statements', 'transactions', 'bank-reconciliation'],
  journal: ['journal-entries'],
  vat: ['vat-report'],
  codes: ['vat-report'],
  reports: ['income-statement', 'balance-sheet', 'trial-balance', 'account-ledger'],
  close: ['year-close'],
};

const TAB_LABEL = {
  'receipts': 'tab.receipts', 'transactions': 'tab.transactions', 'bank-statements': 'tab.bankStatements',
  'journal-entries': 'tab.journalEntries', 'trial-balance': 'tab.trialBalance', 'balance-sheet': 'tab.balanceSheet',
  'income-statement': 'tab.incomeStatement', 'vat-report': 'tab.vat', 'account-ledger': 'tab.accountLedger',
  'bank-reconciliation': 'tab.bankReconciliation', 'year-close': 'tab.yearClose',
} as const satisfies Record<LegacyTab, string>;

const REPORT_TAB = { income: 'income-statement', balance: 'balance-sheet', trial: 'trial-balance' } as const;

/** The tab a route names, if it names one. */
function routeTab(route: Route): LegacyTab | undefined {
  if (route.area === 'reports') return REPORT_TAB[route.report];
  if (route.area === 'bank' && route.payment) return 'transactions';
  return undefined;
}

/** The query keys the old tabs read their selection from. */
function legacyParams(route: Route): URLSearchParams {
  const p = new URLSearchParams();
  if (route.area === 'journal' && route.id) p.set('je', route.id);
  if (route.area === 'reports' && route.account) p.set('account', route.account);
  if (route.area === 'vat' && route.ziffer) p.set('ziffer', route.ziffer);
  if (route.area === 'codes') { p.set('view', 'codes'); if (route.code) p.set('code', route.code); }
  return p;
}

/** The route an old tab's new selection names; the same route when it names nothing new. */
function routeOfParams(route: Route, p: URLSearchParams): Route {
  const get = (k: string) => p.get(k) || undefined;
  switch (route.area) {
    case 'journal': return { area: 'journal', ...(get('je') && { id: get('je') }) };
    case 'reports': return { area: 'reports', report: route.report, ...(get('account') && { account: get('account') }) };
    case 'vat': case 'codes': return get('view') === 'codes'
      ? { area: 'codes', ...(get('code') && { code: get('code') }) }
      : { area: 'vat', ...(get('ziffer') && { ziffer: get('ziffer') }) };
    default: return route;
  }
}

function LegacyPage({ route, period, books, nav, canEdit }: AreaProps) {
  const tabs = TABS[route.area as LegacyArea];
  const [picked, setPicked] = useState<LegacyTab>();
  const tab = routeTab(route) ?? (picked && tabs.includes(picked) ? picked : tabs[0]);

  // An old tab reads its selection once: it mounts again when the route changes from outside it.
  const key = JSON.stringify(route);
  const own = useRef<string>();
  const mounts = useRef({ key, n: 0 });
  if (mounts.current.key !== key) mounts.current = { key, n: mounts.current.n + (own.current === key ? 0 : 1) };
  seedLegacyParams(legacyParams(route), (p) => {
    const next = routeOfParams(route, p);
    own.current = JSON.stringify(next);
    if (own.current !== key) nav.select(next);
  });

  function pick(next: LegacyTab) {
    setPicked(next);
    if (route.area === 'reports') {
      const report = (Object.keys(REPORT_TAB) as Array<keyof typeof REPORT_TAB>).find((r) => REPORT_TAB[r] === next);
      if (report) nav.select({ area: 'reports', report });
    } else if (route.area === 'bank' && route.payment) nav.select({ area: 'bank' });
  }

  return (
    <div className="page">
      <ListHead route={route} period={period} books={books} canEdit={canEdit}>
        {tabs.length > 1 && (
          <div className="counts" role="tablist">
            {tabs.map((x) => (
              <button key={x} role="tab" aria-selected={x === tab} className={x === tab ? 'on' : ''} onClick={() => pick(x)}>{t(TAB_LABEL[x])}</button>
            ))}
          </div>
        )}
      </ListHead>
      <LegacyTabs
        key={`${tab}:${mounts.current.n}`}
        tab={tab}
        period={period}
        index={books}
        refresh={nav.refresh}
        canEdit={canEdit}
        onPeriod={(token) => nav.setQuery({ period: parsePeriodToken(token) })}
        initial={route.area === 'receipts' ? { receiptId: route.id } : route.area === 'bank' ? { txRef: route.payment } : {}}
        onSelect={({ receiptId, txRef }) => {
          if (route.area === 'receipts' && receiptId !== route.id) nav.select({ area: 'receipts', ...(receiptId && { id: receiptId }) });
          if (route.area === 'bank' && tab === 'transactions' && txRef !== route.payment) nav.select({ area: 'bank', ...(txRef && { payment: txRef }) });
        }}
      />
    </div>
  );
}

function parsePeriodToken(token: string) {
  return parsePeriod(token, localToday()) ?? undefined;
}

export function legacyArea<A extends LegacyArea>(id: A, rest: Omit<Area<RouteOf<A>>, 'id' | 'List'>): Area<RouteOf<A>> {
  return { id: id as RouteOf<A>['area'], List: LegacyPage, ...rest };
}

/** Open receipts of the open quarter and later: those still waiting for their payment. */
export function receiptsBadge(books: Index): number {
  const from = openQuarter(books.config?.closedThrough, localToday()).from;
  const linked = new Set(books.mappings.map((m) => m.receiptId));
  return books.receipts.filter((r) => !linked.has(r.id) && !isNonReceipt(r, linked) && !!r.date && r.date >= from).length;
}

/** A place for an object dated `date`: in the current period when it holds the date (urls.md rule 1). */
const at = (route: Route, date: string | undefined, current: Period) =>
  ({ route, query: { period: parsePeriod(periodContaining(date, current), localToday()) ?? undefined } });

export function receiptsPalette({ books, nav, period }: AreaProps): PaletteItem[] {
  return [...books.receipts].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).map((r) => ({
    label: r.description ? `${r.filename} · ${r.description}` : r.filename,
    side: [r.date && formatDate(r.date), r.amount != null && formatAmount(r.amount, r.currency)].filter(Boolean).join('  '),
    run: () => nav.go(at({ area: 'receipts', id: r.id }, r.date, period)),
  }));
}

export function journalPalette({ books, nav, period }: AreaProps): PaletteItem[] {
  return [...(books.journalEntries ?? [])].sort((a, b) => b.date.localeCompare(a.date)).map((e) => ({
    label: [e.id, e.description].filter(Boolean).join(' · '),
    side: `${formatDate(e.date)}  ${fmt(e.amount)}`,
    run: () => nav.go(at({ area: 'journal', id: e.id }, e.date, period)),
  }));
}

