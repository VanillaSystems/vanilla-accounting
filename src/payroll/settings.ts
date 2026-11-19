/**
 * The settings and people a firm keeps for payroll (docs/specs/payroll.md §5.1–§5.4, §19): every value a
 * payslip reads is a dated entry added with `addEntry`, never overwritten; an entry a closed payslip used
 * stays (`used` of its close). A change whose days a closed payslip covers is compared first (§19.3): the
 * payslip computed as if open, with and without the change, Lohnart by Lohnart; the caller saves only once
 * the person chose a way on (a Rückwirkende Korrektur per differing Lohnart, or «So lassen»). A rate outside
 * its kind's range is a warning, never a refusal (§18). Pure: the files are written by the API route.
 */
import { addEntry, entryOn, isDay, withdrawEntry, DatedEntryError, type Dated, type DatedEntry } from '../core/dated.js';
import type { Labels, PayrollData } from '../core/modules/schema.js';
import { parseIban } from '../workspace/banks.js';
import { firmWageTypes, resolveAccount, type WageType } from './catalogue.js';
import { computePayslip, employedFraction, type PayrollContext, type PayslipDraft } from './compute.js';
import { closedOf, latestClosed, type PayslipHistory } from './history.js';
import { correctionOf, PayrollRefusal } from './close.js';
import type {
  Absence, Child, Employment, PayrollEmployee, PayrollInsurance, PayrollLanguage, PayrollStore, PayslipClose, PayslipCorrection, PayslipEvent, PersonInsurances, TaxAtSource, WageTypeLayer,
} from './model.js';
import { payslipId, type CorrectedTariff } from './model.js';
import { firstDay, monthsBetween, nextMonth, round2 } from './money.js';
import { inOpening, openingOf } from './opening.js';

const LANGUAGES: readonly PayrollLanguage[] = ['de', 'fr', 'it', 'en'];
/** The input a German label names, as the UI's `payroll.field.*` key: a refusal says which field it is about. */
const FIELD_OF: Record<string, string> = {
  Vorname: 'first', Nachname: 'last', Name: 'name', PLZ: 'postcode', Ort: 'town', IBAN: 'iban', Lohn: 'salary', Pensum: 'pensum',
  'Stunden pro Woche': 'hoursPerWeek', Ferientage: 'holidayDays', '13. Monatslohn: Monat': 'thirteenth', 'Anteil Arbeitnehmer': 'certEmployee',
  'Beitrag Arbeitnehmer': 'certEmployee', 'Anteil Arbeitgeber': 'certEmployer', 'Beitrag Arbeitgeber': 'certEmployer', Menge: 'quantity', Ansatz: 'unitRate',
  Betrag: 'amount', 'Gilt ab': 'validFrom', 'Gilt bis': 'validUntil', Geburtsdatum: 'birthDate', Eintritt: 'entry', Code: 'code', Kanton: 'canton',
  Zahltag: 'payday', Bewilligung: 'permit', 'E-Mail': 'email', Lohnart: 'wageType', Bezeichnung: 'label',
  Feiertagszuschlag: 'publicHolidaySurcharge', Von: 'from', Bis: 'to', Arbeitsunfähigkeit: 'incapacity', Lohnfortzahlung: 'continuedPay',
  Taggeld: 'dailyAllowance', 'Taggeld ab': 'allowanceFrom', Art: 'kind',
};
const bad = (what: string, field?: string): never => { throw new PayrollRefusal('badInput', what, field); };
/** Something the request names that is not there (a person, an insurance, a solution, an entry). */
const gone = (what: string): never => { throw new PayrollRefusal('gone', what); };
/** An own key of a record from data or a request: never one of Object's («constructor», «toString»). */
const own = <T>(r: Readonly<Record<string, T>> | undefined, k: string): T | undefined => (r && Object.hasOwn(r, k) ? r[k] : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, what: string): string => (typeof v === 'string' && v.trim() ? v.trim() : bad(`${what} fehlt.`, FIELD_OF[what]));
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown, what: string, min = -Infinity, max = Infinity): number =>
  (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : bad(`${what}: eine Zahl${min > -Infinity ? ` ab ${min}` : ''}${max < Infinity ? ` bis ${max}` : ''}.`, FIELD_OF[what] ?? 'rate'));
const optNum = (v: unknown, what: string, min?: number, max?: number): number | undefined => (v === undefined || v === null || v === '' ? undefined : num(v, what, min, max));
const day = (v: unknown, what: string): string => (isDay(v) ? v : bad(`${what}: ein Tag JJJJ-MM-TT.`, FIELD_OF[what]));
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

// ─── the social security number ────────────────────────────────────────────────

/**
 * The number as the jurisdiction writes it (payroll.yaml `socialSecurityNumber`): its pattern, and its
 * check digit where the data names the method. Separators may be dots, spaces, hyphens or none; it is kept with dots. A refusal never repeats the number.
 */
export function socialSecurityNumberOf(raw: string, data: PayrollData): string {
  const digits = raw.replace(/[.\s-]/g, '');
  const spec = data.socialSecurityNumber;
  if (!/^\d+$/.test(digits) || !new RegExp(`^(?:${spec.pattern})$`).test(digits)) throw new PayrollRefusal('socialSecurityNumber', 'Keine gültige Nummer.', 'ssn');
  if (spec.checkDigit === 'ean13' && !ean13(digits)) throw new PayrollRefusal('socialSecurityNumber', 'Die Prüfziffer stimmt nicht.', 'ssn');
  return digits.length === 13 ? `${digits.slice(0, 3)}.${digits.slice(3, 7)}.${digits.slice(7, 11)}.${digits.slice(11)}` : digits;
}

