/**
 * npm run export -- --from YYYY-MM-DD --to YYYY-MM-DD
 *
 * Generates a TSV file for import into Banana Accounting.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBooks } from '../books/store.js';
import { bananaEntries, bananaTsv } from '../providers/banana/banana.js';
import { openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();

function parseArgs(): { from: string; to: string } {
  const args = process.argv.slice(2);
  let from = '';
  let to = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) from = args[++i];
    if (args[i] === '--to' && args[i + 1]) to = args[++i];
  }
  if (!from || !to) {
    console.error('Usage: npm run export -- --from YYYY-MM-DD --to YYYY-MM-DD');
    process.exit(1);
  }
  return { from, to };
}

function validateDescription(description: string): string[] {
  const errors: string[] = [];

  if (!description.trim()) {
    errors.push('missing description');
  }
  if (description.length > 60) {
    errors.push('description exceeds 60 characters');
  }
  if (/Card Transaction Of|Received Money From|Issued By|Wise Charges For/i.test(description)) {
    errors.push('description contains raw bank text');
  }
  if (
    /^Webshop Bestellung #\d{4}/.test(description) &&
    !/^Webshop Bestellung #\d{4}, [^,]+, [^,]+$/.test(description)
  ) {
    errors.push('webshop order description must include customer name and country');
  }
  if (/^FedEx/i.test(description) && /#(?!\d{4}(?!\d))\d+/.test(description)) {
    errors.push('the # reference on a shipping entry must be a four-digit webshop order number');
  }

  return errors;
}

function main() {
  const { from, to } = parseArgs();
  const books = loadBooks(ws);
  const entries = bananaEntries(books, from, to);

  if (entries.length === 0) {
    console.log(`No journal entries found in range ${from} to ${to}.`);
    return;
  }

  const complianceErrors = entries.flatMap(({ entry, description }) =>
    validateDescription(description).map((error) => `${entry.transactionRef}: ${error} (${description})`));

  if (complianceErrors.length > 0) {
    console.error('Export blocked: journal entries are not compliant with description templates.');
    for (const error of complianceErrors) console.error(`  - ${error}`);
    process.exit(1);
  }

  const outputPath = join(ws.paths.root, `banana-import-${from}-to-${to}.tsv`);
  writeFileSync(outputPath, bananaTsv(books, from, to), 'utf8');

  console.log(`Exported ${entries.length} journal entries to ${outputPath}`);
  console.log(`Date range: ${from} to ${to}`);

  const accounts = new Set(entries.flatMap(({ entry }) => [entry.accountDebit, entry.accountCredit]).filter(Boolean));
  console.log(`Accounts used: ${[...accounts].sort().join(', ')}`);
}

main();
