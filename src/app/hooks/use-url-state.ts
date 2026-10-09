import { useEffect, useState } from 'react';

export type FilterMode = 'all' | 'linked' | 'unlinked';

const VALID_TABS = ['receipts', 'transactions', 'bank-statements', 'journal-entries', 'trial-balance', 'balance-sheet', 'income-statement', 'vat-report', 'account-ledger', 'bank-reconciliation'];

const isPeriod = (s: string) => /^\d{4}(-Q\d)?$/.test(s);

function parsePath(): { tab: string; period: string } {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { tab: 'receipts', period: 'all' };
  if (isPeriod(parts[0])) {
    return {
      period: parts[0],
      tab: VALID_TABS.includes(parts[1]) ? parts[1] : 'receipts',
    };
  }
  return { tab: VALID_TABS.includes(parts[0]) ? parts[0] : 'receipts', period: 'all' };
}

function buildPath(tab: string, period: string): string {
  return period === 'all' ? `/${tab}` : `/${period}/${tab}`;
}

/**
 * The view state the URL carries: /<period>/<tab>?filter=&q=&receipt=&tx=. Starts from the URL
 * and writes every change back with replaceState. The selection lives in App (it needs the
 * index), so App passes it in and gets the URL's initial selection back once.
 */
export function useUrlState({ loading, receiptId, txRef }: { loading: boolean; receiptId: string | null; txRef: string | null }) {
  const [initial] = useState(() => {
    const params = new URLSearchParams(window.location.search);
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
  const [period, setPeriod] = useState(initial.period);
  const [filterMode, setFilterMode] = useState(initial.filterMode);
  const [search, setSearch] = useState(initial.search);

  // Skipped while loading, so the original URL survives until the selection is restored from it.
  useEffect(() => {
    if (loading) return;
    const params = new URLSearchParams();
    if (filterMode !== 'all') params.set('filter', filterMode);
    if (search) params.set('q', search);
    if (receiptId) params.set('receipt', receiptId);
    if (txRef) params.set('tx', txRef);
    const qs = params.toString();
    const path = buildPath(tab, period);
    history.replaceState(null, '', qs ? `${path}?${qs}` : path);
  }, [loading, tab, period, filterMode, search, receiptId, txRef]);

  return {
    tab, setTab, period, setPeriod, filterMode, setFilterMode, search, setSearch,
    initialSelection: { receiptId: initial.receiptId, txRef: initial.txRef },
  };
}