/** The EAN-13 check digit: the first twelve digits weighted 1, 3, 1, 3 …; the last makes the sum a multiple of ten. */
export function ean13(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false;
  const sum = [...digits.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

// ─── dated values by path ──────────────────────────────────────────────────────

/** A rate outside the range its kind names: said, never refused. */
export interface RateWarning { key: string; value: number; range: [number, number] }

interface Target {
  history(): Dated<unknown> | undefined;
  write(h: DatedEntry<unknown>[]): void;
  /** The value checked and cleaned, with the warnings it gives. */
  value(v: unknown): { value: unknown; warnings: RateWarning[] };
  /** May the entry end (`validUntil`)? An Anstellung ends with the exit; a rate or a name does not. */
  ends?: boolean;
}

const COMPANY_FIELDS = ['canton', 'payday', 'postingDate', 'rounding', 'proration', 'thirteenth', 'holidayBasis'] as const;
const EMPLOYEE_FIELDS = ['name', 'address', 'bank', 'employment', 'insurances', 'permit', 'email', 'taxAtSource'] as const;

/** The dated value a path names in `store` (the same paths a close's `used` names). */
function targetOf(store: PayrollStore, data: PayrollData, path: string): Target {
  const parts = path.split('/');
  if (parts[0] === 'company' && parts.length === 2 && (COMPANY_FIELDS as readonly string[]).includes(parts[1])) {
    const f = parts[1] as typeof COMPANY_FIELDS[number];
    return {
      history: () => store.company[f] as Dated<unknown>,
      write: (h) => { (store.company as unknown as Record<string, unknown>)[f] = h; },
      value: (v) => ({ value: companyValue(f, v, data), warnings: [] }),
    };
  }
  if (parts[0] === 'employees' && parts.length >= 3) {
    const e = employeeOf(store, parts[1]);
    if (parts[2] === 'children' && parts.length === 5 && parts[4] === 'allowance') {
      const child = (e.children ?? []).find((c) => c.id === parts[3]) ?? gone(`Kind ${parts[3]} gibt es nicht.`);
      return {
        history: () => child.allowance,
        write: (h) => { child.allowance = h as typeof child.allowance; },
        value: (v) => ({ value: allowanceValue(v, data, store), warnings: [] }),
        ends: true,
      };
    }
    if (parts[2] === 'recurring' && parts.length === 4) {
      const key = parts[3];
      const w = firmWageTypes(data, store).get(key);
      if (!w) throw new PayrollRefusal('unknownWageType', `Lohnart ${key} gibt es nicht.`);
      if (w.computes) bad(`${key} rechnet die App selbst: keine wiederkehrende Lohnart.`);
      return {
        history: () => e.recurring.find((r) => r.wageType === key)?.value,
        write: (h) => {
          const r = e.recurring.find((x) => x.wageType === key);
          if (!h.length) e.recurring = e.recurring.filter((x) => x.wageType !== key);
          else if (r) r.value = h as typeof r.value;
          else e.recurring.push({ wageType: key, value: h as DatedEntry<{ amount?: number }>[] });
        },
        value: (v) => ({ value: recurringValue(v, w.input === 'quantity'), warnings: [] }),
        ends: true,
      };
    }
    if (parts.length === 3 && (EMPLOYEE_FIELDS as readonly string[]).includes(parts[2])) {
      const f = parts[2] as typeof EMPLOYEE_FIELDS[number];
      return {
        history: () => e[f] as Dated<unknown> | undefined,
        write: (h) => { (e as unknown as Record<string, unknown>)[f] = h; },
        value: (v) => ({ value: employeeValue(f, v, store, data), warnings: [] }),
        ends: f === 'employment',
      };
    }
  }
  if (parts[0] === 'insurances' && parts.length === 5 && parts[2] === 'solutions' && parts[4] === 'rates') {
    const ins = insuranceById(store, parts[1]);
    const s = ins.solutions.find((x) => x.code === parts[3]);
    if (!s) return gone(`Lösung ${parts[3]} gibt es nicht.`);
    return {
      history: () => s.rates,
      write: (h) => { s.rates = h as typeof s.rates; },
      value: (v) => ratesValue(ins.kind, v, data),
    };
  }
  return bad(`${path} ist kein Wert mit Datum.`);
}

function companyValue(f: typeof COMPANY_FIELDS[number], v: unknown, data: PayrollData): unknown {
  switch (f) {
    case 'canton': return str(v, 'Kanton').toUpperCase();
    case 'payday': return v === 'last-working-day' ? v : num(v, 'Zahltag', 1, 31);
    case 'postingDate': return v === 'month-end' || v === 'payday' ? v : bad('Buchungsdatum: Monatsende oder Zahltag.');
    case 'rounding': return typeof v === 'number' && data.rounding.includes(v) ? v : bad(`Rundung: ${data.rounding.join(' oder ')}.`);
    case 'proration': return v === 'calendar-days' || v === 'thirty-days' ? v : bad('Anteil: Kalendertage oder 30 Tage.');
    case 'thirteenth': return v === 'twelfth' || v === 'percent' ? v : bad('13. Monatslohn: 1/12 oder 8,33 %.');
    case 'holidayBasis': return v === 'wage' || v === 'wage-with-surcharge' ? v : bad('Ferienzuschlag auf: dem Stundenlohn, oder mit dem Feiertagszuschlag.');
  }
}

function employeeValue(f: typeof EMPLOYEE_FIELDS[number], v: unknown, store: PayrollStore, data: PayrollData): unknown {
  switch (f) {
    case 'name': return isObj(v) ? { first: str(v.first, 'Vorname'), last: str(v.last, 'Nachname') } : bad('Ein Name.');
    case 'address': return addressValue(v);
    case 'bank': return bankValue(v);
    case 'employment': return employmentValue(v);
    case 'insurances': return insurancesValue(v, store, data);
    case 'permit': case 'email': return str(v, f === 'permit' ? 'Bewilligung' : 'E-Mail');
    case 'taxAtSource': return taxValue(v);
  }
}

function addressValue(v: unknown) {
  if (!isObj(v)) return bad('Eine Adresse.');
  return clean({
    street: optStr(v.street), number: optStr(v.number), postcode: str(v.postcode, 'PLZ'), town: str(v.town, 'Ort'),
    country: (optStr(v.country) ?? 'CH').toUpperCase(), canton: optStr(v.canton)?.toUpperCase(), municipality: optStr(v.municipality),
  });
}

function bankValue(v: unknown) {
  if (!isObj(v)) return bad('Eine Bankverbindung.');
  const iban = parseIban(str(v.iban, 'IBAN'));
  if (!iban) throw new PayrollRefusal('iban', `${String(v.iban)} ist keine gültige IBAN.`);
  return clean({ iban: iban as string, holder: optStr(v.holder) });
}

function employmentValue(v: unknown): Employment {
  if (!isObj(v)) return bad('Eine Anstellung.');
  const kind = v.kind === 'monthly' || v.kind === 'hourly' ? v.kind : bad('Monatslohn oder Stundenlohn.');
  const months = isObj(v.thirteenth) && Array.isArray(v.thirteenth.months) ? v.thirteenth.months.map((m) => num(m, '13. Monatslohn: Monat', 1, 12)) : undefined;
  return clean({
    kind, amount: num(v.amount, 'Lohn', 0), pensum: optNum(v.pensum, 'Pensum', 1, 100), hoursPerWeek: optNum(v.hoursPerWeek, 'Stunden pro Woche', 0, 80),
    holidayDays: optNum(v.holidayDays, 'Ferientage', 0, 60), ...(months ? { thirteenth: { months: [...new Set(months)].sort((a, b) => a - b) } } : {}),
    fixedTerm: v.fixedTerm === true ? true : undefined, exitReason: optStr(v.exitReason),
    ...(kind === 'hourly' ? {
      holidayPay: v.holidayPay === 'leave' ? 'leave' as const : undefined,
      publicHolidaySurcharge: optNum(v.publicHolidaySurcharge, 'Feiertagszuschlag', 0, 20) || undefined,
    } : {}),
  });
}

/** A child's allowance as the fund decided it: one of the family allowance Lohnarten, a monthly amount. */
function allowanceValue(v: unknown, data: PayrollData, store: PayrollStore): { wageType: string; amount: number } {
  if (!isObj(v)) return bad('Eine Zulage.');
  const key = str(v.wageType, 'Lohnart');
  const w = firmWageTypes(data, store).get(key);
  const group = data.groups.find((g) => g.key === w?.group);
  // The Lohnarten of the kind a fund pays per child: their own allowance data, or the group the catalogue's are in.
  const allowanceGroups = new Set(data.wageTypes.filter((x) => x.allowance || x.once).map((x) => x.group));
  if (!w || !group || !allowanceGroups.has(w.group)) return bad(`${key} ist keine Familienzulage.`, 'wageType');
  // The monthly history takes the monthly allowances; a one-off one (at the birth) is the child's `birth`.
  if (w.once) return bad(`${key} wird einmal bezahlt: als Zulage bei der Geburt erfassen.`, 'wageType');
  return { wageType: key, amount: num(v.amount, 'Betrag', 0) };
}

/** A one-off allowance of a child (at the birth or the adoption): a Lohnart paid once, its amount and the month it is paid in. */
function birthValue(v: unknown, data: PayrollData, store: PayrollStore): Child['birth'] {
  if (!isObj(v)) return bad('Eine Zulage bei der Geburt.');
  const key = str(v.wageType, 'Lohnart');
  const w = firmWageTypes(data, store).get(key);
  if (!w?.once) return bad(`${key} ist keine einmalige Familienzulage.`, 'wageType');
  const month = typeof v.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v.month) ? v.month : bad('Monat: JJJJ-MM.', 'month');
  return { wageType: key, amount: num(v.amount, 'Betrag', 0), month };
}

function insurancesValue(v: unknown, store: PayrollStore, data: PayrollData): PersonInsurances {
  if (!isObj(v)) return bad('Die Versicherungen der Person.');
  const out: PersonInsurances = {};
  for (const [kind, x] of Object.entries(v)) {
    if (x === undefined || x === null) continue;
    if (kind === 'pensioner') { out.pensioner = x === 'allowance' || x === 'waiver' ? x : bad('Rentner: Freibetrag oder Verzicht.'); continue; }
    if (kind === 'smallWage') { if (x === 'liable') out.smallWage = 'liable'; else if (x !== '' && x !== false) bad('Geringer Lohn: beitragspflichtig auf Verlangen, oder leer.'); continue; }
    const def = own(data.insurances, kind);
    if (!def) return bad(`Versicherung ${kind} gibt es nicht.`);
    if (!isObj(x)) return bad(`${kind}: die Versicherung und die Lösung.`);
    const ins = store.insurances.find((i) => i.id === x.insurance && i.kind === kind) ?? bad(`${kind}: diese Versicherung hat die Firma nicht.`);
    if (def.perPerson) {
      const solution = optStr(x.solution);
      out[kind] = isObj(x.percent)
        ? clean({ insurance: ins.id, solution, percent: { employee: num(x.percent.employee, 'Anteil Arbeitnehmer', 0, 100), employer: num(x.percent.employer, 'Anteil Arbeitgeber', 0, 100) } })
        : clean({ insurance: ins.id, solution, employee: num(x.employee, 'Beitrag Arbeitnehmer', 0), employer: num(x.employer, 'Beitrag Arbeitgeber', 0) });
    } else {
      const code = str(x.code, `${kind}: der Code`);
      if (!ins.solutions.some((s) => s.code === code)) bad(`${kind}: die Lösung ${code} hat die Versicherung nicht.`);
      out[kind] = { insurance: ins.id, code };
    }
  }
  return out;
}

function taxValue(v: unknown): TaxAtSource {
  if (!isObj(v) || typeof v.subject !== 'boolean') return bad('Quellensteuer: pflichtig oder nicht.');
  const code = optStr(v.code)?.toUpperCase().replace(/\s+/g, '');
  // A tariff code is a letter, the children (or a second letter) and, optionally, the church tax: A0, A0N, B2Y, G9N.
  if (code !== undefined && !/^[A-Z][0-9A-Z][NY]?$/.test(code)) bad(`Quellensteuer: «${code}» ist kein Tarifcode (etwa A0N, B2Y).`, 'code');
  const o = v.otherEmployment;
  const other = o === undefined || o === null || o === '' || o === 'none' ? undefined
    : o === 'unknown' ? 'unknown' as const
    : isObj(o) && o.pensum !== undefined && o.pensum !== '' ? { pensum: num(o.pensum, 'Pensum der anderen Stellen (1 bis 100 %)', 1, 100) }
    : isObj(o) && o.income !== undefined && o.income !== '' ? { income: num(o.income, 'Einkommen der anderen Stellen', 0) }
    : bad('Quellensteuer: andere Stellen: keine, unbekannt, ein Pensum oder ein Einkommen.');
  return clean({ subject: v.subject, canton: optStr(v.canton)?.toUpperCase(), municipality: optStr(v.municipality), code, church: typeof v.church === 'boolean' ? v.church : undefined, otherEmployment: other });
}

function recurringValue(v: unknown, quantity: boolean) {
  if (!isObj(v)) return bad('Ein Betrag.');
  const text = optStr(v.text);
  if (quantity && v.amount === undefined) return clean({ quantity: num(v.quantity, 'Menge', 0), rate: num(v.rate, 'Ansatz'), text });
  return clean({ amount: num(v.amount, 'Betrag'), text });
}

/** The rates of a solution, by the kind's rate keys; a value outside its range is a warning. */
function ratesValue(kind: string, v: unknown, data: PayrollData): { value: Record<string, number>; warnings: RateWarning[] } {
  if (!isObj(v)) return bad('Die Sätze.');
  const defs = own(data.insurances, kind)?.rates ?? {};
  const value: Record<string, number> = {};
  const warnings: RateWarning[] = [];
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined || x === null || x === '') continue;
    const def = own(defs, k) ?? bad(`${k} ist kein Satz dieser Versicherung.`, 'rate');
    value[k] = num(x, def.label.de);
    if (value[k] < def.range[0] || value[k] > def.range[1]) warnings.push({ key: k, value: value[k], range: def.range });
  }
  return { value, warnings };
}

