import type { BankTransaction, VatRateGroup, ReceiptLine } from "../types/index.js";
import { vat } from "../engines/index.js";
import type { VatSetup } from "../workspace/vat-setup.js";
import { formatCase, type BookingCase } from "../knowledge/cases.js";

export interface MatchResult {
  suggestedFilename: string;
  /** The short title a list shows (TITLE_RULES): parsed into { vendor, what } when both are there. */
  title?: { vendor: string; what: string };
  matchedTransactionRefs: string[];
  date: string;
  description: string;
  amount: number;
  currency: string;
  confidence: number;
}

/** How a receipt's short title is written (the mockup's titles: the vendor, then 1–3 words). */
export const TITLE_RULES = `two parts, in German.
- "v": the vendor as people say it: brand only, no legal form (AG, GmbH, s.r.o., e.K.), no address, no numbers. E.g. "Coop Pronto", "FedEx", "Shopify", "AliExpress", "Google Cloud", "Die Post", "Wise". For the company's own sales (shop orders and payouts, own invoices) use "Verkauf".
- "w": what it is, 1 to 3 German words, the essence only. No amounts, no dates, no invoice numbers, no VAT info, no parentheses. E.g. "Benzin", "Zoll", "Fracht", "Monatsabo", "Autowäsche", "Leere Datei" (a blank capture). For a sale the order number, e.g. "#1132". For a bank statement the month and currency, e.g. "Kontoauszug USD Feb".`;

/** A model's {v, w}, kept only when both are short text. */
export function parseTitle(x: unknown): { vendor: string; what: string } | undefined {
  const o = x as { v?: unknown; w?: unknown } | undefined;
  const v = typeof o?.v === 'string' ? o.v.trim() : '', w = typeof o?.w === 'string' ? o.w.trim() : '';
  return v && w && v.length <= 40 && w.length <= 40 ? { vendor: v, what: w } : undefined;
}

export function buildMatchPrompt(
  extractedText: string,
  transactions: BankTransaction[],
  pdfPath?: string,
): string {
  const receiptSection = pdfPath
    ? `## Receipt\nUse the Read tool to read the file '${pdfPath}' and extract vendor, amount, date, and currency from it.`
    : `## Receipt Text\n${extractedText || "(no text extracted)"}`;

  return `You are an accounting assistant matching receipts to bank transactions.

${receiptSection}

## Bank Statement Transactions (the payments without a receipt most likely to fit, best first)
${JSON.stringify(transactions, null, 2)}

## Instructions
Match the receipt to the most likely bank transaction(s). Priority order:
1. **AMOUNT MATCH** (most important) - receipt amount should closely match transaction amount
   (EXCEPT for grouped vendors — see note below, where the receipt amount may be a fraction of the transaction)
2. Vendor name in receipt text vs. transaction description
3. Date proximity

Rules:
- One receipt can match multiple transactions (e.g. Wise multi-currency splits where one purchase debits multiple accounts)
- Multiple receipts can match one transaction (e.g. FedEx freight invoice + customs invoice)
- Multi-currency: receipt may be in EUR/USD, bank transaction in CHF
- Transactions are a short selection of the payments without a receipt, ranked by an invoice number in their text, amount, vendor name and date
- A transaction with "filed": true lies in a quarter whose VAT return is filed. Name it like any other when the receipt pays it (a receipt that came late); the app links nothing there and books its tax as a correction
- If no good match exists, return empty matchedTransactionRefs and confidence < 0.5

## Grouped Vendor Note (Amazon, AliExpress, FedEx)
These vendors bundle multiple separate purchases/shipments into ONE bank transaction. A receipt from
one of these vendors is often just ONE item/seller/shipment out of several, so its amount can be much
SMALLER than the matched transaction's amount — that is expected and should NOT lower your confidence.
For these vendors, match primarily on vendor name, order number, and date proximity rather than amount
equality (the provided candidates are pre-filtered by vendor keyword, not amount, for this reason).
If the receipt's vendor keyword and date/order date match a candidate's description and date within a
day or two, assign confidence >= 0.85 even though the amounts differ — a low amount-based confidence
score would be wrong here and would cause a real match to be dropped. Only fall back to a lower
confidence when there are multiple same-vendor candidates on the same date and nothing else (order
number, item description, seller name) distinguishes which one this receipt belongs to. Exclude
candidates whose direction is CRDT (refund/credit) unless the receipt itself is a refund/credit note.

## Wise Multi-Currency Note
Wise bank statement transactions may show a foreign currency amount even when booked in a different account currency.
Example: a USD charge deducted from the Wise EUR account will show the original USD amount in the Wise monthly PDF bank statement — that USD amount does not appear anywhere else.
When matching, cross-reference the original foreign currency amount from the Wise statement against the receipt amount, not just the converted CHF/EUR booking amount.

Return ONLY a valid JSON object with these fields:
{
  "suggestedFilename": "YYYYMMDD-vendor-name.pdf",
  "matchedTransactionRefs": ["WEUR000042", "20123456789"],
  "date": "YYYY-MM-DD",
  "description": "Vendor / purpose (for a shipping or customs invoice: include total amount, invoice number, and the webshop order number prefixed with # when the shipment names one, e.g. #1001)",
  "amount": 85.40,
  "currency": "CHF",
  "confidence": 0.95,
  "title": { "v": "Coop Pronto", "w": "Benzin" }
}

Rules for title: ${TITLE_RULES}

Rules for suggestedFilename: YYYYMMDD prefix, lowercase, hyphens instead of spaces, no special chars, end with .pdf.

Rules for description:
- General: concise vendor name and purchase purpose
- Shipping or customs invoices: include total amount (e.g. "CHF 12.50"), invoice number, and the webshop order number prefixed with # when the shipment names one (e.g. "#1001")`;
}

