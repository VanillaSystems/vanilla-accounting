export interface Account {
  number: string;
  name: string;
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
