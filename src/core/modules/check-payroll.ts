/**
 * What makes a jurisdiction's payroll data unusable (payroll.yaml, payroll/<year>.yaml): a Lohnart in a
 * group, a base or an insurance that does not exist, a contribution that names a Lohnart, a rate or a
 * figure nobody defines, a label missing a language. Each problem names its file and path.
 */
import type { Jurisdiction, Labels, PayrollAccountRef } from './schema.js';
import type { ModuleProblem } from './check.js';

const LANGUAGES = ['de', 'fr', 'it', 'en'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function checkPayroll(j: Jurisdiction): ModuleProblem[] {
  const problems: ModuleProblem[] = [];
  const p = j.payroll;
  if (!p) return problems;
  const add = (file: string, path: string, message: string) => problems.push({ file, path, message });
  const labels = (file: string, path: string, l: Labels | undefined) => {
    for (const lang of LANGUAGES) if (typeof l?.[lang] !== 'string' || !l[lang].trim()) add(file, path, `label without ${lang}`);
    // A comma in an unquoted flow mapping splits the label into keys of its own: quote it.
    for (const k of Object.keys(l ?? {})) if (!(LANGUAGES as readonly string[]).includes(k)) add(file, path, `"${k}" is no language: a label with a comma is quoted`);
  };
  const F = 'payroll.yaml';
  const groups = new Set(p.groups.map((g) => g.key));
  const bases = new Set(p.bases.map((b) => b.key));
  const kinds = new Set(Object.keys(p.insurances));
  p.groups.forEach((g, i) => {
    labels(F, `groups.${i}`, g.label);
    if (!['gross', 'deduction', 'after', 'employer'].includes(g.stage)) add(F, `groups.${i}.stage`, `"${g.stage}" is not gross, deduction, after or employer`);
  });
  p.bases.forEach((b, i) => labels(F, `bases.${i}`, b.label));
  for (const [k, l] of Object.entries(p.totals)) labels(F, `totals.${k}`, l);
  for (const [k, l] of Object.entries(p.documents ?? {})) labels(F, `documents.${k}`, l);
  // The note under every payslip names the year of the federal figures it computed with.
  for (const lang of LANGUAGES) if (p.documents && !p.documents.disclaimer?.[lang]?.includes('{year}')) add(F, 'documents.disclaimer', `${lang} names no {year}`);
  if (!p.documents) add(F, 'documents', 'missing');
  try { new RegExp(p.socialSecurityNumber?.pattern ?? ''); if (!p.socialSecurityNumber?.pattern) add(F, 'socialSecurityNumber.pattern', 'missing'); } catch { add(F, 'socialSecurityNumber.pattern', 'not a regular expression'); }
  if (p.socialSecurityNumber?.checkDigit !== undefined && p.socialSecurityNumber.checkDigit !== 'ean13') add(F, 'socialSecurityNumber.checkDigit', `"${String(p.socialSecurityNumber.checkDigit)}" is not ean13`);
  for (const [k, ins] of Object.entries(p.insurances)) {
    labels(F, `insurances.${k}.label`, ins.label);
    labels(F, `insurances.${k}.fund`, ins.fund);
    labels(F, `insurances.${k}.nameOf`, ins.nameOf);
    if (!/^\d{4}$/.test(ins.account)) add(F, `insurances.${k}.account`, 'an account number of four digits');
    if (ins.role !== undefined && ins.role !== 'authority' && ins.role !== 'supplier') add(F, `insurances.${k}.role`, 'authority or supplier');
    for (const [r, def] of Object.entries(ins.rates ?? {})) {
      labels(F, `insurances.${k}.rates.${r}`, def.label);
      if (!Array.isArray(def.range) || def.range.length !== 2 || !(def.range[0] <= def.range[1])) add(F, `insurances.${k}.rates.${r}.range`, 'a range [low, high]');
    }
  }
  const accountRef = (path: string, a: PayrollAccountRef | undefined) => {
    if (a === undefined) return;
    if (typeof a === 'string') { if (!/^\d{4}$/.test(a)) add(F, path, `"${a}" is no account number`); return; }
    if (!kinds.has(a.insurance)) add(F, path, `insurance "${a.insurance}" does not exist`);
  };
  const keys = new Set<string>();
  p.wageTypes.forEach((w, i) => {
    const at = `wageTypes.${i}`;
    if (!/^[a-z0-9-]+$/.test(w.key)) add(F, `${at}.key`, `"${w.key}" is not a key of lower-case letters, digits and dashes`);
    if (keys.has(w.key)) add(F, `${at}.key`, `"${w.key}" twice`);
    keys.add(w.key);
    if (!groups.has(w.group)) add(F, `${at}.group`, `group "${w.group}" does not exist`);
    labels(F, `${at}.label`, w.label);
    for (const [k, l] of Object.entries(w.inputs ?? {})) {
      if (!['quantity', 'rate', 'amount'].includes(k)) add(F, `${at}.inputs.${k}`, 'an input is quantity, rate or amount');
      labels(F, `${at}.inputs.${k}`, l);
    }
    for (const [k, u] of Object.entries(w.units ?? {})) {
      if (k !== 'rate' || u !== 'percent') add(F, `${at}.units.${k}`, 'only the rate has a unit, and it is percent');
    }
    for (const [k, v] of Object.entries(w.defaults ?? {})) {
      if (!['quantity', 'rate'].includes(k) || typeof v !== 'number' || !Number.isFinite(v)) add(F, `${at}.defaults.${k}`, 'a default is a number for quantity or rate');
    }
    for (const [k, l] of Object.entries(w.missing ?? {})) {
      if (!['quantity', 'rate', 'amount'].includes(k)) add(F, `${at}.missing.${k}`, 'an input is quantity, rate or amount');
      labels(F, `${at}.missing.${k}`, l);
    }
    if ((w.units || w.defaults) && w.input !== 'quantity') add(F, at, 'units and defaults are for a Lohnart entered as quantity × rate');
    if (w.sign !== '+' && w.sign !== '-') add(F, `${at}.sign`, 'is + or -');
    for (const b of w.bases ?? []) if (!bases.has(b)) add(F, `${at}.bases`, `base "${b}" does not exist`);
    if (w.side === 'employer' && (w.gross || w.bases.length)) add(F, at, 'an employer line counts for no gross and no base');
    const stage = p.groups.find((g) => g.key === w.group)?.stage;
    if (stage && (stage === 'employer') !== (w.side === 'employer')) add(F, `${at}.side`, `an employer line belongs in an employer group, and only it`);
    if (stage && !!w.gross !== (stage === 'gross')) add(F, `${at}.gross`, `gross lines are the lines of a gross group, and only they`);
    accountRef(`${at}.debit`, w.debit);
    accountRef(`${at}.credit`, w.credit);
  });
  const computed = new Set<string>();
  p.contributions.forEach((c, i) => {
    const at = `contributions.${i}`;
    const w = p.wageTypes.find((x) => x.key === c.wageType);
    if (!w) add(F, `${at}.wageType`, `Lohnart "${c.wageType}" does not exist`);
    else if (w.computes !== 'contribution') add(F, `${at}.wageType`, `Lohnart "${c.wageType}" is not marked computes: contribution`);
    computed.add(c.wageType);
    const kind = p.insurances[c.insurance];
    if (!kind) add(F, `${at}.insurance`, `insurance "${c.insurance}" does not exist`);
    if (typeof c.base === 'string') { if (!bases.has(c.base)) add(F, `${at}.base`, `base "${c.base}" does not exist`); }
    else for (const l of c.base.lines) if (!p.contributions.slice(0, i).some((x) => x.wageType === l)) add(F, `${at}.base`, `"${l}" is no earlier contribution`);
    if ('insurance' in c.rate && kind && kind.computed !== false && !kind.rates?.[c.rate.insurance]) add(F, `${at}.rate`, `insurance "${c.insurance}" states no rate "${c.rate.insurance}"`);
    if ('person' in c.rate && kind && !kind.perPerson) add(F, `${at}.rate`, `insurance "${c.insurance}" is not per person`);
    if (c.share && kind && !kind.rates?.[c.share.employer]) add(F, `${at}.share`, `insurance "${c.insurance}" states no rate "${c.share.employer}"`);
  });
  for (const w of p.wageTypes) if (w.computes === 'contribution' && !computed.has(w.key)) add(F, `wageTypes.${w.key}`, 'marked computes: contribution, but no contribution computes it');
  for (const one of ['monthly', 'thirteenth', 'holiday', 'publicHoliday'] as const) if (p.wageTypes.filter((w) => w.computes === one).length > 1) add(F, 'wageTypes', `at most one Lohnart computes ${one}`);
  for (const [k, a] of Object.entries(p.absences ?? {})) {
    labels(F, `absences.${k}.label`, a.label);
    for (const role of ['loss', 'wage', 'allowance'] as const) {
      const key = a[role];
      if (key !== undefined && !keys.has(key)) add(F, `absences.${k}.${role}`, `Lohnart "${key}" does not exist`);
    }
    if (a.holiday && (a.loss || a.wage || a.allowance)) add(F, `absences.${k}`, 'holidays taken book no line');
  }
  if (p.holidays) {
    if (!(p.holidays.daysPerWeek > 0) || !(p.holidays.weeksPerYear > 0)) add(F, 'holidays', 'daysPerWeek and weeksPerYear are positive');
    if (!p.holidays.minimum?.some((r) => r.untilAge === undefined)) add(F, 'holidays.minimum', 'a row without untilAge holds for every age');
  }
  const liable = p.declarations?.liable;
  if (liable && !p.contributions.some((c) => c.wageType === liable.contribution)) add(F, 'declarations.liable.contribution', `"${liable.contribution}" is no contribution`);
  if (liable && !bases.has(liable.base)) add(F, 'declarations.liable.base', `base "${liable.base}" does not exist`);
  for (const r of p.rounding) if (!(r > 0)) add(F, 'rounding', `${r} is no step`);

  for (const [k, ins] of Object.entries(p.insurances)) {
    if (ins.requiredAbove && !bases.has(ins.requiredAbove.base)) add(F, `insurances.${k}.requiredAbove.base`, `base "${ins.requiredAbove.base}" does not exist`);
  }
  if (p.bases.filter((b) => b.thirteenth).length > 1) add(F, 'bases', 'at most one base is the 13th salary\'s');
  const federal = new Set(p.contributions.flatMap((c) => [
    ...('federal' in c.rate ? [c.rate.federal] : []), c.ceiling, c.liable, c.minHours, c.smallWage,
    ...(typeof c.pensioner === 'object' ? [c.pensioner.allowance] : []),
  ]).filter((k): k is string => !!k));
  for (const ins of Object.values(p.insurances)) if (ins.requiredAbove) federal.add(ins.requiredAbove.figure);
  for (const w of p.wageTypes) if (w.allowance?.minimum) federal.add(w.allowance.minimum);
  for (const [year, y] of Object.entries(j.payrollYears ?? {})) {
    const file = `payroll/${year}.yaml`;
    if (String(y.year) !== year) add(file, 'year', `says ${y.year}`);
    for (const [k, rows] of Object.entries(y.figures ?? {})) {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        if (typeof row.value !== 'number' || !Number.isFinite(row.value)) add(file, `figures.${k}.value`, 'a number');
        if (typeof row.validFrom !== 'string' || !DAY.test(row.validFrom) || !row.validFrom.startsWith(year)) add(file, `figures.${k}.validFrom`, `a day of ${year}`);
        if (typeof row.source !== 'string' || !row.source.trim()) add(file, `figures.${k}.source`, 'every figure names its source');
        if (row.cite !== undefined) labels(file, `figures.${k}.cite`, row.cite as Labels);
      }
    }
    for (const k of federal) if (!y.figures?.[k]) add(file, `figures.${k}`, 'missing: a contribution of payroll.yaml reads it');
    for (const sex of ['m', 'f'] as const) if (!y.referenceAge?.[sex]?.length) add(file, `referenceAge.${sex}`, 'missing');
  }
  return problems;
}
