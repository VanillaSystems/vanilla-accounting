/**
 * A bank statement without a bank export (#217): a PDF, a scan or a photo read by the model, a table a
 * person filled by hand, or a bank's CSV read by a column mapping. Whatever read it, it is this one
 * shape, checked in code (src/books/statement-check.ts) and written as an ISO 20022 statement
 * (src/providers/statement-read/camt-writer.ts), so everything after it is the camt path.
 */

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
 * Why a statement file is a table to fill by hand: no AI here, the file has more pages than the
 * model reads (`limit`), the model's answer was no statement code could take, or the model says the
 * file is no statement at all (then it may be a receipt).
 */
export type HandWhy = 'noAi' | 'pages' | 'failed' | 'notStatement';

/** A statement read and checked, as the drop row shows it for the person to correct and import. */
export interface StatementRead {
  by: ReadBy;
  statement: ReadStatement;
  check: BalanceCheck;
  /** The lines the books hold already (by day and amount), from an ISO 20022 statement or an earlier statement: not added again. */
  known: { date: string; amount: number }[];
  why?: HandWhy;
  /**
   * A bank export in the books covers days of this statement's account (`file`, from `from` to `to`):
   * its movements are not imported, whatever lines match, since a value date or a day misread would
   * double a payment. A PDF is kept as the month's statement instead («Als Monatsauszug behalten»).
   */
  covered?: { file: string; from: string; to: string };
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
