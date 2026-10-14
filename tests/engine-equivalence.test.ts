/**
 * The engines over modules/ch compute exactly what the Swiss code they replace computes
 * (docs/0.4.0/migration.md, steps 1 to 3): every code, and every report, line, filing figure and
 * completed filed return of the frozen books of the workspace under test. Runs on the demo under
 * `npm test`, on demo-consulting, and on the company's books under `npm run test:books`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEntry, QuarterKey, VatAdjustment } from '../src/types/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { returnEngine } from '../src/engines/return.js';
import { NAMED_VAT_CODES, computeVatReport, computeVatReportLines, parseVatCode, sourceZiffern, vatLine } from '../src/accounting/vat-report.js';
import { completeFigures, figuresFromBooks } from '../src/accounting/return-figures.js';
import { parseFiledReturn } from '../src/accounting/filed-return.js';
import { goldenSet } from './support/golden.js';

const loaded = loadJurisdiction(APP_ROOT, 'ch');
const engine = returnEngine(loaded.jurisdiction);

test('modules/ch loads with no problems, and the same data hashes the same', () => {
  assert.deepEqual(loaded.problems, []);
  assert.equal(loadJurisdiction(APP_ROOT, 'ch').hash, loaded.hash);
});

test('every code parses as before: rate, sign, amount type and the boxes it feeds', () => {
  const variants = (c: string) => [c, `-${c}`, ...(/^[MIB]\d+$/.test(c) ? [`${c}-1`, `${c}-2`, `-${c}-1`, `-${c}-2`] : [])];
  const codes = [
    ...NAMED_VAT_CODES.flatMap(variants),
    ...['K81-A', 'K81-B', 'K81-C', 'K26-B', 'K-B', 'K0-C', '-K81-B'],
    ...['', 'X', 'V99', 'M81-3', 'V81-1', 'K81-D', 'I', '--V81'],
  ];
  for (const code of codes) {
    const before = parseVatCode(code);
    const after = engine.codes.parse(code);
    assert.deepEqual(after, before, `parse ${JSON.stringify(code)}`);
    if (before) assert.deepEqual(engine.codes.sourceBoxes(after!), sourceZiffern(before), `boxes of ${code}`);
  }
  assert.deepEqual([...engine.codes.named], [...NAMED_VAT_CODES]);
});

test('synthetic books with every code and variant give the same report, lines and figures', () => {
  const codes = NAMED_VAT_CODES.flatMap((c) => [c, `-${c}`, ...(/^[MIB]\d+$/.test(c) ? [`${c}-1`, `${c}-2`] : [])]).concat(['K81-A', 'K81-B', 'K81-C']);
  const synthetic: JournalEntry[] = codes.map((code, i) => ({
    id: `S${i}`, transactionRef: `S${i}`, date: `2026-0${1 + (i % 3)}-1${i % 9}`, accountDebit: '1020', accountCredit: '3200',
    amount: 100 + i * 37.35, vatCode: code, description: code,
  }));
  assert.deepEqual(engine.report(synthetic, '2026-Q1', []).ziffern, computeVatReport(synthetic, '2026-Q1', []).ziffern);
  assert.deepEqual(engine.lines(synthetic, '2026-Q1', []), computeVatReportLines(synthetic, '2026-Q1', []));
  assert.deepEqual(engine.figures(synthetic, '2026-Q1', []), figuresFromBooks(synthetic, '2026-Q1', []));
  const fed = new Set(codes.flatMap((c) => engine.codes.sourceBoxes(engine.codes.parse(c)!)));
  const derived = ['289', '299', '399', '479'];
  const zero = engine.report(synthetic, '2026-Q1', []).ziffern.filter((z) => (fed.has(z.number) || derived.includes(z.number)) && z.amount === 0);
  assert.deepEqual(zero, [], 'every fed and derived Ziffer carries a figure, so a wrong formula shows');
});

const { ws, books } = goldenSet();
const entries = books.journalEntries as JournalEntry[];
const adjustments = books.config.vatAdjustments as VatAdjustment[];
const quarterOf = (date: string) => `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}` as QuarterKey;
const QUARTERS = [...new Set(entries.map((e) => quarterOf(e.date)))].sort();
const YEAR = QUARTERS.at(-1)!.slice(0, 4);
const FILED = QUARTERS.filter((q) => q <= quarterOf(books.config.closedThrough));

test('every entry declares the same VAT line', () => {
  for (const e of entries) assert.deepEqual(engine.vatLine(e), vatLine(e), `entry ${e.id}`);
});

test('every report, its lines and its filing figures are the same', () => {
  for (const key of [...QUARTERS, `${YEAR}-H1`, YEAR]) {
    const before = computeVatReport(entries, key, adjustments);
    const after = engine.report(entries, key, adjustments);
    assert.deepEqual(after.ziffern, before.ziffern, `${key} ziffern`);
    assert.deepEqual([after.toPay, after.credit], [before.toPay, before.credit], `${key} toPay/credit`);
    assert.deepEqual(
      after.rates.map((x) => [x.row.ziffer, x.row.rate, x.row.kind, x.row.code, x.row.name, !!x.row.superseded, x.base, x.tax]),
      before.rates.map((x) => [x.row.ziffer, x.row.rate, x.row.kind, x.row.vatCode, x.row.name, !!x.row.superseded, x.base, x.tax]),
      `${key} rates`,
    );
    assert.deepEqual(engine.lines(entries, key, adjustments), computeVatReportLines(entries, key, adjustments), `${key} lines`);
  }
  for (const q of QUARTERS) assert.deepEqual(engine.figures(entries, q, adjustments), figuresFromBooks(entries, q, adjustments), `${q} figures`);
});

test('every filed return completes to the same figures', () => {
  for (const q of FILED) {
    const filed = parseFiledReturn(readFileSync(join(ws.paths.filings, q.slice(0, 4), `mwst-ech0217-${q}.xml`), 'utf8'));
    assert.deepEqual(engine.complete(q, filed.ziffern), completeFigures(q, filed.ziffern), `${q} completed`);
  }
});
