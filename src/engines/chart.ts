/** What an account is, from the jurisdiction's chart.yaml: its type, normal side and statement side. */
import type { AccountGroup, AccountType, AccountTypeRule, ChartData } from '../core/modules/schema.js';

/** Whether an account belongs to a statement group of statements.yaml. */
export const inGroup = (g: AccountGroup) => (account: string): boolean =>
  'accounts' in g ? g.accounts.includes(account) : account >= g.from && account < g.to;

export interface ChartEngine {
  typeOf(account: string): AccountType | undefined;
  isDebitNormal(account: string): boolean;
  sideOf(account: string): AccountTypeRule['side'];
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
  return {
    typeOf,
    isDebitNormal: (account) => rule(account).normal === 'debit',
    sideOf: (account) => rule(account).side,
  };
}
