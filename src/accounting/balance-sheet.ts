import type { JournalEntry } from '../types/index.js';
import { computeBalances, isDebitNormal } from './ledger.js';
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

const ASSET_GROUPS: [string, (a: string) => boolean][] = [
  ['Umlaufvermögen', a => a >= '1000' && a < '1500'],
  ['Anlagevermögen', a => a >= '1500' && a < '2000'],
];

const LIABILITY_GROUPS: [string, (a: string) => boolean][] = [
  ['Kurzfristiges Fremdkapital', a => a >= '2000' && a < '2400'],
  ['Langfristiges Fremdkapital', a => a >= '2400' && a < '2800'],
  ['Eigenkapital', a => a >= '2800' && a < '3000'],
];

export function computeBalanceSheet(
  entries: JournalEntry[],
  asOfDate: string,
  openingBalances: Record<string, number>,
  accountNames: Record<string, string>,
): BalanceSheet {
  const year = asOfDate.slice(0, 4);
  const from = `${year}-01-01`;
  const balances = computeBalances(entries, from, asOfDate, openingBalances);
  const balanceMap = new Map(balances.map(b => [b.account, b.balance]));

  // Compute P&L result (3xxx-8xxx) to show as "Jahresergebnis" on the balance sheet
  let plResultRappen = 0;
  for (const b of balances) {
    const prefix = parseInt(b.account.charAt(0));
    if (prefix >= 3 && prefix <= 8) {
      // For credit-normal (revenue 3xxx): positive balance = revenue
      // For debit-normal (expenses 4-8xxx): positive balance = expense
      // Net result = revenue - expenses
      if (isDebitNormal(b.account)) {
        plResultRappen -= toRappen(b.balance); // expenses reduce result
      } else {
        plResultRappen += toRappen(b.balance); // revenue increases result
      }
    }
  }
  const plResult = fromRappen(plResultRappen);

  const allAccounts = Object.keys(accountNames).sort();

  function buildSection(groups: typeof ASSET_GROUPS): BalanceSheetSection[] {
    return groups.map(([title, filter]) => {
      const rows = allAccounts
        .filter(a => filter(a))
        .map(a => ({ account: a, name: accountNames[a] ?? a, balance: balanceMap.get(a) ?? 0 }));
      return {
        title,
        rows,
        total: roundCHF(rows.reduce((sum, r) => sum + r.balance, 0)),
      };
    });
  }

  const assets = buildSection(ASSET_GROUPS);
  const liabilities = buildSection(LIABILITY_GROUPS);

  // Add Jahresergebnis to Eigenkapital section
  const eigenkapitalSection = liabilities.find(s => s.title === 'Eigenkapital');
  if (eigenkapitalSection) {
    eigenkapitalSection.rows.push({
      account: '',
      name: 'Jahresergebnis (noch nicht abgeschlossen)',
      balance: plResult,
    });
    eigenkapitalSection.total = roundCHF(eigenkapitalSection.total + plResult);
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