export interface EntryInput { path: string; validFrom: string; validUntil?: string; value: unknown; note?: string; receiptId?: string }

/** Adds a dated entry to the value `path` names; the warnings of its rates come back. */
export function addDatedEntry(store: PayrollStore, data: PayrollData, input: EntryInput, now: string): { entry: DatedEntry<unknown>; warnings: RateWarning[] } {
  const target = targetOf(store, data, input.path);
  const { value, warnings } = target.value(input.value);
  if (input.validUntil !== undefined && !target.ends) bad('Dieser Wert endet nicht: ein neuer Eintrag ab einem Tag ersetzt ihn.');
  const source = clean({ receiptId: optStr(input.receiptId), note: optStr(input.note) });
  const entry: DatedEntry<unknown> = {
    validFrom: day(input.validFrom, 'Gilt ab'), ...(input.validUntil !== undefined ? { validUntil: day(input.validUntil, 'Gilt bis') } : {}),
    value, enteredAt: now, ...(Object.keys(source).length ? { source } : {}),
  };
  try { target.write(addEntry(target.history(), entry)); } catch (e) { if (e instanceof DatedEntryError) bad(e.message); throw e; }
  return { entry, warnings };
}

/** Whether any closed payslip read the entry. */
export const usedByCloses = (history: PayslipHistory, path: string, key: { validFrom: string; enteredAt: string }): boolean =>
  [...history.closed.values()].some((c) => c.used.some((u) => u.path === path && u.validFrom === key.validFrom && u.enteredAt === key.enteredAt));

/** Takes an entry back that no closed payslip used: a planned raise, a typo; one that was used stays (a new entry corrects it). */
export function withdrawDatedEntry(store: PayrollStore, data: PayrollData, history: PayslipHistory, path: string, key: { validFrom: string; enteredAt: string }): void {
  const target = targetOf(store, data, path);
  const h = target.history() ?? [];
  if (!h.some((e) => e.validFrom === key.validFrom && e.enteredAt === key.enteredAt)) gone('Diesen Eintrag gibt es nicht.');
  if (usedByCloses(history, path, key)) throw new PayrollRefusal('used', 'Eine abgeschlossene Lohnabrechnung hat diesen Eintrag gelesen: er bleibt, ein neuer Eintrag korrigiert ihn.');
  target.write(withdrawEntry(h, key, () => false));
}

// ─── the people ────────────────────────────────────────────────────────────────

const employeeOf = (store: PayrollStore, id: string): PayrollEmployee => store.employees.find((e) => e.id === id) ?? gone(`Keine Person ${id}.`);
const insuranceById = (store: PayrollStore, id: string): PayrollInsurance => store.insurances.find((i) => i.id === id) ?? gone(`Keine Versicherung ${id}.`);

/** A new person with her sections at once (Person, Anstellung, Adresse, Bank, Versicherungen), each dated from the entry day. */
export function createEmployee(store: PayrollStore, data: PayrollData, input: Record<string, unknown>, id: string, now: string): PayrollEmployee {
  const from = day(input.validFrom, 'Eintritt');
  const at = <T>(value: T): DatedEntry<T>[] => [{ validFrom: from, value, enteredAt: now }];
  const lang = (LANGUAGES as readonly unknown[]).includes(input.language) ? input.language as PayrollLanguage : 'de';
  const e: PayrollEmployee = clean({
    id, ...(input.isOwner === true ? { isOwner: true } : {}), language: lang,
    socialSecurityNumber: optStr(input.socialSecurityNumber) ? socialSecurityNumberOf(String(input.socialSecurityNumber), data) : undefined,
    birthDate: day(input.birthDate, 'Geburtsdatum'), sex: input.sex === 'f' || input.sex === 'm' ? input.sex : undefined, nationality: optStr(input.nationality)?.toUpperCase(),
    name: at({ first: str(input.first, 'Vorname'), last: str(input.last, 'Nachname') }),
    email: optStr(input.email) ? at(String(input.email).trim()) : undefined,
    address: input.address !== undefined && isObj(input.address) && (optStr(input.address.postcode) || optStr(input.address.town)) ? at(addressValue(input.address)) : [],
    bank: isObj(input.bank) && optStr(input.bank.iban) ? at(bankValue(input.bank)) : [],
    employment: at(employmentValue(input.employment)),
    recurring: [],
    insurances: isObj(input.insurances) && Object.keys(input.insurances).length ? at(insurancesValue(input.insurances, store, data)) : [],
  });
  // A person who starts here mid-year after months paid elsewhere (or by hand): her opening at once.
  if (isObj(input.opening)) {
    const through = typeof input.opening.through === 'string' ? input.opening.through : '';
    e.opening = { [through.slice(0, 4)]: openingValue(e, data, through.slice(0, 4), input.opening) };
  }
  store.employees.push(e);
  return e;
}