/** OCR of a scanned PDF through the Read tool. The path is absolute: `ask` runs from an empty directory. */
export function buildVisionPrompt(absPdfPath: string): string {
  return `Verwende das Read-Tool, um die Datei '${absPdfPath}' zu lesen. ` +
    'Extrahiere den vollständigen Text aus diesem Beleg/Rechnung. ' +
    'Beginne mit einer kurzen deutschen Beschreibung (z.B. "Tankquittung", "Lebensmitteleinkauf"), ' +
    'gefolgt von einer Leerzeile, dann der vollständige Text. Kein weiterer Kommentar.';
}

export interface ClassifyEntry {
  accountDebit: string;
  accountCredit: string;
  amount: number;
  vatCode: string;
  description: string;
}

export interface BatchClassifyResult {
  /** `reason`: why it is booked so, in a sentence the person reads on the booking. */
  [txRef: string]: { entries: ClassifyEntry[]; reason?: string };
}

interface TxInput {
  ref: string;
  date: string;
  amount: number;
  currency: string;
  direction: string;
  description: string;
  bank: string;
  /** Who paid or was paid, as the bank names them; the description often leaves it out. */
  counterparty?: string;
}

const CLASSIFY_INSTRUCTIONS = `## Instructions
1. Determine the correct expense/revenue account(s) based on the transaction description, receipt text, and historic patterns.
2. The bank account side is already determined — do NOT set it. Leave accountDebit or accountCredit as empty string "" for the bank side. The system will fill it in.
3. For DBIT (money out): the bank account is credited (leave accountCredit as ""), set accountDebit to the expense account.
4. For CRDT (money in): the bank account is debited (leave accountDebit as ""), set accountCredit to the revenue account.
5. IMPORTANT — Multiple receipts per transaction (Aliexpress, Amazon, FedEx, etc.):
   These vendors group multiple separate purchases/invoices into a single bank transaction.
   You MUST create one journal entry row per receipt. Do NOT combine them into a single entry.
   - Each receipt has its own item, its own account, and its own description.
   - Use each receipt's amount (converted to the transaction currency if needed) as the entry amount.
   - Assign each receipt to its correct expense account based on what was purchased (read the receipt text carefully).
   - Example: an Aliexpress transaction with 3 receipts (milk jugs, grinder burrs, USB cable) → 3 journal entries, e.g. 4210/6100/6570.
   - If two receipts genuinely go to the same account, they still get separate rows with separate descriptions.
6. The entries must move the bank account by exactly the transaction amount: the bank paid what the bank paid.
   Every row has both accounts, except the bank side you leave "" (and the single-leg VAT-amount row of rule 9b).
6b. Skonto / a discount taken at payment (the bank paid less than the invoice total): book what the bank paid,
   ONE entry for the transaction amount on the expense account with the receipt's VAT code. Cash basis: the
   discount reduces the expense and the input tax, which is the tax on the amount paid. Never add a separate
   Skonto row with an empty account. Example: invoice 1000.00 incl. 8.1% MWST, paid 980.00 with 2% Skonto
   → { "accountDebit": "4400", "accountCredit": "", "amount": 980.00, "vatCode": "M81", "description": "Lieferant, Material (2% Skonto)" }.
7. VAT code rules (CRITICAL — follow exactly):
   a) Code prefix is determined by the ACCOUNT NUMBER, not the vendor:
      - 4xxx accounts (material/goods) → M-codes (M0, M81, M26, ...)
      - 5xxx/6xxx accounts (operating expenses) → I-codes (I0, I81, I26, ...)
      - 1xxx accounts (assets/investments) → I-codes
      - 3xxx accounts (sales revenue, credit side) → V-codes (V0, V81, V26, ...)
   b) The rate SUFFIX comes from the receipt's "VAT facts" line (extracted directly off
      the receipt — this is the source of truth, use it over anything in the receipt text):
      - "NO Swiss MWST" / no VAT facts line → 0-rate code (I0/M0/V0).
      - Otherwise use the suffix given for the rate: 8.1%→81, 2.6%→26, 3.8%→38
        (historical 7.7→77, 2.5→25, 3.7→37). Combine prefix + suffix, e.g. account 6570
        with an 8.1% fact → I81; a 4400 material line at 2.6% → M26.
   c) No receipt at all (no VAT facts line) on a PURCHASE → 0-rate code (I0/M0): no receipt, no input tax.
      A SALE (CRDT on a 3xxx account) owes its output tax with or without an invoice: a customer in
      Switzerland or Liechtenstein → V81, a customer abroad → V0. The app checks the code against the
      payment and asks the owner; never book a domestic sale V0 for want of a receipt.
   g) A sale whose invoice shows no Swiss MWST because the place of supply of the service is abroad
      ("Leistungsort Deutschland", "nicht der schweizerischen MWST unterstellt") → V0-E (Ziffer 221).
      V0 (Ziffer 220) is the export of goods only.
   d) Refunds invert the code with a minus prefix (e.g. -I81, -M26).
   e) Exception: Coop Pronto receipts can be assumed I81 (always charge 8.1% MWST even if OCR is bad).
   f) MULTI-RATE RECEIPTS: when a receipt's VAT facts list MORE THAN ONE positive rate
      (e.g. Coop fuel "8.1% + 0%", or a mixed cart "8.1% + 2.6%"), SPLIT it into one journal
      entry per rate group. Use each group's gross as that entry's amount and the group's
      suffix for its code. Keep the same expense account for all split rows unless the items
      clearly belong to different accounts. The split rows must sum to the receipt total.
8. For Wise fees (description starts with "Wise Charges"): use account 6940 (Bankspesen) with VatCode I0.
9. For Shopify/Stripe sales (Webshop orders): ALWAYS produce exactly 2 journal entry rows. Specify BOTH accountDebit AND accountCredit (do NOT leave one empty):
   a) Revenue: accountDebit "1093" / accountCredit "3450" — full order amount. Use V81 for Swiss customers, V0 for exports.
   b) Shopify fees: accountDebit "6580" / accountCredit "1093" — the fee amount (= order amount minus Stripe payout, as shown on the Shopify receipt)
   The system will automatically add a third entry for the Stripe payout (D=bank C=1093) — do NOT add it yourself.
9a. Card-terminal and payment-provider payouts (SumUp, Payrexx, Worldline, Stripe Terminal, TWINT): the payout is
   the card sales at the company's own place of business minus the provider's fees. Its payout report rarely shows MWST,
   yet the sales are domestic sales: book the GROSS sales on the revenue account with V81 (the normal rate; another
   rate only when the report shows it), a refund in the report with -V81, and the fees as their own row on the
   bank-fee account with I0 (payment processing is exempt: no input tax, no Bezugsteuer). The rows sum to the payout.
   Without the report: the whole payout on the revenue account with V81.
9b. Shopify MONTHLY VAT correction (Vorsteuer on transaction fees) — a SEPARATE booking, not a sales order.
   The monthly Shopify billing statement ("Payments Invoice") shows the 8.1% Swiss MWST on the fees that the
   per-order payouts hide. Book ONLY the VAT as a SINGLE-LEG correction — this is the ONE case where a leg is
   intentionally left empty (rule 9's "both legs" requirement is about sales rows, not this):
     - accountDebit: "" (EMPTY) — the VatCode supplies this leg to the MWST account automatically
     - accountCredit: "6580"
     - amount: the VAT amount only (= gross fees × 8.1 / 108.1)
     - VatCode: "M81-2"  (a "-2" / MwSt-Betrag code: the amount IS the VAT amount)
   Do NOT touch 2451 (Kontokorrent) and do NOT fill both legs. Description: "Shopify, Vorsteuer Transaktionsgebühren <Mon JJJJ>".
10. Description rules:
   - MUST be in German
   - Format: "Wer, Was" — vendor first, then purpose, comma-separated
   - "Wer" is the real name: the receipt's vendor, else the transaction's Counterparty. Never a role ("Kunde", "Mitarbeiter", "Mobilfunkanbieter") in place of a name you were given
   - Max 60 characters
   - NEVER use raw bank text like "Card Transaction Of..." or "Received Money From..." or "Issued By..." — always clean it up
   - No amounts in description (the amount is its own field)
   - Use these templates for common categories:
     * Subscriptions/SaaS: "Anbieter, Abo Produkt" → "Anthropic, Abo Claude AI"
     * Webshop orders (Stripe/Shopify): "Webshop Bestellung #NNNN, Kundenname, Land" → "Webshop Bestellung #1001, M. Muster, USA"; customer name and country are required
     * Webshop fees: "Webshop Gebühren #NNNN" → "Webshop Gebühren #1001"
     * Webshop refunds: "Webshop Rückerstattung #NNNN" → "Webshop Rückerstattung #1002"
     * Shipping (FedEx): "FedEx, Versand #NNNN Fracht/Zölle/MWST/Abwicklung" → "FedEx, Versand #1001 Fracht"; #NNNN is the webshop order number, not the carrier's invoice number; if an invoice covers multiple webshop orders, include the order refs like "#1003/#1004"
     * Fuel: "Tankstelle Ort, Tanken" → "Coop Pronto Musterdorf, Tanken"
     * Rent: "Garagenmiete, Mon JJJJ" → "Garagenmiete, Jan 2026"
     * Purchases: "Händler, Was" → "Digitec, Bürobedarf"
     * Vehicle: "Werkstatt, Fahrzeug Was" → "Garage Muster, Lieferwagen Reifenwechsel"
     * Bank fees: "Bank, Kontoführung Zeitraum" → "Raiffeisen, Kontoführung Q1 2026"
     * Wise card fees: "Wise, Kartengebühren"
     * Stripe payouts: "Stripe, Auszahlung #NNNN"
     * Taxes/AHV: "Amt, Steuerart Periode" → "Ausgleichskasse Musterkanton, AHV Q1 2026"
     * General: "Wer, Was" → "Post, Verzollung Bestellung"`;

