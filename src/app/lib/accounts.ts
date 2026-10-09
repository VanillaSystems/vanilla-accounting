export interface Account {
  number: string;
  name: string;
}

let accountsCache: Account[] | null = null;
let accountMapCache: Record<string, string> | null = null;

export function setAccounts(accounts: Account[]): void {
  accountsCache = accounts;
  accountMapCache = Object.fromEntries(accounts.map(a => [a.number, a.name]));
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

export function accountTitle(code: string): string {
  const map = getAccountMap();
  return map[code] ? `${code} ${map[code]}` : code;
}