/**
 * A person's opening of `year` (§22 decision 43): January to `through` paid and booked before payroll ran
 * here, with the bases and the Lohnausweis fields of those months (her employment here may start later:
 * months paid before it was recorded). Each base and field is one the jurisdiction names, none negative;
 * `months` (part months by their days) is counted from her employment when absent. A month the app closed
 * for her is no opening month: it is booked already.
 */
function openingValue(e: PayrollEmployee, data: PayrollData, year: string, v: Record<string, unknown>): NonNullable<PayrollEmployee['opening']>[string] {
  const through = typeof v.through === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v.through) && v.through.startsWith(`${year}-`) ? v.through : bad('Eröffnung bis: ein Monat JJJJ-MM des Jahres.', 'openingThrough');
  const bases: Record<string, number> = {};
  for (const [k, x] of Object.entries(isObj(v.bases) ? v.bases : {})) {
    if (x === undefined || x === null || x === '') continue;
    const def = data.bases.find((b) => b.key === k) ?? bad(`${k} ist keine Basis.`, 'openingBase');
    bases[k] = round2(num(x, def.label.de, 0));
  }
  const fields: Record<string, number> = {};
  const form = data.lohnausweis?.fields ?? [];
  for (const [k, x] of Object.entries(isObj(v.fields) ? v.fields : {})) {
    if (x === undefined || x === null || x === '') continue;
    const def = form.find((f) => f.key === k && !f.sum && !f.remark) ?? bad(`${k} ist kein Feld des Lohnausweises, das sich eintragen lässt.`, 'openingField');
    fields[k] = round2(num(x, `${def.key} ${def.label.de}`, 0));
  }
  // Its months for the ceilings, when given: more than none, at most the months January to `through` (a part month by its days).
  const months = optNum(v.months, 'Monate', 0.01, Number(through.slice(5)));
  return clean({ through, ...(months !== undefined ? { months } : {}), bases, fields });
}

/** Sets or removes (`value` null) a person's opening of `year`; refused over a month the app closed for her. */
export function setOpening(store: PayrollStore, data: PayrollData, history: PayslipHistory, id: string, year: string, value: unknown): void {
  const e = employeeOf(store, id);
  if (!/^\d{4}$/.test(year)) bad(`${year} ist kein Jahr.`);
  if (value === null || value === undefined) {
    if (e.opening) { const { [year]: _, ...rest } = e.opening; if (Object.keys(rest).length) e.opening = rest; else delete e.opening; }
    return;
  }
  if (!isObj(value)) bad('Die Eröffnung: bis wann, die Basen und die Felder.');
  const next = openingValue(e, data, year, value as Record<string, unknown>);
  const closed = closedOf(history, id).filter((c) => c.month.startsWith(`${year}-`) && c.month <= next.through!).map((c) => c.month);
  if (closed.length) throw new PayrollRefusal('used', `${closed.join(', ')} ist hier abgeschlossen und gebucht: ein Monat der Eröffnung würde den Lohn ein zweites Mal zählen. Zuerst wieder öffnen, oder die Eröffnung früher enden lassen.`, 'openingThrough');
  e.opening = { ...(e.opening ?? {}), [year]: next };
}

const PERSON_FIELDS = ['socialSecurityNumber', 'birthDate', 'sex', 'nationality', 'language', 'isOwner'] as const;

/** The undated facts of a person (the number, the birth date, the sex, the payslip's language, «Inhaber/in»). */
export function patchEmployee(store: PayrollStore, data: PayrollData, id: string, patch: Record<string, unknown>): void {
  const e = employeeOf(store, id);
  for (const k of Object.keys(patch)) if (!(PERSON_FIELDS as readonly string[]).includes(k)) bad(`${k} ist kein Feld der Person.`);
  if ('socialSecurityNumber' in patch) {
    if (optStr(patch.socialSecurityNumber)) e.socialSecurityNumber = socialSecurityNumberOf(String(patch.socialSecurityNumber), data);
    else delete e.socialSecurityNumber;
  }
  if ('birthDate' in patch) e.birthDate = day(patch.birthDate, 'Geburtsdatum');
  if ('sex' in patch) { if (patch.sex === 'f' || patch.sex === 'm') e.sex = patch.sex; else delete e.sex; }
  if ('nationality' in patch) { const n = optStr(patch.nationality); if (n) e.nationality = n.toUpperCase(); else delete e.nationality; }
  if ('language' in patch) e.language = (LANGUAGES as readonly unknown[]).includes(patch.language) ? patch.language as PayrollLanguage : bad('Sprache: de, fr, it oder en.');
  if ('isOwner' in patch) { if (patch.isOwner === true) e.isOwner = true; else delete e.isOwner; }
}

// ─── children and absences (§5.4, B1) ──────────────────────────────────────────

/** A child with the allowance the fund decided, from a day (and until one, where the decision ends it). */
export function addChild(store: PayrollStore, data: PayrollData, employee: string, input: Record<string, unknown>, id: string, now: string): Child {
  const e = employeeOf(store, employee);
  const validFrom = day(input.validFrom, 'Gilt ab');
  const validUntil = optStr(input.validUntil) ? day(input.validUntil, 'Gilt bis') : undefined;
  if (validUntil && validUntil < validFrom) bad('Das Ende liegt vor dem Beginn.', 'validUntil');
  const child: Child = {
    id, name: str(input.name, 'Name'), birthDate: day(input.birthDate, 'Geburtsdatum'),
    allowance: [{ validFrom, ...(validUntil ? { validUntil } : {}), value: allowanceValue({ wageType: input.wageType, amount: input.amount }, data, store), enteredAt: now }],
    ...(isObj(input.birth) && input.birth.amount !== undefined && input.birth.amount !== '' ? { birth: birthValue(input.birth, data, store) } : {}),
  };
  e.children = [...(e.children ?? []), child];
  return child;
}

/** A child no closed payslip paid an allowance for; one that was paid for stays (its allowance ends with an entry). */
export function removeChild(store: PayrollStore, history: PayslipHistory, employee: string, child: string): void {
  const e = employeeOf(store, employee);
  if (!(e.children ?? []).some((c) => c.id === child)) gone(`Kind ${child} gibt es nicht.`);
  const path = `employees/${employee}/children/${child}/allowance`;
  if ([...history.closed.values()].some((c) => c.used.some((u) => u.path === path) || c.lines.some((l) => l.child === child && l.source === 'fak'))) throw new PayrollRefusal('used', 'Eine abgeschlossene Lohnabrechnung hat für dieses Kind eine Zulage bezahlt: es bleibt, die Zulage endet mit einem Eintrag «gilt bis».');
  e.children = (e.children ?? []).filter((c) => c.id !== child);
}

/** An absence: its days, its kind, the incapacity and the continued pay in %, the insurer's daily allowance. No diagnosis (§11). */
export function addAbsence(store: PayrollStore, data: PayrollData, employee: string, input: Record<string, unknown>, id: string, now: string): Absence {
  const e = employeeOf(store, employee);
  const kind = typeof input.kind === 'string' && own(data.absences, input.kind) ? input.kind : bad('Die Art der Abwesenheit.', 'kind');
  const from = day(input.from, 'Von');
  const to = day(input.to, 'Bis');
  if (to < from) bad('Das Ende liegt vor dem Beginn.', 'to');
  const allowanceFrom = optStr(input.allowanceFrom) ? day(input.allowanceFrom, 'Taggeld ab') : undefined;
  if (allowanceFrom && (allowanceFrom < from || allowanceFrom > to)) bad('Taggeld ab: ein Tag der Abwesenheit.', 'allowanceFrom');
  const def = own(data.absences, kind)!;
  const absence: Absence = clean({
    id, from, to, kind, incapacity: optNum(input.incapacity, 'Arbeitsunfähigkeit', 1, 100),
    continuedPay: def.unpaid || def.holiday ? undefined : optNum(input.continuedPay, 'Lohnfortzahlung', 0, 100),
    dailyAllowance: def.allowance ? optNum(input.dailyAllowance, 'Taggeld', 0) : undefined,
    allowanceFrom: def.allowance ? allowanceFrom : undefined, enteredAt: now,
  });
  e.absences = [...(e.absences ?? []), absence].sort((a, b) => a.from.localeCompare(b.from));
  return absence;
}

