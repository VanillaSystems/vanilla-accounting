/**
 * The data a module carries, as the engines read it (docs/0.4.0/modules.md). A jurisdiction
 * module (modules/ch/) holds the tax codes, the rates and the VAT return as data; the engines in
 * src/engines/ interpret it. Every collection is a map keyed by its natural id (a code, a box), so
 * a workspace overlay can replace, add or remove one entry without copying the rest.
 */

/** A box of the return form, by its number on the form ("200", "303"). */
export type BoxId = string;

/** module.yaml: what a module is. */
export interface ModuleManifest {
  id: string;
  kind: 'jurisdiction' | 'layout' | 'capability';
  /** The module's own version (CalVer for law data). */
  version: string;
  /** The format of its data files; climbs like books.json (src/workspace/schema.ts). */
  schema: number;
  provides?: string[];
  /** A jurisdiction's currency of account; a workspace overlay may set its own (a Swiss company keeping books in EUR). */
  baseCurrency: string;
  /** A workspace overlay names the shipped module it changes and the version it was written against. */
  overlays?: string;
  basedOn?: string;
}

/** A rate row of section II of the return: the turnover (or, for Bezugsteuer, the acquisition) at one rate. */
export interface RateRow {
  rate: number;
  /**
   * Supplies are declared gross and their tax is taken out of it; an acquisition is declared net;
   * a net-rate row (the net tax rate method) is declared gross and its tax is the rate on the gross.
   */
  kind: 'supply' | 'acquisition' | 'net-rate';
  /** The tax code that books into this row. */
  code: string;
  /** The rate's name on the form. */
  name: string;
  /** A rate no longer in force: the form shows its row only when it has a figure. */
  superseded?: boolean;
}

/** rates.yaml */
export interface RatesData {
  /** Keyed by the box the row declares. */
  rows: Record<BoxId, RateRow>;
}

/** What one tax code does, before its sign and amount suffix. */
export interface CodeMeaning {
  rate: number;
  /** The box its turnover goes to (a supply at a rate). */
  revenue?: BoxId;
  /** The deduction box its turnover goes to (exports, supplies abroad, …). */
  deduction?: BoxId;
  /** The input-tax box its tax goes to; only when rate > 0. */
  inputTax?: BoxId;
  /** The correction box its tax goes to. */
  correction?: BoxId;
  /** The acquisition-tax box its tax goes to (Bezugsteuer). */
  acquisition?: BoxId;
}

/** A family of codes recognised by pattern, such as K81-B. */
export interface CodePattern {
  /** A regular expression over the unsigned code without amount suffix. */
  match: string;
  /** The capture group holding the rate times `rateDivisor`; empty means 0. */
  rateGroup: number;
  rateDivisor: number;
  /** The capture group whose value picks the correction box. */
  correctionGroup: number;
  correction: Record<string, BoxId>;
}

/** A sale at the firm's n-th approved net tax rate, booked gross: the rate is the firm's, the tax the rate on the gross. */
export interface NetRateCodeMeaning {
  netRate: 1 | 2;
  revenue: BoxId;
}

/** tax-codes.yaml */
export interface TaxCodesData {
  /** The prefix that makes a code a refund or reversal of the code after it. */
  negativePrefix: string;
  /** The amount-type suffixes, and the code families (leading letters) that may carry them. */
  amountSuffix: { families: string[]; net: string; tax: string };
  /** Every code with a fixed meaning, in catalogue order. */
  codes: Record<string, CodeMeaning>;
  /** The codes of the net tax rate method, whose rate is the firm's (return-net-rate.yaml takes them). */
  netRateCodes?: Record<string, NetRateCodeMeaning>;
  patterns: CodePattern[];
  /** The input-tax box a purchase's tax goes to: by the income section of its account (material and goods), else `otherwise`. */
  purchaseBoxes: { costOfGoods: BoxId; otherwise: BoxId };
}

/** A box that collects a field of the entries feeding it. */
export interface SourceBox {
  label: string;
}

/** A formula over boxes: four operations, so the loader can check references and cycles. */
export type Formula =
  | { sum: BoxId[] }
  | { minus: [BoxId, BoxId] }
  | { positive: Formula | BoxId }
  | { taxOfRows: true }
  | { signed: Record<BoxId, 1 | -1> };

