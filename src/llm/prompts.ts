import type { BankTransaction, OrderFacts, PayoutFacts, PayoutShare, VatRateGroup, ReceiptLine, Supply } from "../types/index.js";
import { vat } from "../engines/index.js";
import type { VatSetup } from "../workspace/vat-setup.js";
import type { SalesDefaults } from "../workspace/sells.js";
import type { SalesKind } from "../workspace/setup.js";
import type { VatLineFacts } from "../accounting/vat-codes.js";
import { formatCase, type BookingCase } from "../knowledge/cases.js";

export interface MatchResult {
  suggestedFilename: string;
  /** The short title a list shows (TITLE_RULES): parsed into { vendor, what } when both are there. */
  title?: { vendor: string; what: string };
  /** A payout report's figures (PAYOUT_RULES), kept only when they add up. */
  payout?: PayoutFacts;
  /** An order document's facts (ORDER_RULES), kept only when they hold together. */
  order?: OrderFacts;
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
/** The figures a payout report states; the model gives them once, at the match step, and the booking step books every linked payout by them (src/booking/classify.ts). */
export const PAYOUT_RULES = `only for the payout report of a card terminal or payment provider (SumUp, TWINT, Stripe, Payrexx, Worldline): "sales" (the card sales before any refund), "refunds", "fees" (the provider's) and "paidOut" (what reached the bank), each a positive number, so that sales − refunds − fees = paidOut; a monthly report gives its totals for the whole month. Leave "payout" out for any other document.`;

/** The report's figures when they are four finite, non-negative numbers that add up (to the Rappen); anything else is no fact. */
export function parsePayoutFacts(x: unknown): PayoutFacts | undefined {
  const o = x as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return undefined;
  const n = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : undefined);
  const [sales, refunds, fees, paidOut] = [n('sales'), n('refunds') ?? 0, n('fees') ?? 0, n('paidOut')];
  if (sales === undefined || paidOut === undefined) return undefined;
  return Math.abs(sales - refunds - fees - paidOut) < 0.05 ? { sales, refunds, fees, paidOut } : undefined;
}

/** What an order document states, for the booking step's split of the payout it names (src/booking/payout-orders.ts). */
export const ORDER_RULES = `only for the page of ONE order of the company's own shop or sales platform (an order page, a sales record of one order): "number" (the order number without #), "date" (YYYY-MM-DD), "currency" (the currency of the amounts paid out, e.g. "EUR" when the page says what was added to a EUR payout), "gross" (what the customer paid, in that currency), "shipTo" (the DELIVERY address's country as its ISO 3166 two-letter code, never the billing address), "tax" (only when the order shows a tax line: { "country": the two-letter code of the country whose VAT it charges, "rate": the percent }), "payouts" (every payout the page says the order went into: { "date": the payout's date as the page names it, "amount": what was added to it }) and "refunds" (every refund the page says was deducted from a payout: { "date", "amount" }), amounts positive. Leave "order" out for any other document.`;

const isoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** An order's facts when they hold together: a number, a day, a currency, ISO countries, positive amounts, and no more paid out than paid. */
export function parseOrderFacts(x: unknown): OrderFacts | undefined {
  const o = x as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return undefined;
  const shares = (v: unknown): PayoutShare[] | undefined => {
    const list = v === undefined ? [] : v;
    if (!Array.isArray(list)) return undefined;
    const out = list.map((s) => (s && isoDay(s.date) && positive(s.amount) ? { date: s.date, amount: s.amount } : undefined));
    return out.every(Boolean) ? (out as PayoutShare[]) : undefined;
  };
  const number = typeof o.number === 'string' || typeof o.number === 'number' ? String(o.number).replace(/^#/, '').trim() : '';
  const country = (v: unknown) => typeof v === 'string' && /^[A-Z]{2}$/.test(v);
  const t = o.tax as Record<string, unknown> | undefined;
  const tax = t === undefined || t === null ? undefined : country(t.country) && positive(t.rate) ? { country: t.country as string, rate: t.rate as number } : null;
  const [payouts, refunds] = [shares(o.payouts), shares(o.refunds)];
  if (!number || !isoDay(o.date) || typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency) || !positive(o.gross) || !country(o.shipTo) || tax === null || !payouts || !refunds) return undefined;
  if (payouts.reduce((s, p) => s + p.amount, 0) > o.gross + 0.005) return undefined;
  return { number, date: o.date, currency: o.currency, gross: o.gross, shipTo: o.shipTo as string, ...(tax ? { tax } : {}), payouts, refunds };
}

