import type { Tags } from '../books/tags.js';

// One row of a receipt's printed MWST summary block (grouped by rate).
// This is the receipt-intrinsic VAT evidence — the source of truth for the
// rate suffix (81/26/0). The accounting letter (I/M/V) and sign are decided
// later at classify time, not here.
export interface VatRateGroup {
  ratePercent: number; // 8.1, 2.6, 3.8, 0
  net?: number;
  vat: number;
  gross?: number;
}

// A single itemized line on a receipt. Only needed when one receipt spans
// multiple accounts (e.g. a mixed cart) or multiple rates.
export interface ReceiptLine {
  description: string;
  gross: number;
  ratePercent?: number; // links this line to a VatRateGroup (rate axis)
  suggestedAccount?: string; // best-effort account hint (account axis)
}

/**
 * What a document is. Only an invoice (or a sales record) has to be paid by a transaction;
 * a supporting document (a Post Aufgabebestätigung billed on the monthly invoice, a delivery
 * note) is kept as proof but never matched. See processes/receipt-intake.flow.yaml.
 */
export const RECEIPT_KINDS = ['invoice', 'sales-record', 'supporting', 'statement', 'noise', 'duplicate'] as const;
export type ReceiptKind = typeof RECEIPT_KINDS[number];

export interface Receipt {
  id: string;
  filename: string;
  originalFilename: string;
  extractedText: string;
  extractionMethod: 'pdftotext' | 'tesseract' | 'claude' | 'claude-vision';
  fileSize: number;
  indexedAt: string;
  location: 'staged' | 'archived';
  // set during match step
  date?: string;
  /** The receipt shows no date: `date` is the day the phone took it (the upload's X-Captured-At). A person's date clears it. */
  dateSource?: 'captured';
  description?: string;
  amount?: number;
  currency?: string;
  // local OCR (pdftotext + tesseract) yielded no text — needs manual approval to send image to AI
  needsVisionReview?: boolean;
  remarks?: string;
  // set during extract-vat step (VAT facts read directly off the receipt)
  vatId?: string; // CHE-... UID if the receipt shows one
  hasSwissVat?: boolean; // true only if the receipt explicitly shows Swiss MWST
  vatSummary?: VatRateGroup[]; // the receipt's MWST block, grouped by rate
  lineItems?: ReceiptLine[]; // best-effort itemization (only when multi-account/rate)
  vatExtractedAt?: string; // ISO timestamp — idempotency guard for extract-vat
  /** A person set the VAT facts (by hand or through the AI sidebar): the VAT step never overwrites them. */
  vatBy?: 'human';
  kind?: ReceiptKind;
  /** Who set the kind: a rule (named in kindRule) or a person. A person's kind is never overwritten; 'human' without a kind is a person's «ordinary receipt», never typed again. */
  kindBy?: 'rule' | 'human';
  kindRule?: string;
  /** The model's one-line reason for the kind it gave (kindRule `model:…`, src/intake/unclear.ts). */
  kindWhy?: string;
  /** The workflow run that took it up (src/workflows/engine.ts): the receipt's page links to it. */
  run?: string;
  /** What a list shows: the vendor as people say it and what it is in 1–3 words (src/intake/titles.ts). */
  title?: ReceiptTitle;
  /** Receipts a person said are other documents, though their facts look alike (src/intake/duplicates.ts): never paired again. */
  distinctFrom?: string[];
  /**
   * The payment it pays, when that payment lies in a filed quarter (src/intake/match.ts): no link
   * is made (golden rule 1); the receipt says so, and its tax is a correction in the open quarter.
   */
  filedPayment?: string;
  /** Payments a person took this receipt apart from (src/server/edits.ts unlink): the matching chain never pairs them again (src/intake/pairing.ts). A person's link clears its payment. */
  notPaidBy?: string[];
  /** Payments the model was shown for this receipt by the matching chain and did not take (src/intake/pair-chain.ts): not asked about again on the next run; «Zahlung suchen» asks again. */
  pairDoubted?: string[];
  /** A payout report's figures, read once at the match step: the booking step splits every payout it is linked to by them, in code (r10f-29). */
  payout?: PayoutFacts;
  /**
   * A customs assessment: the deduction of import VAT once booked from it (its entry's id), by code or
   * by a person (src/booking/customs-invoice.ts). Code never books another from it or its copies, so a
   * deduction a person removed or changed stays as she left it.
   */
  importVatDeduction?: string;
  /** An order document's facts (a shop's order page), read once at the match step: code links it to its order's sale booked from the provider's sales report, as proof of the delivery (src/booking/sales-report.ts linkOrdersToSales). */
  order?: OrderFacts;
  /** A payment provider's sales or fee report (a CSV), booked onto its clearing account when it was dropped (src/booking/sales-report.ts, #203). */
  report?: SalesReportFacts;
}

