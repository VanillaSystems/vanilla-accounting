import type { JournalEntry } from '../types/index.js';

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  severity: Severity;
  entryId: string;
  field: string;
  message: string;
}

const VALID_VAT_CODES = new Set([
  'V0', 'V0-E', 'V0-T', 'V0-N', 'V0-D',
  'V77', 'V81', 'V77-B', 'V81-B',
  'V25-N', 'V26', 'V37', 'V38',
  'M0', 'M77', 'M81', 'M25', 'M26', 'M37', 'M38',
  'I0', 'I77', 'I81', 'I25', 'I26', 'I37', 'I38',
  'K77-A', 'K81-A', 'K77-B', 'K81-B', 'K77-C', 'K81-C',
  'B77', 'B81',
  'M77-1', 'M77-2', 'M81-1', 'M81-2',
  'I77-1', 'I77-2', 'I81-1', 'I81-2',
  'B77-1', 'B77-2', 'B81-1', 'B81-2',
]);

function isValidVatCode(code: string): boolean {
  const clean = code.startsWith('-') ? code.slice(1) : code;
  return VALID_VAT_CODES.has(clean);
}

// Amount-type-2 codes ("-2" = MwSt/USt-Betrag): the amount IS the VAT amount and
// the code supplies its own counter-leg to the VAT account. Such entries are booked
// single-legged in Banana — exactly one of Soll/Haben is filled (e.g. the Shopify
// Vorsteuer-Korrekturbuchung: C 6580 / M81-2, Soll blank). See docs/runbooks.
function isVatAmountCode(code: string | undefined): boolean {
  if (!code) return false;
  const clean = code.startsWith('-') ? code.slice(1) : code;
  return clean.endsWith('-2');
}

/** Where Vorsteuer on Investitionen und Betriebsaufwand (Ziffer 405) is booked: operating expense, or a fixed asset of the Anlagevermögen. */
function isInvestmentOrExpense(account: string): boolean {
  return /^[56]/.test(account) || (account >= '1500' && account <= '1799');
}

export function validateJournalEntries(
  entries: JournalEntry[],
  validAccounts: Set<string>,
  closedThrough: string | null,
  mappings: { transactionRef: string; receiptId: string }[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const receiptsByTx = new Set(mappings.map(m => m.transactionRef));

  for (const entry of entries) {
    // Hard errors

    if (!entry.date) {
      issues.push({ severity: 'error', entryId: entry.id, field: 'date', message: 'Datum fehlt' });
    }

    // Amount-type-2 (VAT-amount) codes book single-legged: exactly one of Soll/Haben
    // is filled, the code carries the other leg to the VAT account. Allow one blank leg
    // for those; every other entry still requires both accounts.
    const vatAmountEntry = isVatAmountCode(entry.vatCode);
    const oneLegBlank = !entry.accountDebit !== !entry.accountCredit; // exactly one empty

    if (!(vatAmountEntry && oneLegBlank && !entry.accountDebit) && !validAccounts.has(entry.accountDebit)) {
      issues.push({ severity: 'error', entryId: entry.id, field: 'accountDebit', message: `Unbekanntes Konto: ${entry.accountDebit}` });
    }
    if (!(vatAmountEntry && oneLegBlank && !entry.accountCredit) && !validAccounts.has(entry.accountCredit)) {
      issues.push({ severity: 'error', entryId: entry.id, field: 'accountCredit', message: `Unbekanntes Konto: ${entry.accountCredit}` });
    }

    if (entry.vatCode && !isValidVatCode(entry.vatCode)) {
      issues.push({ severity: 'error', entryId: entry.id, field: 'vatCode', message: `Ungültiger MWST-Code: ${entry.vatCode}` });
    }

    if (closedThrough && entry.date && entry.date <= closedThrough) {
      issues.push({ severity: 'error', entryId: entry.id, field: 'date', message: `Periode geschlossen bis ${closedThrough}` });
    }

    // Warnings

    if (entry.amount <= 0) {
      issues.push({ severity: 'warning', entryId: entry.id, field: 'amount', message: 'Betrag ist 0 oder negativ' });
    }

    if (entry.vatCode) {
      const cleanCode = entry.vatCode.startsWith('-') ? entry.vatCode.slice(1) : entry.vatCode;
      const prefix = cleanCode.charAt(0);

      // Single-leg VAT-amount corrections (e.g. M81-2 on expense 6580) intentionally
      // pair a code family with the account being corrected, not the code's "expected"
      // account class — skip the prefix/account-class heuristics for them.
      if (prefix === 'V' && !vatAmountEntry) {
        const hasRevenueAccount = entry.accountDebit.startsWith('3') || entry.accountCredit.startsWith('3');
        if (!hasRevenueAccount) {
          issues.push({ severity: 'warning', entryId: entry.id, field: 'vatCode', message: 'V-Code ohne Erlöskonto (3xxx)' });
        }
      }

      if (prefix === 'M' && !vatAmountEntry) {
        const hasMaterialAccount = entry.accountDebit.startsWith('4') || entry.accountCredit.startsWith('4');
        if (!hasMaterialAccount) {
          issues.push({ severity: 'warning', entryId: entry.id, field: 'vatCode', message: 'M-Code ohne Materialkonto (4xxx)' });
        }
      }

      if (prefix === 'I' && !vatAmountEntry) {
        if (!isInvestmentOrExpense(entry.accountDebit) && !isInvestmentOrExpense(entry.accountCredit)) {
          issues.push({ severity: 'warning', entryId: entry.id, field: 'vatCode', message: 'I-Code ohne Aufwand- oder Anlagekonto (5xxx/6xxx, 1500–1799)' });
        }
      }

      const hasInputTax = (cleanCode.startsWith('M') || cleanCode.startsWith('I')) &&
                          !cleanCode.endsWith('0') && cleanCode !== 'M0' && cleanCode !== 'I0';
      if (hasInputTax && !receiptsByTx.has(entry.transactionRef)) {
        issues.push({ severity: 'warning', entryId: entry.id, field: 'vatCode', message: 'Vorsteuerabzug ohne Beleg' });
      }
    }
  }

  return issues;
}