export interface ReceiptInput {
  text: string;
  amount?: number;
  currency?: string;
  description?: string;
  filename?: string;
  // VAT facts extracted at the receipt level (extract-vat step) — source of
  // truth for the rate. See buildReceiptVatPrompt / hasDomesticVat.
  hasSwissVat?: boolean;
  vatId?: string;
  vatSummary?: VatRateGroup[];
  lineItems?: ReceiptLine[];
}

// Map a Swiss VAT rate to the code suffix used in the chart of VAT codes.
export function vatRateSuffix(rate: number): string {
  const map: Record<number, string> = { 8.1: '81', 7.7: '77', 3.8: '38', 3.7: '37', 2.6: '26', 2.5: '25', 0: '0' };
  return map[rate] ?? String(rate);
}

// Render the receipt's VAT facts as a compact, authoritative line for the
// classify prompt — so the rate no longer depends on (truncated) receipt text.
export function formatVatFacts(r: ReceiptInput): string | null {
  if (r.hasSwissVat === undefined && !r.vatSummary) return null; // not extracted yet
  if (r.hasSwissVat === false) return 'VAT facts: NO Swiss MWST on receipt → a purchase: 0-rate code (I0/M0); a sale: see rules 7c, 7g and 9a';
  const groups = (r.vatSummary ?? []).filter((g) => g.ratePercent > 0);
  if (groups.length === 0) {
    return r.hasSwissVat
      ? `VAT facts: Swiss MWST present${r.vatId ? ` (${r.vatId})` : ''} but rate not parsed — assume 8.1% (suffix 81) unless the text says otherwise`
      : null;
  }
  const parts = groups.map(
    (g) =>
      `${g.ratePercent}% → suffix ${vatRateSuffix(g.ratePercent)}${g.gross != null ? `, gross ${g.gross}` : ''}${g.vat != null ? `, vat ${g.vat}` : ''}`,
  );
  return `VAT facts: Swiss MWST${r.vatId ? ` ${r.vatId}` : ''} — ${parts.join('; ')}`;
}

