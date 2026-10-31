/**
 * VAT consistency audit.
 *
 * Cross-checks each journal entry's VAT code against the receipt-level VAT facts
 * (extract-vat step). It reports — it never mutates — the failure modes that
 * silently cost money or misstate VAT:
 *   - a rate code (I81/M26/...) not backed by any linked receipt showing Swiss MWST, all of them read
 *   - a rate code whose linked receipts show no Swiss MWST and one of them has its VAT not read: no
 *     facts yet, or a «no VAT» off a text that is not legible (#284): the proof may be there
 *   - a rate code with no receipt linked at all and no other proof named (BankTransaction.inputTaxProof)
 *   - a 0-code (I0/M0) where a linked receipt DOES show Swiss MWST (missed deduction), unless the
 *     line is on an account the bank's own fee movements are booked on (isSeparateFee): a bank fee is
 *     an exempt financial service (MWSTG Art. 21 Abs. 2 Ziff. 19), and the receipt linked beside it
 *     is the paid merchant's
 */

import type { Index, Receipt } from '../types/index.js';
import { isSeparateFee } from '../booking/separate-fee.js';
import { unprovenNoVat } from '../parsers/receipt-text.js';

const POS_RATE_CODE = /^-?[IMV](77|81|25|26|37|38)\b/;
const ZERO_CODE = /^-?[IMV]0\b/;

/** A receipt whose VAT facts were read: by a person, or by the VAT step off a text that proves what it lacks. */
const vatRead = (r: Receipt) => r.vatBy === 'human' || (r.vatExtractedAt != null && !unprovenNoVat(r));
/** A receipt whose VAT is not read: no facts yet, or a «no VAT» off a text that proves nothing (#284). */
const vatUnread = (r: Receipt) => r.vatBy !== 'human' && (r.hasSwissVat === undefined || unprovenNoVat(r));

export interface VatAuditReport {
  totalEntries: number;
  rateCodeNoSwissReceipt: string[];
  rateCodeVatNotRead: string[];
  rateCodeNoReceipt: string[];
  zeroCodeButSwissReceipt: string[];
}

export function auditVat(index: Index): VatAuditReport {
  const entries = index.journalEntries ?? [];

  const feeTxs = new Set(index.transactions.filter(isSeparateFee).map((tx) => tx.ref));
  const feeAccounts = new Set(entries.filter((e) => feeTxs.has(e.transactionRef)).map((e) => e.accountDebit).filter(Boolean));
  const proved = new Set(index.transactions.filter((tx) => tx.inputTaxProof).map((tx) => tx.ref));
  const linkedTo = new Map<string, Receipt[]>();
  for (const tx of index.transactions) {
    const linked = index.mappings
      .filter((m) => m.transactionRef === tx.ref)
      .map((m) => index.receipts.find((r) => r.id === m.receiptId))
      .filter((r): r is Receipt => !!r);
    linkedTo.set(tx.ref, linked);
  }

  const report: VatAuditReport = {
    totalEntries: entries.length,
    rateCodeNoSwissReceipt: [],
    rateCodeVatNotRead: [],
    rateCodeNoReceipt: [],
    zeroCodeButSwissReceipt: [],
  };

  for (const e of entries) {
    const code = e.vatCode ?? '';
    const desc = e.description ?? '';
    const linked = linkedTo.get(e.transactionRef) ?? [];
    const recs = linked.filter(vatRead);
    const anySwiss = recs.some((r) => r.hasSwissVat === true);
    const label = `${e.transactionRef}  ${code || '(none)'}  ${desc}`;

    if (POS_RATE_CODE.test(code)) {
      const unread = linked.some(vatUnread);
      if (anySwiss) continue;
      if (recs.length && !unread) report.rateCodeNoSwissReceipt.push(label);
      else if (proved.has(e.transactionRef)) continue;
      else if (unread) report.rateCodeVatNotRead.push(label);
      else report.rateCodeNoReceipt.push(label);
    } else if (ZERO_CODE.test(code) && anySwiss && /^-?[IM]0\b/.test(code)) {
      // Revenue exports (V0) are legitimately 0-rated even with a Swiss-VAT
      // receipt, so only input-tax (I/M) 0-codes are flagged here.
      if (feeAccounts.has(e.accountDebit)) continue;
      report.zeroCodeButSwissReceipt.push(label);
    }
  }

  return report;
}

export function reconcileVat(index: Index): VatAuditReport {
  const report = auditVat(index);
  if (report.totalEntries === 0) return report;

  console.log(`\n── VAT consistency audit (${report.totalEntries} entries) ──`);
  console.log(`  rate code but NO linked receipt shows Swiss MWST: ${report.rateCodeNoSwissReceipt.length}`);
  for (const l of report.rateCodeNoSwissReceipt.slice(0, 20)) console.log(`      ⚠ ${l}`);
  console.log(`  rate code, a receipt is linked but its VAT is not read yet (no facts, or its text is not legible): ${report.rateCodeVatNotRead.length}`);
  for (const l of report.rateCodeVatNotRead.slice(0, 20)) console.log(`      ? ${l}`);
  console.log(`  rate code but NO receipt linked at all: ${report.rateCodeNoReceipt.length}`);
  for (const l of report.rateCodeNoReceipt.slice(0, 20)) console.log(`      ⚠ ${l}`);
  console.log(
    `  0-code (I0/M0) but a linked receipt shows Swiss MWST (possible missed deduction): ${report.zeroCodeButSwissReceipt.length}`,
  );
  for (const l of report.zeroCodeButSwissReceipt.slice(0, 20)) console.log(`      ⚠ ${l}`);

  return report;
}
