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
  /** Who set the kind: a rule (named in kindRule) or a person. A person's kind is never overwritten. */
  kindBy?: 'rule' | 'human';
  kindRule?: string;
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
}

/** POST /api/statements read a statement in: its file, the statement to open (account and month it ends in), the payments new to the books. */
export interface StatementImport {
  file: string;
  account: string;
  month: string;
  added: number;
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
   * the app's code, the AI (which model), or a person (by hand, an answer, the AI sidebar on their
   * wish; `was` holds the booking fields before their change). Parsed at the books boundary
   * (src/books/booked-by.ts). Absent: an entry booked before the field existed; the booking page
   * then says what `origin` says.
   */
  by?: BookedBy;
  /**
   * The receipts linked to the payment when the classifier booked it. A receipt linked later is
   * evidence the booking never saw (its VAT above all): the next classify books it again
   * (src/accounting/classify-force.ts entriesWithoutTheirReceipts). Absent: booked before this
   * field existed, or by another writer; such an entry is never booked again for this reason.
   */
  receipts?: string[];
}

/** The app's checks that set a booking's code themselves (src/accounting/sales-without-vat.ts saleCodeOf: a sale's VAT code). */
export const CODE_CHECKS = ['saleCode'] as const;
export type CodeCheck = typeof CODE_CHECKS[number];

/** The booking fields a person's change keeps the old values of. */
export type BookingFields = Partial<Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'vatCode' | 'amount'>>;

/** Who decided a booking (JournalEntry.by). */
export type BookedBy =
  | { kind: 'rule'; rule: string }
  | { kind: 'code'; check: CodeCheck }
  | { kind: 'model'; model: string }
  | { kind: 'person'; at: string; was?: BookingFields };

/** A filing period: a quarter ("2026-Q2") for a firm filing quarterly, a half year ("2026-H1") for one filing half-yearly. */
export type QuarterKey = `${number}-Q${1 | 2 | 3 | 4}` | `${number}-H${1 | 2}`;

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
   * are what receipts are matched against and what entries are split by. A filed transaction
   * keeps exactly what it was filed with, parts or none.
   */
  parts?: BankTransactionPart[];
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
}

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

/** The body of PATCH /api/transactions/:ref. An empty remark or noReceiptNeeded false clears the field. */
export type TransactionPatch = Partial<Pick<BankTransaction, 'description' | 'remarks' | 'noReceiptNeeded'>>;
