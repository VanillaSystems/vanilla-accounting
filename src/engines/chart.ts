/** What an account is, from the jurisdiction's chart.yaml: its type, normal side and statement side. */
import type { AccountGroup, AccountType, AccountTypeRule, ChartData } from '../core/modules/schema.js';

/** Whether an account belongs to a statement group of statements.yaml. */
export const inGroup = (g: AccountGroup) => (account: string): boolean =>
  'accounts' in g ? g.accounts.includes(account) : account >= g.from && account < g.to;

export interface ChartEngine {
  typeOf(account: string): AccountType | undefined;
  isDebitNormal(account: string): boolean;
  sideOf(account: string): AccountTypeRule['side'];
  /** Whether a booking on the account shows in the Bilanz or the Erfolgsrechnung (a closing or unknown class does not). */
  isPlaced(account: string): boolean;
  /** The account classes (first digits) that are placed, as a person reads them: «1–8». */
  placedClasses: string;
}

/** Digits as ranges: 1,2,3,4,5,6,7,8 → «1–8», 1,2,4 → «1–2, 4». */
function ranges(digits: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < digits.length; i++) {
    let j = i;
    while (digits[j + 1] === digits[j] + 1) j++;
    out.push(j > i ? `${digits[i]}–${digits[j]}` : String(digits[i]));
    i = j;
  }
  return out.join(', ');
}

export function chartEngine(data: ChartData): ChartEngine {
  const prefixes = Object.keys(data.classes).sort((a, b) => b.length - a.length);
  const typeOf = (account: string) => {
    const prefix = prefixes.find((p) => account.startsWith(p));
    return prefix === undefined ? undefined : data.classes[prefix];
  };
  const rule = (account: string) => {
    const type = typeOf(account);
    return type ? data.types[type] : data.unclassified;
  };
  const placed = Object.keys(data.classes).filter((p) => p.length === 1 && data.types[data.classes[p]]?.side !== 'none').map(Number).sort((a, b) => a - b);
  return {
    typeOf,
    isDebitNormal: (account) => rule(account).normal === 'debit',
    sideOf: (account) => rule(account).side,
    isPlaced: (account) => rule(account).side !== 'none',
    placedClasses: ranges(placed),
  };
}