export function parseTitle(x: unknown): { vendor: string; what: string } | undefined {
  const o = x as { v?: unknown; w?: unknown } | undefined;
  const v = typeof o?.v === 'string' ? o.v.trim() : '', w = typeof o?.w === 'string' ? o.w.trim() : '';
  return v && w && v.length <= 40 && w.length <= 40 ? { vendor: v, what: w } : undefined;
}

/** What the match prompt shows of a payment: what tells it apart, one line each, no bookkeeping state (#187: about half the prompt's tokens were indentation and fields the model never needs). */
function shownPayment(t: BankTransaction & { filed?: true }): Record<string, unknown> {
  return {
    ref: t.ref, date: t.date, amount: t.amount, currency: t.currency, direction: t.direction, description: t.description,
    ...(t.counterparty ? { counterparty: t.counterparty } : {}), ...(t.reference ? { reference: t.reference } : {}),
    ...(t.parts?.length ? { parts: t.parts.map((p) => ({ amount: p.amount, currency: p.currency, counterparty: p.counterparty, ...(p.reference ? { reference: p.reference } : {}) })) } : {}),
    ...(t.filed ? { filed: true } : {}),
  };
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
${transactions.map((t) => JSON.stringify(shownPayment(t))).join('\n')}

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
  "title": { "v": "Coop Pronto", "w": "Benzin" },
  "payout": { "sales": 1480.00, "refunds": 40.00, "fees": 27.65, "paidOut": 1412.35 },
  "order": { "number": "1001", "date": "2026-08-10", "currency": "EUR", "gross": 120.00, "shipTo": "CH", "tax": { "country": "CH", "rate": 8.1 }, "payouts": [{ "date": "2026-08-12", "amount": 116.20 }], "refunds": [] }
}

Rules for title: ${TITLE_RULES}

Rules for payout: ${PAYOUT_RULES}

Rules for order: ${ORDER_RULES}

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

/** A line's role in a payout report (rule 9a): the code books it on the rule's accounts whatever sides and sign the model wrote (src/booking/classify.ts payoutLines). */
export type PayoutKind = 'sale' | 'refund' | 'fee';

export interface ClassifyEntry {
  accountDebit: string;
  accountCredit: string;
  amount: number;
  /**
   * The code of a line the app makes itself (a rule's, a payout's). The model states facts instead
   * (`vat`, `vatRate`, `amountIs`); a code it still writes is read back to its facts
   * (src/booking/line-vat.ts), so the letter and the sign are the accounts' either way.
   */
  vatCode?: string;
  /** Rule 7, read off the receipt: Swiss VAT charged, none, or none on a service from abroad (Bezugsteuer). */
  vat?: VatLineFacts['charge'];
  /** Rule 7: the Swiss VAT rate charged, in percent (8.1). */
  vatRate?: number;
  /** Rule 9b: the amount is the VAT itself. */
  amountIs?: 'tax';
  description: string;
  /** Only for a payout report's lines. */
  kind?: PayoutKind;
  /** On a purchase line with a receipt (rule 7h): what it buys; on a sale without Swiss VAT (rule 7g): what it sells. */
  supply?: Supply;
  /** On a purchase line with a receipt (rule 7h): the supplier's country as the receipt gives its seat, ISO 3166 alpha-2 ("IE", "CH"). */
  supplierCountry?: string;
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
  /** The payment's fee, which the bank debited as a movement of its own (src/booking/separate-fee.ts). */
  separateFee?: { ref: string; amount: number; currency: string };
  /** An owner's payment of a business part of its receipt (BankTransaction.businessPart): the amount is that part, the rest is private. */
  businessPart?: { what?: string };
  /** The other legs of its card charge split across balances that hold the same receipts (src/booking/shared-receipts.ts): this payment books only its share. */
  sharedWith?: Array<{ ref: string; amount: number; currency: string }>;
}

