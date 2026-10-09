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
export type ReceiptKind = 'invoice' | 'sales-record' | 'supporting' | 'statement' | 'noise' | 'duplicate';

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
  kind?: ReceiptKind;
  /** Who set the kind: a rule (named in kindRule) or a person. A person's kind is never overwritten. */
  kindBy?: 'rule' | 'human';
  kindRule?: string;
}

export interface Mapping {
  transactionRef: string;
  receiptId: string;
  approvedDuplicate?: boolean;
  /** Who made the link: a deterministic rule (and which), the AI matcher, or a person. Absent: before this was recorded. */
  by?: 'rule' | 'llm' | 'human';
  rule?: string;
}

export interface BankStatement {
  /** The manifest's bank label (belege.workspace.yaml bankAccounts). */
  bank: string;
  filename: string;
  fromDate: string;
  toDate: string;
  currency?: string;
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
   * (ESTV form 0535), never in the return of its own date.
   */
  corrects?: QuarterKey;
  /**
   * Who wrote the entry, so `classify --force` can tell its own entries from hand bookings,
   * corrections and rebook-shopify output. The classifier (src/booking/classify.ts, for
   * `npm run classify` and the UI's re-classify) stamps 'classify'; an edit through the API
   * stamps 'manual', and --force keeps such an entry's transaction.
   * Absent means another writer, or an entry booked before the field existed.
   * 'year-close' is the year-end revaluation of a foreign-currency account (npm run year:close):
   * it changes the account's CHF value only, so its native balance leaves it out.
   */
  origin?: 'classify' | 'manual' | 'year-close';
}

/** A VAT quarter, e.g. "2026-Q2". */
export type QuarterKey = `${number}-Q${1 | 2 | 3 | 4}`;

export interface AccountingConfig {
  closedThrough?: string;
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

// A month-end closing balance read off a bank statement PDF, used as the bank-side
// source of truth for monthly reconciliation against the ledger (Bilanzkonten).
export interface StatementClosingBalance {
  account: string; // ledger account (1021..1024)
  bank: string;
  currency: string; // the account's own currency
  date: string; // statement period end (month-end), YYYY-MM-DD
  amount: number; // closing balance in the account's own currency, natural sign
  source: 'pdf';
  sourceFile: string; // PDF filename the balance was read from
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
  // Populated by `npm run extract-balances` (parses monthly statement PDFs).
  statementBalances?: StatementClosingBalance[];
}

export interface BankTransactionPart {
  amount: number;
  currency: string;
  /** Who was paid (creditor) or who paid (debtor). */
  counterparty: string;
  /** QR / creditor reference or remittance text. */
  reference?: string;
}

export interface BankTransaction {
  ref: string;
  /** The manifest's label of the bank account it moved on (belege.workspace.yaml bankAccounts); `manual` when paid privately. */
  bank: string;
  date: string;
  amount: number;
  currency: string;
  direction: 'CRDT' | 'DBIT';
  description: string;
  source?: 'manual';
  type?: 'wise-fee';
  remarks?: string;
  noReceiptNeeded?: boolean;
  /**
   * The individual payments inside one bank booking (a Sammelzahlung / batch), from the
   * camt053 TxDtls. The booking stays ONE transaction (the balance moved once); its parts
   * are what receipts are matched against and what entries are split by. Only kept for
   * open periods: a closed transaction stays exactly as filed.
   */
  parts?: BankTransactionPart[];
  /**
   * The payment reference the payer gave (QR / creditor reference, invoice number, remittance
   * text), from camt053 or, for Wise transfers, the monthly statement PDF. Matched against
   * receipt text by the evidence step. Only kept for open periods, like parts.
   */
  reference?: string;
}

/** The body of PATCH /api/receipts/:id. amount and currency go together; an empty description or remark clears it. */
export type ReceiptPatch = Partial<Pick<Receipt, 'filename' | 'date' | 'amount' | 'currency' | 'description' | 'remarks'>>;

/** The body of PATCH /api/transactions/:ref. An empty remark or noReceiptNeeded false clears the field. */
export type TransactionPatch = Partial<Pick<BankTransaction, 'description' | 'remarks' | 'noReceiptNeeded'>>;