/**
 * What a sales or fee report's receipt keeps of it: the provider's business id, the kind, the days its
 * rows cover, how many orders or fees it holds; `held`: the orders (or fees) its latest taking could
 * not book, each with why, for the person to work through on the receipt (at most HELD_KEPT,
 * src/intake/sales-report-import.ts; `heldMore` the rest); `filedRefunds`: refunds paid in a filed period
 * the books never carried, of sales they carry (#231), each with the filing period it corrects (`corrects`),
 * offered to the person as a correction in the open period.
 */
export interface SalesReportFacts {
  provider: string; kind: 'sales' | 'fees'; from: string; to: string; rows: number;
  held?: Array<{ order: string; why: 'noTax' | 'rate' | 'abroadTax' | 'foreignTax' | 'country' | 'changed' | 'noRate' | 'refundDate' | 'refundMismatch' | 'noPayment' | 'legacy' | 'charges' }>;
  heldMore?: number;
  filedRefunds?: Array<{ order: string; date: string; amount: number; currency?: string; corrects: string }>;
}

/** What a card terminal's or payment provider's report states, all positive: sales − refunds − fees = paidOut. */
export interface PayoutFacts { sales: number; refunds: number; fees: number; paidOut: number }

/** A part of an order in one payout, named by the payout's date as the order document gives it; positive. */
export interface PayoutShare { date: string; amount: number }

/** What an order document states about one order, every amount positive and in the currency of the payouts it names; its number links it to the order's sale (#203). */
export interface OrderFacts {
  number: string;
  date: string;
  currency: string;
  /** What the customer paid. */
  gross: number;
  /** The delivery address's country (ISO 3166 alpha-2): it decides a domestic sale or an export. */
  shipTo: string;
  /** The order's own tax line, when it shows one: the country whose VAT it charges, and the rate. */
  tax?: { country: string; rate: number };
  /** What the provider added to which payout. */
  payouts: PayoutShare[];
  /** Refunds the provider deducted from a payout. */
  refunds: PayoutShare[];
}

export interface ReceiptTitle { vendor: string; what: string }

/** Why two receipts are taken for one document (src/intake/duplicates.ts): the same text, a number only they carry, the same vendor, total and day. */
export type TwinWhy = 'same-text' | 'same-number' | 'same-facts';

/** A PDF in the workspace's inbox that no receipt holds yet (GET /api/inbox). */
export interface InboxFile {
  /** The id its receipt will have once it is read. */
  id: string;
  filename: string;
  size: number;
  addedAt: string;
  /** The last run of the inbox that covered the file stopped: the file waits for the next run, and the person is told why. */
  failed?: { run: string; error: string };
}

export interface Mapping {
  transactionRef: string;
  receiptId: string;
  /** Who made the link: a deterministic rule (and which), the AI matcher, or a person. Absent: before this was recorded. */
  by?: 'rule' | 'llm' | 'human';
  rule?: string;
  /** The workflow run that made the link. */
  run?: string;
}

export interface BankStatement {
  /** The manifest's bank label (belege.workspace.yaml bankAccounts). */
  bank: string;
  filename: string;
  fromDate: string;
  toDate: string;
  currency?: string;
  /**
   * The payments the file holds, with the refs the books carry (a payment an earlier file brought
   * keeps its ref, src/books/bank-import.ts): a statement lists these, not every payment of its days,
   * so two statements that share a day stay apart (r10c-2). Absent on a PDF and in books from before.
   */
  refs?: string[];
}

