/**
 * The questions `npm run init` asks, as data: their order, the plain explanation of each, the
 * answers the engine supports, and why it stops on the others. A preset prefills the answers.
 * The wizard (src/cli/init.ts), the manifest reader and the getting-started guide all read this
 * table, so a newly supported answer is one edit here. A question with `when` is asked only when
 * an earlier answer calls for it: the VAT method, basis and period only of a registered firm.
 */
import { VAT_BASES, VAT_PERIODS, asNetRates, type NetRate, type VatBasis, type VatPeriod, type VatSetup } from './vat-setup.js';

export const LEGAL_FORMS = ['GmbH', 'AG', 'Einzelfirma'] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];
export const BUSINESS_PROFILES = ['services', 'goods', 'both'] as const;
/** The chart's profile, and what the manifest's `profile.sells` keeps: services, goods, or both. */
export type BusinessProfile = (typeof BUSINESS_PROFILES)[number];

/**
 * «Was verkauft ihr?» (#46): products the firm makes itself, goods it buys and resells (Handel),
 * services, in any combination. The manifest keeps the answer as it always did, `profile.sells:
 * services | goods | both`, and which goods in an added `profile.goods: [made, traded]` (profileOf,
 * kindsOf), so an older app reads it unchanged and a manifest without `goods` reads its goods as
 * traded, the webshop `goods` stood for.
 */
export const SALES_KINDS = ['made', 'traded', 'services'] as const;
export type SalesKind = (typeof SALES_KINDS)[number];
export type GoodsKind = Exclude<SalesKind, 'services'>;

/** The kinds in their fixed order, each once. */
export const salesKinds = (kinds: readonly string[]): SalesKind[] => SALES_KINDS.filter((k) => kinds.includes(k));

/** The coarse profile of the kinds: what the chart and the manifest's `sells` know. */
export function profileOf(kinds: readonly SalesKind[]): BusinessProfile {
  const goods = kinds.some((k) => k !== 'services');
  return goods && kinds.includes('services') ? 'both' : goods ? 'goods' : 'services';
}

/** The goods kinds the manifest's `goods` keeps. */
export const goodsOf = (kinds: readonly SalesKind[]): GoodsKind[] => kinds.filter((k): k is GoodsKind => k !== 'services');

/** The kinds a manifest's `sells` and `goods` say; `goods` absent: traded, what `goods` meant before #46. */
export function kindsOf(sells: BusinessProfile, goods: readonly GoodsKind[] | undefined): SalesKind[] {
  const which: GoodsKind[] = goods?.length ? [...goods] : ['traded'];
  return salesKinds([...(sells === 'services' ? [] : which), ...(sells === 'goods' ? [] : ['services' as const])]);
}

export interface Option {
  value: string;
  label: string;
  /** Not supported yet: the wizard prints this and stops. */
  unsupported?: string;
  /** Supported with a limit the owner should know: printed, then the wizard goes on. */
  caveat?: string;
}

type Given = Readonly<Record<string, string | readonly string[] | undefined>>;

interface QuestionSpec {
  ask: string;
  /** One line, in plain words: why the answer matters. */
  why: string;
  options: readonly Option[];
  /** Several answers allowed (comma separated); none is a valid answer, unless `required`. */
  multi?: boolean;
  /** A multiple-choice question that needs one answer at least. */
  required?: boolean;
  /** Asked only when the answers so far say so; otherwise the answer is absent. */
  when?: (answers: Given) => boolean;
}

