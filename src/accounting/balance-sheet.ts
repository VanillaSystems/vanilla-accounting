import type { JournalEntry } from '../types/index.js';
import { computeBalances } from './ledger.js';
import { chart, statements } from '../engines/index.js';
import { inGroup } from '../engines/chart.js';
import type { AccountGroup } from '../core/modules/schema.js';
import { toRappen, fromRappen, roundCHF } from './rappen.js';

export interface BalanceSheetSection {
  title: string;
  rows: { account: string; name: string; balance: number }[];
  total: number;
}

export interface BalanceSheet {
  assets: BalanceSheetSection[];
  liabilities: BalanceSheetSection[];
  totalAssets: number;
  totalLiabilities: number;
  isBalanced: boolean;
}

export function computeBalanceSheet(
  entries: JournalEntry[],
  asOfDate: string,
  openingBalances: Record<string, number>,
  accountNames: Record<string, string>,
): BalanceSheet {
  const year = asOfDate.slice(0, 4);
  const from = `${year}-01-01`;
  const balances = computeBalances(entries, from, asOfDate, openingBalances, chart().isDebitNormal);
  const balanceMap = new Map(balances.map(b => [b.account, b.balance]));

  // Compute P&L result (3xxx-8xxx) to show as "Jahresergebnis" on the balance sheet
  let plResultRappen = 0;
  for (const b of balances) {
    if (chart().sideOf(b.account) === 'result') {
      // For credit-normal (revenue 3xxx): positive balance = revenue
      // For debit-normal (expenses 4-8xxx): positive balance = expense
      // Net result = revenue - expenses
      if (chart().isDebitNormal(b.account)) {
        plResultRappen -= toRappen(b.balance); // expenses reduce result
      } else {
        plResultRappen += toRappen(b.balance); // revenue increases result
      }
    }
  }
  const plResult = fromRappen(plResultRappen);

  const allAccounts = Object.keys(accountNames).sort();

  function buildSection(groups: AccountGroup[]): BalanceSheetSection[] {
    return groups.map((group) => {
      const title = group.title;
      const rows = allAccounts
        .filter(inGroup(group))
        .map(a => ({ account: a, name: accountNames[a] ?? a, balance: balanceMap.get(a) ?? 0 }));
      return {
        title,
        rows,
        total: roundCHF(rows.reduce((sum, r) => sum + r.balance, 0)),
      };
    });
  }

  const layout = statements().balance;
  const assets = buildSection(layout.assets);
  const liabilities = buildSection(layout.liabilities);

  // While the year is open, its result shows in the equity group.
  const equity = layout.liabilities.findIndex((g) => g.openResult);
  if (equity >= 0) {
    liabilities[equity].rows.push({ account: '', name: layout.liabilities[equity].openResult!, balance: plResult });
    liabilities[equity].total = roundCHF(liabilities[equity].total + plResult);
  }

  const totalAssets = roundCHF(assets.reduce((sum, s) => sum + s.total, 0));
  const totalLiabilities = roundCHF(liabilities.reduce((sum, s) => sum + s.total, 0));

  return {
    assets,
    liabilities,
    totalAssets,
    totalLiabilities,
    isBalanced: Math.abs(totalAssets - totalLiabilities) < 0.01,
  };
}
