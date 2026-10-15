/**
 * The questions `npm run init` asks, as data: their order, the plain explanation of each, the
 * answers the engine supports, and why it stops on the others. A preset prefills the answers.
 * The wizard (src/cli/init.ts), the manifest reader and the getting-started guide all read this
 * table, so a newly supported answer is one edit here.
 */

export const LEGAL_FORMS = ['GmbH', 'AG', 'Einzelfirma'] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];
export const BUSINESS_PROFILES = ['services', 'goods', 'both'] as const;
export type BusinessProfile = (typeof BUSINESS_PROFILES)[number];

export interface Option {
  value: string;
  label: string;
  /** Not supported yet: the wizard prints this and stops. */
  unsupported?: string;
  /** Supported with a limit the owner should know: printed, then the wizard goes on. */
  caveat?: string;
}

interface QuestionSpec {
  ask: string;
  /** One line, in plain words: why the answer matters. */
  why: string;
  options: readonly Option[];
  /** Several answers allowed (comma separated); none is a valid answer. */
  multi?: boolean;
}

export const QUESTIONS = {
  legalForm: {
    ask: 'Legal form',
    why: 'Decides the equity accounts and whether the owner draws a salary or takes money out privately.',
    options: [
      { value: 'GmbH', label: 'GmbH' },
      { value: 'AG', label: 'AG' },
      {
        value: 'Einzelfirma', label: 'Einzelfirma',
        caveat: 'An Einzelfirma pays no owner salary: what you take out is booked on 2850 Privat. Day-to-day bookkeeping and VAT work; the year-end (AHV on the profit, the tax return) is not covered.',
      },
    ],
  },
  vatRegistered: {
    ask: 'Registered for VAT (MWST)?',
    why: 'Mandatory from CHF 100,000 turnover a year; only then do entries carry VAT codes and you file returns.',
    options: [
      { value: 'yes', label: 'yes, I have a MWST number' },
      {
        value: 'no', label: 'no',
        unsupported: 'Books without VAT are not supported yet: today every entry carries a VAT code and the app files a VAT return each quarter. This mode is planned; until then Vanilla Accounting is not the right tool for a company that is not registered.',
      },
    ],
  },
  vatMethod: {
    ask: 'VAT method',
    why: 'Effective: you pay the VAT you charged minus the input tax on your costs. Saldosteuersatz: a flat rate on turnover, no input tax.',
    options: [
      { value: 'effective', label: 'effektive Methode' },
      {
        value: 'saldo', label: 'Saldosteuersatz',
        unsupported: 'The Saldosteuersatz method is not supported yet: the return the app writes is the effective one (input tax per receipt). If you switch to the effective method with the ESTV, rerun npm run init.',
      },
    ],
  },
  basis: {
    ask: 'VAT basis',
    why: 'Vereinnahmt: VAT is due when the money moves (bank statement). Vereinbart: when you send or receive the invoice.',
    options: [
      { value: 'received', label: 'vereinnahmt (cash)' },
      {
        value: 'agreed', label: 'vereinbart (invoice)',
        unsupported: 'Vereinbarte Entgelte are not supported yet: the app books from the bank statement, so the tax point is always the payment date. It needs open invoices (Debitoren/Kreditoren), which it does not keep.',
      },
    ],
  },
  period: {
    ask: 'VAT reporting period',
    why: 'How often you file the MWST return. On the effective method that is quarterly unless the ESTV allowed otherwise.',
    options: [
      { value: 'quarterly', label: 'quarterly' },
      { value: 'half-yearly', label: 'half-yearly', unsupported: 'Half-yearly returns are not supported yet: the eCH-0217 export writes quarters only.' },
      { value: 'monthly', label: 'monthly', unsupported: 'Monthly returns are not supported yet: the eCH-0217 export writes quarters only.' },
    ],
  },
  fiscalYear: {
    ask: 'Fiscal year',
    why: 'The books open on 1 January; opening balances, the year-end and the VAT quarters follow the calendar year.',
    options: [
      { value: 'calendar', label: 'calendar year (1.1.-31.12.)' },
      { value: 'other', label: 'other', unsupported: 'A fiscal year other than the calendar year is not supported yet: opening balances and the year-end are kept per calendar year.' },
    ],
  },
  start: {
    ask: 'Starting point',
    why: 'A new company starts with empty books. A running one needs its opening balances of 1 January.',
    options: [
      { value: 'new', label: 'new company, empty books' },
      {
        value: 'switching', label: 'switching from other bookkeeping',
        caveat: 'Bring the opening balances: npm run import-opening reads them from a Banana Konten XML export. The first camt.053 of a bank account offers its starting balance as the opening balance.',
      },
    ],
  },
  sells: {
    ask: 'What you sell',
    why: 'Picks the accounts of your chart: services (consulting, software) or goods (a shop, a webshop), or both.',
    options: [
      { value: 'services', label: 'services' },
      { value: 'goods', label: 'goods' },
      { value: 'both', label: 'both' },
    ],
  },
  foreignCustomers: {
    ask: 'Customers abroad?',
    why: 'A service to a customer abroad is usually not taxed in Switzerland: it is declared, but without VAT.',
    options: [{ value: 'yes', label: 'yes' }, { value: 'no', label: 'no' }],
  },
  imports: {
    ask: 'Do you import goods?',
    why: 'Imports come with customs and import VAT invoices from the courier, booked apart from the goods.',
    options: [{ value: 'yes', label: 'yes' }, { value: 'no', label: 'no' }],
  },
  employees: {
    ask: 'Employees',
    why: 'Salaries come from your payroll provider or Treuhand; Vanilla Accounting books the payments, it does not calculate payroll.',
    options: [
      { value: 'none', label: 'none' },
      { value: 'owner', label: 'the owner only', caveat: 'Vanilla Accounting books the salary and the AHV, BVG and UVG payments; the payroll itself (Lohnausweis, AHV statement) stays with your provider.' },
      { value: 'staff', label: 'staff', caveat: 'Vanilla Accounting books the salary and the AHV, BVG and UVG payments; the payroll itself (Lohnausweis, AHV statement) stays with your provider.' },
    ],
  },
  ownerPaysPrivately: {
    ask: 'Does the owner pay business costs privately?',
    why: 'Then the company owes them back: those receipts are booked on a current account with the owner.',
    options: [{ value: 'yes', label: 'yes' }, { value: 'no', label: 'no' }],
  },
  privateUse: {
    ask: 'Private use of a company car or phone',
    why: 'The private share takes back part of the input tax (Eigenverbrauch, VAT code K81-B).',
    multi: true,
    options: [{ value: 'car', label: 'car' }, { value: 'phone', label: 'phone' }],
  },
  payouts: {
    ask: 'Do sales reach you as payouts from a webshop or payment provider?',
    why: 'A payout bundles sales and fees; it goes over a clearing account (1093) so both are booked.',
    options: [{ value: 'yes', label: 'yes' }, { value: 'no', label: 'no' }],
  },
} as const satisfies Record<string, QuestionSpec>;

