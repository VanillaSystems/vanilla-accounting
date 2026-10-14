/**
 * Characterization of the Wise statement PDF reference parser. The fixture is synthetic text in
 * the shape of `pdftotext -raw` output of a Wise monthly statement: card lines, fee lines, a
 * page-break line glued to a transaction id, and transfers whose last line carries the reference.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wiseReferences } from '../src/providers/wise-pdf/wise-statement-pdf.js';

test('transfer ids map to their payment reference; card lines carry none', () => {
  const raw = readFileSync(join(process.cwd(), 'tests/fixtures/wise-statement-eur.txt'), 'utf8');
  assert.deepEqual([...wiseReferences(raw)], [
    ['TRANSFER-8100000004', 'Shopify A1B2C3'],
    ['TRANSFER-8100000003', 'Shopify D4E5F6'],
    ['TRANSFER-8100000002', 'Invoice 1000000001 Ref.: 2000000001-1'],
    ['TRANSFER-8100000001', 'Shopify G7H8J9'],
  ]);
});

test('reference ends at the line break or the page end and is trimmed', () => {
  const raw = '1 July 2026 | Transaction: TRANSFER-1 |  Reference: abc  \nnext line\n';
  assert.deepEqual([...wiseReferences(raw)], [['TRANSFER-1', 'abc']]);
  const lastLine = '1 July 2026 | Transaction: TRANSFER-2 | Reference: Shopify A1B2C3\fref:0000 5/5';
  assert.deepEqual([...wiseReferences(lastLine)], [['TRANSFER-2', 'Shopify A1B2C3']]);
});
