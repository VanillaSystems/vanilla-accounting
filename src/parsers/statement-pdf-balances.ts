/**
 * Extracts month-end closing balances from bank statement PDFs (the monthly
 * statements the bank issues), for monthly reconciliation against the ledger.
 *
 * Formats handled:
 *  - Raiffeisen "Kontoauszug": closing line "Saldo zu Ihren Gunsten <amount>"
 *    (or "... Lasten" when overdrawn → negative). Swiss number format 12'345.67.
 *  - Wise monthly statement: header line "<CCY> on <day month year> ... <amount> <CCY>"
 *    is the balance held on the statement's last day. US number format 12,345.67.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StatementClosingBalance } from '../types/index.js';
import { findBankAccount } from '../accounting/bank-accounts.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';

const execFileAsync = promisify(execFile);

async function pdfText(pdfPath: string): Promise<string> {
  const { stdout } = await execFileAsync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-']);
  return stdout;
}

function parseSwissNumber(s: string): number {
  return parseFloat(s.replace(/'/g, ''));
}

function parseUsNumber(s: string): number {
  return parseFloat(s.replace(/,/g, ''));
}

/** Raiffeisen: last-day balance from "Saldo zu Ihren Gunsten/Lasten <amount>". */
function extractRaiffeisenClosing(text: string): number | null {
  const m = text.match(/Saldo zu Ihren (Gunsten|Lasten)\s+([0-9']+\.[0-9]{2})/i);
  if (!m) return null;
  const amount = parseSwissNumber(m[2]);
  return m[1].toLowerCase() === 'lasten' ? -amount : amount;
}

/** Wise: "<CCY> on <date> ... <amount> <CCY>" (balance held on the last day). */
function extractWiseClosing(text: string, currency: string): number | null {
  const re = new RegExp(`^\\s*${currency} on [0-9].*?([0-9][0-9,]*\\.[0-9]{2})\\s+${currency}\\s*$`, 'im');
  const m = text.match(re);
  if (!m) return null;
  return parseUsNumber(m[1]);
}

/** Parse "<from>_<to>" or Raiffeisen "dd.mm.yyyy - dd.mm.yyyy" from a filename → toDate (YYYY-MM-DD). */
function toDateFromFilename(filename: string): string | null {
  // Wise: statement_<id>_<CCY>_<from>_<to>.pdf
  const wise = filename.match(/_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.pdf$/i);
  if (wise) return wise[2];
  // Raiffeisen: "... - dd.mm.yyyy - CH... - yyyy-mm-dd.pdf" (trailing yyyy-mm-dd is the statement date)
  const iso = filename.match(/(\d{4}-\d{2}-\d{2})(?:\s*\(\d+\))?\.pdf$/i);
  if (iso) return iso[1];
  const rai = filename.match(/\d{2}\.\d{2}\.\d{4}\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/);
  if (rai) return `${rai[3]}-${rai[2]}-${rai[1]}`;
  return null;
}

function currencyFromFilename(filename: string, bank: string): string {
  const m = filename.match(/_(EUR|USD|CHF)_/);
  if (m) return m[1];
  return bank === 'Raiffeisen' ? 'CHF' : 'CHF';
}

function bankFromDir(dir: string): 'Raiffeisen' | 'Wise' | null {
  if (/raiffeisen/i.test(dir)) return 'Raiffeisen';
  if (/wise/i.test(dir)) return 'Wise';
  return null;
}

export interface ExtractResult {
  balances: StatementClosingBalance[];
  warnings: string[];
}

export async function extractStatementBalances(statementsDir: string, bankAccounts: readonly LedgerBankAccount[]): Promise<ExtractResult> {
  const balances: StatementClosingBalance[] = [];
  const warnings: string[] = [];
  if (!existsSync(statementsDir)) return { balances, warnings };

  for (const sub of readdirSync(statementsDir)) {
    const bank = bankFromDir(sub);
    if (!bank) continue;
    const dir = join(statementsDir, sub);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.pdf')) continue;
      if (bank === 'Raiffeisen' && !/^Kontoauszug/i.test(file)) continue;
      if (bank === 'Wise' && !/^statement_/i.test(file)) continue;

      const date = toDateFromFilename(file);
      if (!date) { warnings.push(`${file}: could not parse statement date`); continue; }
      const currency = currencyFromFilename(file, bank);
      const mapping = findBankAccount(bankAccounts, bank, currency);
      if (!mapping) { warnings.push(`${file}: no ledger account for ${bank}/${currency}`); continue; }

      let text: string;
      try {
        text = await pdfText(join(dir, file));
      } catch (e) {
        warnings.push(`${file}: pdftotext failed (${e})`);
        continue;
      }
      const amount = bank === 'Raiffeisen' ? extractRaiffeisenClosing(text) : extractWiseClosing(text, currency);
      if (amount === null) { warnings.push(`${file}: closing balance not found in PDF text`); continue; }

      balances.push({ account: mapping.account, bank, currency, date, amount, source: 'pdf', sourceFile: file });
    }
  }

  balances.sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account));
  return { balances, warnings };
}
