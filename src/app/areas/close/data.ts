/**
 * The year's close as the API computes it (src/books/year-close.ts), shared by the list and the
 * detail: fetched once per year and per load of the books, so a write followed by nav.refresh()
 * shows the new state everywhere.
 */
import { useSyncExternalStore } from 'react';
import type { Index } from '../../../types/index.js';
import { localToday, openQuarter, type Period } from '../../../accounting/periods.js';
import { api, DEMO, errorText, STATIC_EXPORT, type YearCloseView } from '../../lib/api.js';
import { t } from '../../i18n/index.js';

interface State { year: string; books: Index | null; data?: YearCloseView; error?: string }

let state: State = { year: '', books: null };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

function load(year: string, books: Index): void {
  if (state.year === year && state.books === books) return;
  const keep = state.year === year ? state.data : undefined;
  state = { year, books, data: keep };
  if (STATIC_EXPORT) { state = { ...state, error: t(DEMO ? 'yearClose.demoOff' : 'yearClose.apiOnly') }; return; }
  api.yearClose(year).then(
    (data) => { if (state.year === year && state.books === books) { state = { ...state, data, error: undefined }; emit(); } },
    (e) => { if (state.year === year && state.books === books) { state = { ...state, error: errorText(e) }; emit(); } },
  );
}

/** The close of `year`; `data` stays the last one while the books reload. */
export function useYearClose(year: string, books: Index): Pick<State, 'data' | 'error'> {
  load(year, books);
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);
}

/**
 * The year the page closes: the one the period names, else the open quarter's year; in the
 * half year after a close (closed through 31.12., profit allocation and opening still to do)
 * the closed year.
 */
export function closeYear(period: Period | undefined, books: Index, today = localToday()): string {
  if (period && period.kind !== 'all') return period.from.slice(0, 4);
  const closed = books.config?.closedThrough;
  if (closed?.endsWith('-12-31') && today < `${+closed.slice(0, 4) + 1}-07-01`) return closed.slice(0, 4);
  return openQuarter(closed, today).from.slice(0, 4);
}
