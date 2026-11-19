/**
 * What the second persona walk of payroll B0 found wanting (docs/specs/payroll.md §22 decisions 53 ff.): the
 * company car's rate in percent with its words and default, the federal sources in the person's language,
 * the month states' words, the final statement's December warning and the insurers' «Immer so».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computePayslip } from '../src/payroll/compute.js';
import { firmWageTypes, ratePercent, rateShown, rateStored } from '../src/payroll/catalogue.js';
import { checkPayroll } from '../src/core/modules/check-payroll.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payslipPdf } from '../src/payroll/pdf.js';
import type { Jurisdiction } from '../src/core/modules/schema.js';
import { amountOf, ch, closedThrough, ctxOf, dated, firm, owner } from './support/payroll.js';
import { decemberOpen } from '../src/payroll/views.js';

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

test('a federal line names its articles in the reader\'s language; a figure with only a plain source keeps its head in all', async () => {
  const { lineSource, sourceText, citesOf } = await import('../src/payroll/sources.js');
  const store = firm();
  const d = computePayslip(ctxOf(store), 'e1', '2026-10')!;
  const of = (wageType: string, lang: 'de' | 'fr' | 'it' | 'en') => {
    const s = lineSource(d.lines.find((x) => x.wageType === wageType)!, d, data, ch.payrollYears, store.insurances)!;
    return sourceText(s, data.documents, lang);
  };
  assert.equal(of('ahv-an', 'de'), 'Bundeswert 2026 · AHVG Art. 5, 13; IVG Art. 3; EOV Art. 36');
  assert.match(of('ahv-an', 'fr'), /· LAVS art\. 5, 13; LAI art\. 3; RAPG art\. 36$/);
  assert.match(of('alv-an', 'fr'), /· LACI art\. 3 al\. 1-2$/);
  assert.match(of('alv-an', 'it'), /· LADI art\. 3 cpv\. 1-2$/);
  assert.doesNotMatch(of('alv-an', 'fr'), /AVIG|Abs\./);
  assert.deepEqual(citesOf({ source: 'XG Art. 1: an explanation' }), { de: 'XG Art. 1', fr: 'XG Art. 1', it: 'XG Art. 1', en: 'XG Art. 1' }, 'a plain string as before');
  // Every figure of the year names its articles in all four languages, and the French ones carry no German abbreviation.
  for (const [k, rows] of Object.entries(ch.payrollYears!['2026'].figures)) {
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      for (const lang of ['de', 'fr', 'it', 'en'] as const) assert.ok(row.cite?.[lang], `${k} cites in ${lang}`);
      assert.doesNotMatch(row.cite!.fr!, /\b(AHVG|AHVV|AVIG|UVG|UVV|BVG|BVV|IVG|EOV|FamZG|FamZV|Abs\.|lit\.)/, `${k} in French`);
    }
  }
  const bad = structuredClone(ch) as Jurisdiction;
  (bad.payrollYears!['2026'].figures.ahvEmployee as { cite?: unknown }).cite = { de: 'AHVG Art. 5' };
  assert.ok(checkPayroll(bad).some((p) => p.path === 'figures.ahvEmployee.cite' && p.message.includes('without fr')));
});

test('the month states read alike: in French, Italian and English every state is lower case, as the German adjectives are', async () => {
  for (const lang of ['fr', 'it', 'en'] as const) {
    const dict = readFileSync(`src/app/i18n/locales/${lang}.ts`, 'utf8');
    for (const key of ['payroll.state.closed', 'payroll.state.open', 'payroll.state.future', 'payroll.state.opening', 'payroll.slip.draft', 'payroll.slip.closed', 'payroll.slip.opening']) {
      const v = new RegExp(`"${key.replace(/\./g, '\\.')}": "([^"]*)"`).exec(dict)?.[1];
      assert.ok(v, `${lang} ${key}`);
      assert.equal(v[0], v[0].toLowerCase(), `${lang} ${key}: «${v}»`);
    }
  }
  assert.match(readFileSync('src/app/areas/payroll/Payslips.tsx', 'utf8'), /<h2>\{t\('payroll\.month\.openingTitle'\)\}<\/h2>/, 'a heading keeps its capital');
});

test('the final statement: December still a draft is named before booking; the button says the difference and its direction', () => {
  const store = firm();
  assert.deepEqual(decemberOpen(ctxOf(store, closedThrough(store, '2026-12')), '2026'), ['Mila Beispiel'], 'closed through November');
  // «up to 2026-13»: through December.
  assert.deepEqual(decemberOpen(ctxOf(store, closedThrough(store, '2026-13')), '2026'), [], 'December closed: nothing to say');
  const payments = readFileSync('src/app/areas/payroll/Payments.tsx', 'utf8');
  assert.match(payments, /round2\(total - known\.compare\.books\)/, 'the difference as she types');
  assert.match(payments, /diff > 0 \? t\('payroll\.settle\.saveMore'[\s\S]*diff < 0 \? t\('payroll\.settle\.saveBack'/, 'the button names the amount and the direction');
  assert.match(payments, /data-testid="settle-december"/);
  const route = readFileSync('src/server/routes/payroll.ts', 'utf8');
  assert.match(route, /if \(entry && \(compare\.large \|\| december\.length\) && b\.confirm !== true\)/);
});

test('the payslip PDF prints the car\'s rate as the page does: «0.90 %»', async () => {
  const store = firm([owner({ recurring: [{ wageType: 'privatanteil-fahrzeug', value: [dated('2026-01-01', { quantity: 60000, rate: 0.009 })] }] })]);
  const d = computePayslip(ctxOf(store), 'e1', '2026-10')!;
  const pdf = await payslipPdf({
    month: d.month, payday: d.payday, language: 'de', lines: d.lines, gross: d.gross, deductions: d.deductions, net: d.net, payout: d.payout, employer: d.employer,
    person: d.person, firm: { name: 'Beispiel GmbH' }, at: '2026-10-31T12:00:00.000Z',
  }, data, firmWageTypes(data, store));
  const file = join(mkdtempSync(join(tmpdir(), 'payroll-car-')), 'p.pdf');
  writeFileSync(file, pdf);
  const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
  assert.match(text, /0[.,]90 %/);
  assert.doesNotMatch(text, /0[.,]009/);
});
