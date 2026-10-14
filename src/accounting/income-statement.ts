import type { JournalEntry } from '../types/index.js';
import { computeBalances } from './ledger.js';
import { chart, statements } from '../engines/index.js';
import { inGroup } from '../engines/chart.js';
import { roundCHF } from './rappen.js';

export interface IncomeStatementSection {
  title: string;
  rows: { account: string; name: string; amount: number }[];
  total: number;
}

export interface IncomeStatement {
  revenue: IncomeStatementSection;
  costOfGoods: IncomeStatementSection;
  grossProfit: number;
  operatingExpenses: IncomeStatementSection;
  operatingResult: number;
  otherIncome: IncomeStatementSection;
  otherExpenses: IncomeStatementSection;
  extraordinaryItems: IncomeStatementSection;
  netResult: number;
}

export function computeIncomeStatement(
  entries: JournalEntry[],
  from: string,
  to: string,
  accountNames: Record<string, string>,
): IncomeStatement {
  const balances = computeBalances(entries, from, to, {}, chart().isDebitNormal);
  const balanceMap = new Map(balances.map(b => [b.account, b.balance]));

  const allAccounts = Object.keys(accountNames).sort();

  function section(title: string, filter: (a: string) => boolean): IncomeStatementSection {
    const rows = allAccounts
      .filter(a => filter(a))
      .map(a => ({ account: a, name: accountNames[a] ?? a, amount: balanceMap.get(a) ?? 0 }));
    return {
      title,
      rows,
      total: roundCHF(rows.reduce((sum, r) => sum + r.amount, 0)),
    };
  }

  const layout = statements().income;
  const of = (key: keyof typeof layout) => section(layout[key].title, inGroup(layout[key]));
  const revenue = of('revenue');
  const costOfGoods = of('costOfGoods');
  const grossProfit = roundCHF(revenue.total - costOfGoods.total);

  const operatingExpenses = of('operatingExpenses');
  const operatingResult = roundCHF(grossProfit - operatingExpenses.total);

  const otherIncome = of('otherIncome');
  const otherExpenses = of('otherExpenses');
  const extraordinaryItems = of('extraordinaryItems');

  const netResult = roundCHF(operatingResult + otherIncome.total - otherExpenses.total);

  return {
    revenue,
    costOfGoods,
    grossProfit,
    operatingExpenses,
    operatingResult,
    otherIncome,
    otherExpenses,
    extraordinaryItems,
    netResult,
  };
}
