/**
 * Extracts opening/closing balance snapshots from camt053 bank statement XML.
 *
 * Both Raiffeisen and Wise export camt053, each with `<Bal>` blocks carrying an
 * OPBD (opening booked) and CLBD (closing booked) balance, an amount + currency,
 * a credit/debit indicator, and a date. These are the bank's authoritative
 * period-end balances — the source of truth to reconcile our ledger against.
 */

import { XMLParser } from 'fast-xml-parser';

export interface BalanceSnapshot {
  bank: 'Raiffeisen' | 'Wise';
  iban: string;
  currency: string;
  type: 'OPBD' | 'CLBD'; // opening / closing booked balance
  date: string; // effective YYYY-MM-DD (normalized for midnight boundary timestamps)
  amount: number; // signed into natural direction (positive = money in the account)
  sourceFile: string;
}

function bankFromInstitution(name: string, iban: string): 'Raiffeisen' | 'Wise' {
  if (/wise/i.test(name)) return 'Wise';
  if (/raiffeisen/i.test(name)) return 'Raiffeisen';
  // Wise IBANs are Belgian (BE) / bank-issued; Raiffeisen is CH80808.
  return /^CH\d{2}80808/i.test(iban) ? 'Raiffeisen' : 'Wise';
}

/**
 * Normalize a balance date. camt uses either <Dt>YYYY-MM-DD</Dt> or
 * <DtTm>YYYY-MM-DDThh:mm:ss</DtTm>. A midnight timestamp (T00:00:00) marks the
 * boundary at the *start* of that day, i.e. the close of the previous day —
 * so Wise's CLBD DtTm 2026-07-01T00:00 is the closing balance as of 2026-06-30.
 */
function normalizeBalanceDate(dtEl: any): string {
  if (dtEl == null) return '';
  const dt = typeof dtEl === 'object' ? dtEl : { Dt: dtEl };
  if (dt.Dt) return String(dt.Dt).substring(0, 10);
  const dtTm = String(dt.DtTm ?? '');
  if (!dtTm) return '';
  const datePart = dtTm.substring(0, 10);
  if (/T00:00:00/.test(dtTm)) {
    // Shift back one day: close of the previous day.
    const d = new Date(`${datePart}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().substring(0, 10);
  }
  return datePart;
}

export function parseStatementBalances(xml: string, sourceFile: string): BalanceSnapshot[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['Bal'].includes(name),
  });
  const parsed = parser.parse(xml);
  const stmt = parsed?.Document?.BkToCstmrStmt?.Stmt;
  if (!stmt) return [];

  const iban = String(stmt?.Acct?.Id?.IBAN ?? '');
  const acctCcy = String(stmt?.Acct?.Ccy ?? '');
  const institution = String(stmt?.Acct?.Svcr?.FinInstnId?.Nm ?? '');
  const bank = bankFromInstitution(institution, iban);

  const bals: any[] = stmt?.Bal ?? [];
  const snapshots: BalanceSnapshot[] = [];
  for (const bal of bals) {
    const code = String(bal?.Tp?.CdOrPrtry?.Cd ?? '');
    if (code !== 'OPBD' && code !== 'CLBD') continue;
    const amtEl = bal?.Amt;
    const rawAmount = typeof amtEl === 'object' ? parseFloat(String(amtEl?.['#text'] ?? 0)) : parseFloat(String(amtEl ?? 0));
    const currency = String((typeof amtEl === 'object' ? amtEl?.['@_Ccy'] : undefined) ?? acctCcy ?? 'CHF');
    const cdtDbt = String(bal?.CdtDbtInd ?? 'CRDT');
    // CRDT = money in the account (positive asset); DBIT = overdrawn (negative).
    const amount = cdtDbt === 'DBIT' ? -Math.abs(rawAmount) : Math.abs(rawAmount);
    const date = normalizeBalanceDate(bal?.Dt);
    snapshots.push({ bank, iban, currency, type: code, date, amount, sourceFile });
  }
  return snapshots;
}
