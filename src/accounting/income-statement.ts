import type { JournalEntry } from '../types/index.js';
import { computeBalances } from './ledger.js';
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
  const balances = computeBalances(entries, from, to);
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

  const revenue = section('Erlöse', a => a >= '3000' && a < '4000');
  const costOfGoods = section('Aufwand für Material und Waren', a => a >= '4000' && a < '5000');
  const grossProfit = roundCHF(revenue.total - costOfGoods.total);

  const operatingExpenses = section('Betriebsaufwand', a => a >= '5000' && a < '7000');
  const operatingResult = roundCHF(grossProfit - operatingExpenses.total);

  const otherIncome = section('Nebenbetrieblicher Ertrag', a => a === '7000' || a === '8100' || a === '8510');
  const otherExpenses = section('Nebenbetrieblicher Aufwand', a => a === '7010' || a === '8000' || a === '8500' || a === '8900');
  const extraordinaryItems = section('Ausserordentliches', () => false);

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
