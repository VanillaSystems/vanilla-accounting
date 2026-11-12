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

/** What the field knows beside the typed text (#344): which class its side takes first, and how a layperson names a class. */
export interface AccountContext<T extends string = string> {
  /** An account's class (the chart's type: revenue, expense, asset, …). */
  typeOf(number: string): T | undefined;
  /** The class this side of the payment takes first: revenue for money in, expense for money out. */
  prefer?: T;
  /** The firm's default accounts (what the setup wrote), first within their class. */
  defaults?: readonly string[];
  /** The words a person types for a class instead of an account's name («ertrag», «einnahme» for revenue), folded like a query. */
  words?: Partial<Record<T, readonly string[]>>;
}

/**
 * The accounts a typed query picks, the likeliest first (#344). A word finds the accounts whose
 * name holds it and the accounts of the class the word names («Ertrag» lists the revenue accounts,
 * whose names say «Erlöse»). Order: the class the side takes first, in it the firm's default
 * accounts, then a name that starts with the query before one a word of which starts with it before
 * one that only holds it before a match by class alone, then chart order. Digits keep chart order: a typed number is a number.
 */
export function rankAccounts<T extends string>(accounts: readonly Account[], query: string, ctx: AccountContext<T>): AccountMatch[] {
  const q = foldAll(query.trim());
  const preferred = (a: Account) => (ctx.prefer !== undefined && ctx.typeOf(a.number) === ctx.prefer ? 0 : 1);
  const standing = (a: Account) => { const i = ctx.defaults?.indexOf(a.number) ?? -1; return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  if (/^\d+$/.test(q)) return filterAccounts(accounts, query);
  const classes = new Set<T>();
  // Each typed word may name a class («Einnahme von Kunde»): the word itself, the word with an ending, or its start of five letters
  // at least, so three letters («ein», «ver») that start a name («Einlage») never list a whole class before it.
  for (const part of q.split(/\s+/).filter((x) => x.length >= 3)) {
    for (const [type, words] of Object.entries(ctx.words ?? {}) as Array<[T, readonly string[]]>) {
      if (words.some((w) => { const f = foldAll(w); return part.startsWith(f) || (part.length >= 5 && f.startsWith(part)); })) classes.add(type);
    }
  }
  const out: Array<{ m: AccountMatch; quality: number; i: number }> = [];
  accounts.forEach((account, i) => {
    if (!q) { out.push({ m: { account, highlight: null }, quality: 0, i }); return; }
    const hay = foldAll(`${account.number} ${account.name}`);
    const at = hay.indexOf(q);
    const type = ctx.typeOf(account.number);
    // A word that names the account's class asked for the class: its accounts stay in chart order, whichever name holds the word too.
    const named = type !== undefined && classes.has(type);
    if (at >= 0) out.push({ m: { account, highlight: [at, at + q.length] }, quality: named ? 3 : at === 0 || at === account.number.length + 1 ? 0 : /[^\p{L}\p{N}]/u.test(hay[at - 1]) ? 1 : 2, i });
    else if (named) out.push({ m: { account, highlight: null }, quality: 3, i });
  });
  return out
    .sort((a, b) => preferred(a.m.account) - preferred(b.m.account)
      || (preferred(a.m.account) === 0 ? standing(a.m.account) - standing(b.m.account) : 0)
      || a.quality - b.quality || a.i - b.i)
    .map((x) => x.m);
}
