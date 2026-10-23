import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Index, JournalEntry } from '../../types/index.js';
import { conversionOf, estvRates, rateDateOf, type Conversion, type EstvRates } from '../../accounting/fx-conversion.js';
import { api } from '../lib/api.js';

interface Fx {
  /** Null until the ESTV rate table has loaded. */
  rates: EstvRates | null;
  paymentDate(entry: JournalEntry): string;
  /** Undefined for a CHF entry, and until the rates have loaded. */
  convert(entry: JournalEntry): Conversion | undefined;
}

const FxContext = createContext<Fx>({ rates: null, paymentDate: (e) => e.date, convert: () => undefined });

/** The ESTV rates and each entry's payment date, for every view below it. */
export function FxProvider({ index, children }: { index: Index; children: ReactNode }) {
  const [rates, setRates] = useState<EstvRates | null>(null);
  useEffect(() => {
    let live = true;
    api.fxRates().then((table) => { if (live) setRates(estvRates(table)); }, () => {});
    return () => { live = false; };
  }, []);

  const value = useMemo<Fx>(() => {
    const txDates = new Map(index.transactions.map((tx) => [tx.ref, tx.date]));
    const paymentDate = (entry: JournalEntry) => rateDateOf(entry, txDates);

    return { rates, paymentDate, convert: (entry) => (rates ? conversionOf(entry, paymentDate(entry), rates) : undefined) };
  }, [rates, index.transactions]);

  return <FxContext.Provider value={value}>{children}</FxContext.Provider>;
}

export const useFx = (): Fx => useContext(FxContext);
