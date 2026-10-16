/**
 * What makes a jurisdiction module unusable: a code that feeds a box the return does not have, a
 * formula that names a missing box or depends on itself, a rate row the form never shows. Each
 * problem names its file and path, so the person (or the AI) editing the overlay can fix it.
 */
import { INCOME_SECTIONS, type BoxId, type Formula, type Jurisdiction } from './schema.js';
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
  const boxes = new Set<BoxId>([r.turnoverBox, ...rateBoxes, ...Object.keys(r.deductions), ...Object.keys(r.inputTax), ...Object.keys(r.derived)]);

  for (const z of r.rateOrder) if (!rateBoxes.has(z)) add('return.yaml', `rateOrder`, `Ziffer ${z} is not a rate row of rates.yaml`);
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

  for (const [z, d] of Object.entries(r.derived)) {
    for (const ref of formulaRefs(d.formula)) if (!boxes.has(ref)) add('return.yaml', `derived.${z}.formula`, `Ziffer ${ref} does not exist`);
  }
  const visiting = new Set<BoxId>(); const done = new Set<BoxId>();
  const visit = (z: BoxId, trail: BoxId[]) => {
    if (done.has(z) || !(z in r.derived)) return;
    if (visiting.has(z)) { add('return.yaml', `derived.${z}.formula`, `depends on itself: ${[...trail, z].join(' → ')}`); return; }
    visiting.add(z);
    for (const ref of formulaRefs(r.derived[z].formula)) visit(ref, [...trail, z]);
    visiting.delete(z); done.add(z);
  };
  for (const z of Object.keys(r.derived)) visit(z, []);
  for (const key of ['payable', 'credit'] as const) if (!(r[key] in r.derived)) add('return.yaml', key, `Ziffer ${r[key]} is not a derived Ziffer`);
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
  if (!FILING_LENGTHS.includes(j.periods.vat.length)) add('periods.yaml', 'vat.length', `"${j.periods.vat.length}" is not one of ${FILING_LENGTHS.join(', ')}`);
  if (!(j.periods.vat.dueDays >= 0)) add('periods.yaml', 'vat.dueDays', 'must be a number of days');
  return problems;
}