/** What every classify prompt says about the company: its name, chart, prior-year entries, VAT codes, and the firm's VAT setup (absent: the effective method). */
export interface ClassifyPromptContext {
  companyName: string;
  chartOfAccounts: string;
  historicEntries: string;
  vatCodes: string;
  vat?: VatSetup;
}

/** The VAT part of the prompt: the full code reference for the effective method; what the other kinds of firm book instead (code enforces it either way). */
function vatSection(vatCodes: string, setup: VatSetup | undefined): string {
  if (setup && !setup.registered) {
    return `## VAT
The company is NOT registered for VAT. Leave "vatCode" empty ("") on EVERY row and book every amount gross, whatever a receipt shows. Ignore the VAT code rules below.`;
  }
  if (setup?.registered && setup.method === 'net-rate') {
    const rates = setup.rates.map((r, i) => `F${i + 1} = ${r.rate} %${r.label ? ` (${r.label})` : ''}`).join(', ');
    return `## VAT (net tax rate method, Saldosteuersatz)
The company files with approved flat rates on its gross turnover: ${rates}. Rules for THIS company, which replace the I/M/V rules below:
- A PURCHASE (expense, material, investment) carries NO VAT code (""), whatever the receipt shows: there is no input tax.
- A SALE on a revenue account carries ${setup.rates.length > 1 ? 'F1 or F2 (the approved rate that fits the activity)' : 'F1'} with the GROSS amount; an export of goods V0; a service supplied abroad V0-E.
- Bezugsteuer on a service from abroad: B81.`;
  }
  return `## VAT Codes Reference
${vatCodes}`;
}

