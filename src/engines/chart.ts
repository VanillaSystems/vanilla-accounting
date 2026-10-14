/** What an account is, from the jurisdiction's chart.yaml: its type, normal side and statement side. */
import type { AccountType, AccountTypeRule, ChartData } from '../core/modules/schema.js';

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
