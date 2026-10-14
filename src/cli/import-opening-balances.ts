/**
 * npm run import-opening -- --file <path/to/prior-year.Konten.xml> [--year 2026] [--write]
 *
 * Derives the opening balances for a new accounting year from the *closing*
 * balances of the previous year's Banana Accounting "Konten" (Accounts) XML.
 *
 * How it works:
 *  - Banana's `<Balance>` field is a debit-positive signed balance
 *    (assets positive; liabilities / equity / revenue appear negative).
 *  - This app stores opening balances in the account's *natural* direction
 *    (assets & expenses positive; liabilities / equity / revenue positive),
 *    keyed by year: index.config.openingBalances[year][account] = CHF.
 *    So we flip the sign for credit-normal accounts (2xxx / 3xxx).
 *  - Only balance-sheet accounts carry forward: BClass 1 (assets) and
 *    BClass 2 (liabilities/equity). P&L accounts (BClass 3-8) reset to zero.
 *  - The previous year's net result (sum of the P&L accounts) is folded into
 *    equity account 2970 (Gewinnvortrag) — mirroring Banana's year-end close —
 *    so the new year opens with Aktiven == Passiven.
 *
 * Without --write the script only prints a report (dry run).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { loadBooks, mutateJournal, saveBooks } from '../books/store.js';
import { toRappen, fromRappen } from '../accounting/rappen.js';
import { chart, baseCurrency } from '../engines/index.js';
import { openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();
const RETAINED_EARNINGS_ACCOUNT = '2970'; // Gewinnvortrag oder Verlustvortrag

interface ParsedAccount {
  account: string;
  description: string;
  bclass: number;
  currency?: string;
  balanceCHF: number; // Banana debit-positive signed CHF balance
  balanceCurrency: number; // in the account's own currency
}

function parseArgs(): { file: string; year: string; write: boolean } {
  const args = process.argv.slice(2);
  let file = '';
  let year = '';
  let write = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) file = args[++i];
    else if (args[i] === '--year' && args[i + 1]) year = args[++i];
    else if (args[i] === '--write') write = true;
  }
  if (!file) {
    console.error('Usage: npm run import-opening -- --file <prior-year.Konten.xml> [--year 2026] [--write]');
    process.exit(1);
  }
  if (!year) {
    // Default: the year after the file's implied year, best-effort from the filename.
    const m = file.match(/(\d{4})/);
    year = m ? String(Number(m[1]) + 1) : String(new Date().getFullYear());
  }
  return { file, year, write };
}

function num(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseAccounts(xmlPath: string): ParsedAccount[] {
  if (!existsSync(xmlPath)) {
    console.error(`File not found: ${xmlPath}`);
    process.exit(1);
  }
  const xml = readFileSync(xmlPath, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);

  // AC2 > Table (may be an array of tables) > RowList > Row
  const tables = doc?.AC2?.Table;
  const tableArr = Array.isArray(tables) ? tables : [tables];
  const accountsTable = tableArr.find((t: any) => t?.['@_ID'] === 'Accounts') ?? tableArr[0];
  const rows = accountsTable?.RowList?.Row ?? [];
  const rowArr = Array.isArray(rows) ? rows : [rows];

  const accounts: ParsedAccount[] = [];
  for (const r of rowArr) {
    const account = r?.Account;
    const bclass = r?.BClass;
    // Only real accounts (have an Account number + a BClass); skip group/section rows.
    if (account === undefined || account === null || bclass === undefined) continue;
    accounts.push({
      account: String(account),
      description: String(r?.Description ?? ''),
      bclass: Number(bclass),
      currency: r?.Currency ? String(r.Currency) : undefined,
      balanceCHF: num(r?.Balance),
      balanceCurrency: num(r?.BalanceCurrency ?? r?.Balance),
    });
  }
  return accounts;
}

/** Convert Banana's debit-positive signed CHF balance into the app's natural direction. */
function naturalBalance(account: string, bananaBalanceCHF: number): number {
  return chart().isDebitNormal(account) ? bananaBalanceCHF : -bananaBalanceCHF;
}