/** return.yaml */
export interface ReturnData {
  /** The authority's number of the form (0550, 0553), for the UI. */
  form?: string;
  /**
   * The codes this form takes; absent: every code whose boxes it all has. A box a listed code
   * names that the form lacks is left out (B81 on the net-rate form: its acquisition, no deduction).
   */
  codes?: string[];
  /** The box that collects the gross amount of every revenue and deduction code. */
  turnoverBox: BoxId;
  turnoverLabel: string;
  /** The rate rows in form order (rates.yaml holds what each row is). */
  rateOrder: BoxId[];
  /** Deduction boxes in schema order, each with its eCH-0217 element (absent when the schema has none). */
  deductions: Record<BoxId, SourceBox & { element?: string }>;
  /** Input-tax boxes in schema order; a negative sign reduces the input tax. */
  inputTax: Record<BoxId, SourceBox & { element: string; sign: 1 | -1 }>;
  /** Boxes computed from others, with their formulas. */
  derived: Record<BoxId, SourceBox & { formula: Formula }>;
  /** The derived boxes that are the amount to pay and the credit. */
  payable: BoxId;
  credit: BoxId;
}

/** return-net-rate.yaml: the net tax rate method's form, with a rate row per approved rate of the firm. */
export interface NetRateReturnData extends ReturnData {
  codes: string[];
  /** The rows of the firm's first and second approved rate, by box; a firm with one rate has no second row. */
  netRateRows: Record<BoxId, { netRate: 1 | 2; code: string; name: string }>;
}

/** registration.yaml: when a firm must register for VAT. */
export interface RegistrationData {
  /** Turnover of a calendar year, in the base currency, from which registration is mandatory. */
  turnoverThreshold: number;
}

import type { FilingLength } from '../../accounting/periods.js';

/** periods.yaml: the length of one VAT return and the days after its end until the tax is due. */
export interface PeriodsData {
  vat: { length: FilingLength; dueDays: number };
}

export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense' | 'closing';

/** Which side of the statements an account's balance counts on; `none` keeps it off both. */
export type StatementSide = 'assets' | 'liabilities' | 'result' | 'none';

export interface AccountTypeRule {
  normal: 'debit' | 'credit';
  side: StatementSide;
}

/** chart.yaml: an account's type from its leading digits (longest prefix wins), and what each type means. */
export interface ChartData {
  classes: Record<string, AccountType>;
  types: Record<AccountType, AccountTypeRule>;
  /** An account no class matches. */
  unclassified: AccountTypeRule;
}

/** Accounts by range (`from` inclusive, `to` exclusive) or one by one. */
export type AccountGroup = { title: string } & ({ from: string; to: string } | { accounts: string[] });

export const INCOME_SECTIONS = ['revenue', 'costOfGoods', 'operatingExpenses', 'otherIncome', 'otherExpenses', 'extraordinaryItems'] as const;

/** statements.yaml: the groups of the balance sheet and the sections of the income statement. */
export interface StatementsData {
  balance: {
    assets: AccountGroup[];
    /** The group with `openResult` also shows the year's result while the year is open, under that name. */
    liabilities: (AccountGroup & { openResult?: string })[];
  };
  income: Record<(typeof INCOME_SECTIONS)[number], AccountGroup>;
  /**
   * How the statements show the VAT during the year. `net`: the tax the codes split off sits on
   * the VAT account from the day it is booked, as the year close posts it (src/accounting/statement-postings.ts);
   * `gross`: revenue and expense hold it until the year close.
   */
  vat: StatementsVat;
}

export const STATEMENTS_VAT = ['net', 'gross'] as const;
export type StatementsVat = (typeof STATEMENTS_VAT)[number];

/** A guided year-end entry; a blank account is the user's pick. */
export interface YearEndTemplate { id: string; accountDebit: string; accountCredit: string; vatCode?: string; /** Only for these legal forms (a GmbH's tax provision; an Einzelfirma's owner pays the income tax). */ legalForms?: string[] }

/**
 * How one legal form closes the year's result and uses the profit (year-end.yaml `byLegalForm`).
 * Accounts are candidates: the first the chart has wins.
 */
