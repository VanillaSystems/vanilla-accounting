/**
 * Characterization of the camt053 parser. Every bank transaction and ref in the books comes
 * from here. The fixtures under tests/fixtures/camt053/ are synthetic statements in the shape
 * Raiffeisen and Wise export (batch with child TxDtls, QR references, Wise DtTm and fee lines);
 * tests/bank-statements.test.ts reads the UBS, PostFinance and cantonal bank shapes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BankTransaction } from '../src/types/index.js';
import { assignUniqueRefs, readCamt, transactionsOf } from '../src/providers/camt053/camt053.js';
import type { StatementKind } from '../src/workspace/banks.js';
import { buildBatchClassifyPrompt } from '../src/llm/prompts.js';

const RAIFFEISEN = 'uuid_camt053_001_08_raiffeisen.xml';
const WISE_USD = 'uuid_statement_wise_USD.xml';
const read = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/camt053', name), 'utf8');
const parse = (xml: string, bank = 'Raiffeisen', statements: StatementKind = 'camt053'): BankTransaction[] =>
  readCamt(xml).statements.flatMap((s) => transactionsOf(s, { bank, statements }));
const parseFile = (name: string): BankTransaction[] => (name.includes('wise') ? parse(read(name), 'Wise', 'wise') : parse(read(name)));

function ntry(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt>
<Acct><Svcr><FinInstnId><Nm>Raiffeisen Schweiz</Nm></FinInstnId></Svcr></Acct>
${inner}
</Stmt></BkToCstmrStmt></Document>`;
}

test('Sammelzahlung with child TxDtls stays one transaction carrying its parts', () => {
  const txs = parseFile(RAIFFEISEN);
  assert.equal(txs.length, 3, 'one transaction per Ntry, children not split out');
  const batch = txs.find((t) => t.ref === '90000000003');
  assert.deepEqual(batch, {
    ref: '90000000003',
    bank: 'Raiffeisen',
    date: '2026-01-30',
    amount: 480.5,
    currency: 'CHF',
    direction: 'DBIT',
    description: 'Sammelzahlung',
    parts: [
      { amount: 150.4, currency: 'CHF', counterparty: 'Beispiel Versicherung AG', reference: '100000000000000000000000011' },
      { amount: 310.25, currency: 'CHF', counterparty: 'Beispiel Versicherung AG', reference: '100000000000000000000000022' },
      { amount: 19.85, currency: 'CHF', counterparty: 'Beispiel Telefon AG', reference: '100000000000000000000000033' },
    ],
  });
  const partsTotal = batch!.parts!.reduce((s, p) => s + p.amount, 0);
  assert.equal(Math.round(partsTotal * 100), Math.round(batch!.amount * 100), 'parts add up to the booked amount');
});

test('a single TxDtls lends its remittance text and QR reference to the entry', () => {
  const txs = parseFile(RAIFFEISEN);
  assert.deepEqual(txs.find((t) => t.ref === '90000000002'), {
    ref: '90000000002',
    bank: 'Raiffeisen',
    date: '2026-01-22',
    amount: 335,
    currency: 'CHF',
    direction: 'DBIT',
    description: 'Zahlung Beispiel Medien AG',
    reference: '210000000003139471430009017',
  });
  assert.deepEqual(txs.find((t) => t.ref === '90000000001')?.direction, 'CRDT');
});

test('Wise entries: AcctSvcrRef, DtTm date, native currency, fee type', () => {
  const txs = parseFile(WISE_USD);
  assert.equal(txs.length, 6);
  assert.deepEqual(txs.slice(0, 2), [
    { ref: 'WUSD000001', bank: 'Wise', date: '2026-01-07', amount: 9.5, currency: 'USD', direction: 'DBIT',
      description: 'Card transaction of 7.60 CHF issued by Example Hosting INTERNET (fee: 0.02 USD)' },
    { ref: 'WUSD000002', bank: 'Wise', date: '2026-01-07', amount: 0.02, currency: 'USD', direction: 'DBIT',
      description: 'Wise Charges for: CARD-7200000001', type: 'wise-fee' },
  ]);
  assert.equal(txs.filter((t) => t.type === 'wise-fee').length, 2);
});

test('only a camt.053 holds statements; a notification or report is recognised, not read', () => {
  assert.equal(readCamt(read(WISE_USD)).statements.length, 1);
  assert.deepEqual(readCamt('<Document><BkToCstmrDbtCdtNtfctn><Ntfctn/></BkToCstmrDbtCdtNtfctn></Document>'), { message: 'camt.054', statements: [] });
  assert.deepEqual(readCamt('<Document><BkToCstmrAcctRpt><Rpt/></BkToCstmrAcctRpt></Document>'), { message: 'camt.052', statements: [] });
  assert.deepEqual(readCamt('<Document/>'), { message: 'other', statements: [] });
});

test('synthetic entry: a Wise ref falls back to BkTxCd, any other bank numbers the entry; long digits stay strings', () => {
  const xml = `<?xml version="1.0"?><Document><BkToCstmrStmt><Stmt><Id>S-1</Id>
<Ntry><Amt Ccy="EUR">12.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-07-03</Dt></BookgDt>
<BkTxCd><Prtry><Cd>WEUR000001</Cd></Prtry></BkTxCd><AddtlNtryInf>Entry text</AddtlNtryInf>
<NtryDtls><TxDtls><AddtlTxInf>Detail text</AddtlTxInf><RmtInf><Strd><CdtrRefInf><Ref>210000000003139471430009017</Ref></CdtrRefInf></Strd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
  assert.deepEqual(parse(xml, 'Wise', 'wise'), [{
    ref: 'WEUR000001', bank: 'Wise', date: '2026-07-03', amount: 12.5, currency: 'EUR', direction: 'CRDT',
    description: 'Detail text', reference: '210000000003139471430009017',
  }]);
  assert.equal(parse(xml, 'UBS')[0].ref, 'S-1#1', 'a transaction code is no id: the entry is numbered in its statement');
});

test('a fee line is tagged on a wise account only', () => {
  const xml = read(WISE_USD);
  assert.equal(parse(xml, 'Wise', 'wise').filter((t) => t.type === 'wise-fee').length, 2);
  assert.equal(parse(xml, 'Other', 'camt053').filter((t) => t.type === 'wise-fee').length, 0);
});

test('synthetic batch: debit parts name the creditor, credit parts the debtor', () => {
  const detail = (amt: string, who: string, side: 'Cdtr' | 'Dbtr') =>
    `<TxDtls><Amt Ccy="CHF">${amt}</Amt><RltdPties><${side}><Pty><Nm>${who}</Nm></Pty></${side}></RltdPties><RmtInf><Ustrd>inv ${amt}</Ustrd></RmtInf></TxDtls>`;
  const entry = (dir: 'DBIT' | 'CRDT', side: 'Cdtr' | 'Dbtr') =>
    `<Ntry><AcctSvcrRef>R-${dir}</AcctSvcrRef><Amt Ccy="CHF">30.00</Amt><CdtDbtInd>${dir}</CdtDbtInd><BookgDt><Dt>2026-07-10</Dt></BookgDt>
<AddtlNtryInf>Batch</AddtlNtryInf><NtryDtls>${detail('10.00', 'Alpha AG', side)}${detail('20.00', 'Beta GmbH', side)}</NtryDtls></Ntry>`;
  const [debit, credit] = parse(ntry(entry('DBIT', 'Cdtr') + entry('CRDT', 'Dbtr')));
  const expectedParts = [
    { amount: 10, currency: 'CHF', counterparty: 'Alpha AG', reference: 'inv 10.00' },
    { amount: 20, currency: 'CHF', counterparty: 'Beta GmbH', reference: 'inv 20.00' },
  ];
  assert.deepEqual(debit, { ref: 'R-DBIT', bank: 'Raiffeisen', date: '2026-07-10', amount: 30, currency: 'CHF', direction: 'DBIT', description: 'Batch', parts: expectedParts });
  assert.deepEqual(credit.parts, expectedParts);
  assert.equal(credit.reference, undefined, 'a batch has no single reference');
});

function tx(ref: string, date: string, direction: 'CRDT' | 'DBIT', amount: number, currency = 'CHF'): BankTransaction {
  return { ref, bank: 'Wise', date, amount, currency, direction, description: '' };
}

test('assignUniqueRefs: a charge and its refund on one card ref get distinct, stable legs', () => {
  const txs = [tx('CARD-1', '2026-07-01', 'DBIT', 59.6), tx('CARD-1', '2026-07-03', 'CRDT', 59.6), tx('CARD-2', '2026-07-01', 'DBIT', 5)];
  assert.deepEqual(assignUniqueRefs(txs).map((t) => t.ref), [
    'CARD-1~2026-07-01-DBIT-59.60CHF',
    'CARD-1~2026-07-03-CRDT-59.60CHF',
    'CARD-2',
  ]);
});

test('assignUniqueRefs: NOTPROVIDED payments in one currency are split apart', () => {
  const txs = [tx('NOTPROVIDED', '2026-07-01', 'DBIT', 10), tx('NOTPROVIDED', '2026-07-02', 'DBIT', 10)];
  assert.deepEqual(assignUniqueRefs(txs).map((t) => t.ref), [
    'NOTPROVIDED~2026-07-01-DBIT-10.00CHF',
    'NOTPROVIDED~2026-07-02-DBIT-10.00CHF',
  ]);
});

test('assignUniqueRefs: a Wise currency split keeps its shared ref; empty refs are left alone', () => {
  const txs = [tx('CARD-9', '2026-07-01', 'DBIT', 166.98, 'EUR'), tx('CARD-9', '2026-07-01', 'DBIT', 4.3), tx('', '2026-07-01', 'DBIT', 1), tx('', '2026-07-02', 'DBIT', 2)];
  assert.deepEqual(assignUniqueRefs(txs).map((t) => t.ref), ['CARD-9', 'CARD-9', '', '']);
});

test('assignUniqueRefs: mixed directions across currencies are still split', () => {
  const txs = [tx('CARD-7', '2026-07-01', 'DBIT', 20, 'EUR'), tx('CARD-7', '2026-07-05', 'CRDT', 18.5)];
  assert.deepEqual(assignUniqueRefs(txs).map((t) => t.ref), [
    'CARD-7~2026-07-01-DBIT-20.00EUR',
    'CARD-7~2026-07-05-CRDT-18.50CHF',
  ]);
});

test('a single payment keeps its counterparty beside the remittance text, which leaves the name out (finding quarter-close-10)', () => {
  const [credit, debit] = parse(ntry(`
<Ntry><Amt Ccy="CHF">4860.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-07-02</Dt></BookgDt>
  <NtryDtls><TxDtls><Refs><AcctSvcrRef>RB-1</AcctSvcrRef></Refs><RltdPties><Dbtr><Nm>Familie Keller</Nm></Dbtr></RltdPties>
  <RmtInf><Ustrd>Rechnung 2026-028 Malerarbeiten Wohnzimmer</Ustrd></RmtInf></TxDtls></NtryDtls><AddtlNtryInf>Gutschrift Familie Keller</AddtlNtryInf></Ntry>
<Ntry><Amt Ccy="CHF">89.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-08-15</Dt></BookgDt>
  <NtryDtls><TxDtls><Refs><AcctSvcrRef>RB-2</AcctSvcrRef></Refs><RltdPties><Cdtr><Nm>Swisscom (Schweiz) AG</Nm></Cdtr></RltdPties>
  <RmtInf><Ustrd>Rechnung August Natel</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`));
  assert.deepEqual([credit.description, credit.counterparty], ['Rechnung 2026-028 Malerarbeiten Wohnzimmer', 'Familie Keller']);
  assert.deepEqual([debit.description, debit.counterparty], ['Rechnung August Natel', 'Swisscom (Schweiz) AG']);
  const prompt = buildBatchClassifyPrompt([{ tx: credit, receipts: [] }], { companyName: 'Malerei', chartOfAccounts: '', historicEntries: '', vatCodes: '' });
  assert.match(prompt, /Bank description: Rechnung 2026-028 Malerarbeiten Wohnzimmer\n {2}Counterparty: Familie Keller/, 'the model is told who paid');
});

test('a single payment keeps the other party\'s IBAN: the debtor\'s on a credit, the creditor\'s on a debit', () => {
  const [credit, debit] = parse(ntry(`
<Ntry><Amt Ccy="CHF">500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-08-02</Dt></BookgDt>
  <NtryDtls><TxDtls><Refs><AcctSvcrRef>IB-1</AcctSvcrRef></Refs><RltdPties><Dbtr><Nm>Beispiel Kunde AG</Nm></Dbtr><DbtrAcct><Id><IBAN>LI00 0881 0000 2324 013A A</IBAN></Id></DbtrAcct></RltdPties>
  <RmtInf><Ustrd>Beratung</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="CHF">89.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-08-15</Dt></BookgDt>
  <NtryDtls><TxDtls><Refs><AcctSvcrRef>IB-2</AcctSvcrRef></Refs><RltdPties><Cdtr><Nm>Beispiel Telefon AG</Nm></Cdtr><CdtrAcct><Id><IBAN>CH0000762011623852957</IBAN></Id></CdtrAcct></RltdPties>
  <RmtInf><Ustrd>Natel</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`));
  assert.equal(credit.counterpartyIban, 'LI00088100002324013AA');
  assert.equal(debit.counterpartyIban, 'CH0000762011623852957');
});
