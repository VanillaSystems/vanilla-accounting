/**
 * Golden master for everything a VAT return is computed from, on the frozen books of the
 * workspace under test (tests/support/golden.ts): the demo under `npm test`, the company's own
 * under `npm run test:books`. Quarters up to closedThrough are filed: their figures must not move.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { QuarterKey } from '../src/types/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { computeVatReport, computeVatReportLines } from '../src/accounting/vat-report.js';
import { figuresFromBooks } from '../src/accounting/return-figures.js';
import { parseFiledReturn } from '../src/accounting/filed-return.js';
import { reconcileCases, caseEffect } from '../src/accounting/correction-cases.js';
import { goldenSet } from './support/golden.js';
import { tempWorkspace } from './support/workspace.js';

const { ws, books, expect: golden } = goldenSet();
const entries = books.journalEntries;
const adjustments = books.config.vatAdjustments;

const quarterOf = (date: string) => `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}` as QuarterKey;
const QUARTERS = [...new Set(entries.map((e) => quarterOf(e.date)))].sort();
const FILED = QUARTERS.filter((q) => q <= quarterOf(books.config.closedThrough));
const OPEN = QUARTERS.at(-1)!;
const YEAR = OPEN.slice(0, 4);
const REPORT_KEYS = [...QUARTERS, `${YEAR}-H1`, YEAR];
const filedXml = (q: QuarterKey) => readFileSync(join(ws.paths.filings, q.slice(0, 4), `mwst-ech0217-${q}.xml`), 'utf8');

test('the frozen books span one year with a filed and an open quarter', () => {
  assert.ok(QUARTERS.every((q) => q.startsWith(YEAR)), `one year: ${QUARTERS.join(', ')}`);
  assert.ok(FILED.length > 0 && !FILED.includes(OPEN), `filed ${FILED.join(', ')}, open ${OPEN}`);
});

test('VAT report Ziffern per period', () => {
  for (const key of REPORT_KEYS) {
    const r = computeVatReport(entries, key, adjustments);
    golden(`report-${key}`, { ziffern: r.ziffern.map((z) => [z.number, z.amount]), toPay: r.toPay, credit: r.credit });
  }
});

test('VAT report lines per Ziffer (which entries feed which Ziffer)', () => {
  for (const key of QUARTERS) {
    const lines = computeVatReportLines(entries, key, adjustments);
    const compact = Object.fromEntries(Object.entries(lines).map(([z, ls]) => [z, ls.map((l) => [l.date, l.ref, l.code, l.gross, l.base, l.tax])]));
    golden(`lines-${key}`, compact);
  }
});

test('return figures (what vat-xml would file, and the 0535 «korrigiert» column)', () => {
  for (const q of QUARTERS) golden(`figures-${q}`, figuresFromBooks(entries, q, adjustments));
});

test('filed returns parse to their Ziffern', () => {
  for (const q of FILED) golden(`filed-${q}`, parseFiledReturn(filedXml(q)));
});

test('correction cases explain every franc of each Korrekturabrechnung', () => {
  for (const q of FILED) {
    const corrected = figuresFromBooks(entries, q, adjustments);
    const r = reconcileCases(books.config.correctionCases, entries, parseFiledReturn(filedXml(q)), corrected);
    assert.deepEqual(r.unexplained, [], `${q}: unexplained 0535 difference`);
    assert.deepEqual(r.orphans.map((e) => e.id), [], `${q}: correction entries in no case`);
    golden(`cases-${q}`, books.config.correctionCases.filter((c) => c.period === q).map((c) => [c.id, caseEffect(c, entries).contribution]));
  }
});

test('eCH-0217 XML for the open quarter (the file uploaded to the ESTV)', () => {
  const { paths } = tempWorkspace('belege-golden-', ws.paths.root);
  const dir = paths.root;
  try {
    symlinkSync(join(APP_ROOT, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(paths.books, JSON.stringify({ receipts: [], transactions: [], mappings: [], bankStatements: [], ...books }));
    execFileSync(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'src/cli/vat-ech0217.ts'), OPEN, join(dir, 'open.xml')], {
      cwd: dir, env: { ...process.env, BELEGE_WORKSPACE: dir }, stdio: 'pipe',
    });
    const xml = readFileSync(join(dir, 'open.xml'), 'utf8').replace(/<eCH-0217:generationTime>[^<]*</, '<eCH-0217:generationTime>X<');
    golden(`xml-${OPEN}`, { xml });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