export interface ResultCloseData {
  /** The equity account the result is carried to when the next year opens. */
  resultTo: string[];
  /** The owner's private account whose balance closes into `resultTo` with the year (an Einzelfirma's Privat). */
  privateInto?: string[];
  /** The profit allocation after the shareholders' resolution; absent where the profit is the owner's without one. */
  allocation?: { reserve: string; dividend: string; withholdingTax: string; withholdingTaxRate: number };
}

/** year-end.yaml: the accounts the year close books on, its entry forms, and the close of the result by legal form. */
export interface YearEndData {
  accounts: { fxDifference: string[]; vatSettlement: string[]; vat: string[]; receivables: string[]; payables: string[] };
  templates: YearEndTemplate[];
  byLegalForm: Record<string, ResultCloseData> & { otherwise: ResultCloseData };
  /**
   * What a country's law asks of money accounts at the year end beyond the base every country
   * gets (a closing balance from a document on every bank and card account, a cash count on every
   * cash box). `monthlyStatements`: the roles whose accounts need a statement for every month of
   * the year, imported or not. Absent or empty: only accounts with an imported statement do.
   */
  moneyAccounts?: { monthlyStatements?: string[] };
}

/** invoicing.yaml: the rates an invoice line offers, and a 0 % line's deduction box by exemption. */
export interface InvoicingData {
  rates: number[];
  exemptions: Record<'abroad' | 'export', BoxId>;
  /** The country codes of the VAT territory, as an IBAN starts: a payer there is domestic. */
  territory: string[];
  /** Words with which an invoice without the jurisdiction's VAT says its service is supplied abroad. */
  placeAbroad: string[];
}

/** setup.yaml: the accounts a new workspace gets from the setup's answers. */
export interface SetupData {
  bankAccounts: {
    byCurrency: Record<string, string>;
    nextFree: { bank: number; card: number };
    byClass: Record<string, { type: AccountType; line: string }> & { otherwise: { type: AccountType; line: string } };
  };
  owner: Record<string, { account: string; label: string }> & { otherwise: { account: string; label: string } };
  answers: {
    /** «Auszahlungen eines Zahlungsanbieters: ja»: the accounts added, and the firm's own payout split when no rule names the provider. */
    payouts: { accounts: string[]; sales: { otherwise: string }; fees: { account: string; vat: string } };
    imports: string[];
  };
  /** «Was verkauft ihr?»: each kind's default accounts (src/workspace/sells.ts). */
  sells: Record<'made' | 'traded' | 'services', { purchase?: string; sales: string }>;
}

/**
 * documents.yaml: the words that say what a document is, in the languages of the jurisdiction's
 * receipts (src/intake/document-kind.ts). Each list is matched as words, ignoring case.
 */
export interface DocumentsData {
  /** Words of a receipt: its title, its total, its due date, a payment slip, the label of its number. */
  receipt: Record<'title' | 'total' | 'due' | 'slip' | 'number', string[]>;
  /** Documents kept as proof beside an invoice, never paid on their own. */
  supporting: Record<'order-confirmation' | 'delivery-note' | 'reminder', string[]>;
  /** Documents that are no receipt at all. */
  other: Record<'newsletter' | 'terms' | 'price-list' | 'tracking' | 'no-receipt', string[]>;
  /** The title of a bank statement: the drop reads such a PDF as a statement, not as a receipt. */
  statement: string[];
}

/** A document kept beside an invoice, and a document that is no receipt, by what its words say. */
export type SupportingWhy = keyof DocumentsData['supporting'];
export type OtherWhy = keyof DocumentsData['other'];

/** A jurisdiction module after its files are read and any workspace overlay is merged. */
export interface Jurisdiction {
  manifest: ModuleManifest;
  rates: RatesData;
  taxCodes: TaxCodesData;
  vatReturn: ReturnData;
  /** Absent in a jurisdiction without a net tax rate method: a workspace on it then does not open. */
  vatReturnNetRate?: NetRateReturnData;
  /** Absent: the MWST page of a firm that is not registered names no threshold. */
  registration?: RegistrationData;
  chart: ChartData;
  periods: PeriodsData;
  statements: StatementsData;
  yearEnd: YearEndData;
  invoicing: InvoicingData;
  setup: SetupData;
  documents: DocumentsData;
}
