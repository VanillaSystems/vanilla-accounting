/**
 * Wise monthly statement PDFs carry one fact the Wise camt053 export drops: the payment
 * reference of a transfer ("Invoice 2026000001 Ref.: 1234567890-1", a QR reference). Each
 * transaction ends with a line like
 *   25 August 2026 | Transaction: TRANSFER-1234567890 | Reference: Invoice 2026000001 Ref.: …
 * Returns transaction id → reference, from `pdftotext -raw` output.
 */
export function wiseReferences(rawText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of rawText.matchAll(/Transaction: ([A-Z]+-[\w-]+)\s*\|\s*Reference: ([^\n]+)/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}
