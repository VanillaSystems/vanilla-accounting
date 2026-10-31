/** The returns as filed with the ESTV (filings/<year>/), read once per year for one load of the books (filed-cache.ts). */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import type { ReturnFigures } from '../../../engines/return.js';
import type { Index } from '../../../types/index.js';
import { filing } from '../../../engines/index.js';
import { isFilingKey } from '../../../accounting/periods.js';
import { perBooks } from './filed-cache.js';

const filedReturns = perBooks((year: string) => api.filedReturns(year).catch((): ReturnFigures[] => []));

/** The filed return of a quarter key; undefined while loading, for any other key, or when none was filed. Read again with each load of `books` (r8f-45). */
export function useFiledReturn(key: string, books: Index): ReturnFigures | undefined {
  const [filed, setFiled] = useState<{ key: string; figures?: ReturnFigures }>();
  useEffect(() => {
    if (!isFilingKey(key, filing().length)) return;
    let live = true;
    filedReturns(books, key.slice(0, 4)).then((list) => { if (live) setFiled({ key, figures: list.find((f) => f.period === key) }); });
    return () => { live = false; };
  }, [key, books]);
  return filed?.key === key ? filed.figures : undefined;
}
