import type { Account } from './accounts.js';

export interface AccountMatch {
  account: Account;
  /** The matched characters in `${number} ${name}`, [start, end), for highlighting. */
  highlight: [number, number] | null;
  /** Found by a hint of the standard chart alone, not by its name (#365). */
  hint?: true;
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
  /** The words the standard chart gives an account besides its name (modules/<country>/accounts.yaml `hints`), else the account's own. */
  hints?(number: string): readonly string[] | undefined;
  /** What the linked receipt's lines say (#382): before anything is typed, the accounts whose hints those words name come first, the most named first. */
  suggest?: readonly string[];
}

/**
 * Whether a typed word names a hint of the account: the whole word («Miete»), or its start of five
 * letters or more («Versich» for «Versicherung»). Never a hint inside a longer word: «Arbeitskleider»
 * is no «Arbeit», «Autoversicherung» no «Auto».
 */
const hinted = (parts: readonly string[], hints: readonly string[] | undefined): boolean =>
  !!hints?.some((h) => { const f = foldAll(h); return parts.some((p) => f === p || (p.length >= 5 && f.startsWith(p))); });

/**
 * The row ↵ takes after typing: the first, unless it was found by a hint alone on the other side of
 * the payment (a revenue account on a cost field): then none is chosen until she moves to one (-1).
 */
export function firstPick<T extends string>(matches: ReadonlyArray<Pick<AccountMatch, 'account' | 'hint'>>, ctx: Pick<AccountContext<T>, 'typeOf' | 'prefer'>): number {
  const m = matches[0];
  return m?.hint && ctx.prefer !== undefined && ctx.typeOf(m.account.number) !== ctx.prefer ? -1 : 0;
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
  // Nothing typed: the accounts the receipt's words name by their hints first (each word folded, as a typed one is).
  const said = !q && ctx.suggest?.length ? ctx.suggest.map(foldAll) : undefined;
  const saidBy = (a: Account) => (said ? -said.filter((w) => hinted([w], ctx.hints?.(a.number) ?? a.hints)).length : 0);
  const classes = new Set<T>();
  const parts = q.split(/\s+/).filter((x) => x.length >= 3);
  // Each typed word may name a class («Einnahme von Kunde»): the word itself, the word with an ending, or its start of five letters
  // at least, so three letters («ein», «ver») that start a name («Einlage») never list a whole class before it.
  for (const part of parts) {
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
    // A hint is as good as a word of the name that starts with the query; a class alone comes after.
    const hint = hinted(parts, ctx.hints?.(account.number) ?? account.hints);
    // A hint of the account names the word itself («Spesen» for Bankspesen): it counts before the class the word names.
    if (at >= 0) out.push({ m: { account, highlight: [at, at + q.length] }, quality: named && !hint ? 3 : at === 0 || at === account.number.length + 1 ? 0 : /[^\p{L}\p{N}]/u.test(hay[at - 1]) || hint ? 1 : 2, i });
    else if (hint) out.push({ m: { account, highlight: null, hint: true }, quality: 1, i });
    else if (named) out.push({ m: { account, highlight: null }, quality: 3, i });
  });
  return out
    .sort((a, b) => preferred(a.m.account) - preferred(b.m.account)
      || saidBy(a.m.account) - saidBy(b.m.account)
      // A name or a hint that holds the word before an account listed only for the class the word names («Spesen»: Bankspesen before Materialaufwand, #382).
      || (a.quality === 3 ? 1 : 0) - (b.quality === 3 ? 1 : 0)
      || (preferred(a.m.account) === 0 ? standing(a.m.account) - standing(b.m.account) : 0)
      || a.quality - b.quality || a.i - b.i)
    .map((x) => x.m);
}

/**
 * The one purchase account (an expense of the chart) a receipt's words name by its hints (#397):
 * a word that is the hint, or ends in a hint of five letters or more, the head of a compound
 * («Dispersionsfarbe» names «Farbe», «Gerüstmiete» names «Miete»). Undefined when no account or
 * several are named: the person chooses, from the list ranked by those words.
 */
export function accountOfWords<T extends string>(accounts: readonly Account[], words: readonly string[], ctx: Pick<AccountContext<T>, 'typeOf' | 'hints'> & { expense: T }): { account: string; word: string } | undefined {
  const said = words.map((w) => ({ w, f: foldAll(w) }));
  const hits = new Map<string, string>();
  for (const a of accounts) {
    if (ctx.typeOf(a.number) !== ctx.expense) continue;
    const hints = (ctx.hints?.(a.number) ?? a.hints ?? []).map(foldAll);
    const word = said.find(({ f }) => hints.some((h) => f === h || (h.length >= 5 && f.endsWith(h))));
    if (word) hits.set(a.number, word.w);
  }
  if (hits.size !== 1) return undefined;
  const [[account, word]] = [...hits];
  return { account, word };
}
