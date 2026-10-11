/**
 * What the intake reads off a receipt's extracted text without a model: a Swiss UID, a VAT
 * indicator worth a model call, and the vendor traps that look like an invoice but prove no VAT.
 */

// A Swiss UID survives text extraction in more shapes than one: extraction wraps it across
// lines ("#CHE-\n153.004.184 MWST" on Shopify's bills, the same break after "CHE-" on some
// other invoices), and some layouts space the groups out. Matching the strict
// "CHE-###.###.###" form alone produces false "no VAT proof" verdicts on perfectly good
// invoices, so allow whitespace between every part.
const SWISS_UID_RE = /CHE[-\s]*\d{3}[.\s]*\d{3}[.\s]*\d{3}/;

export function hasSwissUid(text: string): boolean {
  return SWISS_UID_RE.test(text);
}

/** Cheap pre-filter: anything that could be Swiss MWST. Absence skips the model and records hasSwissVat=false. */
export function hasVatIndicator(text: string): boolean {
  return /MWST|MwSt|Mehrwertsteuer|CHE-\d{3}|\bVAT\b|USt|\d[.,]\d\s?%/i.test(text);
}

/**
 * Some vendors expose two different PDFs for the same purchase: a summary or confirmation page
 * (no proof of Swiss VAT) and the actual tax invoice (shows the CHE-... UID). Filing the wrong
 * one silently loses the VAT deduction (docs/runbooks/receipt-collection.md lists the traps).
 * This only flags known patterns; absence of a flag is not proof a receipt is fine.
 */
export function detectVatProofIssue(text: string): string | undefined {
  // Amazon.de "Order Summary" (order-history print/PDF) vs. the real per-seller "Rechnung"
  // invoice. The summary only ever shows "Estimated VAT"; the real invoice shows
  // "Rechnungsnummer" + "USt-IDNr. CHE-...".
  if (/Order Summary/i.test(text) && /Estimated VAT/i.test(text) && !hasSwissUid(text)) {
    return '⚠ VAT PROOF MISSING: this looks like an Amazon order-summary page, not the real invoice — no CHE-... VAT ID shown, so it cannot justify a VAT refund. Download the actual "Invoice" PDF per order/seller from the order details popover instead (see docs/runbooks/receipt-collection.md § Amazon.de).';
  }
  return undefined;
}
