/**
 * The payroll's records (docs/specs/payroll.md §9): payroll.json (the firm's Stammdaten, its
 * Sozialversicherungen, its layer over the Lohnart catalogue, the Mitarbeitende, every value dated) and
 * per year payroll/payslips.jsonl (closed payslips, append-only). Types only; browser-safe.
 */
import type { Dated } from '../core/dated.js';
import type { Labels, WageTypeDef } from '../core/modules/schema.js';
import type { Address } from '../invoices/model.js';

export type PayrollLanguage = 'de' | 'fr' | 'it' | 'en';

/** The firm's payroll settings (Löhne › Einstellungen › Stammdaten, §5.1). */
export interface PayrollCompany {
  /** The canton (or region) of work, as the jurisdiction names it. */
  canton: Dated<string>;
  /** The firm's number in the business register of the statistics office, for a later electronic report. */
  bur?: string;
  /** The day of the month wages are paid, or the month's last working day. */
  payday: Dated<number | 'last-working-day'>;
  /** The day the Lohnbuchungen are dated: the month's last day, or the payday. */
  postingDate: Dated<'month-end' | 'payday'>;
  rounding: Dated<number>;
  /** How a part month is prorated: by calendar days, or 30 days to a month. */
  proration: Dated<'calendar-days' | 'thirty-days'>;
  /** The 13th salary: a twelfth of the year's wage, or 8.33 % of it (a little less than a twelfth). */
  thirteenth: Dated<'twelfth' | 'percent'>;
  lohnausweis?: Dated<{ meals?: 'free' | 'reduced'; transportF?: boolean; canteenG?: boolean; expenseRules?: { canton: string; approvedOn: string }; remarks?: string }>;
  /** Who gets a copy of each payslip mail. */
  sender?: { copyTo?: string };
  /** The person a Lohnausweis names as responsible, with a phone number (Form 11, Buchstabe I). */
  contact?: { name?: string; phone?: string };
}

/** One solution of an insurance (a code and its rates in %, dated: a new policy year is a new entry). */
export interface InsuranceSolution {
  code: string;
  label?: string;
  rates: Dated<Record<string, number>>;
}

/** One Sozialversicherung of the firm (§5.2): a kind of payroll.yaml, the fund's knowledge file, its numbers and solutions. */
export interface PayrollInsurance {
  id: string;
  /** A kind of the jurisdiction's payroll.yaml. */
  kind: string;
  /** The knowledge file of the fund or insurer (its id), where the firm has one. */
  business?: string;
  /** The fund's or insurer's name as the firm knows it. */
  name: string;
  memberNumber?: string;
  contractNumber?: string;
  customerNumber?: string;
  /** Its liability account; absent: the kind's. */
  account?: string;
  solutions: InsuranceSolution[];
  validFrom: string;
  validUntil?: string;
}

/** The firm's layer over the catalogue (§5.3): an override, a copy, or a Lohnart of its own after the warning. */
export type WageTypeLayer =
  | { key: string; label?: Partial<Labels>; debit?: string; credit?: string; lohnausweis?: string }
  | { key: string; copyOf: string; label: Labels; debit?: string; credit?: string; lohnausweis?: string }
  | { key: string; own: WageTypeDef };

export interface Employment {
  kind: 'monthly' | 'hourly';
  /** The monthly salary at full Pensum, or the hourly wage. */
  amount: number;
  /** In %; absent: 100. The monthly salary is paid at amount × pensum. */
  pensum?: number;
  hoursPerWeek?: number;
  holidayDays?: number;
  /** The months the 13th salary is paid in (December is always one: a person who leaves gets it with her last month). */
  thirteenth?: { months: number[] };
  fixedTerm?: boolean;
  exitReason?: string;
}

/** A Lohnart every payslip of the person gets, with its values (dated). */
export interface RecurringWageType {
  wageType: string;
  value: Dated<{ amount?: number; quantity?: number; rate?: number; text?: string }>;
}

export interface PersonInsurances {
  /** A pension certificate's monthly contributions, fixed; or a percent of the coordinated wage. */
  bvg?: { insurance: string; solution?: string; employee: number; employer: number } | { insurance: string; solution?: string; percent: { employee: number; employer: number } };
  uvg?: { insurance: string; code: string };
  uvgz?: { insurance: string; code: string };
  ktg?: { insurance: string; code: string };
  /** Past the reference age: the monthly allowance, or the person waived it for the year. */
  pensioner?: 'allowance' | 'waiver';
  /** Any further kind the jurisdiction has, by its key: the solution the person is in. */
  [kind: string]: unknown;
}

export interface TaxAtSource {
  /** Subject to the tax at source. */
  subject: boolean;
  canton?: string;
  municipality?: string;
  code?: string;
  church?: boolean;
  otherEmployment?: { pensum?: number; income?: number } | 'unknown';
  daysInCountry?: number;
}

