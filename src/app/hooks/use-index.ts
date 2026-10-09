import { useCallback, useEffect, useState } from 'react';
import type { Index } from '../../types/index.js';
import { setAccounts } from '../lib/accounts.js';
import { api } from '../lib/api.js';

const EMPTY: Index = { receipts: [], transactions: [], mappings: [], bankStatements: [] };

export function useIndex() {
  const [data, setData] = useState<Index>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    Promise.all([
      fetch(`/books.json?t=${tick}`).then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Index>;
      }),
      api.accounts().catch(() => []),
    ]).then(([json, accounts]) => {
      setAccounts(accounts);
      setData(json);
      setLoading(false);
    }).catch((e: Error) => {
      setError(e.message);
      setLoading(false);
    });
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, refresh };
}