export function removeAbsence(store: PayrollStore, employee: string, absence: string): void {
  const e = employeeOf(store, employee);
  if (!(e.absences ?? []).some((a) => a.id === absence)) gone(`Abwesenheit ${absence} gibt es nicht.`);
  e.absences = (e.absences ?? []).filter((a) => a.id !== absence);
}

// ─── the firm's insurances ─────────────────────────────────────────────────────

/** A Sozialversicherung of a kind of payroll.yaml, with its first solution and rates (dated from its start). */
export function createInsurance(store: PayrollStore, data: PayrollData, input: Record<string, unknown>, id: string, now: string): { insurance: PayrollInsurance; warnings: RateWarning[] } {
  const kind = typeof input.kind === 'string' && own(data.insurances, input.kind) ? input.kind : bad('Eine Art der Versicherung.', 'kind');
  const validFrom = day(input.validFrom, 'Gilt ab');
  const code = optStr(input.code) ?? 'A';
  const { value, warnings } = ratesValue(kind, input.rates ?? {}, data);
  // Kept off a document's card (src/payroll/setup-documents.ts): the insurance and its rates name the document.
  const receiptId = optStr(input.receiptId);
  const source = receiptId ? { source: { receiptId } } : {};
  const insurance: PayrollInsurance = clean({
    id, kind, name: str(input.name, 'Name'), business: optStr(input.business), memberNumber: optStr(input.memberNumber), contractNumber: optStr(input.contractNumber),
    customerNumber: optStr(input.customerNumber), account: accountValue(input.account),
    solutions: [clean({ code, label: optStr(input.solutionLabel), rates: Object.keys(value).length ? [{ validFrom, value, enteredAt: now, ...source }] : [] })],
    validFrom, ...source,
  });
  store.insurances.push(insurance);
  return { insurance, warnings };
}

const accountValue = (v: unknown): string | undefined => {
  const a = optStr(v);
  return a === undefined ? undefined : /^\d{4}$/.test(a) ? a : bad(`Konto ${a}: vier Stellen.`);
};

const INSURANCE_FIELDS = ['name', 'business', 'memberNumber', 'contractNumber', 'customerNumber', 'account', 'validUntil'] as const;

/** The insurance's numbers, name, liability account, or its end; a closed payslip's insurance ends but is never deleted. */
export function patchInsurance(store: PayrollStore, id: string, patch: Record<string, unknown>): void {
  const ins = insuranceById(store, id);
  for (const k of Object.keys(patch)) if (!(INSURANCE_FIELDS as readonly string[]).includes(k)) bad(`${k} ist kein Feld der Versicherung.`);
  const rec = ins as unknown as Record<string, unknown>;
  for (const k of INSURANCE_FIELDS) {
    if (!(k in patch)) continue;
    const v = k === 'account' ? accountValue(patch[k]) : k === 'validUntil' ? (optStr(patch[k]) ? day(patch[k], 'Gilt bis') : undefined) : optStr(patch[k]);
    if (k === 'name' && !v) bad('Name fehlt.', 'name');
    if (k === 'validUntil' && v !== undefined && v < ins.validFrom) bad('Das Ende liegt vor dem Beginn.', 'validUntil');
    if (v === undefined) delete rec[k]; else rec[k] = v;
  }
}

/** A further solution («B» for the workshop) with its rates from a day. */
export function addSolution(store: PayrollStore, data: PayrollData, id: string, input: Record<string, unknown>, now: string): RateWarning[] {
  const ins = insuranceById(store, id);
  const code = str(input.code, 'Code');
  if (ins.solutions.some((s) => s.code === code)) throw new PayrollRefusal('exists', `Die Lösung ${code} gibt es schon.`);
  const { value, warnings } = ratesValue(ins.kind, input.rates ?? {}, data);
  ins.solutions.push(clean({ code, label: optStr(input.label), rates: Object.keys(value).length ? [{ validFrom: day(input.validFrom, 'Gilt ab'), value, enteredAt: now }] : [] }));
  return warnings;
}

// ─── the Lohnarten layer ───────────────────────────────────────────────────────

/** Whether a closed payslip has a line of the Lohnart (then it is never deleted, §5.3). */
export const wageTypeUsed = (history: PayslipHistory, key: string): boolean => [...history.closed.values()].some((c) => c.lines.some((l) => l.wageType === key));

/** A rename, other accounts, another Lohnausweis field of a Lohnart; empty fields go back to the catalogue's. */
export function setWageType(store: PayrollStore, data: PayrollData, key: string, input: Record<string, unknown>): void {
  const types = firmWageTypes(data, store);
  if (!types.has(key)) throw new PayrollRefusal('unknownWageType', `Lohnart ${key} gibt es nicht.`);
  const label = isObj(input.label) ? clean(Object.fromEntries(LANGUAGES.map((l) => [l, optStr((input.label as Record<string, unknown>)[l])]))) as Partial<Labels> : undefined;
  const fields = clean({ debit: accountValue(input.debit), credit: accountValue(input.credit), lohnausweis: optStr(input.lohnausweis) });
  const i = store.wageTypes.findIndex((l) => l.key === key);
  const layer = i >= 0 ? store.wageTypes[i] : undefined;
  if (layer && 'own' in layer) bad('Eine eigene Lohnart ändert ihr Formular.');
  if (layer && 'copyOf' in layer) {
    const copy = layer as Extract<WageTypeLayer, { copyOf: string }>;
    store.wageTypes[i] = clean({ key, copyOf: copy.copyOf, label: { ...copy.label, ...(label ?? {}) } as Labels, ...fields });
    return;
  }
  const next: WageTypeLayer = clean({ key, ...(label && Object.keys(label).length ? { label } : {}), ...fields });
  if (Object.keys(next).length === 1) { if (i >= 0) store.wageTypes.splice(i, 1); return; }
  if (i >= 0) store.wageTypes[i] = next; else store.wageTypes.push(next);
}

/** A copy that keeps every flag of the Lohnart, under a new key and label. */
export function copyWageType(store: PayrollStore, data: PayrollData, input: Record<string, unknown>, key: string): string {
  const from = str(input.copyOf, 'Lohnart');
  const w = firmWageTypes(data, store).get(from) ?? (() => { throw new PayrollRefusal('unknownWageType', `Lohnart ${from} gibt es nicht.`); })();
  if (w.computes) bad(`${from} rechnet die App selbst: eine Kopie davon rechnet niemand.`);
  const de = str(isObj(input.label) ? input.label.de : input.label, 'Bezeichnung');
  const label = Object.fromEntries(LANGUAGES.map((l) => [l, (isObj(input.label) ? optStr(input.label[l]) : undefined) ?? de])) as Labels;
  store.wageTypes.push(clean({ key, copyOf: from, label, debit: accountValue(input.debit), credit: accountValue(input.credit), lohnausweis: optStr(input.lohnausweis) }));
  return key;
}

/** Removes a copy no closed payslip used; a catalogue Lohnart is never removed. */
export function removeWageType(store: PayrollStore, history: PayslipHistory, key: string): void {
  const layer = store.wageTypes.find((l) => l.key === key);
  if (!layer || !('copyOf' in layer)) bad('Nur eine Kopie lässt sich entfernen; eine Lohnart des Katalogs bleibt.');
  if (wageTypeUsed(history, key)) throw new PayrollRefusal('used', 'Eine abgeschlossene Lohnabrechnung hat diese Lohnart: sie bleibt.');
  if (store.wageTypes.some((l) => 'copyOf' in l && l.copyOf === key)) throw new PayrollRefusal('used', 'Eine andere Kopie ist von dieser Lohnart gemacht: sie bleibt.');
  if (history.corrections.some((c) => c.wageType === key && !history.carriedBy.has(c.id))) throw new PayrollRefusal('used', 'Eine Rückwirkende Korrektur wartet mit dieser Lohnart auf den nächsten offenen Monat: sie bleibt.');
  if (store.employees.some((e) => e.recurring.some((r) => r.wageType === key)) || store.monthLines.some((l) => l.wageType === key && !l.removed)) throw new PayrollRefusal('used', 'Eine Person hat diese Lohnart noch: sie bleibt.');
  store.wageTypes = store.wageTypes.filter((l) => l.key !== key);
}

// ─── a change dated before a closed month (§19.3) ──────────────────────────────

