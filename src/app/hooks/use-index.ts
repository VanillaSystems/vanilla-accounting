import { useCallback, useEffect, useRef, useState } from 'react';
import type { Index } from '../../types/index.js';
import { setAccounts, setStandardAccounts } from '../lib/accounts.js';
import { setOrderPages, setProviderIssues, setVatCorrections } from '../lib/order-pages.js';
import { api } from '../lib/api.js';
import { setJurisdiction } from '../../engines/index.js';
import { latestLoad } from '../lib/latest-load.js';

const EMPTY: Index = { receipts: [], transactions: [], mappings: [], bankStatements: [] };

export function useIndex() {
  const [data, setData] = useState<Index>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Two loads close together (a run's step and a drop's answer, #424): the earlier one answering last never replaces the later.
  const begin = useRef(latestLoad()).current;

  useEffect(() => {
    const current = begin();
    Promise.all([
      api.books(),
      api.accounts().catch(() => []),
      api.modules(),
      api.orderPages().catch(() => ({})),
      api.vatCorrections().catch(() => ({})),
      api.standardAccounts().catch(() => []),
      api.providerIssues().catch(() => undefined),
    ]).then(([json, accounts, modules, orderPages, corrections, standard, providerIssues]) => {
      if (!current()) return;
      setAccounts(accounts);
      setStandardAccounts(standard);
      setOrderPages(orderPages);
      setVatCorrections(corrections);
      setProviderIssues(providerIssues);
      setJurisdiction(modules.effective, modules.vat);
      setData(json);
      setLoading(false);
    }).catch((e: Error) => {
      if (!current()) return;
      setError(e.message);
      setLoading(false);
    });
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, refresh };
}