const CLASSIFY_INSTRUCTIONS = `## Instructions
1. Determine the correct expense/revenue account(s) based on the transaction description, receipt text, and historic patterns.
   Use ONLY account numbers listed in the Chart of Accounts above. The numbers in these instructions are the standard
   KMU ones: where this company's chart has another account for the same purpose, take its own. A row on an account
   the chart does not have is refused and the payment is not booked.
2. The bank account side is already determined — do NOT set it. Leave accountDebit or accountCredit as empty string "" for the bank side. The system will fill it in.
3. For DBIT (money out): the bank account is credited (leave accountCredit as ""), set accountDebit to the expense account.
4. For CRDT (money in): the bank account is debited (leave accountDebit as ""), set accountCredit to the revenue account.
5. IMPORTANT — Multiple receipts per transaction (Aliexpress, Amazon, FedEx, etc.):
   These vendors group multiple separate purchases/invoices into a single bank transaction.
   You MUST create one journal entry row per receipt. Do NOT combine them into a single entry.
   - Each receipt has its own item, its own account, and its own description.
   - Use each receipt's amount (converted to the transaction currency if needed) as the entry amount.
   - Assign each receipt to its correct expense account based on what was purchased (read the receipt text carefully).
   - Example: an Aliexpress transaction with 3 receipts (milk jugs, grinder burrs, USB cable) → 3 journal entries, e.g. 4200/6100/6570.
   - If two receipts genuinely go to the same account, they still get separate rows with separate descriptions.
6. The entries must move the bank account by exactly the transaction amount: the bank paid what the bank paid.
   Every row has both accounts, except the bank side you leave "" (and the single-leg VAT-amount row of rule 9b).
6b. Skonto / a discount taken at payment (the bank paid less than the invoice total): book what the bank paid,
   ONE entry for the transaction amount on the expense account with the receipt's VAT facts. Cash basis: the
   discount reduces the expense and the input tax, which is the tax on the amount paid. Never add a separate
   Skonto row with an empty account. Example: invoice 1000.00 incl. 8.1% MWST, paid 980.00 with 2% Skonto
   → { "accountDebit": "4400", "accountCredit": "", "amount": 980.00, "vat": "charged", "vatRate": 8.1, "description": "Lieferant, Material (2% Skonto)" }.
7. VAT facts (CRITICAL — follow exactly). Give the FACTS of each row, never a VAT code: the app computes the
   code from these facts and the row's accounts (the letter from the account, the minus from the direction of
   the money). Do not write "vatCode".
   a) "vat": what the receipt shows for this row:
      - "charged": Swiss MWST charged. Then "vatRate": the rate in percent (8.1, 2.6, 3.8; historical 7.7, 2.5, 3.7).
      - "none": no Swiss MWST charged.
      - "acquisition": Bezugsteuer, see h).
   b) The receipt's "VAT facts" line (extracted directly off the receipt) is the source of truth, use it over
      anything in the receipt text: "NO Swiss MWST" → "none"; "Swiss MWST" at a rate → "charged" at that rate.
      Swiss MWST is charged only when the receipt shows it; a vendor's country decides nothing.
   c) No receipt at all (no VAT facts line) on a PURCHASE → "none": no receipt, no input tax.
      A SALE (CRDT on a revenue account) owes its output tax with or without an invoice: a customer in
      Switzerland or Liechtenstein → "charged" at 8.1, a customer abroad → "none". The app checks it against
      the payment and asks the owner; never book a domestic sale "none" for want of a receipt.
   g) A sale without Swiss MWST: give "supply" as well: "service" when the invoice places the service abroad
      ("Leistungsort Deutschland", "nicht der schweizerischen MWST unterstellt"), "goods" for an export of goods.
   h) Bezugsteuer: a SERVICE (software, online service, advertising, consulting) from a supplier based
      abroad whose receipt shows no Swiss MWST and no CHE number → "acquisition" on the expense line (the
      amount paid is the net). Not for goods (import VAT instead), not for services exempt from VAT (payment
      processing, Stripe or card fees, banking, insurance), not when the receipt shows Swiss MWST ("charged").
      On EVERY purchase line with a receipt, also give two facts read off the receipt, which the app
      decides Bezugsteuer by: "supply": "service", "goods" or "exempt" (a service exempt from VAT), and
      "supplierCountry": the supplier's country as the receipt gives its address, as the two-letter
      ISO country code ("IE", "US", "CH").
   d) A refund keeps the facts of what it refunds ("charged" at 8.1 when the purchase was); its accounts make it a refund.
   f) MULTI-RATE RECEIPTS: when a receipt's VAT facts list MORE THAN ONE positive rate
      (e.g. Coop fuel "8.1% + 0%", or a mixed cart "8.1% + 2.6%"), SPLIT it into one journal
      entry per rate group. Use each group's gross as that entry's amount and the group's
      rate as its "vatRate". Keep the same expense account for all split rows unless the items
      clearly belong to different accounts. The split rows must sum to the receipt total.
8. For Wise fees (description starts with "Wise Charges"): use account 6940 (Bankspesen), "vat": "none".
9. For Shopify/Stripe sales (Webshop orders): ALWAYS produce exactly 2 journal entry rows. Specify BOTH accountDebit AND accountCredit (do NOT leave one empty):
   a) Revenue: accountDebit "1093" / accountCredit the chart's revenue account for goods sold (KMU "3200" Handelserlöse) — full order amount. "charged" at 8.1 for Swiss customers, "none" with "supply": "goods" for exports.
   b) Shopify fees: accountDebit "6580" / accountCredit "1093" — the fee amount (= order amount minus Stripe payout, as shown on the Shopify receipt)
   The system will automatically add a third entry for the Stripe payout (D=bank C=1093) — do NOT add it yourself.
9a. Card-terminal and payment-provider payouts (SumUp, Payrexx, Worldline, Stripe Terminal, TWINT): the payout is
   the card sales at the company's own place of business minus the provider's fees. Its payout report rarely shows MWST,
   yet the sales are domestic sales: book the GROSS sales on the revenue account "charged" at 8.1 (the normal rate;
   another rate only when the report shows it), a refund in the report the same, and the fees as their own row on
   the bank-fee account with "vat": "none" (payment processing is exempt: no input tax, no Bezugsteuer). The rows
   sum to the payout. Give every row of a payout report its role, "kind": "sale", "refund" or "fee", and its amount
   as a positive number; the role decides the accounts and codes, so a fee is never written as a negative sale.
   Without the report: the whole payout on the revenue account, "charged" at 8.1.
9b. Shopify MONTHLY VAT correction (Vorsteuer on transaction fees) — a SEPARATE booking, not a sales order.
   The monthly Shopify billing statement ("Payments Invoice") shows the 8.1% Swiss MWST on the fees that the
   per-order payouts hide. Book ONLY the VAT as a SINGLE-LEG correction — this is the ONE case where a leg is
   intentionally left empty (rule 9's "both legs" requirement is about sales rows, not this):
     - accountDebit: "" (EMPTY) — the app books this leg to the MWST account
     - accountCredit: "6580"
     - amount: the VAT amount only (= gross fees × 8.1 / 108.1)
     - "vat": "charged", "vatRate": 8.1, "amountIs": "tax" (the amount IS the VAT amount)
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

// Render the receipt's VAT facts as a compact, authoritative line for the
// classify prompt — so the rate no longer depends on (truncated) receipt text.
function formatVatFacts(r: ReceiptInput): string | null {
  if (r.hasSwissVat === undefined && !r.vatSummary) return null; // not extracted yet
  if (r.hasSwissVat === false) return 'VAT facts: NO Swiss MWST on receipt → a purchase: "vat": "none", but a service from a supplier abroad: "acquisition" (rule 7h); a sale: see rules 7c, 7g and 9a';
  const groups = (r.vatSummary ?? []).filter((g) => g.ratePercent > 0);
  if (groups.length === 0) {
    return r.hasSwissVat
      ? `VAT facts: Swiss MWST present${r.vatId ? ` (${r.vatId})` : ''} but rate not parsed — assume 8.1% unless the text says otherwise`
      : null;
  }
  const parts = groups.map(
    (g) =>
      `${g.ratePercent}%${g.gross != null ? `, gross ${g.gross}` : ''}${g.vat != null ? `, vat ${g.vat}` : ''}`,
  );
  return `VAT facts: Swiss MWST${r.vatId ? ` ${r.vatId}` : ''} — ${parts.join('; ')}`;
}

/** What every classify prompt says about the company: its name, chart, prior-year entries, and the firm's VAT setup (absent: the effective method). */
export interface ClassifyPromptContext {
  companyName: string;
  chartOfAccounts: string;
  historicEntries: string;
  vat?: VatSetup;
  /** What the firm sells and the default accounts that follow (src/workspace/sells.ts, #46); absent: not answered. */
  sells?: SalesDefaults;
}

const KIND_WORDS: Record<SalesKind, { sells: string; buys?: string }> = {
  made: { sells: 'products it makes itself', buys: 'material for its own products' },
  traded: { sells: 'goods it buys and resells', buys: 'goods bought for resale' },
  services: { sells: 'services' },
};

/** What the firm sells, as the setup answered it, and the default accounts the model starts from. */
function sellsSection(d: SalesDefaults | undefined): string {
  if (!d?.kinds.length) return '';
  const accounts = [...d.purchase.map((p) => `${KIND_WORDS[p.kind].buys} → ${p.account}`), ...d.sales.map((s) => `sales of ${KIND_WORDS[s.kind].sells} → ${s.account}`)];
  return `## What the company sells
