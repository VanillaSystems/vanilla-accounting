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

let chartNames: Record<string, string> = {};

/** Names of the SME chart's accounts, for an account a review books that accounts.json lacks yet. */
export function setChartNames(chart: Account[]): void {
  chartNames = Object.fromEntries(chart.map((a) => [a.number, a.name]));
}

export function accountTitle(code: string): string {
  const name = getAccountMap()[code] ?? chartNames[code];
  return name ? `${code} ${name}` : code;
}
