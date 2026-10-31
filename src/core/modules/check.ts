/**
 * What makes a jurisdiction module unusable: a code that feeds a box the return does not have, a
 * formula that names a missing box or depends on itself, a rate row the form never shows. Each
 * problem names its file and path, so the person (or the AI) editing the overlay can fix it.
 */
import { INCOME_SECTIONS, STATEMENTS_VAT, type BoxId, type Formula, type Jurisdiction, type ReturnData } from './schema.js';
import { FILING_LENGTHS } from '../../accounting/periods.js';

export interface ModuleProblem {
  file: string;
  path: string;
  message: string;
}

/** The boxes a formula reads. */
export function formulaRefs(f: Formula | BoxId): BoxId[] {
  if (typeof f === 'string') return [f];
  if ('sum' in f) return f.sum;
  if ('minus' in f) return f.minus;
  if ('positive' in f) return formulaRefs(f.positive);
  if ('signed' in f) return Object.keys(f.signed);
  return [];
}

export function checkJurisdiction(j: Jurisdiction): ModuleProblem[] {
  const problems: ModuleProblem[] = [];
  const add = (file: string, path: string, message: string) => problems.push({ file, path, message });
  const r = j.vatReturn;
  const rateBoxes = new Set(Object.keys(j.rates.rows));

  checkForm(r, rateBoxes, 'return.yaml', add);
  for (const z of rateBoxes) if (!r.rateOrder.includes(z)) add('return.yaml', `rateOrder`, `rate row ${z} of rates.yaml is missing from rateOrder`);

  const feeds: [keyof Jurisdiction['taxCodes']['codes'][string], Set<BoxId>][] = [
    ['revenue', rateBoxes], ['deduction', new Set(Object.keys(r.deductions))], ['inputTax', new Set(Object.keys(r.inputTax))],
    ['correction', new Set(Object.keys(r.inputTax))], ['acquisition', rateBoxes],
  ];
  for (const [code, meaning] of Object.entries(j.taxCodes.codes)) {
    for (const [field, allowed] of feeds) {
      const z = meaning[field];
      if (z !== undefined && !allowed.has(String(z))) add('tax-codes.yaml', `codes.${code}.${field}`, `Ziffer ${z} is not a ${field} Ziffer of return.yaml`);
    }
  }
  j.taxCodes.patterns.forEach((p, i) => {
    try { new RegExp(p.match); } catch { add('tax-codes.yaml', `patterns[${i}].match`, `not a regular expression: ${p.match}`); }
    for (const [k, z] of Object.entries(p.correction)) if (!(z in r.inputTax)) add('tax-codes.yaml', `patterns[${i}].correction.${k}`, `Ziffer ${z} is not an input-tax Ziffer`);
  });

  for (const [k, z] of Object.entries(j.taxCodes.purchaseBoxes)) if (!(z in r.inputTax)) add('tax-codes.yaml', `purchaseBoxes.${k}`, `Ziffer ${z} is not an input-tax Ziffer`);

  const n = j.vatReturnNetRate;
  for (const [code, m] of Object.entries(j.taxCodes.netRateCodes ?? {})) {
    if (m.netRate !== 1 && m.netRate !== 2) add('tax-codes.yaml', `netRateCodes.${code}.netRate`, 'must be 1 or 2: the firm has at most two approved rates');
    if (!n) add('tax-codes.yaml', `netRateCodes.${code}`, 'the module has no return-net-rate.yaml to declare it on');
    else if (n.netRateRows[m.revenue]?.netRate !== m.netRate) add('tax-codes.yaml', `netRateCodes.${code}.revenue`, `Ziffer ${m.revenue} is not the row of net rate ${m.netRate} in return-net-rate.yaml`);
  }
  if (n) {
    const file = 'return-net-rate.yaml';
    const rows = new Set([...rateBoxes, ...Object.keys(n.netRateRows ?? {})]);
    checkForm(n, rows, file, add);
    for (const z of Object.keys(n.netRateRows ?? {})) if (!n.rateOrder.includes(z)) add(file, 'rateOrder', `net-rate row ${z} is missing from rateOrder`);
    if (!Array.isArray(n.codes)) add(file, 'codes', 'the list of codes this form takes is missing');
    const formBoxes = new Set<BoxId>([...n.rateOrder, ...Object.keys(n.deductions), ...Object.keys(n.inputTax)]);
    // A listed code the tax codes lack (an overlay removed it) is simply not taken.
    for (const code of n.codes ?? []) {
      const m = j.taxCodes.codes[code];
      const nr = j.taxCodes.netRateCodes?.[code];
      if (!m && !nr) continue;
      const boxes = nr ? [nr.revenue] : [m.revenue, m.deduction, m.inputTax, m.correction, m.acquisition].filter((z): z is BoxId => z !== undefined);
      if (boxes.length && !boxes.some((z) => formBoxes.has(z))) add(file, 'codes', `${code} feeds no Ziffer of this form`);
    }
  }
  if (j.registration && !(j.registration.turnoverThreshold > 0)) add('registration.yaml', 'turnoverThreshold', 'must be an amount above 0');

  for (const [prefix, type] of Object.entries(j.chart.classes)) {
    if (!j.chart.types[type]) add('chart.yaml', `classes.${prefix}`, `type "${type}" is not one of types`);
  }
  const named = Object.entries(j.taxCodes.codes);
  for (const rate of j.invoicing.rates) {
    if (rate !== 0 && !named.some(([, m]) => m.revenue && m.rate === rate)) add('invoicing.yaml', 'rates', `no code in tax-codes.yaml books a sale at ${rate} %`);
  }
  for (const [why, box] of Object.entries(j.invoicing.exemptions)) {
    if (!named.some(([, m]) => m.deduction === box)) add('invoicing.yaml', `exemptions.${why}`, `no code in tax-codes.yaml deducts its turnover in Ziffer ${box}`);
  }
  if (!Array.isArray(j.invoicing.territory) || !j.invoicing.territory.length || !j.invoicing.territory.every((c) => /^[A-Z]{2}$/.test(String(c)))) add('invoicing.yaml', 'territory', 'a list of two-letter country codes');
  if (!Array.isArray(j.invoicing.placeAbroad) || !j.invoicing.placeAbroad.every((w) => typeof w === 'string' && w.trim())) add('invoicing.yaml', 'placeAbroad', 'a list of words');
  for (const s of INCOME_SECTIONS) if (!j.statements.income[s]) add('statements.yaml', `income.${s}`, 'missing');
  if (!STATEMENTS_VAT.includes(j.statements.vat)) add('statements.yaml', 'vat', `"${j.statements.vat}" is not one of ${STATEMENTS_VAT.join(', ')}`);
  if (!FILING_LENGTHS.includes(j.periods.vat.length)) add('periods.yaml', 'vat.length', `"${j.periods.vat.length}" is not one of ${FILING_LENGTHS.join(', ')}`);
  if (!(j.periods.vat.dueDays >= 0)) add('periods.yaml', 'vat.dueDays', 'must be a number of days');
  return problems;
}

