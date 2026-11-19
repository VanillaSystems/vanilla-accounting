/**
 * The screens and texts the scored persona walk of payroll B0 found wanting (docs/specs/payroll.md §22
 * decisions 43–48): each line's rate source, a Lohnart's inputs called by their names («Kaufpreis»), the
 * neutral note under the figures, the insurers' names in whole phrases, the Lohnart labels in the UI's
 * language, refusals as panels in the page, the payroll data read again when the books change, and the
 * sidebar without the VAT period's card on Löhne.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computePayslip } from '../src/payroll/compute.js';
import { lineSource, sourceText } from '../src/payroll/sources.js';
import { payslipPdf } from '../src/payroll/pdf.js';
import { firmWageTypes } from '../src/payroll/catalogue.js';
import { checkPayroll } from '../src/core/modules/check-payroll.js';
import { ch, ctxOf, dated, firm, owner } from './support/payroll.js';

const textOfPdf = (pdf: Buffer): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'payroll-src-')), 'p.pdf');
  writeFileSync(file, pdf);
  return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
};

const data = ch.payroll!;

test('each contribution line names where its rate comes from: the law\'s figure, the insurer\'s solution, the certificate', () => {
  const store = firm();
  const d = computePayslip(ctxOf(store), 'e1', '2026-10')!;
  const of = (wageType: string, lang: 'de' | 'fr' = 'de') => {
    const l = d.lines.find((x) => x.wageType === wageType)!;
    const s = lineSource(l, d, data, ch.payrollYears, store.insurances);
    return s && sourceText(s, data.documents, lang);
  };
  assert.equal(of('ahv-an'), 'Bundeswert 2026 · AHVG Art. 5, 13; IVG Art. 3; EOV Art. 36');
  assert.equal(of('alv-an'), 'Bundeswert 2026 · AVIG Art. 3 Abs. 1-2');
  assert.equal(of('nbu-an'), 'Unfallversicherung Beispiel, Lösung A1');
  assert.equal(of('nbu-an', 'fr'), 'Unfallversicherung Beispiel, solution A1');
  assert.equal(of('bvg-an'), 'Vorsorgeausweis Pensionskasse Beispiel');
  assert.equal(of('monatslohn'), undefined, 'the wage of the Anstellung says no source of its own');
});

test('the payslip PDF prints each source under its line and the neutral note with the year', async () => {
  const store = firm();
  const ctx = ctxOf(store);
  const d = computePayslip(ctx, 'e1', '2026-10')!;
  const pdf = await payslipPdf({
    month: d.month, payday: d.payday, language: 'de', lines: d.lines, gross: d.gross, deductions: d.deductions, net: d.net, payout: d.payout, employer: d.employer,
    person: d.person, firm: { name: 'Beispiel GmbH' }, at: '2026-10-31T12:00:00.000Z',
    sources: d.lines.map((l) => { const s = lineSource(l, d, data, ch.payrollYears, store.insurances); return s && sourceText(s, data.documents, 'de'); }),
  }, data, firmWageTypes(data, store));
  const text = textOfPdf(pdf).replace(/\s+/g, ' ');
  assert.match(text, /Bundeswert 2026 · AHVG Art\. 5, 13/);
  assert.match(text, /Unfallversicherung Beispiel, Lösung A1/);
  assert.match(text, /Berechnet aus den erfassten Sätzen und den Bundeswerten 2026\./);
  assert.doesNotMatch(text, /Treuhänder/, 'the owner who runs his own payroll is told no one else checks it');
});

test('the note under the figures is neutral and names the year in every language, payslip and Lohnausweis alike', async () => {
  for (const lang of ['de', 'fr', 'it', 'en'] as const) {
    assert.match(data.documents.disclaimer[lang], /\{year\}/);
    assert.doesNotMatch(data.documents.disclaimer[lang], /Treuh|fiduciair|fiduciar|fiduciary/i);
  }
  for (const lang of ['de', 'fr', 'it', 'en']) {
    const { messages } = ((await import(`../src/app/i18n/locales/${lang}.ts`)) as { default: { messages: Record<string, string> } }).default;
    assert.match(messages['payroll.disclaimer'], /\{year\}/, lang);
  }
  assert.deepEqual(checkPayroll(ch).filter((p) => p.path.startsWith('documents')), []);
  const broken = structuredClone(ch);
  broken.payroll!.documents.disclaimer.fr = 'Calcul selon les taux saisis.';
  assert.ok(checkPayroll(broken).some((p) => p.path === 'documents.disclaimer'), 'a note without the year is a problem of the module');
});

test('a missing input of a quantity Lohnart is named for what it lacks: the quantity or the rate per unit', () => {
  const store = firm();
  store.monthLines = [
    { id: 'm1', employee: 'e1', month: '2026-10', wageType: 'privatanteil-fahrzeug', quantity: 1, enteredAt: '2026-10-02T00:00:00Z' },
    { id: 'm2', employee: 'e1', month: '2026-10', wageType: 'ueberstunden', rate: 60, enteredAt: '2026-10-02T00:00:00Z' },
  ];
  const d = computePayslip(ctxOf(store), 'e1', '2026-10')!;
  assert.deepEqual(d.missing.map((m) => [m.wageType, m.missing]), [['privatanteil-fahrzeug', 'unitRate'], ['ueberstunden', 'quantity']]);
  const car = data.wageTypes.find((w) => w.key === 'privatanteil-fahrzeug')!;
  assert.equal(car.inputs?.quantity?.de, 'Kaufpreis ohne MWST');
  assert.equal(car.inputs?.rate?.de, 'Satz % pro Monat', 'typed in percent, 0.9 prefilled (payroll-walk2.test.ts)');
  assert.equal(data.wageTypes.find((w) => w.key === 'stundenlohn')!.inputs?.quantity?.de, 'Stunden');
  const broken = structuredClone(ch);
  broken.payroll!.wageTypes.find((w) => w.key === 'stundenlohn')!.inputs = { quantity: { de: 'Stunden', fr: '', it: 'Ore', en: 'Hours' } };
  assert.ok(checkPayroll(broken).some((p) => p.path.endsWith('.inputs.quantity')), 'an input label lacking a language is a problem of the module');
});

test('the UI names an input by its Lohnart\'s word and a Lohnart in the UI\'s language; the preview shows what closing books', () => {
  // The UI's words module reads the dictionaries through the bundler (import.meta.glob): what it does is read here off its code.
  for (const lang of ['de', 'fr', 'it', 'en'] as const) {
    for (const w of data.wageTypes.filter((x) => x.input === 'quantity')) assert.ok(w.inputs?.quantity?.[lang] && w.inputs.rate?.[lang], `${w.key} names its inputs in ${lang}`);
  }
  const words = readFileSync('src/app/areas/payroll/words.ts', 'utf8');
  assert.match(words, /if \(said\) return t\('payroll\.missing\.input', \{ what: said \}\)/);
  const payslips = readFileSync('src/app/areas/payroll/Payslips.tsx', 'utf8');
  assert.match(payslips, /\.\.\.inputFields\(w\)/, 'the form calls the car\'s quantity «Kaufpreis»');
  assert.match(readFileSync('src/app/areas/payroll/inputs.ts', 'utf8'), /inputLabel\(w\.key, 'quantity', w\.inputs\) \?\? t\('payroll\.field\.quantity'\)/);
  assert.match(payslips, /\{w \? labelOf\(w\.label, l\.label\) : l\.label\}/, 'a line in the UI\'s language, not the person\'s');
  assert.match(payslips, /const textOf = \(p: [^)]*\) => p\.text;/, 'the preview shows the books\' words as closing writes them (German data, a correction its own line)');
  for (const lang of ['de', 'fr', 'it', 'en'] as const) assert.equal(typeof data.wageTypes.find((w) => w.key === 'ahv-an')!.label[lang], 'string');
});

test('an insurer\'s name field is a whole phrase per kind: «Name des Versicherers», «Nom de l’assureur»', () => {
  assert.equal(data.insurances.ktg.nameOf.de, 'Name des Versicherers');
  assert.equal(data.insurances.uvg.nameOf.de, 'Name des Unfallversicherers');
  assert.equal(data.insurances.ktg.nameOf.fr, 'Nom de l’assureur');
  assert.equal(data.insurances.ahv.nameOf.fr, 'Nom de la caisse de compensation');
  const fr = readFileSync('src/app/i18n/locales/fr.ts', 'utf8');
  assert.doesNotMatch(fr, /Compte de dette|Nom de la \{fund\}/);
  assert.match(fr, /"payroll\.insurances\.account": "Compte de passif"/);
});

test('refusals stay in the page; the area reads its data again when the books change; Löhne shows no VAT period card', async () => {
  const { booksChanged } = await import('../src/app/areas/payroll/books-seen.js');
  const a = {}; const b = {};
  assert.equal(booksChanged(a), false, 'the first books are no change');
  assert.equal(booksChanged(a), false);
  assert.equal(booksChanged(b), true, 'a drop that booked a wage gives other books: Lohnzahlungen reads again');
  const payslips = readFileSync('src/app/areas/payroll/Payslips.tsx', 'utf8');
  assert.doesNotMatch(payslips, /nav\.toast\(errorText/, 'no refusal of a payslip\'s action is only a toast');
  assert.doesNotMatch(readFileSync('src/app/areas/payroll/Dated.tsx', 'utf8'), /nav\.toast\(errorText/);
  assert.match(readFileSync('src/app/areas/payroll/Employees.tsx', 'utf8'), /catch \(x\) \{ refusal\.refuse\(x\); \}/, 'the social security number as a password is refused in the page');
  assert.match(readFileSync('src/app/areas/payroll/payroll.tsx', 'utf8'), /noPeriodCard: true/);
  assert.match(readFileSync('src/app/shell/Shell.tsx', 'utf8'), /noPeriodCard=\{!!area\.noPeriodCard\}/);
  assert.match(readFileSync('src/app/shell/Sidebar.tsx', 'utf8'), /!setup && !noPeriodCard \? <OpenPeriodCard/);
});

test('a recurring Lohnart keeps its inputs\' words too (the car on the person, its price missing)', () => {
  const store = firm([owner({ recurring: [{ wageType: 'privatanteil-fahrzeug', value: [dated('2026-01-01', { rate: 0.009 })] }] })]);
  const d = computePayslip(ctxOf(store), 'e1', '2026-10')!;
  assert.deepEqual(d.missing.map((m) => [m.wageType, m.missing]), [['privatanteil-fahrzeug', 'quantity']]);
});