export function buildBatchClassifyPrompt(
  transactions: Array<{ tx: TxInput; receipts: ReceiptInput[] }>,
  { companyName, chartOfAccounts, historicEntries, vatCodes, vat: setup }: ClassifyPromptContext,
  cases: readonly BookingCase[] = [],
): string {
  const txSections = transactions.map(({ tx, receipts }, i) => {
    let receiptPart: string;
    if (receipts.length === 0) {
      receiptPart = '  No receipt.';
    } else if (receipts.length === 1) {
      const r = receipts[0];
      const meta = [r.amount != null && r.currency && `${r.amount} ${r.currency}`, r.description].filter(Boolean).join(' — ');
      const vat = formatVatFacts(r);
      receiptPart = `  Receipt${meta ? ` (${meta})` : ''}:${vat ? `\n    ${vat}` : ''}\n    ${r.text.slice(0, 1200)}`;
    } else {
      receiptPart = `  Receipts (${receipts.length} — create one entry per receipt):\n${receipts.map((r, j) => {
        const meta = [r.filename, r.amount != null && r.currency && `${r.amount} ${r.currency}`, r.description].filter(Boolean).join(' | ');
        const vat = formatVatFacts(r);
        return `    ${j + 1}. ${meta ? `[${meta}] ` : ''}${vat ? `${vat} — ` : ''}${r.text.slice(0, 700)}`;
      }).join('\n')}`;
    }
    return `### Transaction ${i + 1}: ${tx.ref}
  Date: ${tx.date} | Amount: ${tx.amount} ${tx.currency} | Direction: ${tx.direction} | Bank: ${tx.bank}
  Bank description: ${tx.description}${tx.counterparty ? `\n  Counterparty: ${tx.counterparty}` : ''}
${receiptPart}`;
  }).join('\n\n');

  return `You are an accounting assistant for ${companyName} (Swiss company, cash basis taxation).
Classify these bank transactions into journal entry rows for Banana Accounting.

## Bank Transactions
${txSections}

## Chart of Accounts
${chartOfAccounts}

${vatSection(vatCodes, setup)}

## Historic Journal Entry Examples (prior year)
${historicEntries}
${cases.length ? `
## Casebook: invented examples of how similar cases are booked
These are standard Swiss cases on KMU account numbers. Follow their pattern and VAT code, but use this company's own chart of accounts above. "bank" is the side you leave empty.
${cases.map(formatCase).join('\n')}
` : ''}
${CLASSIFY_INSTRUCTIONS}

Return ONLY a valid JSON object keyed by transaction ref. Each value has an "entries" array and a "reason":
one short German sentence the bookkeeper reads on the booking, naming the receipt fact and the rule behind the
account and the VAT code (e.g. "Beleg DigitalOcean zeigt 8.1 % MWST mit CHE-Nummer: Webhosting auf 6570, I81.").
Example:
{
  "WEUR000042": {
    "entries": [
      { "accountDebit": "6570", "accountCredit": "", "amount": 7.55, "vatCode": "I81", "description": "DigitalOcean, Webhosting" }
    ],
    "reason": "Beleg DigitalOcean zeigt 8.1 % MWST mit CHE-Nummer: Webhosting auf 6570, I81."
  },
  "20123456790": {
    "entries": [
      { "accountDebit": "6940", "accountCredit": "", "amount": 0.02, "vatCode": "I0", "description": "Wise, Kartengebühren" }
    ],
    "reason": "Wise-Gebühr ohne Beleg: Bankspesen 6940, ohne Vorsteuer (I0)."
  }
}`;
}