/** POST /api/statements read a statement in: its file, the statement to open (account and month it ends in), the payments new to the books. */
export interface StatementImport {
  file: string;
  account: string;
  month: string;
  added: number;
  /** Movements made by hand that rows of the statement confirmed (#88): matched, not added. */
  confirmed?: number;
  bank: string;
  currency: string;
  /** The days it covers, as far as the file says (a camt export: its first and last booking). */
  from?: string;
  to: string;
  /** The bank's closing balance on its last day, in the account's currency: what the books must show then. */
  closing?: { date: string; amount: number };
  /** A camt export's opening balance (OPBD), the bank's balance before its first day: what the account starts the books with. */
  opening?: { date: string; amount: number };
}

export interface JournalEntry {
  id: string;
  transactionRef: string;
  date: string;
  accountDebit: string;
  accountCredit: string;
  amount: number;
  vatCode?: string;
  description?: string;
  exchangeCurrency?: string;
  exchangeRate?: number;
  /**
   * The filed quarter this entry corrects. The entry is dated in an open period
   * for the books, but its VAT is declared in that quarter's Korrekturabrechnung
   * (ESTV form 0535), never in the return of its own date. A filing-period key
   * (src/accounting/periods.ts isFilingKey): a quarter for the effective method.
   */
  corrects?: string;
  /**
   * Who wrote the entry, so `classify --force` can tell its own entries from hand bookings,
   * corrections and rebook-shopify output. The classifier (src/booking/classify.ts, for
   * `npm run classify` and the UI's re-classify) stamps 'classify'; an edit through the API
   * stamps 'manual', and --force keeps such an entry's transaction.
   * Absent means another writer, or an entry booked before the field existed.
   * 'year-close' is the year-end revaluation of a foreign-currency account (npm run year:close):
   * it changes the account's CHF value only, so its native balance leaves it out.
   * 'invoice' is the revenue of a paid invoice, booked from its lines (src/invoices/payments.ts).
   */
  origin?: 'classify' | 'manual' | 'year-close' | 'invoice';
  /** The workflow run that booked it (src/workflows/engine.ts): its history explains why it is booked like this. */
  run?: string;
  /** Why the classifier booked it so, in the model's words (src/booking/classify.ts): the booking page shows it. */
  reason?: string;
  /** The id of the company's rule that booked it (src/booking/rules.ts): Firma › Regeln counts how often each applied. */
  rule?: string;
  /**
   * Who decided the booking as it stands, and so who wrote its `reason`: a company rule, a check of
   * the app's code, the AI (which model), a person (by hand, an answer to a question), or the AI
   * sidebar on a person's wish (`assistant`, with its conversation); `was` holds the booking fields
   * before the change. Parsed at the books boundary
   * (src/books/booked-by.ts). Absent: an entry booked before the field existed; the booking page
   * then says what `origin` says.
   */
  by?: BookedBy;
  /**
   * The receipts linked to the payment when the classifier booked it. A receipt linked later is
   * evidence the booking never saw (its VAT above all): the next classify books it again
   * (src/accounting/classify-force.ts entriesWithoutTheirReceipts). Absent: booked before this
   * field existed, or by another writer; such an entry is never booked again for this reason.
   * On a booking without a payment (a ref of its own, #89) it is the receipts linked to it, kept in
   * step with its links (src/server/edits.ts carried): deleted and put back, it carries them again.
   */
  receipts?: string[];
  /**
   * What the line buys (or sells), as the classifier read it off the receipt (ClassifyEntry.supply,
   * #80): Bezugsteuer is owed on a service from abroad only, so later checks (the rule card's
   * national VAT rules, src/booking/national-vat.ts) need it after the booking. Stamped on the
   * entries the model books; absent on older entries and other writers' (a filed entry keeps what
   * it was filed with).
   */
  supply?: Supply;
  /** The supplier's country as the classifier read it off the receipt, ISO 3166 alpha-2 (#80); absent as `supply` is. */
  supplierCountry?: string;
  /**
   * The booking's reporting dimensions (#127, src/books/tags.ts): per dimension the workspace
   * declares (belege.workspace.yaml `dimensions`) at most one value, `{ projekt: "alpha" }`. The
   * reports filter and group by them; no VAT figure reads them. Absent: none. A filed entry keeps
   * what it was sealed with, so a tag on it never changes.
   */
  tags?: Tags;
}

