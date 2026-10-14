/** What the MWST list and detail share: the return a page shows, a Ziffer's name, and the 0535 difference. */
import { useMemo } from 'react';
import type { Index } from '../../../types/index.js';
import { localToday, openFilingPeriod, type Period } from '../../../accounting/periods.js';
import { fmt } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { rateOf, vatKeyOf, vatReturn, type VatReturn } from './model.js';
import { useFiledReturn } from './filed.js';
import { vat, filing } from '../../../engines/index.js';
import type { ReturnFigures } from '../../../engines/return.js';

/** A Ziffer's short name in the list and the detail heading. */
export function zifferLabel(v: VatReturn, n: string): string {
  const r = rateOf(v, n);
  if (r) return t(r.row.kind === 'supply' ? 'vat.nSupply' : 'vat.nAcquisition', { rate: r.row.rate });
  return t(`vat.n${n}` as 'vat.n200');
}

/** The open quarter, and the return a page shows for its period. */
export function useReturn({ books, period }: { books: Index; period: Period }) {
  const key = vatKeyOf(period, openFilingPeriod(books.config?.closedThrough, localToday(), filing().length));
  const v = useMemo(() => vatReturn(books, key), [books, key]);
  const filed = useFiledReturn(key);
  return { v, filed, key };
}

/** Korrigiert minus filed tax: what the 0535 changes (positive: more to pay). */
export function correctionDiff(books: Index, filed: ReturnFigures): number {
  const corrected = vat().figures(books.journalEntries ?? [], filed.period, books.config?.vatAdjustments ?? []);
  return Math.round((corrected.payable - ((filed.ziffern['500'] ?? 0) - (filed.ziffern['510'] ?? 0))) * 100) / 100;
}

export const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));
