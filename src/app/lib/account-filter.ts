import type { Account } from './accounts.js';

export interface AccountMatch {
  account: Account;
  /** The matched characters in `${number} ${name}`, [start, end), for highlighting. */
  highlight: [number, number] | null;
}

/** One character folded for search: lower case, accents and umlauts dropped (ä → a, é → e). */
const fold = (c: string) => c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().charAt(0) || c;
const foldAll = (s: string) => [...s].map(fold).join('');

/**
 * The accounts a typed query picks, in chart order. Digits match the number's start ("40" finds
 * 4000 to 4099); anything else is a substring of number and name, ignoring case and accents
 * ("mwst", "buro" finds "Büro"). An empty query keeps every account.
 */
export function filterAccounts(accounts: readonly Account[], query: string): AccountMatch[] {
  const q = foldAll(query.trim());
  if (!q) return accounts.map((account) => ({ account, highlight: null }));
  const out: AccountMatch[] = [];
  for (const account of accounts) {
    if (/^\d+$/.test(q)) {
      if (account.number.startsWith(q)) out.push({ account, highlight: [0, q.length] });
      continue;
    }
    const at = foldAll(`${account.number} ${account.name}`).indexOf(q);
    if (at >= 0) out.push({ account, highlight: [at, at + q.length] });
  }
  return out;
}
