/**
 * The words a person knows from other bookkeeping tools, found by ⌘K (#567): «Debitoren»,
 * «Kontoblatt», «Saldovortrag». Each opens the place here that does that job, under its name here,
 * so she learns ours. The words of each language are its dictionary's (`shell.synonyms.<id>`, one
 * line of terms split by «|»); the palette lists a place only once a term matches what she typed.
 */
import type { Route, Query } from './route.js';
import { yearEnd } from '../../engines/index.js';
import { getAccountMap } from '../lib/accounts.js';
import { t } from '../i18n/index.js';

export const SYNONYMS = ['journal', 'manual', 'debtors', 'creditors', 'inbox', 'ledger', 'opening', 'vatSettlement'] as const;
export type SynonymId = (typeof SYNONYMS)[number];

/** Where a word leads: a route and the query besides the period. */
export function synonymPlace(id: SynonymId): { route: Route; query: Omit<Query, 'period'> } {
  switch (id) {
    case 'journal': return { route: { area: 'journal' }, query: {} };
    case 'manual': return { route: { area: 'journal' }, query: { chips: [{ field: 'who', value: 'manual' }] } };
    case 'debtors': return { route: { area: 'invoices', view: 'list' }, query: { status: 'open' } };
    case 'creditors': case 'inbox': return { route: { area: 'receipts' }, query: {} };
    case 'ledger': return { route: { area: 'reports', report: 'trial' }, query: {} };
    case 'opening': return { route: { area: 'company', section: 'opening' }, query: {} };
    case 'vatSettlement': {
      // The settlement account the chart has (year-end.yaml `vatSettlement`), else the balance sheet.
      const account = yearEnd().accounts.vatSettlement.find((a) => getAccountMap()[a]);
      return { route: { area: 'reports', report: 'balance', ...(account && { account }) }, query: {} };
    }
  }
}

/** The places whose words hold every word typed, each with the term that matched first. */
export function synonymHits(query: string): Array<{ id: SynonymId; term: string }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return SYNONYMS.flatMap((id) => {
    const term = t(`shell.synonyms.${id}`).split('|').map((x) => x.trim()).find((x) => words.every((w) => x.toLowerCase().includes(w)));
    return term ? [{ id, term }] : [];
  });
}