${d.kinds.map((k) => KIND_WORDS[k].sells).join(', ')}. Default accounts, unless a rule, the receipt or the prior year says otherwise: ${accounts.join('; ')}.
`;
}

/** The VAT part of the prompt: the model gives facts on every kind of firm, what code books of them differs (code enforces it either way). */
function vatSection(setup: VatSetup | undefined): string {
  if (setup && !setup.registered) {
    return `## VAT
The company is NOT registered for VAT. Give no VAT facts (leave out "vat") on EVERY row and book every amount gross, whatever a receipt shows. Ignore the VAT facts rules below.`;
  }
  if (setup?.registered && setup.method === 'net-rate') {
    const rates = setup.rates.map((r) => `${r.rate} %${r.label ? ` (${r.label})` : ''}`).join(', ');
    return `## VAT (net tax rate method, Saldosteuersatz)
The company files with approved flat rates on its gross turnover: ${rates}. Give the VAT facts of rule 7 as for any company; the app books them by this method:
- A PURCHASE (expense, material, investment) claims no input tax, whatever the receipt shows.
- A SALE on a revenue account: "vat": "charged" with "vatRate" the approved rate${setup.rates.length > 1 ? ' that fits the activity' : ''} (not the 8.1 % the invoice shows); the app books it GROSS at that rate. An export of goods and a service supplied abroad as rule 7g says.
- Bezugsteuer on a service from a supplier abroad that charged no Swiss MWST: "acquisition" (rule 7h), owed without a deduction. Give the "supply" and "supplierCountry" facts of rule 7h on every purchase line with a receipt.`;
  }
  return '';
}

/** What the model is told of an owner's payment of a business part of its receipt: book the part only, the rest is private. */
function businessPartLine(tx: TxInput, receipt: ReceiptInput | undefined): string {
  const of = receipt?.amount != null ? ` of the receipt's ${Math.abs(receipt.amount)} ${receipt.currency ?? tx.currency}` : ' of the receipt';
  const what = tx.businessPart?.what ? ` (${tx.businessPart.what})` : '';
  return `Business part: only ${tx.amount} ${tx.currency}${of} was for the business${what}; the owner paid the rest privately and it is not booked. Book exactly this amount, in one entry, with the VAT facts the receipt shows for that part.`;
}