export function parseBatchClassifyResult(raw: string): BatchClassifyResult | null {
  const cleaned = raw
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
  try {
    return JSON.parse(cleaned) as BatchClassifyResult;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as BatchClassifyResult;
      } catch {}
    }
    return null;
  }
}

// ─── Receipt-level VAT extraction (extract-vat step) ─────────────────────────
//
// Reads ONLY the VAT facts off a receipt — the printed MWST summary block,
// the CHE- UID, and (best-effort) itemized lines. It deliberately does NOT
// assign accounting codes (I/M/V) or decide refunds — that is classify's job.
// This is where the "the receipt is the source of truth" rule is grounded.

export interface ReceiptVatResult {
  vatId?: string;
  currency?: string;
  total?: number;
  hasSwissVat: boolean;
  vatSummary: VatRateGroup[];
  lineItems?: ReceiptLine[];
}

export function buildReceiptVatPrompt(text: string): string {
  return `You are a Swiss accounting assistant. Extract ONLY the VAT (MWST) facts from this receipt.
Do NOT assign accounting codes, accounts, or decide anything about refunds — extract what is printed.

## Receipt Text
${(text || "(no text)").slice(0, 8000)}

## What to extract
1. vatId: the Swiss UID if shown (format "CHE-###.###.###"), else "".
2. currency: ISO code of the amounts (CHF, EUR, USD, ...).
3. total: the receipt grand total (gross), as a number.
4. hasSwissVat: true ONLY if the receipt shows a POSITIVE Swiss MWST rate was charged
   — a Swiss rate is 8.1%, 2.6%, or 3.8% (historically also 7.7%/2.5%/3.7%).
   - A FOREIGN rate is NOT Swiss VAT: e.g. 19% (Germany), 20%, 21%, 22%. Set hasSwissVat=false
     for these EVEN IF a "CHE-..." UID appears — that UID may just be the seller's own
     letterhead on an invoice billed to a foreign customer in a foreign currency.
   - A 0%-only receipt (exempt/export) is hasSwissVat=false.
   - If no Swiss rate is shown at all, set hasSwissVat=false. Do NOT infer VAT from the
     vendor's country. Still record any foreign rate you see in vatSummary (facts), but
     hasSwissVat stays false unless a positive Swiss rate is present.
5. vatSummary: one entry per VAT rate PRINTED on the receipt's MWST summary block.
   Each: { "ratePercent": 8.1, "net": 49.49, "vat": 4.01, "gross": 53.50 }.
   Take the numbers straight from the receipt. Omit net/gross if the receipt does not print them,
   but always include vat and ratePercent. A 0%/exempt portion has ratePercent 0 and vat 0.
6. lineItems (optional, best-effort): only include when the receipt itemizes purchases AND the
   items fall under different rates or clearly different expense categories. Each:
   { "description": "...", "gross": 12.90, "ratePercent": 8.1 }. Omit entirely for simple receipts.

Return ONLY a valid JSON object, no commentary:
{
  "vatId": "CHE-###.###.###",
  "currency": "CHF",
  "total": 53.50,
  "hasSwissVat": true,
  "vatSummary": [ { "ratePercent": 8.1, "net": 49.49, "vat": 4.01, "gross": 53.50 } ],
  "lineItems": []
}`;
}