/** One person (§5.4). Entry is the first employment's validFrom, exit the last one's validUntil. */
export interface PayrollEmployee {
  id: string;
  isOwner?: boolean;
  language: PayrollLanguage;
  /** The social insurance number; masked in lists, never to a model, never a password or a file name. */
  socialSecurityNumber?: string;
  /** The password a payslip sent by mail is locked with: set by the employer or generated; never the social security number. */
  mailPassword?: string;
  birthDate: string;
  sex?: 'f' | 'm';
  nationality?: string;
  name: Dated<{ first: string; last: string }>;
  permit?: Dated<string>;
  email?: Dated<string>;
  address: Dated<Address & { canton?: string; municipality?: string }>;
  bank: Dated<{ iban: string; holder?: string }>;
  employment: Dated<Employment>;
  recurring: RecurringWageType[];
  insurances: Dated<PersonInsurances>;
  children?: Array<{ name: string; birthDate: string; allowance: Dated<{ wageType: string; amount: number }> }>;
  absences?: Array<{ from: string; to: string; kind: string; incapacity?: number; continuedPay?: number }>;
  taxAtSource?: Dated<TaxAtSource>;
  /**
   * Totals of the year before payroll started here (a firm starting mid-year): per base and Lohnausweis field, no
   * booking. `through` (YYYY-MM): its last month, January to it being the opening's months (src/payroll/opening.ts);
   * absent (written before it existed): January and the months after it, `months` of them (a part month whole); with
   * neither, its figures count and it holds no month.
   */
  opening?: Record<string, { through?: string; bases?: Record<string, number>; fields?: Record<string, number>; months?: number }>;
}

/** A line added to one month's payslip by a person (hours, a bonus, an expense, a text). */
export interface MonthLine {
  id: string;
  employee: string;
  month: string;
  wageType: string;
  amount?: number;
  quantity?: number;
  rate?: number;
  text?: string;
  enteredAt: string;
  removed?: boolean;
}

export interface PayrollStore {
  schema: number;
  company: PayrollCompany;
  insurances: PayrollInsurance[];
  wageTypes: WageTypeLayer[];
  employees: PayrollEmployee[];
  /** The lines a person added to a month not yet closed; a closed payslip keeps its own copy. */
  monthLines: MonthLine[];
  /** A free text for every payslip of a month («Frohe Festtage»), by month. */
  monthTexts?: Record<string, string>;
}

/** One line of a payslip: base × rate = amount, with where it came from. */
export interface PayslipLine {
  wageType: string;
  label: string;
  quantity?: number;
  base?: number;
  rate?: number;
  amount: number;
  side: 'employee' | 'employer';
  /** The law's figure, the fund's document, the contract, the person's entry. */
  source: string;
  days?: { from: string; to: string };
  /** The payslip a correction line corrects. */
  corrects?: string;
  /** The correction event the line carries: once carried by a standing close, it is in no other draft. */
  correction?: string;
  text?: string;
}

/** A line whose input is missing: shown «unvollständig», left out of every figure (§6.2). */
export interface MissingLine { wageType: string; label: string; missing: string; days?: { from: string; to: string } }

/** Every dated entry a payslip read, by path: a later entry never changes it (§19.2). */
export interface UsedEntry { path: string; validFrom: string; enteredAt: string }

export type PayslipEvent =
  | {
    event: 'close'; id: string; employee: string; month: string;
    postingDate: string; payday: string; closedAt: string; closedBy: 'person';
    lines: PayslipLine[];
    bases: Record<string, { month: number; year: number }>;
    gross: number; net: number; payout: number; employer: number; text?: string;
    left: MissingLine[];
    receiptId?: string; entries: string[];
    used: UsedEntry[];
    /** What the payslip printed of the person and the firm, as on its payday. */
    person: { name: string; address?: Address; iban?: string; language: PayrollLanguage };
  }
  | { event: 'reopen'; id: string; at: string; by: 'person' }
  | {
    event: 'correction'; id: string; of: string; wageType: string; side: 'employee' | 'employer';
    amount: number; base?: number; rateDiff?: number; text?: string; at: string; by: 'person';
  }
  /** «So lassen» (§19.3): a change dated back over this closed payslip was kept without a correction; history only. */
  | { event: 'keep'; id: string; at: string; by: 'person'; path: string; validFrom?: string };

export type PayslipClose = Extract<PayslipEvent, { event: 'close' }>;
export type PayslipCorrection = Extract<PayslipEvent, { event: 'correction' }>;

/** A payslip's id: <yyyy>-<mm>-<employeeId>. */
export const payslipId = (month: string, employee: string): string => `${month}-${employee}`;
/** The ref of the entries a closed payslip books (§7.2). */
export const payslipRef = (month: string, employee: string): string => `LR-${month}-${employee}`;
