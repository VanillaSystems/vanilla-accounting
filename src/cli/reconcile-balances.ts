/**
 * npm run reconcile-balances -- [--as-of YYYY-MM-DD] [--all]
 *
 * Reconciles each bank account's ledger balance against the closing balance the
 * bank reports on its statement (camt053 CLBD), in the account's own currency.
 *
 *   --as-of DATE  reconcile as of this date (default: latest available closing date)
 *   --all         reconcile at every available statement closing date
 *
 * The statements are every camt053 under bank-statements/ (src/workspace/bank-statements.ts),
 * each on the ledger account belege.workspace.yaml routes it to.
 */

import { loadBooks } from '../books/store.js';
import { parseStatementBalances, BalanceSnapshot } from '../parsers/statement-balances.js';
import { reconcileBankBalances, closingDates, ReconcileRow } from '../accounting/reconcile-bank.js';
import { openWorkspace } from '../workspace/workspace.js';
import { readBankStatements } from '../workspace/bank-statements.js';

const ws = openWorkspace();

function parseArgs(): { asOf?: string; all: boolean } {
  const args = process.argv.slice(2);
  let asOf: string | undefined;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--as-of' && args[i + 1]) asOf = args[++i];
    else if (args[i] === '--all') all = true;
  }
  return { asOf, all };
}

function loadSnapshots(): BalanceSnapshot[] {
  const files = readBankStatements(ws);
  for (const f of files) if (f.status === 'unmatched') console.warn(`  skip ${f.file}: ${f.problem}`);
  return files.flatMap((f) => (f.status === 'read' ? parseStatementBalances(f.statement, f.account.bank, f.file) : []));
}

function fmt(n: number, currency: string): string {
  return `${n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function printReport(rows: ReconcileRow[]): void {
  for (const r of rows) {
    const mark = r.matched ? '✓' : '✗';
    const line =
      `  ${mark} ${r.account} ${r.label.padEnd(18)} ` +
      `bank ${fmt(r.bankBalance, r.currency).padStart(16)}  ` +
      `book ${fmt(r.bookBalance, r.currency).padStart(16)}  ` +
      `diff ${fmt(r.difference, r.currency).padStart(14)}`;
    console.log(line);
  }
}

function main() {
  const index = loadBooks(ws);
  const snapshots = loadSnapshots();
  if (snapshots.length === 0) {
    console.error('No bank statement balance snapshots found under bank-statements/.');
    process.exit(1);
  }

  const { asOf, all } = parseArgs();
  const dates = closingDates(snapshots);

  const targetDates = all ? dates : [asOf ?? dates[dates.length - 1]];

  let anyMismatch = false;
  for (const date of targetDates) {
    const rows = reconcileBankBalances(index, snapshots, date, ws.bankAccounts);
    console.log(`\nBank-balance reconciliation as of ${date}:`);
    if (rows.length === 0) {
      console.log('  (no bank accounts have a closing balance on or before this date)');
      continue;
    }
    printReport(rows);
    const mismatches = rows.filter((r) => !r.matched);
    if (mismatches.length) {
      anyMismatch = true;
      console.log(`  → ${mismatches.length} account(s) do not match the bank statement.`);
    } else {
      console.log('  → all accounts match the bank statements.');
    }
  }

  console.log(`\nAvailable statement closing dates: ${dates.join(', ')}`);
  process.exit(anyMismatch ? 2 : 0);
}

main();
