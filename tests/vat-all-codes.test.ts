/**
 * Every MWST code and variant booked once on synthetic books, so every fed and derived Ziffer
 * carries a figure: a wrong rate or formula in modules/ch changes this golden even where the demo
 * books have no such entry. The golden was written by the code modules/ch replaced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalEntry } from '../src/types/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import './support/jurisdiction.js';
import { vat } from '../src/engines/index.js';

const codes = vat().codes.named.flatMap((c) => [c, `-${c}`, ...(/^[MIB]\d+$/.test(c) ? [`${c}-1`, `${c}-2`] : [])]).concat(['K81-A', 'K81-B', 'K81-C', 'K26-B', 'K-C']);
const entries: JournalEntry[] = codes.map((code, i) => ({
  id: `S${i}`, transactionRef: `S${i}`, date: `2026-0${1 + (i % 3)}-1${i % 9}`, accountDebit: '1020', accountCredit: '3200',
  amount: 100 + i * 37.35, vatCode: code, description: code,
}));

test('synthetic books with every code: report, lines and filing figures are as frozen', () => {
  const actual = {
    report: vat().report(entries, '2026-Q1', []).ziffern.map((z) => [z.number, z.label, z.amount]),
    lines: Object.fromEntries(Object.entries(vat().lines(entries, '2026-Q1', [])).map(([z, ls]) => [z, ls.map((l) => [l.ref, l.gross, l.base, l.tax])])),
    figures: vat().figures(entries, '2026-Q1', []),
  };
  const file = join(APP_ROOT, 'tests/golden/synthetic/all-codes.json');
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, JSON.stringify(actual, null, 1) + '\n');
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(readFileSync(file, 'utf8')));
  const zero = actual.report.filter(([z, , amount]) => !['235', '500', '510'].includes(z as string) && amount === 0);
  assert.deepEqual(zero, [], 'every Ziffer a code feeds, and every total, carries a figure');
});