function fmt(n: number): string {
  return n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function main() {
  const { file, year, write } = parseArgs();
  const accounts = parseAccounts(file);

  const balanceSheet = accounts.filter((a) => a.bclass === 1 || a.bclass === 2);
  const profitLoss = accounts.filter((a) => a.bclass >= 3 && a.bclass <= 8);

  // Opening balances (natural direction) for balance-sheet accounts, nonzero only.
  const opening: Record<string, number> = {};
  // Foreign-currency accounts also carry a native-currency opening (used by
  // bank-balance reconciliation, which compares against native bank balances).
  const openingNative: Record<string, { amount: number; currency: string }> = {};
  const currencyNotes: string[] = [];
  for (const a of balanceSheet) {
    const nat = naturalBalance(a.account, a.balanceCHF);
    if (toRappen(nat) === 0) continue;
    opening[a.account] = fromRappen(toRappen(nat));
    if (a.currency && a.currency !== baseCurrency()) {
      const natCur = naturalBalance(a.account, a.balanceCurrency);
      openingNative[a.account] = { amount: fromRappen(toRappen(natCur)), currency: a.currency };
      currencyNotes.push(
        `  ${a.account} ${a.description.slice(0, 28).padEnd(28)} ${a.currency} ${fmt(a.balanceCurrency)}  → CHF ${fmt(nat)}`,
      );
    }
  }

  // Previous-year net result = -(sum of P&L debit-positive balances). Profit is positive.
  let plSignedRappen = 0;
  for (const a of profitLoss) plSignedRappen += toRappen(a.balanceCHF);
  const netResult = fromRappen(-plSignedRappen); // + = profit, - = loss

  // Check whether the balance-sheet accounts already balance (file already closed).
  let assetsRappen = 0;
  let liabEqRappen = 0;
  for (const [acc, val] of Object.entries(opening)) {
    if (acc.charAt(0) === '1') assetsRappen += toRappen(val);
    else liabEqRappen += toRappen(val);
  }
  const preFoldImbalance = fromRappen(assetsRappen - liabEqRappen);

  // The retained-earnings carry is the plug that makes Aktiven == Passiven. Fold the
  // exact balance-sheet imbalance into Gewinnvortrag (mirrors Banana's year-end close).
  // The P&L-derived net result is an independent cross-check on that plug.
  const foldAmount = preFoldImbalance; // add to a credit-normal (natural) equity account
  let foldNote: string;
  if (toRappen(foldAmount) === 0) {
    foldNote = 'Balance-sheet accounts already balance — file appears post-close; nothing folded.';
  } else {
    const before = opening[RETAINED_EARNINGS_ACCOUNT] ?? 0;
    opening[RETAINED_EARNINGS_ACCOUNT] = fromRappen(toRappen(before) + toRappen(foldAmount));
    foldNote =
      `Folded prev-year result CHF ${fmt(foldAmount)} into ${RETAINED_EARNINGS_ACCOUNT} ` +
      `(Gewinnvortrag ${fmt(before)} → ${fmt(opening[RETAINED_EARNINGS_ACCOUNT])}).`;
  }

  // Re-check the final balance after folding.
  let assets2 = 0;
  let liabEq2 = 0;
  for (const [acc, val] of Object.entries(opening)) {
    if (acc.charAt(0) === '1') assets2 += toRappen(val);
    else liabEq2 += toRappen(val);
  }
  const residual = fromRappen(assets2 - liabEq2);

  // ---- Report ----
  console.log(`\nOpening balances for ${year}, from: ${file}\n`);
  console.log('Balance-sheet accounts carried forward (natural direction, CHF):');
  for (const acc of Object.keys(opening).sort()) {
    const a = balanceSheet.find((x) => x.account === acc);
    const name = a?.description ?? '';
    console.log(`  ${acc}  ${name.slice(0, 34).padEnd(34)} ${fmt(opening[acc]).padStart(14)}`);
  }
  if (currencyNotes.length) {
    console.log('\nForeign-currency accounts (original → CHF valuation stored):');
    console.log(currencyNotes.join('\n'));
  }
  console.log('\nP&L (BClass 3-8) reset to zero for the new year.');
  console.log(`Balance-sheet plug folded into ${RETAINED_EARNINGS_ACCOUNT}: CHF ${fmt(preFoldImbalance)}`);
  console.log(foldNote);
  console.log(`P&L-derived net result (cross-check): CHF ${fmt(netResult)} (${netResult >= 0 ? 'profit' : 'loss'})`);

  const crossCheckDiff = fromRappen(toRappen(preFoldImbalance) - toRappen(netResult));
  if (toRappen(crossCheckDiff) !== 0) {
    console.log(
      `  Cross-check: balance-sheet plug vs P&L result differ by CHF ${fmt(crossCheckDiff)} ` +
        `(expected — year-end FX revaluation on foreign accounts: Wise EUR/USD carry an ExchangeDifference).`,
    );
  }

  if (Math.abs(toRappen(residual)) <= 1) {
    console.log(`✓ New-year opening balances balance (Aktiven == Passiven, residual CHF ${fmt(residual)}).`);
  } else {
    console.log(`⚠ Aktiven != Passiven after import — residual CHF ${fmt(residual)}. Review before use.`);
  }

  if (!write) {
    console.log('\nDry run — no changes written. Re-run with --write to save into books.json.');
    return;
  }

  if (!existsSync(ws.paths.books)) {
    console.error(`\nCannot write: ${ws.paths.books} not found.`);
    process.exit(1);
  }
  const index = loadBooks(ws);
  mutateJournal(index, ({ config }) => {
    if (!config.openingBalances) config.openingBalances = {};
    config.openingBalances[year] = opening;
    // A native value the export does not carry was set from another source (1093 Stripe EUR is a
    // CHF account in Banana; its EUR opening comes from Shopify's balance). Keep it, never wipe it.
    if (!config.openingBalancesNative) config.openingBalancesNative = {};
    const previous = config.openingBalancesNative[year] ?? {};
    const kept = Object.keys(previous).filter((a) => !(a in openingNative));
    config.openingBalancesNative[year] = { ...previous, ...openingNative };
    if (kept.length) console.log(`  kept native opening values not in the export: ${kept.map((a) => `${a} ${previous[a].currency} ${previous[a].amount}`).join(', ')}`);
  });
  saveBooks(ws, index);
  console.log(
    `\n✓ Wrote ${Object.keys(opening).length} opening balances ` +
      `(${Object.keys(openingNative).length} with native currency) for ${year} into books.json`,
  );
}

main();
