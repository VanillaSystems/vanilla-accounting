/** The returns as filed with the ESTV (filings/<year>/), read once per year and kept. */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import type { ReturnFigures } from '../../../engines/return.js';

const years = new Map<string, Promise<ReturnFigures[]>>();

const load = (year: string) => {
  if (!years.has(year)) years.set(year, api.filedReturns(year).catch(() => []));
  return years.get(year)!;
};

/** The filed return of a quarter key; undefined while loading, for any other key, or when none was filed. */
export function useFiledReturn(key: string): ReturnFigures | undefined {
  const [filed, setFiled] = useState<{ key: string; figures?: ReturnFigures }>();
  useEffect(() => {
    if (!/^\d{4}-Q[1-4]$/.test(key)) return;
    let live = true;
    load(key.slice(0, 4)).then((list) => { if (live) setFiled({ key, figures: list.find((f) => f.period === key) }); });
    return () => { live = false; };
  }, [key]);
  return filed?.key === key ? filed.figures : undefined;
}
