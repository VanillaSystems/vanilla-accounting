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
  /** The labels before a place of supply on an invoice («Leistungsort»): the hand form's proof of a supply abroad is a place outside the territory after one (#382). */
  placeOfSupply?: string[];
  /** Wordings that a price includes the jurisdiction's VAT («inkl. MWST»): never a supply abroad. */
  vatIncluded?: string[];
  /** The words that label a VAT on an invoice: a percentage beside one that is no rate of the jurisdiction is a foreign VAT. */
  vatLabels?: string[];
}

/** setup.yaml: the accounts a new workspace gets from the setup's answers. */
export interface SetupData {
  bankAccounts: {
    byCurrency: Record<string, string>;
    nextFree: { bank: number; card: number };
    byClass: Record<string, { type: AccountType; line: string }> & { otherwise: { type: AccountType; line: string } };
  };
  owner: Record<string, { account: string; label: string }> & { otherwise: { account: string; label: string } };
  /** The account the bank's own fee row is booked on by code, without a VAT code (src/booking/bank-fee.ts, #359); absent: such a row is left to a rule, the model or the person. */
  bankCharges?: { account: string };
  /** The wage account: a booking on it carries no VAT code (src/booking/rule-vat.ts); absent: no rule for wages is offered. The hand form proposes it (#382); `deductions`: where wages' deductions go, books carrying it get no proposal; `contributions`: the employer's social insurance contributions, which carry no VAT code either. */
  wages?: {
    account: string; deductions?: string; contributions?: string[];
    /** The business files (ids) that collect contributions with the employees' share the payslips withheld: a payment to one is told what `deductions` holds (src/booking/withheld.ts, #426). */
    payees?: string[];
    /** The contribution accounts the employees share in (AHV/IV/EO/ALV, BVG), never one the employer pays alone (family allowances): a payment booked there with nothing on `deductions` is a task (#426). */
    shared?: string[];
    /** The words a payslip names each deduction by, per kind (a key of `payees` is what that business collects): code reads the payslips' deductions per fund by them (src/booking/withheld.ts fundShare, #476). */
    withholds?: Record<string, string[]>;
  };
  /** The account each kind of private use (the setup's privateUse: car, phone) is booked on: a share named in the setup is offered as a rule on a payment booked there (#402). */
  privateUse?: Partial<Record<'car' | 'phone', string>>;
  answers: {
    /** «Auszahlungen eines Zahlungsanbieters: ja»: the accounts added, and the firm's own payout split when no rule names the provider. */
    payouts: { accounts: string[]; sales: { otherwise: string }; fees: { account: string; vat: string }; clearing: { account: string; name: string } };
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
  /** A title word also closes a compound at the start of a line («Akontorechnung»), unless the compound ends in one of these («Lohnabrechnung», «Berechnung»): src/core/modules/words.ts compoundLines. */
  notCompound?: string[];
  /** Words on a line with a total's word that make it no total of the document: a payroll, a sum insured, a limit, hours. */
  notTotal?: string[];
  /** Phrases by which a document says it charges no VAT of the jurisdiction (a sale abroad, an exempt premium, a reverse charge). */
  noVat?: string[];
  /** Words of a document that repeats another's number and amount without being its copy (a credit note, a proforma, an instalment): a mailbox never sets it aside as a duplicate (src/platform/sources/aside.ts contentTwin). */
  notDuplicate?: string[];
  /** Words of a file name that say nothing of what a file is (a camera's «IMG», a scanner's «Scan»): a file-name shape made of these alone is never offered to be kept aside (src/platform/sources/aside.ts). */
  genericFileNames?: string[];
  /** Short forms by which a file name says it is a receipt («re», «inv»): a file-name shape with one as a part of its own is never offered to be kept aside, however short. */
  receiptFileNames?: string[];
  /** Documents kept as proof beside an invoice, never paid on their own. */
  supporting: Record<'order-confirmation' | 'delivery-note' | 'reminder' | 'customs-assessment' | 'balance-sheet', string[]>;
  /** Documents that are no receipt at all. */
  other: Record<'newsletter' | 'terms' | 'price-list' | 'tracking' | 'no-receipt', string[]>;
  /** A courier's customs invoice: its positions by their words and accounts, and the customs office's assessment that proves import VAT (src/booking/customs-invoice.ts). */
  customs: {
    positions: Record<CustomsPosition, { account: string; words: string[] }>;
    /** Words that name only the tax («MwSt / TVA / IVA»): such a line at no rate is the import VAT the carrier advanced, on an invoice whose lines name duty or import VAT. */
    tax: string[];
    /** Words that name costs passed on free of VAT («MWST.-freie Kosten»): such a line at no rate is the import VAT the carrier advanced, on an invoice that cites a customs declaration's number. */
    untaxed?: string[];
    /** `number`: the pattern (a regular expression's source) of the assessment's number; `access`: the label of the access code a courier's invoice prints to fetch it; `importer`: the label of the importer's block. */
    assessment: { title: string[]; total: string[]; number: string; access: string[]; importer?: string[] };
  };
  /** The title of a bank statement: with an IBAN or the movement columns, the drop reads such a PDF as a statement, not as a receipt (src/core/modules/words.ts isBankStatement). */
  statement: string[];
  /** The title of a credit card's monthly statement («Kreditkartenabrechnung», «Card statement»): with a period, a card statement among the receipts, which the app reads as the receipt of the card's debit on the bank account, never as a statement (src/books/statement-facts.ts isCardStatement, #401, #94). */
  cardStatement?: string[];
  /** The card's own payment on its statement («Ihre Zahlung», «Payment received»): with the balance words, a row that is no merchant's line (src/books/card-lines.ts, #409). */
  cardPayment?: string[];
  /** The column words of a statement's movements, money out and money in («Belastung», «Gutschrift»): a bank statement without an IBAN shows them. */
  movements: { out: string[]; in: string[] };
  /** The balance lines of a statement («Saldovortrag», «Closing balance»): with its title, IBAN and period, a statement among the receipts (src/books/statement-facts.ts). */
  balance: string[];
  /** The title of a credit note («Gutschrift», «Credit note»): money comes back for it, so it is matched to money in (src/intake/pairing.ts paysIn). */
  credit?: string[];
  /** The words of a payment's text that say only that it is a payment («Zahlung», «Auftrag», «Karte»): a rule on them alone is not offered (src/saving/hand-rule.ts, #383). */
  payment?: string[];
  /** The words of a cash discount («Skonto», «escompte»): a percentage beside one is a discount a payment states or an invoice offers (src/intake/near-pairs.ts, #397). */
  discount?: string[];
  /** Words that negate a discount word right after them («ohne Skonto»). */
  discountNone?: string[];
  /** The words of a count of days in payment terms («Tagen», «jours»). */
  days?: string[];
  /** The months, January first, each by its names in the jurisdiction's languages. */
  months?: string[][];
  /** Legal forms and words of a firm's name that tell no one apart («GmbH», «Holding»). */
  legalForms?: string[];
  /** The words that label the customer's block of an invoice («Kunde», «Rechnungsadresse», «Ihre UID»): a VAT number beside one is the buyer's, never the sender's (src/intake/own-invoice.ts buyerUids). */
  buyer?: string[];
  /** A title's vendor that names no business (the model's «Verkauf» for a till's slip): it tells no vendor apart (src/intake/own-invoice.ts buyerUids). */
  notVendor?: string[];
}

/** What a line of a customs invoice charges: the import VAT the carrier advanced, customs duty, the carrier's fees, freight. */
export const CUSTOMS_POSITIONS = ['importVat', 'duty', 'fees', 'freight'] as const;
export type CustomsPosition = typeof CUSTOMS_POSITIONS[number];

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
