/**
 * A workspace changes the shipped jurisdiction by overlaying only the keys it names
 * (docs/0.4.0/modules.md, "Three ways to customize"): a code added, a code removed, everything
 * else still the app's. A broken overlay is reported with its file and path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { loadJurisdiction, mergeOverlay } from '../src/core/modules/load.js';
import { returnEngine } from '../src/engines/return.js';
import { chartEngine } from '../src/engines/chart.js';

function workspaceWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'modules-overlay-'));
  mkdirSync(join(root, 'modules/ch'), { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(root, 'modules/ch', file), body);
  return root;
}

test('an overlay merges key by key: replace, add, and remove with ~', () => {
  assert.deepEqual(mergeOverlay({ a: 1, b: { c: 2, d: 3 }, e: [1] }, { b: { c: 9, d: null }, f: 4, e: [2] }), { a: 1, b: { c: 9 }, e: [2], f: 4 });
});

test('a workspace adds a code and removes one; every other code stays the app\'s', () => {
  const ws = workspaceWith({
    'module.yaml': 'overlays: ch\nbasedOn: 2026.4.0\n',
    'tax-codes.yaml': 'codes:\n  I26-P:\n    rate: 2.6\n    inputTax: "405"\n  V0-T: ~\n',
  });
  try {
    const loaded = loadJurisdiction(APP_ROOT, 'ch', ws);
    const codes = returnEngine(loaded.jurisdiction).codes;
    assert.deepEqual(loaded.problems, []);
    assert.deepEqual(loaded.overlaid.sort(), ['manifest', 'taxCodes']);
    assert.equal(codes.parse('I26-P')?.inputTaxZiffer, '405');
    assert.equal(codes.parse('V0-T'), null);
    assert.equal(codes.parse('V81')?.revenueZiffer, '303');
    assert.notEqual(loaded.hash, loadJurisdiction(APP_ROOT, 'ch').hash);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('files without the overlay manifest are ignored', () => {
  const ws = workspaceWith({ 'tax-codes.yaml': 'codes:\n  V81: ~\n' });
  try {
    assert.equal(returnEngine(loadJurisdiction(APP_ROOT, 'ch', ws).jurisdiction).codes.parse('V81')?.revenueZiffer, '303');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a broken overlay is reported with its file, path and reason', () => {
  const ws = workspaceWith({
    'module.yaml': 'overlays: ch\n',
    'return.yaml': 'derived:\n  "299":\n    label: Steuerbarer Umsatz\n    formula:\n      minus: ["200", "999"]\n  "289":\n    label: x\n    formula:\n      sum: ["289"]\n',
    'tax-codes.yaml': 'codes:\n  V99:\n    rate: 9.9\n    revenue: "304"\n',
    'chart.yaml': 'classes:\n  "9": result\n',
  });
  try {
    const messages = loadJurisdiction(APP_ROOT, 'ch', ws).problems.map((p) => `${p.file} ${p.path}: ${p.message}`);
    assert.ok(messages.includes('return.yaml derived.299.formula: Ziffer 999 does not exist'), messages.join('\n'));
    assert.ok(messages.some((m) => m.startsWith('return.yaml derived.289.formula: depends on itself')), messages.join('\n'));
    assert.ok(messages.includes('tax-codes.yaml codes.V99.revenue: Ziffer 304 is not a revenue Ziffer of return.yaml'), messages.join('\n'));
    assert.ok(messages.includes('chart.yaml classes.9: type "result" is not one of types'), messages.join('\n'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a workspace whose chart puts class 4 on the credit side changes that normal side only', () => {
  const ws = workspaceWith({ 'module.yaml': 'overlays: ch\n', 'chart.yaml': 'classes:\n  "4": revenue\n' });
  try {
    const chart = chartEngine(loadJurisdiction(APP_ROOT, 'ch', ws).jurisdiction.chart);
    assert.equal(chart.isDebitNormal('4200'), false);
    assert.equal(chart.isDebitNormal('6500'), true);
    assert.equal(chart.sideOf('1020'), 'assets');
    assert.equal(chart.sideOf('9200'), 'none');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('the base currency is the jurisdiction\'s unless the workspace overlay names its own', () => {
  assert.equal(loadJurisdiction(APP_ROOT, 'ch').jurisdiction.manifest.baseCurrency, 'CHF');
  const ws = workspaceWith({ 'module.yaml': 'overlays: ch\nbaseCurrency: EUR\n' });
  try {
    assert.equal(loadJurisdiction(APP_ROOT, 'ch', ws).jurisdiction.manifest.baseCurrency, 'EUR');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('a jurisdiction the app does not ship is refused with the reason', () => {
  assert.throws(() => loadJurisdiction(APP_ROOT, 'xx'), /no module "xx"/);
});