export function parseReceiptVat(raw: string): ReceiptVatResult | null {
  const cleaned = raw
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  let parsed: any = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {}
    }
  }
  // An answer without both facts the prompt asks for is no answer, not "no VAT".
  if (!parsed || typeof parsed !== "object" || typeof parsed.hasSwissVat !== "boolean" || !Array.isArray(parsed.vatSummary)) return null;

  const summary: VatRateGroup[] = parsed.vatSummary
    .filter((g: any) => g && typeof g.ratePercent === "number")
    .map((g: any) => ({
      ratePercent: g.ratePercent,
      net: typeof g.net === "number" ? g.net : undefined,
      vat: typeof g.vat === "number" ? g.vat : 0,
      gross: typeof g.gross === "number" ? g.gross : undefined,
    }));

  const lineItems: ReceiptLine[] | undefined = Array.isArray(parsed.lineItems) && parsed.lineItems.length
    ? parsed.lineItems
        .filter((l: any) => l && typeof l.description === "string")
        .map((l: any) => ({
          description: l.description,
          gross: typeof l.gross === "number" ? l.gross : 0,
          ratePercent: typeof l.ratePercent === "number" ? l.ratePercent : undefined,
          suggestedAccount: typeof l.suggestedAccount === "string" ? l.suggestedAccount : undefined,
        }))
    : undefined;

  return {
    vatId: typeof parsed.vatId === "string" && parsed.vatId.trim() ? parsed.vatId.trim() : undefined,
    currency: typeof parsed.currency === "string" ? parsed.currency : undefined,
    total: typeof parsed.total === "number" ? parsed.total : undefined,
    hasSwissVat: hasDomesticVat(summary, parsed.hasSwissVat === true),
    vatSummary: summary,
    lineItems,
  };
}

export function parseMatchResult(raw: string): MatchResult | null {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  let parsed: MatchResult | null = null;
  try {
    parsed = JSON.parse(cleaned) as MatchResult;
  } catch {
    // Try to extract JSON object from within the string
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]) as MatchResult;
      } catch {}
    }
  }
  if (!parsed) return null;
  // Validate suggestedFilename is present and ends with .pdf
  if (!parsed.suggestedFilename || !parsed.suggestedFilename.trim().toLowerCase().endsWith('.pdf')) {
    return null;
  }
  const title = parseTitle((parsed as { title?: unknown }).title);
  delete parsed.title;
  return title ? { ...parsed, title } : parsed;
}

/**
 * Whether a receipt charged the jurisdiction's own VAT: only when it shows one of its positive
 * rates (modules/ch/rates.yaml). A 0%-only summary or a foreign rate does not count, even under a
 * domestic VAT number in the letterhead. When no rate could be parsed at all (poor OCR), the
 * model's own call decides.
 */
function hasDomesticVat(summary: VatRateGroup[], llmSaidYes: boolean): boolean {
  if (summary.some((g) => g.ratePercent > 0 && vat().isDomesticRate(g.ratePercent))) return true;
  return summary.length === 0 ? llmSaidYes : false;
}
