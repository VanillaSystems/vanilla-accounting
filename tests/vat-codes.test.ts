/**
 * The VAT-code catalogue (src/accounting/vat-codes.ts) cannot drift from the engine: the Ziffern
 * it shows for a code are the ones computeVatReport moves for an entry with that code, every code
 * the engine or the books use has an entry, and its derived files are current.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { computeVatReport, NAMED_VAT_CODES, parseVatCode } from '../src/accounting/vat-report.js';
import { lookupVatCode, VAT_CODE_FAMILIES, VAT_CODE_KINDS, VAT_CODES } from '../src/accounting/vat-codes.js';
import { BANANA_VAT_CODES } from '../src/accounting/vat-codes.source.js';
import { loadCases } from '../src/knowledge/cases.js';
import { loadBooks } from '../src/books/store.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOTS } from './support/workspace.js';
import { DOCS_FILE, SOURCE_FILE, renderDocs, renderSource } from '../tools/vat-codes/generate.js';
import de from '../src/app/i18n/locales/de.js';
import type { JournalEntry } from '../src/types/index.js';

/** Totals the return derives from the source Ziffern: they move with any figure. */
const DERIVED = new Set(['289', '299', '399', '479', '500', '510']);

/** The Ziffern an entry of `code` moves in its quarter's return, with the sign of each figure. */
function moved(code: string): Array<[string, number]> {
  const entry: JournalEntry = { id: 'e1', transactionRef: 't1', date: '2026-08-20', accountDebit: '1020', accountCredit: '3400', amount: 1081, vatCode: code };
  return computeVatReport([entry], '2026-Q3', []).ziffern
    .filter((z) => z.amount !== 0 && !DERIVED.has(z.number))
    .map((z) => [z.number, Math.sign(z.amount)]);
}

test('the Ziffern of every catalogue entry are what computeVatReport books for an entry with its code', () => {
  for (const c of VAT_CODES) {
    const expected = c.ziffern?.map((z) => z.ziffer) ?? [];
    assert.deepEqual(moved(c.code), expected.map((z) => [z, 1]), c.code);
    assert.deepEqual(moved(`-${c.code}`), expected.map((z) => [z, -1]), `-${c.code}`);
  }
});

test('a code is "not declared" exactly when the engine does not parse it', () => {
  for (const c of VAT_CODES) assert.equal(c.ziffern === null, parseVatCode(c.code) === null, c.code);
  const undeclared = VAT_CODES.filter((c) => c.ziffern === null).map((c) => c.code);
  assert.ok(undeclared.includes('VS81') && undeclared.includes('Z0') && undeclared.includes('V81-B'), undeclared.join(' '));
});

test('every code the engine knows by name, and every K code of a Swiss rate, has a catalogue entry', () => {
  const k = ['77', '81'].flatMap((r) => ['A', 'B', 'C'].map((x) => `K${r}-${x}`));
  const codes = new Set(VAT_CODES.map((c) => c.code));
  for (const code of [...NAMED_VAT_CODES, ...k]) assert.ok(codes.has(code), code);
  for (const b of BANANA_VAT_CODES) assert.ok(codes.has(b.code), `Banana's ${b.code}`);
});

test('every code the demo books and the casebook use is explained, minus codes by their plain code', () => {
  const used = new Set<string>();
  for (const root of DEMO_ROOTS) for (const e of loadBooks(workspaceAt(root)).journalEntries ?? []) if (e.vatCode) used.add(e.vatCode);
  for (const c of loadCases()) for (const l of c.lines) if (l.vatCode) used.add(l.vatCode);
  assert.ok(used.has('V81') && used.has('-I81'), [...used].join(' '));
  for (const code of used) {
    const found = lookupVatCode(code);
    assert.ok(found, code);
    assert.equal(found.negative, code.startsWith('-'), code);
    assert.equal(found.entry.code, code.replace(/^-/, ''), code);
  }
  assert.equal(lookupVatCode('X99'), null);
});

test('Banana and the engine agree on rate and amount type; the engine declares at least Banana\'s Ziffern', () => {
  for (const b of BANANA_VAT_CODES) {
    const info = parseVatCode(b.code);
    if (!info) continue;
    if (b.rate !== undefined) assert.equal(info.rate, b.rate, b.code);
    assert.equal(info.amountIs, b.amountType === '2' ? 'tax' : b.amountType === '1' ? 'net' : 'gross', b.code);
    const engine = VAT_CODES.find((c) => c.code === b.code)!.ziffern!.map((z) => z.ziffer);
    for (const z of b.ziffern) assert.ok(engine.includes(z), `${b.code}: Banana declares ${z}, the engine ${engine.join(', ')}`);
  }
  // The one place the engine goes beyond Banana: Bezugsteuer is deducted again as input tax.
  assert.deepEqual(VAT_CODES.find((c) => c.code === 'B81-1')!.ziffern, [{ ziffer: '383', figure: 'tax' }, { ziffer: '405', figure: 'tax' }]);
  assert.deepEqual(VAT_CODES.find((c) => c.code === 'V81')!.ziffern, [{ ziffer: '200', figure: 'turnover' }, { ziffer: '303', figure: 'taxable' }]);
});

test('every kind has its texts, every family its name, and every rule id exists in the guides', () => {
  const messages = de.messages as Record<string, unknown>;
  for (const k of VAT_CODE_KINDS) for (const part of ['name', 'when', 'notWhen']) assert.ok(messages[`vatCodes.kind.${k.kind}.${part}`], `${k.kind}.${part}`);
  for (const f of VAT_CODE_FAMILIES) assert.ok(messages[`vatCodes.family.${f}`], f);
  const ruleIds = new Set(readdirSync(join(APP_ROOT, 'processes')).filter((f) => f.endsWith('.guide.yaml'))
    .flatMap((f) => Object.values((parse(readFileSync(join(APP_ROOT, 'processes', f), 'utf8')) as { steps?: Record<string, { gates?: { id: string }[]; rules?: { id: string }[] }> }).steps ?? {}))
    .flatMap((s) => [...(s.gates ?? []), ...(s.rules ?? [])].map((r) => r.id)));
  for (const k of VAT_CODE_KINDS) for (const r of k.rules) assert.ok(ruleIds.has(r), `${k.kind}: rule ${r}`);
});

test('vat-codes.source.ts and docs/vat-codes.md are what `npm run vat-codes` writes', async () => {
  assert.equal(readFileSync(SOURCE_FILE, 'utf8'), renderSource(), 'run npm run vat-codes');
  assert.equal(readFileSync(DOCS_FILE, 'utf8'), await renderDocs(), 'run npm run vat-codes');
});
