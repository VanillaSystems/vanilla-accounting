/**
 * npm run extract-balances
 *
 * Parses the monthly bank statement PDFs under bank-statements/<Bank>/ and stores
 * each account's month-end closing balance in index.statementBalances. This is
 * the bank-side source of truth for the monthly reconciliation view (Kontenabgleich).
 */

import { join } from 'node:path';
import { loadBooks, saveBooks, update, PERSON } from '../books/store.js';
import { extractStatementBalances } from '../providers/statement-pdf/statement-pdf-balances.js';
import { reconcileMonthly } from '../accounting/reconcile-bank.js';
import { openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();
const STATEMENTS_DIR = ws.paths.statements;

async function main() {
  const index = loadBooks(ws);

  const { balances, warnings } = await extractStatementBalances(STATEMENTS_DIR, ws.bankAccounts);
  update(index, PERSON, (books) => { books.statementBalances = balances; });
  saveBooks(ws, index);

  console.log(`Extracted ${balances.length} month-end closing balances from statement PDFs.`);
  for (const w of warnings) console.log(`  warn: ${w}`);

  // Show the reconciliation immediately so it's verifiable from the CLI too.
  const recon = reconcileMonthly(index, ws.bankAccounts);
  for (const acc of recon) {
    console.log(`\n${acc.account} ${acc.label} (${acc.currency}) — ${acc.allMatched ? 'all months reconciled ✓' : 'MISMATCH ✗'}`);
    for (const r of acc.rows) {
      const mark = r.matched ? '✓' : '✗';
      console.log(
        `  ${mark} ${r.date}  bank ${r.bankBalance.toFixed(2).padStart(12)}  ` +
          `book ${r.bookBalance.toFixed(2).padStart(12)}  diff ${r.difference.toFixed(2).padStart(9)}`,
      );
    }
  }
}

main();