/**
 * One Lohnart of a closed payslip that a change computes otherwise. `carry`: the Rückwirkende Korrektur
 * carries it as a line of its own; false: it follows from a wage difference carried with it (§22 decision 32).
 */
export interface Difference {
  wageType: string; label: string; side: 'employee' | 'employer'; before: number; after: number; diff: number; carry: boolean;
  /** A tariff kind's line: its region (a canton is settled on its own). */
  region?: string;
  /** The tax at source as the month computes now (its code, wage and rate): what its correction declares (§22 decision 111). */
  tariff?: CorrectedTariff;
}

export interface Affected {
  payslip: string; employee: string; name: string; month: string; postingDate: string;
  /** A person's own corrections of the month's tax at source since its close: shown, never undone (a double is seen). */
  hand?: Array<{ wageType: string; label: string; amount: number }>;
  /** Its posting date lies in a closed period: only the correction, never «So lassen» or «Wieder öffnen». */
  closedPeriod: boolean;
  differences: Difference[];
}

/** The history as if the payslip `id` were not closed: its draft computed again from the values. */
function withoutClose(h: PayslipHistory, id: string): PayslipHistory {
  const closed = new Map(h.closed);
  closed.delete(id);
  return { ...h, closed };
}

/** The lines summed by Lohnart and side, and a tariff kind's lines by their region too (a canton is settled on its own). */
function byWageType(d: Pick<PayslipDraft, 'lines'> | undefined): Map<string, { label: string; side: 'employee' | 'employer'; region?: string; amount: number }> {
  const out = new Map<string, { label: string; side: 'employee' | 'employer'; region?: string; amount: number }>();
  // A correction line is carried by whichever month is open first: it is no value of this month.
  for (const l of (d?.lines ?? []).filter((x) => !x.corrects)) {
    const region = l.tariff?.region;
    const k = `${l.wageType}|${l.side}|${region ?? ''}`;
    const x = out.get(k) ?? { label: l.label, side: l.side, ...(region ? { region } : {}), amount: 0 };
    x.amount = round2(x.amount + l.amount);
    out.set(k, x);
  }
  return out;
}

/** A tax line's own figures in a region (not a correction's): what a correction of the month declares. */
function ownTariff(d: Pick<PayslipDraft, 'lines'> | undefined, wageType: string, region: string): CorrectedTariff | undefined {
  const own = (d?.lines ?? []).filter((l) => l.wageType === wageType && !l.corrects && l.tariff?.region === region && l.base !== undefined && l.rate !== undefined);
  return own.length === 1 ? { region, code: own[0].tariff!.code, income: own[0].tariff!.income, wage: own[0].base!, rate: own[0].rate! } : undefined;
}

/**
 * The differences of two computations, each marked whether a correction carries it. A wage line that counts
 * for a base (Monatslohn, an allowance) is carried, and the month that carries it computes the contributions
 * on it, as on any line of its own: so when one differs, the contributions' differences are not carried
 * again (they would be charged twice). Without such a line (a rate, a certificate, a new insurance) the
 * contributions' differences are carried themselves. A tariff kind's line differs per region: a canton
 * moved back over a closed month takes the tax back from the old canton and owes it to the new one.
 */
function differencesOf(ctx: Pick<PayrollContext, 'data' | 'store'>, before: Pick<PayslipDraft, 'lines'> | undefined, after: Pick<PayslipDraft, 'lines'> | undefined): Difference[] {
  const types = firmWageTypes(ctx.data, ctx.store);
  const b = byWageType(before); const a = byWageType(after);
  const out: Array<Omit<Difference, 'carry'>> = [];
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(k); const y = a.get(k);
    const diff = round2((y?.amount ?? 0) - (x?.amount ?? 0));
    if (diff === 0) continue;
    const wageType = k.split('|')[0];
    const region = (y ?? x)!.region;
    // The tax's own line in its region as computed now, else as it was (the canton the tax is taken back from).
    const tariff = region && types.get(wageType)?.computes !== 'commission' ? ownTariff(after, wageType, region) ?? ownTariff(before, wageType, region) : undefined;
    out.push({ wageType, label: (y ?? x)!.label, side: (y ?? x)!.side, before: x?.amount ?? 0, after: y?.amount ?? 0, diff, ...(region ? { region } : {}), ...(tariff ? { tariff } : {}) });
  }
  const contribution = (d: { wageType: string }) => types.get(d.wageType)?.computes === 'contribution';
  const wage = out.some((d) => !contribution(d) && (types.get(d.wageType)?.bases.length ?? 0) > 0);
  // A commission follows the tax it is taken on: the month that carries the tax's correction takes it again (§22 decision 92).
  const commission = (d: { wageType: string }) => types.get(d.wageType)?.computes === 'commission';
  return out.map((d) => ({ ...d, carry: !(wage && contribution(d)) && !commission(d) }));
}

/**
 * The closed payslips `next` computes otherwise than the store of `ctx`: each computed as if open, once
 * with the values before the change and once with them after, so only the change's own difference shows.
 */
export function affectedBy(ctx: PayrollContext, next: PayrollStore, isClosed: (day: string) => boolean = () => false): Affected[] {
  return affectedBetween(ctx, { ...ctx, store: next }, isClosed);
}

/** The closed payslips `after` computes otherwise than `before` (another store, another tariff file), each computed as if open. */
export function affectedBetween(ctx: PayrollContext, next: PayrollContext, isClosed: (day: string) => boolean = () => false): Affected[] {
  const out: Affected[] = [];
  for (const c of ctx.history.closed.values()) {
    const history = withoutClose(ctx.history, c.id);
    const before = computePayslip({ ...ctx, history }, c.employee, c.month);
    const after = computePayslip({ ...next, history }, c.employee, c.month);
    const differences = differencesOf({ data: ctx.data, store: next.store }, before, after);
    if (differences.length) out.push({ payslip: c.id, employee: c.employee, name: c.person.name, month: c.month, postingDate: c.postingDate, closedPeriod: isClosed(c.postingDate), differences });
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));
}

/**
 * The closed payslips another tariff file computes otherwise (§22 decision 96): for the Lohnarten of a tariff
 * kind and the commission only, what the payslip withheld (its own lines, less the corrections a carried line of
 * another month brought, plus the corrections entered on it since its close, as `driftOf` reads it) against
 * what it computes as if open with `next`'s file. So a month closed without a file, corrected by hand since,
 * or kept as it was («So lassen»), shows what it really lacks, and nothing is carried twice.
 */
export function affectedByTariff(ctx: PayrollContext, next: PayrollContext, isClosed: (day: string) => boolean = () => false): Affected[] {
  const { types, taxed } = tariffWageTypes(ctx);
  const keep = (d: Pick<PayslipDraft, 'lines'> | undefined) => ({ lines: (d?.lines ?? []).filter((l) => taxed.has(l.wageType)) });
  const out: Affected[] = [];
  for (const c of ctx.history.closed.values()) {
    const corrected = ctx.history.corrections.filter((x) => x.of === c.id && x.at >= c.closedAt && taxed.has(x.wageType));
    const after = keep(computePayslip({ ...next, history: withoutClose(ctx.history, c.id) }, c.employee, c.month));
    // «So lassen» on this very file: the person decided for this month, no card again.
    const year = c.month.slice(0, 4);
    const regions = new Set(after.lines.filter((l) => l.tariff).map((l) => l.tariff!.region));
    const kept = (ctx.history.events.get(c.id) ?? []).some((ev) => ev.event === 'keep' && ev.at >= c.closedAt
      && [...regions].some((r) => {
        const file = next.tariffs?.(r, year);
        // By the file's checksum; an older keep named only the file's date.
        return ev.path === `tariffs/${r}/${year}` && !!file && (ev.version ? ev.version === file.sha256 : ev.validFrom === file.file.created);
      }));
    if (kept) continue;
    // What the month withheld: its own lines and the corrections a computation made (a file, a value dated back). A
    // person's own corrections stay hers and are not undone, unless the month was closed without its tax: then they
    // stand for it, and nothing is carried twice (decision 96). A hand correction is shown beside the card.
    const { counted, hand } = withheldBy(c, corrected, taxed);
    // A correction counts in its canton: its own, else the closed month's, else the only one the month computes now.
    const regionOf = (x: PayslipCorrection) => x.tariff?.region ?? closeRegion(c, x.wageType) ?? onlyRegion(after, x.wageType);
    const withheld: Pick<PayslipDraft, 'lines'> = {
      lines: [...keep(c).lines, ...counted.map((x) => {
        const region = regionOf(x);
        return { wageType: x.wageType, label: types.get(x.wageType)?.label.de ?? x.wageType, amount: x.amount, side: x.side, source: 'correction', ...(region ? { tariff: { region, code: '', income: 0 } } : {}) };
      })],
    };
    const differences = differencesOf({ data: ctx.data, store: ctx.store }, withheld, after);
    // Only what a correction carries is offered: a commission's rounding alone leaves nothing to do.
    if (differences.some((d) => d.carry)) {
      out.push({
        payslip: c.id, employee: c.employee, name: c.person.name, month: c.month, postingDate: c.postingDate, closedPeriod: isClosed(c.postingDate), differences,
        ...(hand.length ? { hand: hand.map((x) => ({ wageType: x.wageType, label: types.get(x.wageType)?.label.de ?? x.wageType, amount: x.amount })) } : {}),
      });
    }
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));
}

