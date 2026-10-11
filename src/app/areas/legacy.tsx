/**
 * The old tabs inside the new shell until each area is built (phases 2–9): one adapter turns an
 * area's route into the old tab, its selection and its period, and the old tab's selection back
 * into the route. Deleted in phase 10 with legacy-tabs.tsx.
 */
import { useRef, useState } from 'react';
import { seedLegacyParams } from '../lib/location.js';
import { fmt, formatDate } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { localToday, parsePeriod, periodContaining, type Period } from '../../accounting/periods.js';
import { ListHead } from '../shell/ListHead.js';
import type { AreaId, Route, RouteOf } from '../shell/route.js';
import type { Area, AreaProps, PaletteItem } from './index.js';
import { LegacyTabs, type LegacyTab } from './legacy-tabs.js';

type LegacyArea = Exclude<AreaId, 'company' | 'invoices' | 'receipts' | 'vat' | 'reports'>;

/** Each area's old tabs; the first is shown unless the route names another. */
const TABS: Record<LegacyArea, LegacyTab[]> = {
  bank: ['bank-statements', 'transactions', 'bank-reconciliation'],
  journal: ['journal-entries'],
  codes: ['vat-codes'],
  close: ['year-close'],
};

const TAB_LABEL = {
'transactions': 'tab.transactions', 'bank-statements': 'tab.bankStatements',
  'journal-entries': 'tab.journalEntries', 'vat-codes': 'vatCodes.title',
  'bank-reconciliation': 'tab.bankReconciliation', 'year-close': 'tab.yearClose',
} as const satisfies Record<LegacyTab, string>;

/** The tab a route names, if it names one. */
function routeTab(route: Route): LegacyTab | undefined {
  if (route.area === 'bank' && route.payment) return 'transactions';
  return undefined;
}

/** The query keys the old tabs read their selection from. */
function legacyParams(route: Route): URLSearchParams {
  const p = new URLSearchParams();
  if (route.area === 'journal' && route.id) p.set('je', route.id);
  if (route.area === 'codes') { p.set('view', 'codes'); if (route.code) p.set('code', route.code); }
  return p;
}

/** The route an old tab's new selection names; the same route when it names nothing new. */
function routeOfParams(route: Route, p: URLSearchParams): Route {
  const get = (k: string) => p.get(k) || undefined;
  switch (route.area) {
    case 'journal': return { area: 'journal', ...(get('je') && { id: get('je') }) };
    case 'codes': return get('view') === 'codes'
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
    if (route.area === 'bank' && route.payment) nav.select({ area: 'bank' });
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
        initial={route.area === 'bank' ? { txRef: route.payment } : {}}
        onSelect={({ txRef }) => {
          if (route.area === 'bank' && tab === 'transactions' && txRef !== route.payment) nav.select({ area: 'bank', ...(txRef && { payment: txRef }) });
        }}
      />
    </div>
  );
}


export function legacyArea<A extends LegacyArea>(id: A, rest: Omit<Area<RouteOf<A>>, 'id' | 'List'>): Area<RouteOf<A>> {
  return { id: id as RouteOf<A>['area'], List: LegacyPage, ...rest };
}

/** A place for an object dated `date`: in the current period when it holds the date (urls.md rule 1). */
const at = (route: Route, date: string | undefined, current: Period) =>
  ({ route, query: { period: parsePeriod(periodContaining(date, current), localToday()) ?? undefined } });

export function journalPalette({ books, nav, period }: AreaProps): PaletteItem[] {
  return [...(books.journalEntries ?? [])].sort((a, b) => b.date.localeCompare(a.date)).map((e) => ({
    label: [e.id, e.description].filter(Boolean).join(' · '),
    side: `${formatDate(e.date)}  ${fmt(e.amount)}`,
    run: () => nav.go(at({ area: 'journal', id: e.id }, e.date, period)),
  }));
}

