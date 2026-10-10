import { localToday, parsePeriod, periodContaining, type Period } from '../../accounting/periods.js';
import { hrefOf } from '../shell/history.js';
import type { Route } from '../shell/route.js';

/** A link to one object, in a period that holds its date: the current one when it does, else the date's quarter. */
function objectHref(route: Route, date?: string, current?: Period): string {
  return hrefOf({ route, query: { period: parsePeriod(periodContaining(date, current), localToday()) ?? undefined } });
}

export const receiptHref = (id: string, date?: string, current?: Period) => objectHref({ area: 'receipts', id }, date, current);

export const txHref = (ref: string, date?: string, current?: Period) => objectHref({ area: 'bank', payment: ref }, date, current);

export const entryHref = (id: string, date?: string, current?: Period) => objectHref({ area: 'journal', id }, date, current);

/** An account's ledger in the period `token` names. */
export const accountHref = (account: string, token: string) =>
  hrefOf({ route: { area: 'reports', report: 'trial', account }, query: { period: parsePeriod(token, localToday()) ?? undefined } });

export const vatCodeHref = (code: string) => hrefOf({ route: { area: 'codes', code }, query: {} });

/**
 * The selection the old tabs keep in query keys (je=, account=, ziffer=, view=, code=,
 * statement=): held here instead of in the URL, which names it as a path now. The legacy
 * adapter (src/app/areas/legacy.tsx) fills it from the route and hears every change. Deleted
 * with the old tabs in phase 10.
 */
let legacyParams = new URLSearchParams();
let onLegacyChange: (params: URLSearchParams) => void = () => {};

export function seedLegacyParams(params: URLSearchParams, onChange: (params: URLSearchParams) => void): void {
  legacyParams = params;
  onLegacyChange = onChange;
}

export function viewParams(): URLSearchParams {
  return new URLSearchParams(legacyParams);
}

export function setView(params: URLSearchParams): void {
  if (params.toString() === legacyParams.toString()) return;
  legacyParams = new URLSearchParams(params);
  onLegacyChange(viewParams());
}