/** What the model is told of a leg of a card charge split across balances: the receipt also pays the other legs, so this one books only its share and its share of the VAT. */
function sharedLine(tx: TxInput): string {
  const others = tx.sharedWith!.map((o) => `${o.ref} (${Math.abs(o.amount)} ${o.currency})`).join(', ');
  return `Shared receipt: the receipt below also pays ${others}, the other part${tx.sharedWith!.length > 1 ? 's' : ''} of one card charge. Book only this payment's ${Math.abs(tx.amount)} ${tx.currency} as its share, with the receipt's VAT facts in proportion: the input tax of all these payments together never exceeds the VAT the receipt shows.`;
}

export function buildBatchClassifyPrompt(
  transactions: Array<{ tx: TxInput; receipts: ReceiptInput[] }>,
  { companyName, chartOfAccounts, historicEntries, vat: setup, sells }: ClassifyPromptContext,
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
  Bank description: ${tx.description}${tx.counterparty ? `\n  Counterparty: ${tx.counterparty}` : ''}${tx.separateFee ? `\n  Fee: ${tx.separateFee.amount} ${tx.separateFee.currency}, debited separately as ${tx.separateFee.ref} and booked there. The amount above is without it: book no fee line here.` : ''}${tx.businessPart ? `\n  ${businessPartLine(tx, receipts[0])}` : ''}${tx.sharedWith?.length ? `\n  ${sharedLine(tx)}` : ''}
${receiptPart}`;
  }).join('\n\n');

  return `You are an accounting assistant for ${companyName} (Swiss company, cash basis taxation).
Classify these bank transactions into journal entry rows for Banana Accounting.

## Bank Transactions
${txSections}

## Chart of Accounts
${chartOfAccounts}

${sellsSection(sells)}${vatSection(setup)}

## Historic Journal Entry Examples (prior year)
${historicEntries}
${cases.length ? `
## Casebook: invented examples of how similar cases are booked
These are standard Swiss cases on KMU account numbers. Follow their pattern and VAT facts, but use this company's own chart of accounts above. "bank" is the side you leave empty.
${cases.map(formatCase).join('\n')}
` : ''}
${CLASSIFY_INSTRUCTIONS}

Return ONLY a valid JSON object keyed by transaction ref. Each value has an "entries" array and a "reason":
one short German sentence the bookkeeper reads on the booking, naming the receipt fact and the rule behind the
account (e.g. "Beleg DigitalOcean zeigt 8.1 % MWST mit CHE-Nummer: Webhosting auf 6570."). Name no VAT code: the app computes it.
Example:
{
  "WEUR000042": {
    "entries": [
      { "accountDebit": "6570", "accountCredit": "", "amount": 7.55, "vat": "charged", "vatRate": 8.1, "description": "DigitalOcean, Webhosting", "supply": "service", "supplierCountry": "US" }
    ],
    "reason": "Beleg DigitalOcean zeigt 8.1 % MWST mit CHE-Nummer: Webhosting auf 6570."
  },
  "20123456790": {
    "entries": [
      { "accountDebit": "6940", "accountCredit": "", "amount": 0.02, "vat": "none", "description": "Wise, Kartengebühren" }
    ],
    "reason": "Wise-Gebühr ohne Beleg: Bankspesen 6940, ohne Vorsteuer."
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
   A courier's or forwarder's customs invoice (Zollrechnung) is always itemized: one line per charge
   as printed (import VAT, customs duty, each fee, freight), its printed name as the description,
   the amount it adds to the total as gross, the rate of the carrier's own VAT on it as ratePercent
   (0 where none; the import VAT line takes 0, it is the tax itself).

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
  const payout = parsePayoutFacts((parsed as { payout?: unknown }).payout);
  const order = parseOrderFacts((parsed as { order?: unknown }).order);
  delete parsed.title;
  delete parsed.payout;
  delete parsed.order;
  return { ...parsed, ...(title ? { title } : {}), ...(payout ? { payout } : {}), ...(order ? { order } : {}) };
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
