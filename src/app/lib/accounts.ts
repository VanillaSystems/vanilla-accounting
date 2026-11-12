export interface Account {
  number: string;
  name: string;
  /** The standard chart's words for the account besides its name («Miete», «Benzin»): an account field finds it by them (#365). */
  hints?: string[];
}

let accountsCache: Account[] | null = null;
let accountMapCache: Record<string, string> | null = null;
let standardCache: Account[] = [];

export function setAccounts(accounts: Account[]): void {
  accountsCache = accounts;
  accountMapCache = Object.fromEntries(accounts.map(a => [a.number, a.name]));
}

/** An account added from a field: in the list at once, before the next load of the books. */
export function addAccount(account: Account): void {
  setAccounts([...getAccounts().filter((a) => a.number !== account.number), account].sort((x, y) => x.number.localeCompare(y.number)));
}

export function getAccountMap(): Record<string, string> {
  if (!accountMapCache) {
    // Fallback: return empty until loaded
    return {};
  }
  return accountMapCache;
}

export function getAccounts(): Account[] {
  return accountsCache ?? [];
}

export function setStandardAccounts(accounts: Account[]): void {
  standardCache = accounts;
}

/** The standard chart's accounts the books lack: what an account field offers to add. */
export function addableAccounts(): Account[] {
  const have = getAccountMap();
  return standardCache.filter((a) => !(a.number in have));
}

/**
 * The standard chart's words for an account of that number (Account.hints), while the firm's chart
 * still names it as the standard chart does: a number the firm renamed («4400 Verbrauchsmaterial
 * Salon») is no longer the standard account, and its hints («Subunternehmer») would mislead.
 */
export function hintsOf(number: string): string[] | undefined {
  const standard = standardCache.find((a) => a.number === number);
  const name = getAccountMap()[number];
  // A chart made from 0.4.0 to #365 carries the name a comma cut («Telefon» for «Telefon, Internet»): still the standard account.
  return standard && (name === undefined || name === standard.name || name === standard.name.split(',')[0]) ? standard.hints : undefined;
}
