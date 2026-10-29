/**
 * A bank statement without a bank export (#217): a PDF, a scan or a photo read by the model, a table a
 * person filled by hand, or a bank's CSV read by a column mapping. Whatever read it, it is this one
 * shape, checked in code (src/books/statement-check.ts) and written as an ISO 20022 statement
 * (src/providers/statement-read/camt-writer.ts), so everything after it is the camt path.
 */
import type { AiRefusal } from './ai-refusal.js';

/** One movement as the statement prints it: signed in the account's currency (money out negative). */
export interface ReadMovement {
  date: string;
  valueDate?: string;
  amount: number;
  counterparty?: string;
  text?: string;
  reference?: string;
  /**
   * The amount in the currency the payment was made in, when the statement prints one besides the
   * account's (a card charge in USD on an account in another currency): positive. Written as the ISO 20022 InstdAmt, so
   * a receipt in that currency matches it as it matches a bank export's (#187).
   */
  original?: { amount: number; currency: string };
  /** The page it is printed on, where the statement has several. */
  page?: number;
  /** The account's balance the row prints after it (a running balance column), where it prints one. */
  balance?: number;
  /**
   * The payment of the books a person said this line is (#243: a table filled by hand from a kept
   * statement PDF's payments): its reference and amount in another currency go onto that payment.
   */
  payment?: string;
}

/** A page's carry-over as printed: the balance brought forward at its top and carried at its foot. */
export interface ReadPage { page: number; carriedIn?: number; carriedOut?: number }

export interface ReadStatement {
  iban?: string;
  currency: string;
  bankName?: string;
  owner?: string;
  period?: { from: string; to: string };
  /** The balance before the first movement (its day: the period's first) and after the last. */
  opening: { date: string; amount: number };
  closing: { date: string; amount: number };
  pages?: ReadPage[];
  movements: ReadMovement[];
}

/**
 * Where the figures do not add up, to the cent: the whole statement (opening + movements =
 * closing), one page (carried in + its movements = carried out) or the step between two pages (what
 * one carries out, the next brings in). `expected` is what the statement prints, `found` what its
 * movements make.
 */
export interface BalanceGap { where: 'total' | 'page' | 'carry'; page?: number; expected: number; found: number; gap: number }

export interface BalanceCheck { ok: boolean; gaps: BalanceGap[] }

/** Who filled the table: the model from the file, a person by hand, a CSV by its column mapping. */
export type ReadBy = 'model' | 'hand' | 'csv';

/**
 * Why a statement file is a table to fill by hand: the AI is switched off (Firma › KI), no provider
 * answers here, the file has more pages than the model reads (`limit`), the model's call failed (its
 * words in `error`) or its answer was no statement code could take, or the model says the file is no
 * statement at all (then it may be a receipt).
 */
export type HandWhy = 'noAi' | 'noProvider' | 'pages' | 'failed' | 'notStatement';

/** Days of a statement a structured source of its account covers (#254): that file's, clipped to the statement's days. */
export interface CoveredDays { file: string; from: string; to: string }

/** A statement read and checked, as the drop row shows it for the person to correct and import. */
export interface StatementRead {
  by: ReadBy;
  statement: ReadStatement;
  check: BalanceCheck;
  /** The lines the books hold already (by day and amount), from an ISO 20022 statement or an earlier statement: not added again. */
  known: { date: string; amount: number }[];
  why?: HandWhy;
  /** The provider's words when its call failed (`why: 'failed'`). */
  error?: string;
  /**
   * The days of this statement the account's bank export or bank CSV covers already (#254): a line on
   * them is imported only as the payment the books hold of its day and amount, never as a new one,
   * since a value date or a day misread would double a payment. `whole`: they cover every day, so
   * there is nothing to read in; the PDF is kept as the statement.
   */
  covered?: CoveredDays[];
  whole?: true;
  /** The file's pages, and the most the model reads (`why: 'pages'`). */
  pages?: number;
  limit?: number;
}

/** Which column of a bank's CSV holds what (0-based); an amount is one signed column or a debit and a credit column. */
export interface CsvColumns {
  date: number;
  valueDate?: number;
  amount?: number;
  debit?: number;
  credit?: number;
  counterparty?: number;
  text?: number;
  reference?: number;
  balance?: number;
}

/** A bank CSV waiting for its columns: its header, a few rows, and the mapping proposed (kept for its account, else guessed). */
export interface CsvAsk {
  header: string[];
  sample: string[][];
  rows: number;
  columns?: CsvColumns;
  /** The ledger account whose kept mapping fits this header. */
  account?: string;
  /** The bank accounts that take statements, for the person to say whose CSV it is. */
  accounts: { account: string; label: string; currency: string }[];
}

/**
 * What a statement PDF kept as its statement gives the books (#243, src/server/statement-reads.ts):
 * `read` by the model or `hand` by a person (the read beside it), `asked` (the table of its question
 * in the books), not read yet (`unread`, or `filed`: its month is filed, so it is not read), or the
 * model's answer gave no statement (`notStatement`, `pages`: more than the model reads, `unreadable`).
 */
export type PdfFactsState = 'read' | 'hand' | 'asked' | 'unread' | 'filed' | 'notStatement' | 'pages' | 'unreadable';

export interface PdfFactsView {
  /** `<bank>/<file name>`. */
  file: string;
  account: string;
  from: string;
  to: string;
  state: PdfFactsState;
  by?: 'model' | 'hand';
  statement?: ReadStatement;
  /** Its figures add up (a person's table is taken as she typed it): only then the books take its closing balance. */
  adds?: boolean;
  /** The closing balance the books hold from this file. */
  closing?: { date: string; amount: number };
  /** The references and amounts in another currency its lines put on open payments. */
  taken?: { references: number; originals: number };
  /** Lines with a reference or foreign amount that more than one payment could be, and those no payment of their day and amount is: nothing taken. */
  ambiguous?: number;
  unmatched?: number;
  /** Why the last reading of it failed (nothing kept: the next run asks again). */
  error?: string;
}

/** The kept statement PDFs still to read, and the reading the person started (GET /api/statement-reads). */
export interface StatementReadsView {
  /** Whether the model reads statement PDFs here: `noAi` switched off, `noProvider` no AI set up, `unserved` none here reads a PDF. */
  ai: 'ready' | 'noAi' | 'noProvider' | 'unserved';
  /** The PDFs of open months not read yet (`<bank>/<file name>`). */
  unread: string[];
  /** The most the inbox run reads by itself; a larger backlog waits for the person. */
  withoutAsking: number;
  /** The most pages the model reads of one statement. */
  limit: number;
  failures: { file: string; error: string }[];
  job?: {
    done: number; total: number; current?: string; cancelling?: true; finished?: true;
    read: number; failed: { file: string; error: string }[];
    stopped?: { error: string; refusal?: AiRefusal };
    error?: string;
  };
}
