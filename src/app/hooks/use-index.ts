import { useCallback, useEffect, useRef, useState } from 'react';
import type { Index } from '../../types/index.js';
import { setAccounts } from '../lib/accounts.js';
import { api } from '../lib/api.js';

const EMPTY: Index = { receipts: [], transactions: [], mappings: [], bankStatements: [] };

const outside = new WeakSet<Index>();

/**
 * Books loaded because they changed outside the app (src/app/shell/live.ts): a selected object
 * they no longer hold keeps its place with a notice (urls.md rule 5) instead of handing the
 * selection on, as a delete in the app does.
 */
export const loadedFromOutside = (books: Index): boolean => outside.has(books);

export function useIndex() {
  const [data, setData] = useState<Index>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const why = useRef<'outside'>();

  useEffect(() => {
    const fromOutside = why.current === 'outside';
    why.current = undefined;
    Promise.all([
      api.books(),
      api.accounts().catch(() => []),
    ]).then(([json, accounts]) => {
      if (fromOutside) outside.add(json);
      setAccounts(accounts);
      setData(json);
      setLoading(false);
    }).catch((e: Error) => {
      setError(e.message);
      setLoading(false);
    });
  }, [tick]);

  /** Loads the books again in the background; `outside` when they changed outside the app. */
  const refresh = useCallback((reason?: 'outside') => {
    why.current = reason;
    setTick((t) => t + 1);
  }, []);

  return { data, loading, error, refresh };
}
