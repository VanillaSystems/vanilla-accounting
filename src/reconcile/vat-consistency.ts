/**
 * VAT consistency audit.
 *
 * Cross-checks each journal entry's VAT code against the receipt-level VAT facts
 * (extract-vat step). It reports — it never mutates — the failure modes that
 * silently cost money or misstate VAT:
 *   - a rate code (I81/M26/...) not backed by any linked receipt showing Swiss MWST
 *   - a rate code with no receipt linked at all (no receipt = no deduction)
 *   - a 0-code (I0/M0) where a linked receipt DOES show Swiss MWST (missed deduction)
 */

import type { Index } from '../types/index.js';

const POS_RATE_CODE = /^-?[IMV](77|81|25|26|37|38)\b/;
const ZERO_CODE = /^-?[IMV]0\b/;

export interface VatAuditReport {
  totalEntries: number;
  rateCodeNoSwissReceipt: string[];
  rateCodeNoReceipt: string[];
  zeroCodeButSwissReceipt: string[];
}

export function auditVat(index: Index): VatAuditReport {
  const entries = index.journalEntries ?? [];

  const receiptsByTx = new Map<string, Array<{ hasSwissVat?: boolean }>>();
  for (const tx of index.transactions) {
    const recs = index.mappings
      .filter((m) => m.transactionRef === tx.ref)
      .map((m) => index.receipts.find((r) => r.id === m.receiptId))
      .filter((r): r is NonNullable<typeof r> => !!r && r.vatExtractedAt != null);
    receiptsByTx.set(tx.ref, recs);
  }

  const report: VatAuditReport = {
    totalEntries: entries.length,
    rateCodeNoSwissReceipt: [],
    rateCodeNoReceipt: [],
    zeroCodeButSwissReceipt: [],
  };

  for (const e of entries) {
    const code = e.vatCode ?? '';
    const desc = e.description ?? '';
    const recs = receiptsByTx.get(e.transactionRef) ?? [];
    const anySwiss = recs.some((r) => r.hasSwissVat === true);
    const label = `${e.transactionRef}  ${code || '(none)'}  ${desc}`;

    // Coop Pronto is an explicit exception: I81 is allowed even when the receipt
    // (bad OCR) or no receipt shows MWST. Don't flag it as a rate-code violation.
    const isCoopPronto = /coop\s*pronto/i.test(desc);
    // Shopify Webshop Gebühren are I81 by rule — Shopify charges 8.1% on fees and
    // the proof is the MONTHLY billing statement, not the per-order payout PDF, so
    // the individual per-order fee transactions legitimately have no linked receipt.
    const isWebshopFee = /webshop\s*geb[üu]hr/i.test(desc);
    // Wise fees are rule-bound to I0 (account 6940) regardless of any statement
    // linked to the same transaction, so a 0-code there is never a missed deduction.
    const isWiseFee = /^wise,/i.test(desc) || /kartengeb|transfergeb|bankspesen/i.test(desc);

    if (POS_RATE_CODE.test(code)) {
      if (isCoopPronto || isWebshopFee) continue;
      if (recs.length === 0) report.rateCodeNoReceipt.push(label);
      else if (!anySwiss) report.rateCodeNoSwissReceipt.push(label);
    } else if (ZERO_CODE.test(code) && anySwiss && /^-?[IM]0\b/.test(code)) {
      // Revenue exports (V0) are legitimately 0-rated even with a Swiss-VAT
      // receipt, so only input-tax (I/M) 0-codes are flagged here.
      if (isWiseFee) continue;
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
  console.log(`  rate code but NO receipt linked at all: ${report.rateCodeNoReceipt.length}`);
  for (const l of report.rateCodeNoReceipt.slice(0, 20)) console.log(`      ⚠ ${l}`);
  console.log(
    `  0-code (I0/M0) but a linked receipt shows Swiss MWST (possible missed deduction): ${report.zeroCodeButSwissReceipt.length}`,
  );
  for (const l of report.zeroCodeButSwissReceipt.slice(0, 20)) console.log(`      ⚠ ${l}`);

  return report;
}
