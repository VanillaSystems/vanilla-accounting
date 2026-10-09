/**
 * Characterization of the camt053 balance parser behind `reconcile-balances`, on the synthetic
 * statements under tests/fixtures/camt053/ and the demo workspaces'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseStatementBalances } from '../src/parsers/statement-balances.js';
import { parseCamt053 } from '../src/parsers/camt053.js';
import { DEMO_ROOTS } from './support/workspace.js';

const FIXTURES = join(import.meta.dirname, 'fixtures/camt053');
const read = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

test('Raiffeisen: OPBD and CLBD from <Dt> dates', () => {
  const name = 'uuid_camt053_001_08_raiffeisen.xml';
  assert.deepEqual(parseStatementBalances(read(name), name), [
    { bank: 'Raiffeisen', iban: 'CH4180808000000000001', currency: 'CHF', type: 'OPBD', date: '2026-01-05', amount: 10000, sourceFile: name },
    { bank: 'Raiffeisen', iban: 'CH4180808000000000001', currency: 'CHF', type: 'CLBD', date: '2026-06-30', amount: 10434.5, sourceFile: name },
  ]);
});

test('Wise: a midnight DtTm is the close of the previous day', () => {
  const name = 'uuid_statement_wise_USD.xml';
  assert.deepEqual(parseStatementBalances(read(name), name), [
    { bank: 'Wise', iban: 'BE00967000000002', currency: 'USD', type: 'CLBD', date: '2026-03-31', amount: 0, sourceFile: name },
    { bank: 'Wise', iban: 'BE00967000000002', currency: 'USD', type: 'OPBD', date: '2025-12-31', amount: 10, sourceFile: name },
  ]);
});

test('every statement: opening balance plus parsed movements equals closing balance', () => {
  const dirs = [FIXTURES, ...DEMO_ROOTS.flatMap((root) => ['Raiffeisen', 'Wise'].map((bank) => join(root, 'bank-statements', bank)))];
  const files = dirs.flatMap((dir) => readdirSync(dir).filter((f) => f.startsWith('uuid_') && f.endsWith('.xml')).map((f) => join(dir, f)));
  assert.ok(files.length >= 14, `${files.length} statements`);
  for (const file of files) {
    const xml = readFileSync(file, 'utf8');
    const bals = parseStatementBalances(xml, file);
    const open = bals.find((b) => b.type === 'OPBD');
    const close = bals.find((b) => b.type === 'CLBD');
    assert.ok(open && close, `${file}: OPBD and CLBD present`);
    const cents = parseCamt053(xml).reduce((s, t) => s + Math.round(t.amount * 100) * (t.direction === 'CRDT' ? 1 : -1), 0);
    assert.equal(Math.round(open.amount * 100) + cents, Math.round(close.amount * 100), `${file}: OPBD + movements = CLBD`);
  }
});

test('synthetic: DBIT balance is negative, other balance types are ignored, bank from IBAN', () => {
  const bal = (code: string, amt: string, ind: string, dt: string) =>
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${amt}</Amt><CdtDbtInd>${ind}</CdtDbtInd><Dt>${dt}</Dt></Bal>`;
  const xml = `<Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>CH9980808000000000000</IBAN></Id><Ccy>EUR</Ccy></Acct>
${bal('OPBD', '12.00', 'DBIT', '<Dt>2026-07-01</Dt>')}${bal('ITBD', '99.00', 'CRDT', '<Dt>2026-07-15</Dt>')}${bal('CLBD', '5.50', 'CRDT', '<DtTm>2026-09-30T18:00:00</DtTm>')}
</Stmt></BkToCstmrStmt></Document>`;
  assert.deepEqual(parseStatementBalances(xml, 's.xml'), [
    { bank: 'Raiffeisen', iban: 'CH9980808000000000000', currency: 'EUR', type: 'OPBD', date: '2026-07-01', amount: -12, sourceFile: 's.xml' },
    { bank: 'Raiffeisen', iban: 'CH9980808000000000000', currency: 'EUR', type: 'CLBD', date: '2026-09-30', amount: 5.5, sourceFile: 's.xml' },
  ]);
  assert.deepEqual(parseStatementBalances('<Document/>', 'x.xml'), []);
});