/** What a purchase line buys, as the model reads it (rule 7h): code decides Bezugsteuer from it (src/accounting/acquisition-tax.ts). `exempt`: a service exempt from VAT, such as payment processing, banking or insurance. */
export type Supply = 'goods' | 'service' | 'exempt';

/**
 * The app's checks that set a booking's code themselves: a sale's VAT code (src/accounting/sales-without-vat.ts saleCodeOf), a payment
 * provider's report and payout (`payoutReport`: its sales and fees onto its clearing account, src/booking/sales-report.ts, and the payout from
 * there to the bank, src/booking/classify.ts providerPayout, #203; before, a payout split by its report), a payout's lines per order
 * (`payoutOrders`, before #203: books keep them), a credit note's from the invoice it names (src/accounting/credit-note-code.ts), Bezugsteuer
 * on a service from abroad (src/accounting/acquisition-tax.ts), a purchase's input tax from its receipt and the app's business files
 * (src/booking/purchase-vat.ts). A sealed quarter hashes `by`, and an older build drops a check it does not know, so a new check is a
 * change of the books' format: the list only grows with a new schema.
 */
export const CODE_CHECKS = ['saleCode', 'payoutReport', 'payoutOrders', 'creditNote', 'acquisitionTax', 'purchaseVat'] as const;
export type CodeCheck = typeof CODE_CHECKS[number];

/** The booking fields a person's change keeps the old values of. */
export type BookingFields = Partial<Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'vatCode' | 'amount'>>;

/** Who decided a booking (JournalEntry.by). */
export type BookedBy =
  | { kind: 'rule'; rule: string }
  | { kind: 'code'; check: CodeCheck }
  | { kind: 'model'; model: string }
  | { kind: 'person'; at: string; was?: BookingFields }
  /** The AI sidebar, in conversation `conversation`, on the person's wish; `was`: the fields as they were before the AI changed them. */
  | { kind: 'assistant'; at: string; conversation: string; was?: BookingFields };

/** A filing period: a quarter ("2026-Q2") for a firm filing quarterly, a half year ("2026-H1") for one filing half-yearly. */
export type QuarterKey = `${number}-Q${1 | 2 | 3 | 4}` | `${number}-H${1 | 2}`;

/**
 * A return approved for filing: its period and the period's last day, through which the books are
 * held. `filed` (r10h-4): «Eingereicht» found the books differ from the return filed with the tax authority;
 * the hold stays, and the write door lets a person make only changes that bring every box and
 * the payable back to these figures (src/books/store.ts update), until «Weiter» seals.
 */
export interface ApprovedReturn { period: QuarterKey; through: string; filed?: FiledFigures }
/** The return's figures as filed: each box and the payable. */
export interface FiledFigures { figures: Record<string, number>; payable: number }

export interface AccountingConfig {
  closedThrough?: string;
  /**
   * The VAT return a person approved («Freigegeben») and has not filed yet. Until «Eingereicht»
   * closes the period or «Zurück» frees it, its records are held as a filed period's are
   * (src/books/store.ts periodLock), so the XML the person uploads is the books' (r7h-24).
   */
  approvedReturn?: ApprovedReturn;
  openingBalances?: Record<string, Record<string, number>>;
  // Opening balances in the account's own currency (foreign-currency accounts only),
  // keyed by year then account. Used by bank-balance reconciliation, which compares
  // native-currency book balances against bank statement closing balances.
  openingBalancesNative?: Record<string, Record<string, { amount: number; currency: string }>>;
  // Amounts declared in a period's VAT return that are not journal entries of that
  // period: the books are right, a filed return was not, and the difference is
  // declared in the next open period (AGENTS.md golden rule 1). Never dated into a
  // filed period.
  vatAdjustments?: VatAdjustment[];
  /** Why each filed quarter's Korrekturabrechnung (0535) differs from what was filed, case by case. */
  correctionCases?: CorrectionCase[];
}

/**
 * One reason a filed quarter is corrected: what was wrong, what fixes it, and the entries
 * before and after. Every entry with `corrects` belongs to exactly one case.
 * - originalEntryIds: the entries as filed (the "before"). Empty when the item was never booked.
 * - correctionEntryIds: the open-period entries with `corrects === period` that fix it. Empty when
 *   the books were right and only the filed return missed the originals (recomputed).
 */