/** The Lohnarten of a tariff kind (the tax at source) and its commission. */
function tariffWageTypes(ctx: Pick<PayrollContext, 'data' | 'store'>) {
  const types = firmWageTypes(ctx.data, ctx.store);
  const tariffKinds = new Set(Object.entries(ctx.data.insurances).filter(([, k]) => k.tariff).map(([k]) => k));
  const taxed = new Set(ctx.data.contributions.filter((c) => tariffKinds.has(c.insurance)).map((c) => c.wageType));
  for (const w of types.values()) if (w.computes === 'commission') taxed.add(w.key);
  return { types, taxed };
}

/**
 * A closed month's corrections of the tax at source as the comparison counts them: those a computation made (they carry
 * the corrected month's figures), and a person's own (hand) ones only where the month was closed without its tax, for
 * then they stand for it. A hand correction of a month closed with its tax is hers: never compared, never undone.
 */
function withheldBy(c: Pick<PayslipClose, 'left'>, corrected: readonly PayslipCorrection[], taxed: ReadonlySet<string>) {
  // The month could compute its tax when it closed (a line, or a rate of 0 %): nothing of the tax was left «unvollständig».
  const ownTax = !c.left.some((m) => taxed.has(m.wageType));
  const isHand = (x: PayslipCorrection) => taxed.has(x.wageType) && x.tariff?.wage === undefined;
  return { counted: corrected.filter((x) => !(ownTax && isHand(x))), hand: ownTax ? corrected.filter(isHand) : [] };
}

/** The region of a closed payslip's own line of a Lohnart (a tariff kind's), if it has one. */
const closeRegion = (c: Pick<PayslipClose, 'lines'>, wageType: string): string | undefined =>
  c.lines.find((l) => l.wageType === wageType && !l.corrects && l.tariff)?.tariff?.region;

/** The one region a computation's lines of a Lohnart name, if exactly one. */
function onlyRegion(d: Pick<PayslipDraft, 'lines'>, wageType: string): string | undefined {
  const rs = new Set(d.lines.filter((l) => l.wageType === wageType && l.tariff).map((l) => l.tariff!.region));
  return rs.size === 1 ? [...rs][0] : undefined;
}

/** «Wieder öffnen» on the card: only when the one payslip affected is the person's latest closed month, in an open period. */
export function reopenOffer(ctx: PayrollContext, affected: readonly Affected[], isClosed: (day: string) => boolean): string | undefined {
  if (affected.length !== 1) return undefined;
  const a = affected[0];
  return latestClosed(ctx.history, a.employee)?.id === a.payslip && !isClosed(a.postingDate) ? a.payslip : undefined;
}

/** «Rückwirkende Korrektur»: one correction per carried difference of each affected payslip, carried to the person's next open month. */
export function backdatedCorrections(ctx: PayrollContext, affected: readonly Affected[], id: () => string, now: string): PayslipCorrection[] {
  return affected.flatMap((a) => a.differences.filter((d) => d.carry).map((d) => correctionOf(ctx, ctx.data, a.payslip, { wageType: d.wageType, amount: d.diff, ...(d.tariff ? { tariff: d.tariff } : {}) }, id(), now)));
}

/** «So lassen» on each affected payslip, for its history; it changes nothing closed. */
export const keepEvents = (affected: readonly Affected[], what: { path: string; validFrom?: string; version?: string }, now: string): PayslipEvent[] =>
  affected.map((a) => ({ event: 'keep', id: a.payslip, at: now, by: 'person', path: what.path, ...(what.validFrom ? { validFrom: what.validFrom } : {}), ...(what.version ? { version: what.version } : {}) }));

/**
 * What a closed payslip would compute today, less the corrections entered on it since: shown on it as a
 * fact («berechnet mit den Werten von damals»), never a reminder; empty when nothing differs (§19.3 «So lassen»).
 */
export function driftOf(ctx: PayrollContext, close: PayslipClose): Difference[] {
  const now = computePayslip({ ...ctx, history: withoutClose(ctx.history, close.id) }, close.employee, close.month);
  // As the tariff card counts them: a person's own correction of the tax of a month closed with its tax is hers.
  const { taxed } = tariffWageTypes(ctx);
  const { counted: corrected, hand } = withheldBy(close, ctx.history.corrections.filter((c) => c.of === close.id && c.at >= close.closedAt), taxed);
  const left = differencesOf(ctx, close, now).filter((d) => d.carry).map((d) => {
    const inRegion = (c: PayslipCorrection) => !d.region || (c.tariff?.region ?? closeRegion(close, c.wageType) ?? d.region) === d.region;
    const done = round2(corrected.filter((c) => c.wageType === d.wageType && c.side === d.side && inRegion(c)).reduce((s, c) => s + c.amount, 0));
    // Her own correction is never undone, but where it is exactly what is left (she corrected the difference by
    // hand, after «So lassen»), nothing is left to say.
    const byHand = round2(hand.filter((c) => c.wageType === d.wageType && c.side === d.side && inRegion(c)).reduce((s, c) => s + c.amount, 0));
    const diff = round2(d.diff - done);
    return { ...d, diff: byHand !== 0 && byHand === diff ? 0 : diff };
  });
  return left.filter((d) => d.diff !== 0);
}

// ─── what the pages read ───────────────────────────────────────────────────────

/** The first day of the person's first month without a closed payslip, after her opening: the default «gilt ab» (domain-model.md §5.6). */
export function defaultFrom(ctx: PayrollContext, e: PayrollEmployee, today: string): string {
  const entry = [...e.employment].sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0]?.validFrom;
  if (!entry) return today;
  const last = closedOf(ctx.history, e.id).at(-1)?.month;
  const opening = openingOf(e, today.slice(0, 4))?.through;
  const after = [last, opening].filter((m): m is string => !!m).sort().at(-1);
  if (!after) return entry;
  const next = firstDay(nextMonth(after));
  return next > entry ? next : entry;
}

export interface EmployeeDetail {
  /** The password of her payslips by mail never leaves the server after it is set: only whether one is (a generated one is shown once). */
  employee: Omit<PayrollEmployee, 'socialSecurityNumber' | 'mailPassword'> & { socialSecurityNumber?: string; hasSocialSecurityNumber: boolean; hasMailPassword: boolean };
  /** The entries closed payslips read, as `path|validFrom|enteredAt`: they stay, a new entry corrects them. */
  used: string[];
  /** The person's months of the year, closed, open, or the opening's (the Zeitachse). */
  months: Array<{ month: string; status: 'closed' | 'draft' | 'opening'; payslip: string }>;
  defaultFrom: string;
  /** Her opening of the year with its months made explicit (src/payroll/opening.ts), when she has one. */
  opening?: { year: string; through?: string; months: number; bases: Record<string, number>; fields: Record<string, number> };
}

