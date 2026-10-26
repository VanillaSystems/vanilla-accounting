/**
 * Issue #186, part 3: Belege lists what was set aside as no receipt, each with its reason and who
 * decided: the app's rules, the model (with its own reason), or a person.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Index, Receipt } from '../src/types/index.js';
import { parsePeriod } from '../src/accounting/periods.js';
import { ledgerOf, visible } from '../src/app/areas/receipts/model.js';

const receipt = (id: string, x: Partial<Receipt>): Receipt => ({
  id, filename: `${id}.pdf`, originalFilename: `${id}.pdf`, extractedText: '', extractionMethod: 'pdftotext',
  fileSize: 4000, indexedAt: '2026-09-30T08:00:00Z', location: 'staged', date: '2026-09-10', ...x,
});

const books: Index = {
  config: {},
  receipts: [
    receipt('brochure', { kind: 'noise', kindBy: 'rule', kindRule: 'model:no-receipt', kindWhy: 'Verkaufsbroschüre eines Paketdienstes' }),
    receipt('terms', { kind: 'noise', kindBy: 'rule', kindRule: 'document:terms' }),
    receipt('flyer', { kind: 'noise', kindBy: 'human' }),
    receipt('invoice', { amount: 12 }),
  ],
  transactions: [], mappings: [], bankStatements: [],
} as unknown as Index;

test('each file set aside says who decided, and the model\'s reason is kept with it', () => {
  const l = ledgerOf(books, '2026-07-01');
  const hidden = visible(l, parsePeriod('2026-Q3', '2026-10-26')!, undefined, undefined).hidden;
  assert.deepEqual(hidden.map((v) => [v.r.id, v.noneBy]), [['brochure', 'model'], ['terms', 'rule'], ['flyer', 'person']]);
  assert.deepEqual(hidden.map((v) => v.noneWhy), ['no-receipt', 'terms', 'no-receipt']);
  assert.equal(hidden[0].r.kindWhy, 'Verkaufsbroschüre eines Paketdienstes');
});

test('a search finds a file among what was set aside by the model\'s reason', () => {
  const l = ledgerOf(books, '2026-07-01');
  const hidden = visible(l, parsePeriod('2026-Q3', '2026-10-26')!, undefined, 'paketdienst').hidden;
  assert.deepEqual(hidden.map((v) => v.r.id), ['brochure']);
});
