/**
 * What the second persona walk of payroll B0 found wanting (docs/specs/payroll.md §22 decisions 120 ff.): the
 * company car's rate in percent with its words and default, the federal sources in the person's language,
 * the month states' words, the final statement's December warning and the insurers' «Immer so».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computePayslip } from '../src/payroll/compute.js';
import { firmWageTypes, ratePercent, rateShown, rateStored } from '../src/payroll/catalogue.js';
import { checkPayroll } from '../src/core/modules/check-payroll.js';
import type { Jurisdiction } from '../src/core/modules/schema.js';
import { amountOf, ch, ctxOf, dated, firm, owner } from './support/payroll.js';

const data = ch.payroll!;
const car = data.wageTypes.find((w) => w.key === 'privatanteil-fahrzeug')!;

test('the company car: its rate is typed in percent, 0.9 prefilled, and computes as price × 0.009', () => {
  assert.equal(ratePercent(car), true);
  assert.equal(car.defaults?.rate, 0.9);
  assert.equal(rateStored(car, car.defaults!.rate!), 0.009, '0.9 % is kept as the fraction the payslip computes with');
  assert.equal(rateShown(car, 0.009), 0.9);
  assert.equal(rateStored(undefined, 45), 45, 'an hourly rate stays as typed');
  const store = firm([owner({ recurring: [{ wageType: 'privatanteil-fahrzeug', value: [dated('2026-01-01', { quantity: 60000, rate: rateStored(car, 0.9) })] }] })]);
  assert.equal(amountOf(computePayslip(ctxOf(store), 'e1', '2026-10')!, 'privatanteil-fahrzeug'), 540, '60,000 × 0.9 % = 540');
  // A firm's copy of the Lohnart keeps the unit and the default.
  const copy = firmWageTypes(data, { wageTypes: [{ key: 'auto-2', copyOf: 'privatanteil-fahrzeug', label: { de: 'Auto 2', fr: 'Auto 2', it: 'Auto 2', en: 'Car 2' } }] }).get('auto-2')!;
  assert.equal(ratePercent(copy), true);
});

test('the company car names its inputs and what is missing in a car\'s words, in each language', () => {
  for (const lang of ['de', 'fr', 'it', 'en'] as const) {
    assert.ok(car.inputs?.quantity?.[lang] && car.inputs.rate?.[lang]?.includes('%'), `${lang}: price and rate % named`);
    assert.ok(car.missing?.quantity?.[lang], `${lang}: the missing price in a sentence`);
  }
  assert.equal(car.missing!.quantity!.de, 'Kaufpreis des Fahrzeugs (ohne MWST) fehlt');
  const words = readFileSync('src/app/areas/payroll/words.ts', 'utf8');
  assert.match(words, /const sentence = input && def\?\.missing\?\.\[input\];\n\s+if \(sentence\) return labelOf\(sentence\);/, 'the line «unvollständig» says the data\'s sentence');
});

test('both forms of a Lohnart take the same fields, unit and default; a refusal names the field by the form\'s word', () => {
  const payslips = readFileSync('src/app/areas/payroll/Payslips.tsx', 'utf8');
  const employees = readFileSync('src/app/areas/payroll/Employees.tsx', 'utf8');
  for (const [name, src] of [['month form', payslips], ['recurring form', employees]] as const) {
    assert.match(src, /inputFields\(w/, `${name}: the Lohnart's fields`);
    assert.match(src, /inputDefaults\(/, `${name}: the default prefilled`);
    assert.match(src, /inputValue\(w, f\)/, `${name}: the typed percent kept as a fraction`);
    assert.match(src, /fieldWord\(w\)/, `${name}: a refusal names the field as the form does`);
    assert.doesNotMatch(src, /\$\{v?\.?quantity\} × \$\{fmt\(v\.rate/, `${name}: no bare «quantity × rate»`);
  }
  const inputs = readFileSync('src/app/areas/payroll/inputs.ts', 'utf8');
  assert.match(inputs, /rateStored\(w, rate\)/);
  assert.match(inputs, /field === 'unitRate' \? 'rate' : field/, 'the server\'s «Ansatz» field is the form\'s rate');
});

test('the checker refuses a unit, a default or a missing sentence that does not fit', () => {
  assert.deepEqual(checkPayroll(ch), []);
  const bad = structuredClone(ch) as Jurisdiction;
  const w = bad.payroll!.wageTypes.find((x) => x.key === 'bonus')!;
  Object.assign(w, { units: { rate: 'permille' }, defaults: { rate: 'x' }, missing: { quantity: { de: 'fehlt' } } });
  const found = checkPayroll(bad).map((p) => `${p.path}: ${p.message}`);
  assert.ok(found.some((f) => f.includes('units.rate')), found.join('\n'));
  assert.ok(found.some((f) => f.includes('defaults.rate')));
  assert.ok(found.some((f) => f.includes('missing.quantity') && f.includes('without fr')));
  assert.ok(found.some((f) => f.includes('quantity × rate')));
});
