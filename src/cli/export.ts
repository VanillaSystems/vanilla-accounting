/**
 * npm run export -- --from YYYY-MM-DD --to YYYY-MM-DD
 *
 * Generates a TSV file for import into Banana Accounting.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BankTransaction, JournalEntry } from '../types/index.js';
import { loadBooks } from '../books/store.js';
import { roundCHF } from '../accounting/rappen.js';
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

function normalizeCell(value: unknown): string {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

function validateDescription(je: JournalEntry, tx: BankTransaction): string[] {
  const description = je.description ?? tx.description;
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

  const index = loadBooks(ws);
  const journalEntries = index.journalEntries;

  // Build transaction lookup for dates and refs
  const txByRef = new Map(index.transactions.map((tx) => [tx.ref, tx]));

  // Filter journal entries by date range (using entry date or transaction date)
  const filtered = journalEntries.filter((je) => {
    const tx = txByRef.get(je.transactionRef);
    if (!tx) return false;
    const date = je.date ?? tx.date;
    return date >= from && date <= to;
  });

  if (filtered.length === 0) {
    console.log(`No journal entries found in range ${from} to ${to}.`);
    return;
  }

  const complianceErrors = filtered.flatMap((je) => {
    const tx = txByRef.get(je.transactionRef);
    if (!tx) return [`${je.transactionRef}: missing transaction`];
    return validateDescription(je, tx).map((error) => `${je.transactionRef}: ${error} (${je.description ?? tx.description})`);
  });

  if (complianceErrors.length > 0) {
    console.error('Export blocked: journal entries are not compliant with description templates.');
    for (const error of complianceErrors) console.error(`  - ${error}`);
    process.exit(1);
  }

  // Sort by effective date, then by transactionRef
  filtered.sort((a, b) => {
    const dateA = a.date ?? txByRef.get(a.transactionRef)?.date ?? '';
    const dateB = b.date ?? txByRef.get(b.transactionRef)?.date ?? '';
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    return a.transactionRef.localeCompare(b.transactionRef);
  });

  // TSV columns (Banana NameXml)
  const columns = [
    'Date',
    'Description',
    'AccountDebit',
    'AccountCredit',
    'Amount',
    'AmountCurrency',
    'ExchangeCurrency',
    'ExchangeRate',
    'ExchangeMultiplier',
    'VatCode',
    'ExternalReference',
  ];

  const rows: string[] = [columns.join('\t')];

  for (const je of filtered) {
    const tx = txByRef.get(je.transactionRef)!;
    const isForeign = je.exchangeCurrency && je.exchangeCurrency !== 'CHF';
    const rate = je.exchangeRate ?? 1;

    // For foreign currency: Amount = AmountCurrency * ExchangeRate
    // AmountCurrency is the original foreign amount, Amount is CHF
    const amountCHF = isForeign
      ? roundCHF(je.amount * rate)
      : je.amount;

    const row = [
      je.date ?? tx.date,                               // Date
      je.description ?? tx.description,                 // Description
      je.accountDebit,                                  // AccountDebit
      je.accountCredit,                                 // AccountCredit
      formatAmount(amountCHF),                          // Amount (CHF)
      isForeign ? formatAmount(je.amount) : '',         // AmountCurrency
      isForeign ? je.exchangeCurrency : '',             // ExchangeCurrency
      isForeign ? rate : '',                            // ExchangeRate
      isForeign ? -1 : '',                              // ExchangeMultiplier
      je.vatCode ?? '',                                 // VatCode
      je.transactionRef,                                // ExternalReference
    ];

    rows.push(row.map(normalizeCell).join('\t'));
  }

  const outputPath = join(ws.paths.root, `banana-import-${from}-to-${to}.tsv`);
  writeFileSync(outputPath, rows.join('\n') + '\n', 'utf8');

  console.log(`Exported ${filtered.length} journal entries to ${outputPath}`);
  console.log(`Date range: ${from} to ${to}`);

  // Summary
  const accounts = new Set(filtered.map((je) => je.accountDebit).filter(Boolean));
  filtered.forEach((je) => { if (je.accountCredit) accounts.add(je.accountCredit); });
  console.log(`Accounts used: ${[...accounts].sort().join(', ')}`);
}

main();