const registered = (a: Given) => a.vatRegistered === 'yes';

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
        caveat: 'Purchases and sales are booked gross, without VAT codes, and there is no VAT return. The MWST page watches the turnover of the calendar year against the registration threshold.',
      },
    ],
  },
  vatMethod: {
    ask: 'VAT method',
    why: 'Effective: you pay the VAT you charged minus the input tax on your costs. Saldosteuersatz: a flat rate on turnover, no input tax.',
    when: registered,
    options: [
      { value: 'effective', label: 'effektive Methode' },
      {
        value: 'net-rate', label: 'Saldosteuersatz',
        caveat: 'Sales are booked gross with the approved rate (one or two, as the ESTV allowed them), purchases gross without input tax; the return is form 0553, half-yearly. The wizard asks for the rate(s) next.',
      },
    ],
  },
  basis: {
    ask: 'VAT basis',
    why: 'Vereinbart (the law\'s default, MWSTG Art. 39): VAT is due when you send the invoice, input tax when you receive the bill. Vereinnahmt (on request): when the money moves.',
    when: registered,
    options: [
      { value: 'received', label: 'vereinnahmt (cash)' },
      {
        value: 'agreed', label: 'vereinbart (invoice)',
        caveat: 'An invoice the app issues is booked on its date as a receivable (1100) with its VAT; the payment only settles it. A supplier bill\'s input tax counts on the bill\'s date once its payment is booked.',
      },
    ],
  },
  period: {
    ask: 'VAT reporting period',
    why: 'How often you file the MWST return. Quarterly on the effective method, half-yearly on the Saldosteuersatz, unless the ESTV allowed otherwise.',
    when: registered,
    options: [
      { value: 'quarterly', label: 'quarterly' },
      { value: 'half-yearly', label: 'half-yearly' },
      { value: 'monthly', label: 'monthly', unsupported: 'Monthly returns are not supported yet: the return and its export cover quarters and half years.' },
    ],
  },
  fiscalYear: {
    ask: 'Fiscal year',
    why: 'The books open on 1 January; opening balances, the year-end and the periods follow the calendar year.',
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
    why: 'Sets the default accounts: material for your own products (4000) or goods bought to resell (4200); sales of own products (3000), traded goods (3200), services (3400). Any combination.',
    multi: true,
    required: true,
    options: [
      { value: 'made', label: 'products you make yourself' },
      { value: 'traded', label: 'goods you buy and resell (trade)' },
      { value: 'services', label: 'services' },
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
    why: 'The private share is charged to the owner at the year-end; a firm registered for VAT also takes back the input tax on it (Eigenverbrauch).',
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

/** The questions whose answers make the VAT setup (Company.vat), not the profile. */
export const VAT_QUESTIONS = ['vatRegistered', 'vatMethod', 'basis', 'period'] as const;
export type VatQuestionKey = (typeof VAT_QUESTIONS)[number];
/** The VAT questions a firm that is not registered is never asked: absent in its answers. */
type ConditionalKey = Exclude<VatQuestionKey, 'vatRegistered'>;

type Value<K extends QuestionKey, V> = IsMulti<K> extends true ? V[] : V;

/** An answer as given: any option, supported or not; a question not asked has none. */
export type Answers = { [K in Exclude<QuestionKey, ConditionalKey>]: Value<K, ValueOf<K>> } & { [K in ConditionalKey]?: Value<K, ValueOf<K>> };
/** An answer the engine runs on: what the manifest stores. */
export type SupportedAnswers = { [K in Exclude<QuestionKey, ConditionalKey>]: Value<K, SupportedValueOf<K>> } & { [K in ConditionalKey]?: Value<K, SupportedValueOf<K>> };

/** The order the wizard asks in. */
export const QUESTION_ORDER = Object.keys(QUESTIONS) as QuestionKey[];

/** Whether `key` is asked, given the answers so far. */
export function asked(key: QuestionKey, answers: Given): boolean {
  const q: QuestionSpec = QUESTIONS[key];
  return q.when === undefined || q.when(answers);
}

export const PRESETS = {
  consultant: {
    label: 'Consultant / services GmbH',
    answers: {
      legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly',
      fiscalYear: 'calendar', start: 'new', sells: ['services'], foreignCustomers: 'yes', imports: 'no',
      employees: 'owner', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no',
    },
  },
  webshop: {
    label: 'Webshop / goods GmbH',
    answers: {
      legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly',
      fiscalYear: 'calendar', start: 'new', sells: ['traded'], foreignCustomers: 'no', imports: 'yes',
      employees: 'owner', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'yes',
    },
  },
  trades: {
    label: 'Trades / construction GmbH',
    answers: {
      legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'effective', basis: 'received', period: 'quarterly',
      fiscalYear: 'calendar', start: 'new', sells: ['made', 'services'], foreignCustomers: 'no', imports: 'no',
      employees: 'staff', ownerPaysPrivately: 'yes', privateUse: ['car', 'phone'], payouts: 'no',
    },
  },
  freelancer: {
    label: 'Freelancer, not registered for VAT',
    answers: {
      legalForm: 'Einzelfirma', vatRegistered: 'no',
      fiscalYear: 'calendar', start: 'new', sells: ['services'], foreignCustomers: 'no', imports: 'no',
      employees: 'none', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no',
    },
  },
  // None of the above: every question is asked; a firm that fits no preset is more often not registered for VAT.
  custom: { label: 'Something else: answer every question', answers: { vatRegistered: 'no' } },
} as const satisfies Record<string, { label: string; answers: Partial<Answers> }>;

/** Whether the firm pays wages: its setup says it has staff or an employed owner. A firm without a profile (books older than the setup's questions) has not said so. */
export const employs = (profile: { employees?: string } | undefined): boolean => profile?.employees === 'staff' || profile?.employees === 'owner';

export type Preset = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as Preset[];

export function optionOf(key: QuestionKey, value: string): Option | undefined {
  return (QUESTIONS[key].options as readonly Option[]).find((o) => o.value === value);
}

/**
 * The first unsupported answer, in question order, with its explanation; undefined when the
 * engine supports every answer. A question not asked has no answer to judge.
 */
export function firstUnsupported(answers: Partial<Answers>): { key: QuestionKey; option: Option } | undefined {
  for (const key of QUESTION_ORDER) {
    if (!asked(key, answers)) continue;
    const values: string[] = ([] as string[]).concat(answers[key] ?? []);
    for (const v of values) {
      const option = optionOf(key, v);
      if (option?.unsupported) return { key, option };
    }
  }
  return undefined;
}

/** The first question asked but not answered, in question order. */
export function firstMissing(answers: Partial<Answers>): QuestionKey | undefined {
  return QUESTION_ORDER.find((key) => {
    if (!asked(key, answers)) return false;
    const q: QuestionSpec = QUESTIONS[key];
    const given = answers[key];
    return q.multi ? !!q.required && !([] as string[]).concat(given ?? []).length : given === undefined;
  });
}

export function isSupported(answers: Answers): answers is Answers & SupportedAnswers {
  return firstUnsupported(answers) === undefined && firstMissing(answers) === undefined;
}

/**
 * The VAT setup the answers describe; `rates` are the approved net rates, asked besides the
 * questions when the method is the net tax rate. Null when the rates are missing or too many.
 */
export function vatSetupOf(answers: Pick<SupportedAnswers, VatQuestionKey>, rates: readonly NetRate[] = []): VatSetup | null {
  if (answers.vatRegistered === 'no') return { registered: false };
  const period = (answers.period ?? 'quarterly') as VatPeriod;
  if (!VAT_PERIODS.includes(period)) return null;
  const reporting = (answers.basis ?? 'received') as VatBasis;
  if (!VAT_BASES.includes(reporting)) return null;
  if (answers.vatMethod === 'net-rate') {
    const approved = asNetRates(rates);
    return approved && { registered: true, method: 'net-rate', reporting, period, rates: approved };
  }
  return { registered: true, method: 'effective', reporting, period };
}