export interface CorrectionCase {
  id: string;
  period: QuarterKey;
  title: string;
  wrong: string;
  fix: string;
  originalEntryIds: string[];
  correctionEntryIds: string[];
  /** Where the evidence or the full reasoning lives (a document, a receipt). */
  source?: string;
}

export interface VatAdjustment {
  id: string;
  /** The return that declares it, e.g. "2026-Q3". */
  period: string;
  /** ESTV Ziffer it adds to, e.g. "400". */
  ziffer: string;
  /** CHF, signed as it adds to that Ziffer. */
  amount: number;
  reason: string;
  /** The journal entries whose tax this declares. */
  entryIds: string[];
}

// A balance at the end of a day as the bank states it: a month-end closing balance read off a
// statement PDF, or a camt.053's opening (OPBD, as the close of the day before) and closing (CLBD).
// The bank-side source of truth for the reconciliation against the ledger (Bilanzkonten).
export interface StatementClosingBalance {
  account: string; // ledger account (1021..1024)
  bank: string;
  currency: string; // the account's own currency
  date: string; // the day the balance closes, YYYY-MM-DD
  amount: number; // closing balance in the account's own currency, natural sign
  source: 'pdf' | 'camt';
  sourceFile: string; // the statement file's name the balance was read from
}

export interface Index {
  /** The format of books.json (src/workspace/schema.ts BOOKS_SCHEMA); absent in books from before it: 1. */
  schema?: number;
  receipts: Receipt[];
  transactions: BankTransaction[];
  mappings: Mapping[];
  bankStatements: BankStatement[];
  journalEntries?: JournalEntry[];
  config?: AccountingConfig;
  // The balances each statement states (a camt.053's, or one read without it, #217), and year-end confirmations (#119).
  statementBalances?: StatementClosingBalance[];
}

export interface BankTransactionPart {
  amount: number;
  currency: string;
  /** Who was paid (creditor) or who paid (debtor). */
  counterparty: string;
  /** QR / creditor reference or remittance text. */
  reference?: string;
  /** The other party's IBAN as the bank names it for this part: a payer rule keyed by IBAN decides the part (r10h-14). */
  counterpartyIban?: string;
}