export function employeeDetail(ctx: PayrollContext, id: string, year: string, today: string, mask: (n: string) => string): EmployeeDetail {
  const e = employeeOf(ctx.store, id);
  const prefix = `employees/${id}/`;
  const used = [...new Set(closedOf(ctx.history, id).flatMap((c) => c.used.filter((u) => u.path.startsWith(prefix)).map((u) => `${u.path}|${u.validFrom}|${u.enteredAt}`)))];
  const months = monthsBetween(`${year}-01`, `${year}-12`).flatMap((m): EmployeeDetail['months'] => {
    const pid = payslipId(m, id);
    if (ctx.history.closed.has(pid)) return [{ month: m, status: 'closed', payslip: pid }];
    if (inOpening(e, m)) return [{ month: m, status: 'opening', payslip: pid }];
    return employedFraction(e, m, 'calendar-days') > 0 ? [{ month: m, status: 'draft', payslip: pid }] : [];
  });
  const { socialSecurityNumber, mailPassword, ...rest } = e;
  const opening = openingOf(e, year);
  return {
    employee: { ...rest, ...(socialSecurityNumber ? { socialSecurityNumber: mask(socialSecurityNumber) } : {}), hasSocialSecurityNumber: !!socialSecurityNumber, hasMailPassword: !!mailPassword },
    used, months, defaultFrom: defaultFrom(ctx, e, today), ...(opening ? { opening: { year, ...opening } } : {}),
  };
}

/** One account the payroll books on, and whether the chart has it. */
export interface PayrollAccount { number: string; exists: boolean; name?: string; wageTypes: string[] }

/**
 * The accounts the firm's payslips book on (§5.3 «accounts exist»): those of the Lohnarten code computes
 * for the insurances the firm has or must have, of the Lohnarten its people have, and of its closed lines.
 */
export function payrollAccounts(ctx: PayrollContext, chart: ReadonlyMap<string, string>, standard: ReadonlyMap<string, string>): PayrollAccount[] {
  const { data, store, history } = ctx;
  const types = firmWageTypes(data, store);
  const kinds = new Set([...store.insurances.map((i) => i.kind), ...Object.entries(data.insurances).filter(([, k]) => k.required).map(([k]) => k)]);
  const contributionTypes = new Set(data.contributions.filter((c) => kinds.has(c.insurance)).map((c) => c.wageType));
  const keys = new Set<string>([
    ...[...types.values()].filter((w) => w.computes === 'monthly' || w.computes === 'thirteenth').map((w) => w.key),
    ...contributionTypes,
    ...store.employees.flatMap((e) => e.recurring.map((r) => r.wageType)),
    ...store.monthLines.filter((l) => !l.removed).map((l) => l.wageType),
    ...[...history.closed.values()].flatMap((c) => c.lines.map((l) => l.wageType)),
  ]);
  const byNumber = new Map<string, Set<string>>();
  for (const key of keys) {
    const w = types.get(key);
    if (!w) continue;
    for (const ref of [w.debit, w.credit]) {
      const kind = ref && typeof ref === 'object' ? ref.insurance : undefined;
      const insurance = kind ? store.insurances.find((i) => i.kind === kind) : undefined;
      const n = resolveAccount(ref, data, insurance);
      if (n) byNumber.set(n, (byNumber.get(n) ?? new Set()).add(key));
    }
  }
  return [...byNumber.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([number, ws]) => {
    const name = chart.get(number) ?? standard.get(number);
    return { number, exists: chart.has(number), ...(name ? { name } : {}), wageTypes: [...ws] };
  });
}

/** The settings page: the Stammdaten, the insurances, the firm's Lohnarten and which closed payslip used what. */
export function settingsView(ctx: PayrollContext, accounts: PayrollAccount[]) {
  const { store, history } = ctx;
  const types = firmWageTypes(ctx.data, store);
  return {
    company: store.company,
    insurances: store.insurances,
    wageTypes: [...types.values()].map((w) => ({ ...w, used: wageTypeUsed(history, w.key) })),
    used: [...new Set([...history.closed.values()].flatMap((c) => c.used.filter((u) => u.path.startsWith('company/') || u.path.startsWith('insurances/')).map((u) => `${u.path}|${u.validFrom}|${u.enteredAt}`)))],
    accounts,
  };
}
export type SettingsView = ReturnType<typeof settingsView>;

// ─── a document's card (src/payroll/setup-documents.ts) ────────────────────────

/** One insurance of a card as the person kept it: the card's fields after her edits, and from when they hold. */
export interface KeptItem { kind: string; name?: string; memberNumber?: string; contractNumber?: string; code?: string; rates?: Record<string, number>; validFrom: string; person?: { name: string; employee?: number; employer?: number } }

const foldName = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}]+/gu, ' ').trim();

/**
 * Keeps a document's card (§6.1 step 2): each insurance it proposes is created as the form creates it, or, where the firm
 * has one of the kind, its rates are a dated entry from `validFrom` of its solution (a new solution for a new code) and
 * the numbers it lacks are set; a pension certificate's person gets her contributions as a dated entry of her
 * insurances. Every entry names the document (`source.receiptId`). `persons`: the people the certificate names that
 * payroll.json does not have, left for the person to add.
 */
export function keepSetupCard(store: PayrollStore, data: PayrollData, receiptId: string, items: readonly KeptItem[], newId: () => string, now: string): { insurances: string[]; persons: string[]; warnings: RateWarning[] } {
  if (!items.length) bad('Die Karte schlägt nichts vor.');
  const out = { insurances: [] as string[], persons: [] as string[], warnings: [] as RateWarning[] };
  for (const item of items) {
    if (!own(data.insurances, item.kind)) bad(`Versicherung ${item.kind} gibt es nicht.`, 'kind');
    const rates = Object.fromEntries(Object.entries(item.rates ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
    let ins = store.insurances.find((i) => i.kind === item.kind && !i.validUntil);
    if (!ins) {
      const made = createInsurance(store, data, { kind: item.kind, name: item.name, memberNumber: item.memberNumber, contractNumber: item.contractNumber, code: item.code, validFrom: item.validFrom, rates, receiptId }, newId(), now);
      ins = made.insurance;
      out.warnings.push(...made.warnings);
    } else {
      for (const k of ['memberNumber', 'contractNumber'] as const) if (!ins[k] && optStr(item[k])) ins[k] = optStr(item[k]);
      if (Object.keys(rates).length && !data.insurances[item.kind].perPerson) {
        const code = optStr(item.code) ?? ins.solutions[0]?.code ?? 'A';
        if (!ins.solutions.some((s) => s.code === code)) out.warnings.push(...addSolution(store, data, ins.id, { code, validFrom: item.validFrom, rates: {} }, now));
        // A rate the document does not name (the NBU's employer share on a policy) holds on as it was on that day.
        const current = entryOn(ins.solutions.find((s) => s.code === code)?.rates, item.validFrom)?.value ?? {};
        out.warnings.push(...addDatedEntry(store, data, { path: `insurances/${ins.id}/solutions/${code}/rates`, validFrom: item.validFrom, value: { ...current, ...rates }, receiptId }, now).warnings);
      }
    }
    out.insurances.push(ins.id);
    if (item.person !== undefined && data.insurances[item.kind].perPerson) {
      // Contributions typed without the person they are hers: refused, never dropped (walk 3, §22 decision 108).
      if (!isObj(item.person) || typeof item.person.name !== 'string' || !item.person.name.trim()) bad('Person wählen: für wen gelten die Beiträge des Vorsorgeausweises? Ihren Namen bei «Versicherte Person» eintragen.', 'person');
      const want = foldName(item.person.name);
      const e = store.employees.find((x) => { const n = x.name.at(-1)?.value; return !!n && foldName(`${n.first} ${n.last}`) === want || (!!n && foldName(`${n.last} ${n.first}`) === want); });
      if (!e) { out.persons.push(item.person.name); continue; }
      const current = entryOn(e.insurances, item.validFrom)?.value ?? {};
      // A contribution left blank is not nothing: it stays as her entry says, or her part is not taken.
      const had = (current as Record<string, { employee?: number; employer?: number } | undefined>)[item.kind];
      const employee = item.person.employee ?? had?.employee;
      const employer = item.person.employer ?? had?.employer;
      if (employee === undefined || employer === undefined) { out.persons.push(item.person.name); continue; }
      const value = { ...current, [item.kind]: { insurance: ins.id, employee: num(employee, 'Beitrag Arbeitnehmer', 0), employer: num(employer, 'Beitrag Arbeitgeber', 0) } };
      addDatedEntry(store, data, { path: `employees/${e.id}/insurances`, validFrom: item.validFrom, value, receiptId }, now);
    }
  }
  return out;
}