/** One return form: its rate order names rows, its formulas name boxes that exist and do not loop, its result boxes are derived. */
function checkForm(r: ReturnData, rows: Set<BoxId>, file: string, add: (file: string, path: string, message: string) => void): void {
  const boxes = new Set<BoxId>([r.turnoverBox, ...rows, ...Object.keys(r.deductions), ...Object.keys(r.inputTax), ...Object.keys(r.derived)]);
  for (const z of r.rateOrder) if (!rows.has(z)) add(file, `rateOrder`, `Ziffer ${z} is not a rate row`);
  for (const [z, d] of Object.entries(r.derived)) {
    for (const ref of formulaRefs(d.formula)) if (!boxes.has(ref)) add(file, `derived.${z}.formula`, `Ziffer ${ref} does not exist`);
  }
  const visiting = new Set<BoxId>(); const done = new Set<BoxId>();
  const visit = (z: BoxId, trail: BoxId[]) => {
    if (done.has(z) || !(z in r.derived)) return;
    if (visiting.has(z)) { add(file, `derived.${z}.formula`, `depends on itself: ${[...trail, z].join(' → ')}`); return; }
    visiting.add(z);
    for (const ref of formulaRefs(r.derived[z].formula)) visit(ref, [...trail, z]);
    visiting.delete(z); done.add(z);
  };
  for (const z of Object.keys(r.derived)) visit(z, []);
  for (const key of ['payable', 'credit'] as const) if (!(r[key] in r.derived)) add(file, key, `Ziffer ${r[key]} is not a derived Ziffer`);
}
