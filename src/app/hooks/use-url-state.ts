import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { buildViewPath, setView, splitViewPath, viewParams, viewPath } from '../lib/location.js';
import { ALL, localToday, parsePeriod, type Period } from '../../accounting/periods.js';

export type FilterMode = 'all' | 'linked' | 'unlinked';

const VALID_TABS = ['receipts', 'transactions', 'bank-statements', 'journal-entries', 'trial-balance', 'balance-sheet', 'income-statement', 'vat-report', 'account-ledger', 'bank-reconciliation', 'year-close'];

/** Query keys that belong to one tab's selection: dropped when the tab changes. */
const TAB_SELECTION = ['je', 'utx', 'receipt', 'tx', 'account', 'statement', 'ziffer', 'view', 'code'];

/** /<lang>/<period>/<tab>, /<lang>/<tab> and the older /<period>/<tab> and /<tab>. */
function parsePath(): { tab: string; period: string } {
  const [first, second] = splitViewPath(viewPath()).rest;
  if (first === undefined) return { tab: 'receipts', period: 'all' };
  if (VALID_TABS.includes(first)) return { tab: first, period: 'all' };
  return {
    period: parsePeriod(first, localToday()) ? first : 'all',
    tab: second && VALID_TABS.includes(second) ? second : 'receipts',
  };
}

/**
 * The view state the URL carries: /<lang>/<period>/<tab>?filter=&q=&receipt=&tx=. Starts from the
 * URL and writes every change back with replaceState, the language included, so a link without
 * one gets the language the person sees. The selection lives in App (it needs the index), so App
 * passes it in and gets the URL's initial selection back once.
 */
export function useUrlState({ loading, language, receiptId, txRef }: { loading: boolean; language: string; receiptId: string | null; txRef: string | null }) {
  const [initial] = useState(() => {
    const params = viewParams();
    const f = params.get('filter');
    return {
      ...parsePath(),
      filterMode: (f === 'linked' || f === 'unlinked' ? f : 'all') as FilterMode,
      search: params.get('q') ?? '',
      receiptId: params.get('receipt'),
      txRef: params.get('tx'),
    };
  });
  const [tab, setTab] = useState(initial.tab);
  const [periodToken, setPeriod] = useState(initial.period);
  const [filterMode, setFilterMode] = useState(initial.filterMode);
  const [search, setSearch] = useState(initial.search);
  const period: Period = useMemo(() => parsePeriod(periodToken, localToday()) ?? ALL, [periodToken]);

  /** A tab's own selection (je=, account=) is left behind before the next tab reads the URL. */
  function selectTab(next: string) {
    if (next === tab) return;
    const params = viewParams();
    for (const key of TAB_SELECTION) params.delete(key);
    setView(viewPath(), params);
    setTab(next);
  }

  // Skipped while loading, so the original URL survives until the selection is restored from it.
  // Keys a tab writes itself (account=, je=) stay.
  useEffect(() => {
    if (loading) return;
    const params = viewParams();
    const own: Array<[string, string | null]> = [['filter', filterMode === 'all' ? null : filterMode], ['q', search || null]];
    if (tab === 'receipts' || tab === 'transactions') own.push(['receipt', receiptId], ['tx', txRef]);
    for (const [key, value] of own) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    setView(buildViewPath(language, period.token, tab), params);
  }, [loading, language, tab, period.token, filterMode, search, receiptId, txRef]);

  return {
    tab, setTab: selectTab, period, setPeriod, filterMode, setFilterMode, search, setSearch,
    initialSelection: { receiptId: initial.receiptId, txRef: initial.txRef },
  };
}

/** One query parameter a tab keeps itself (?account=…), read once and written back on change. */
export function useUrlParam(name: string): [string | null, Dispatch<SetStateAction<string | null>>] {
  const [value, setValue] = useState(() => viewParams().get(name));
  useEffect(() => {
    const params = viewParams();
    if (value) params.set(name, value);
    else params.delete(name);
    setView(viewPath(), params);
  }, [name, value]);
  return [value, setValue];
}