export type QuestionKey = keyof typeof QUESTIONS;
type ValueOf<K extends QuestionKey> = (typeof QUESTIONS)[K]['options'][number]['value'];
type SupportedValueOf<K extends QuestionKey> = Exclude<(typeof QUESTIONS)[K]['options'][number], { unsupported: string }>['value'];
type IsMulti<K extends QuestionKey> = (typeof QUESTIONS)[K] extends { multi: true } ? true : false;

/** An answer as given: any option, supported or not. */
export type Answers = { [K in QuestionKey]: IsMulti<K> extends true ? ValueOf<K>[] : ValueOf<K> };
/** An answer the engine runs on: what the manifest stores. */
export type SupportedAnswers = { [K in QuestionKey]: IsMulti<K> extends true ? SupportedValueOf<K>[] : SupportedValueOf<K> };

/** The order the wizard asks in. */
export const QUESTION_ORDER = Object.keys(QUESTIONS) as QuestionKey[];

export const PRESETS = {
  consultant: {
    label: 'Consultant / services GmbH',
    answers: {
      legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly',
      fiscalYear: 'calendar', start: 'new', sells: 'services', foreignCustomers: 'yes', imports: 'no',
      employees: 'owner', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no',
    },
  },
  webshop: {
    label: 'Webshop / goods GmbH',
    answers: {
      legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly',
      fiscalYear: 'calendar', start: 'new', sells: 'goods', foreignCustomers: 'no', imports: 'yes',
      employees: 'owner', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'yes',
    },
  },
  trades: {
    label: 'Trades / construction GmbH',
    answers: {
      legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly',
      fiscalYear: 'calendar', start: 'new', sells: 'both', foreignCustomers: 'no', imports: 'no',
      employees: 'staff', ownerPaysPrivately: 'yes', privateUse: ['car', 'phone'], payouts: 'no',
    },
  },
  freelancer: {
    label: 'Freelancer, not registered for VAT (not supported yet)',
    answers: { legalForm: 'Einzelfirma', vatRegistered: 'no' },
  },
  custom: { label: 'Custom: answer every question', answers: {} },
} as const satisfies Record<string, { label: string; answers: Partial<Answers> }>;

export type Preset = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as Preset[];

export function optionOf(key: QuestionKey, value: string): Option | undefined {
  return (QUESTIONS[key].options as readonly Option[]).find((o) => o.value === value);
}

/**
 * The first unsupported answer, in question order, with its explanation; undefined when the
 * engine supports every answer.
 */
export function firstUnsupported(answers: Answers): { key: QuestionKey; option: Option } | undefined {
  for (const key of QUESTION_ORDER) {
    const values: string[] = ([] as string[]).concat(answers[key]);
    for (const v of values) {
      const option = optionOf(key, v);
      if (option?.unsupported) return { key, option };
    }
  }
  return undefined;
}

export function isSupported(answers: Answers): answers is Answers & SupportedAnswers {
  return firstUnsupported(answers) === undefined;
}
