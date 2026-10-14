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
  kind: 'jurisdiction' | 'integration' | 'layout' | 'capability';
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
  /** Supplies are declared gross and their tax is computed from it; an acquisition is declared net. */
  kind: 'supply' | 'acquisition';
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

/** tax-codes.yaml */
export interface TaxCodesData {
  /** The prefix that makes a code a refund or reversal of the code after it. */
  negativePrefix: string;
  /** The amount-type suffixes, and the code families (leading letters) that may carry them. */
  amountSuffix: { families: string[]; net: string; tax: string };
  /** Every code with a fixed meaning, in catalogue order. */
  codes: Record<string, CodeMeaning>;
  patterns: CodePattern[];
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
}

/** A guided year-end entry; a blank account is the user's pick. */
export interface YearEndTemplate { id: string; accountDebit: string; accountCredit: string; vatCode?: string }

/** year-end.yaml: the accounts the year close books on, its entry forms, the dividend's withholding tax. */
export interface YearEndData {
  accounts: { retainedEarnings: string[]; fxDifference: string[]; vatSettlement: string[]; vat: string[] };
  templates: YearEndTemplate[];
  profitAllocation: { accountDebit: string; accountCredit: string };
  receivables: { accountDebit: string };
  withholdingTaxRate: number;
}

/** A jurisdiction module after its files are read and any workspace overlay is merged. */
export interface Jurisdiction {
  manifest: ModuleManifest;
  rates: RatesData;
  taxCodes: TaxCodesData;
  vatReturn: ReturnData;
  chart: ChartData;
  periods: PeriodsData;
  statements: StatementsData;
  yearEnd: YearEndData;
}