export interface BankTransaction {
  ref: string;
  /**
   * The manifest's label of the money account it moved on (belege.workspace.yaml bankAccounts): a
   * bank, the cash box, an employee, a card; `manual` is the owner's account (src/accounting/bank-accounts.ts accountOf).
   */
  bank: string;
  date: string;
  amount: number;
  currency: string;
  direction: 'CRDT' | 'DBIT';
  description: string;
  /**
   * Where the movement was learned (#88). Absent: a row of an imported statement, as every record
   * without it has been. `manual`: a receipt, a person's answer or a hand entry made it.
   */
  source?: 'manual';
  /**
   * A movement made by hand that a statement imported later confirmed: the ref that statement row
   * has (src/books/bank-import.ts matchStatementRows). The movement keeps its ref, its bookings and
   * its origin; a re-import finds the row here and adds nothing (src/accounting/bank-accounts.ts byStatement).
   */
  statement?: string;
  /**
   * An owner's payment of a business part of its receipt («Privat oder bar bezahlt», nur ein Teil,
   * src/server/edits.ts privatePayment): `amount` is that part, the rest of the receipt was private
   * and is never booked. `what`: the part as the person named it («Kaffee»); `rate`: the receipt's
   * Swiss VAT rate line the part falls under, named when the receipt shows several.
   */
  businessPart?: { what?: string; rate?: number };
  /**
   * The person's bookings without a payment this owner's payment replaced («Buchung ersetzen»,
   * src/server/edits.ts privatePayment), as they were: deleting the payment puts them back.
   */
  replaced?: JournalEntry[];
  type?: 'wise-fee';
  remarks?: string;
  noReceiptNeeded?: boolean;
  /**
   * The individual payments inside one bank booking (a Sammelzahlung / batch), from the
   * camt053 TxDtls. The booking stays ONE transaction (the balance moved once); its parts
   * are what receipts are matched against and what entries are split by. A filed transaction
   * keeps exactly what it was filed with, parts or none.
   */
  parts?: BankTransactionPart[];
  /**
   * The amount in the currency the payment was made in, when the bank names one besides the
   * account's (camt053 InstdAmt): a receipt in that currency matches it to the Rappen (src/intake/pairing.ts
   * originalOf, which also reads it from the text, «Card transaction of 12.40 USD»). Only on rows imported since #187.
   */
  original?: { amount: number; currency: string };
  /**
   * The payment reference the payer gave (QR / creditor reference, invoice number, remittance
   * text), from camt053 or, for Wise transfers, the monthly statement PDF. Matched against
   * receipt text by the evidence step. A filed transaction keeps what it was filed with.
   */
  reference?: string;
  /**
   * The other party of a single payment as the bank names it (camt053 RltdPties), which the
   * description, the remittance text, often leaves out: who paid or was paid. Only kept for open
   * periods, like parts.
   */
  counterparty?: string;
  /**
   * The other party's IBAN as the bank names it (camt053 DbtrAcct or CdtrAcct): its country tells
   * a domestic customer from one abroad (src/accounting/sales-without-vat.ts), and it names one
   * payer for certain. A filed transaction keeps what it was filed with.
   */
  counterpartyIban?: string;
  /**
   * The bank's own id of the movement when the ref is another one: Wise names its transactions
   * CARD-…, FEE-CARD-… on its statements while the ref is its statement reference (WEUR…). It pairs a
   * fee with its payment (src/booking/separate-fee.ts). Only open-period transactions get it: a
   * filed one keeps what it was filed with.
   */
  bankTxId?: string;
  /**
   * The payment waits for a person (r10h-5): its booking was deleted on purpose, by hand or on a
   * wish in the KI sidebar, so no run books it again. The mark goes with the next booking on it,
   * by hand or asked for with «Automatisch buchen» (src/server/edits.ts bookedAgain).
   */
  waitsForPerson?: { since: string; why: 'bookingDeleted' };
  /**
   * The payment needs a receipt and has none yet, so the inbox run does not book it (issue #29):
   * no provisional booking, it is booked once a receipt is linked. The run sets the mark and takes
   * it away again (src/booking/receipt-wait.ts); src/accounting/receipt-due.ts says from when the
   * person is asked about it. `unread`: its receipt came, and its VAT could not be read (issue #57):
   * the person is asked at once. `decided`: a run with a model judged that it waits (the model's
   * answer or a company rule books it onto no settlement account); a mark without it was set by a
   * run without a model, and the next run with one judges the payment again (issue #110).
   */
  waitsForReceipt?: { since: string; unread?: true; decided?: true };
  /**
   * The proof of the input tax other than a receipt, as a person named it when she booked the
   * payment by hand with input tax (issue #134): the documents that together show the supplier
   * charged Swiss VAT, such as a contract and the payment confirmation (MWSTG Art. 81 Abs. 3, ESTV
   * MWST-Info 09 Ziff. 1.6). Only a person's booking sets it; no run claims input tax without a
   * receipt. The booking is then not flagged as a deduction without evidence (evidence-check.ts).
   */
  inputTaxProof?: InputTaxProof;
}

/** A person's words for the other proof of a payment's input tax, and when she named it. */
export interface InputTaxProof { text: string; at: string }

/** A receipt's VAT facts as a person sets them: whether it shows Swiss VAT, at which rates, and its VAT number. */
export interface VatFacts { hasSwissVat: boolean; vatSummary: VatRateGroup[]; vatId?: string }

/**
 * The body of PATCH /api/receipts/:id. amount and currency go together; null clears a date, an
 * amount, a kind or the VAT facts (an undo puts back what was not there); an empty description or
 * remark clears it. A kind or VAT facts sent here are a person's (kindBy, vatBy 'human'); only an
 * undo sends `vatBy: null` with them, to put back facts the AI read.
 */
export type ReceiptPatch = Partial<Pick<Receipt, 'filename' | 'currency' | 'description' | 'remarks'>>
  & { date?: string | null; amount?: number | null; kind?: ReceiptKind | null; vat?: VatFacts | null; vatBy?: null };

/** The body of PATCH /api/transactions/:ref. An empty remark, noReceiptNeeded false or an empty inputTaxProof clears the field. */
export type TransactionPatch = Partial<Pick<BankTransaction, 'description' | 'remarks' | 'noReceiptNeeded'>> & { inputTaxProof?: string };
