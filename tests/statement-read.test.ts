/**
 * Statements without camt.053 (#217): the balance check (it adds up, a misread digit fails on its
 * page, a carry-over that does not match), the model's answer and the person's table parsed into one
 * shape, the camt.053 written from it read back exactly as a bank's export, the dedupe against a
 * bank export's movements in either order, and a bank CSV read by its columns. Invented statements only.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStatement, parseReadStatement } from '../src/books/statement-check.js';
import { parseStatementRead } from '../src/llm/prompts.js';
import { toStatementXml } from '../src/providers/statement-read/camt-writer.js';
import { readCamt, transactionsOf } from '../src/providers/camt053/camt053.js';
import { alignReads, heldLines, transactionsOfFiles, refsByFile } from '../src/books/bank-import.js';
import { csvStatement, csvTable, dayOf, guessColumns, MAX_CSV_ROWS } from '../src/providers/statement-read/csv.js';
import { camtDetails } from '../src/providers/camt053/details.js';
import type { StatementFile } from '../src/workspace/bank-statements.js';
import type { ReadStatement } from '../src/types/statement-read.js';
import { DEMO_OCTOBER, inventedStatement } from './support/statement-pdf.js';

const account = { account: '1021', bank: 'Musterbank', currency: 'CHF', label: 'Musterbank', statements: 'camt053' as const, role: 'bank' as const };

test('the check: opening and movements make the closing balance, each page its carry-over; a misread digit fails on its page, to the cent', async () => {
  const { truth } = await inventedStatement(DEMO_OCTOBER);
  assert.equal(truth.pages?.length, 2);
  assert.deepEqual(checkStatement(truth), { ok: true, gaps: [] });
  // 1'204.00 read as 1'240.00 on page 1: the page and the whole statement are 36.00 off.
  const misread = { ...truth, movements: truth.movements.map((m, i) => (i === 0 ? { ...m, amount: -1240 } : m)) };
  assert.deepEqual(checkStatement(misread).gaps, [
    { where: 'page', page: 1, expected: truth.pages![0].carriedOut, found: truth.pages![0].carriedOut! - 36, gap: 36 },
    { where: 'total', expected: truth.closing.amount, found: truth.closing.amount - 36, gap: 36 },
  ]);
  // A carry-over misread: page 2 brings in what page 1 did not carry out.
  const carried = { ...truth, pages: truth.pages!.map((p) => (p.page === 2 ? { ...p, carriedIn: p.carriedIn! + 0.1, carriedOut: p.carriedOut! + 0.1 } : p)) };
  assert.deepEqual(checkStatement(carried).gaps.map((g) => [g.where, g.page, g.gap]), [['carry', 2, 0.1]]);
  assert.equal(checkStatement({ ...truth, closing: { ...truth.closing, amount: truth.closing.amount + 0.01 } }).gaps[0].gap, 0.01, 'one cent is a gap');
});

test('the model\'s answer and the person\'s table: amounts as printed, wholly empty lines dropped, a line without its day or amount refused, «not a statement» said', () => {
  const answer = '```json\n' + JSON.stringify({
    iban: 'CH65 8080 8000 0000 0000 1', currency: 'chf', opening: { date: '2026-10-01', amount: "88'252.44" }, closing: { date: '2026-10-31', amount: '89 000,00' },
    movements: [{ date: '2026-10-02', amount: '-1\'204.00', text: 'Zahlung', page: 1 }, { date: '', amount: '', text: '' }, { date: '2026-10-05', amount: '1204.00-' }],
  }) + '\n```';
  const s = parseStatementRead(answer) as ReadStatement;
  assert.deepEqual([s.iban, s.currency, s.opening.amount, s.closing.amount], ['CH6580808000000000001', 'CHF', 88252.44, 89000]);
  assert.deepEqual(s.movements.map((m) => m.amount), [-1204, -1204]);
  assert.equal(parseStatementRead('{"notStatement": true}'), 'notStatement');
  assert.equal(parseStatementRead('kein JSON'), undefined);
  assert.equal(parseReadStatement({ currency: 'CHF', opening: { date: '2026-10-01', amount: 0 }, closing: { date: '2026-10-31', amount: 0 }, movements: [{ date: '2026-10-02', text: 'ohne Betrag' }] }), undefined, 'a misread line is never dropped silently');
  assert.equal(parseReadStatement({ currency: 'CHF', opening: { date: '2026-02-30', amount: 0 }, closing: { date: '2026-10-31', amount: 0 }, movements: [] }), undefined, 'no such day');
});

test('the camt.053 written from a read statement is read back as a bank\'s export: account, balances, period, each movement\'s fields; refs stable per statement', async () => {
  const { truth } = await inventedStatement(DEMO_OCTOBER);
  const xml = toStatementXml(truth, { id: 'read-abc', source: 'okt.pdf', by: 'model', at: '2026-11-01T08:00:00' });
  const { message, statements: [st] } = readCamt(xml);
  assert.equal(message, 'camt.053');
  assert.deepEqual([st.id, st.iban, st.currency, st.bankName, st.ownerName, st.period, st.read], ['read-abc', truth.iban, 'CHF', truth.bankName, truth.owner, truth.period, { from: 'okt.pdf', by: 'model' }]);
  const txs = transactionsOf(st, account);
  // A bank's export of the first movement, as the banks write it: the same transaction, field for field, but its ref.
  const bank = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>S1</Id><Acct><Id><IBAN>${truth.iban}</IBAN></Id><Ccy>CHF</Ccy></Acct>
    <Ntry><Amt Ccy="CHF">1204.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-02</Dt></BookgDt><ValDt><Dt>2026-10-02</Dt></ValDt><AcctSvcrRef>B-1</AcctSvcrRef>
    <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Gruenkaffee Muster AG</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Zahlung Rechnung 2026-1187</Ustrd><Strd><CdtrRefInf><Ref>210000000003139471430009017</Ref></CdtrRefInf></Strd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`;
  const [fromBank] = transactionsOf(readCamt(bank).statements[0], account);
  assert.deepEqual({ ...txs[0], ref: 'B-1' }, fromBank);
  assert.deepEqual(txs.map((t) => t.ref), truth.movements.map((_, i) => `read-abc#${i + 1}`));
  assert.deepEqual(txs.map((t) => (t.direction === 'DBIT' ? -t.amount : t.amount)), truth.movements.map((m) => m.amount));
  assert.equal(txs.at(-1)!.description, 'Kontoführungsgebühr');
  // Its balances and days, as the details of a bank's export show them.
  const d = camtDetails(xml, 'okt.xml', 3)!;
  assert.deepEqual([d.read, d.opening, d.closing, d.movements], [{ from: 'okt.pdf', by: 'model' }, truth.opening, truth.closing, truth.movements.length]);
  // A line the books hold carries the ref they hold, so the bank's export and this one are one payment.
  assert.equal(transactionsOf(readCamt(toStatementXml(truth, { id: 'read-abc', source: 'okt.pdf', by: 'model', refs: new Map([[0, 'B-1']]) })).statements[0], account)[0].ref, 'B-1');
});

const fileOf = (file: string, xml: string): Extract<StatementFile, { status: 'read' }> => {
  const [statement] = readCamt(xml).statements;
  return { status: 'read', file, statement, account, by: 'iban' };
};

test('dedupe: a read statement\'s movements a bank export holds are one payment, in either order; the export\'s fields win, a reference only the read names fills its gap', async () => {
  const { truth } = await inventedStatement(DEMO_OCTOBER);
  const bankXml = toStatementXml({ ...truth, movements: truth.movements.slice(0, 3).map(({ reference: _, text: __, ...m }) => m) }, { id: 'S-bank', source: 'x', by: 'model' })
    .replace(/<AddtlStmtInf>.*<\/AddtlStmtInf>/, '').replace(/read-x|S-bank#/g, 'BANK-');
  const bank = fileOf('Musterbank/bank.xml', bankXml);
  assert.equal(bank.statement.read, undefined, 'a bank export carries no read mark');
  // Read first (its refs are in the books), the bank's export later: one payment each, under the read's ref.
  const read = fileOf('Musterbank/okt.xml', toStatementXml(truth, { id: 'read-1', source: 'okt.pdf', by: 'model' }));
  const both = transactionsOfFiles([bank, read]);
  assert.equal(both.length, truth.movements.length, 'nothing doubled');
  assert.deepEqual(both.slice(0, 3).map((t) => t.ref), ['read-1#1', 'read-1#2', 'read-1#3']);
  assert.equal(both[0].reference, '210000000003139471430009017', 'the read\'s reference fills the export\'s gap');
  assert.deepEqual(transactionsOfFiles([read, bank]).map((t) => t.ref), both.map((t) => t.ref), 'whatever the files\' order');
  const refs = refsByFile([bank, read]);
  assert.deepEqual(refs.get('Musterbank/bank.xml'), ['read-1#1', 'read-1#2', 'read-1#3'], 'the export lists the payments it holds by the books\' refs');
  // The export first: the read's lines it holds are found (heldLines) and written with the export's refs.
  const held = heldLines(truth.movements, transactionsOfFiles([bank]), account);
  assert.deepEqual([...held.keys()], [0, 1, 2]);
  const later = fileOf('Musterbank/okt.xml', toStatementXml(truth, { id: 'read-2', source: 'okt.pdf', by: 'model', refs: new Map([...held].map(([i, t]) => [i, t.ref])) }));
  const merged = transactionsOfFiles([bank, later]);
  assert.equal(merged.length, truth.movements.length);
  assert.deepEqual(merged.slice(0, 3).map((t) => t.ref), transactionsOfFiles([bank]).map((t) => t.ref), 'the export\'s refs stay');
});

test('a bank CSV: header found below the bank\'s preamble, columns guessed from its words, debit and credit, newest first turned round, opening and closing from the balance column', () => {
  const csv = [
    'Konto;CH65 8080 8000 0000 0000 1', 'Zeitraum;01.10.2026 - 31.10.2026', '',
    'Buchungsdatum;Valuta;Buchungstext;Belastung;Gutschrift;Saldo',
    '20.10.2026;20.10.2026;"Gutschrift Bistro Exempel; RE-2026-044";;1\'950.00;90\'842.04',
    '05.10.2026;05.10.2026;Gutschrift Café Beispiel;;2\'380.50;88\'892.04',
    '02.10.2026;02.10.2026;Zahlung Gruenkaffee Muster AG;1\'204.00;;86\'511.54',
    'Total;;;1\'204.00;4\'330.50;',
  ].join('\r\n');
  const table = csvTable(Buffer.from(csv, 'latin1'))!;
  assert.deepEqual(table.header, ['Buchungsdatum', 'Valuta', 'Buchungstext', 'Belastung', 'Gutschrift', 'Saldo']);
  const columns = guessColumns(table.header)!;
  assert.deepEqual(columns, { valueDate: 1, date: 0, debit: 3, credit: 4, balance: 5, text: 2 });
  const s = csvStatement(table, columns, { currency: 'CHF', iban: 'CH6580808000000000001' }) as ReadStatement;
  assert.deepEqual(s.movements.map((m) => [m.date, m.amount]), [['2026-10-02', -1204], ['2026-10-05', 2380.5], ['2026-10-20', 1950]]);
  assert.equal(s.movements[2].text, 'Gutschrift Bistro Exempel; RE-2026-044', 'a quoted separator stays in its cell');
  assert.deepEqual([s.opening, s.closing], [{ date: '2026-10-02', amount: 87715.54 }, { date: '2026-10-20', amount: 90842.04 }]);
  assert.ok(checkStatement(s).ok);
  assert.deepEqual(csvStatement({ header: table.header, rows: [['02.10.2026', '', 'x', '', '', '']] }, columns, { currency: 'CHF' }), { kind: 'amount', row: 1 });
  const many = { header: table.header, rows: Array.from({ length: MAX_CSV_ROWS + 1 }, () => table.rows[0]) };
  assert.deepEqual(csvStatement(many, columns, { currency: 'CHF' }), { kind: 'tooMany', rows: MAX_CSV_ROWS + 1, limit: MAX_CSV_ROWS }, 'the limit names itself');
  assert.deepEqual([dayOf('31.12.26'), dayOf('2026-02-30'), dayOf('Total')], ['2026-12-31', undefined, undefined]);
});

test('a card charge in another currency: the read keeps the amount as printed, the written camt.053 carries it as InstdAmt, read back as the payment\'s original amount; none in the account\'s own currency', async () => {
  const { truth } = await inventedStatement(DEMO_OCTOBER);
  const card = { date: '2026-10-09', amount: -86.4, counterparty: 'Cloud Beispiel Inc.', text: 'Karte 1234 USD 98.50', original: { amount: '-98.50', currency: 'usd' } };
  const parsed = parseReadStatement({ ...truth, movements: [card, { date: '2026-10-10', amount: -5, original: { amount: 5, currency: 'CHF' } }] })!;
  assert.deepEqual(parsed.movements.map((m) => m.original), [{ amount: 98.5, currency: 'USD' }, undefined], 'positive, upper case; the account\'s own currency is no original');
  const [tx] = transactionsOf(readCamt(toStatementXml(parsed, { id: 'read-fx', source: 'okt.pdf', by: 'model' })).statements[0], account);
  assert.deepEqual([tx.amount, tx.currency, tx.original], [86.4, 'CHF', { amount: 98.5, currency: 'USD' }]);
});

test('a structured source\'s days (#254): those of a statement on the same account, in part or whole, are covered and clipped to it; a CSV only when asked; a PDF names its account and days by its text or name', async () => {
  const { coveredDays, coversAll, isCovered, placeByText, readDays } = await import('../src/intake/statement-read.js');
  const spans = [{ account: '1021', from: '2026-07-01', to: '2026-09-30', file: 'Raiffeisen/q3.xml' }, { account: '1021', from: '2026-10-01', to: '2026-10-10', file: 'Raiffeisen/okt.xml', csv: true as const }];
  const part = coveredDays(spans, '1021', '2026-09-21', '2026-10-15');
  assert.deepEqual(part, [{ file: 'Raiffeisen/q3.xml', from: '2026-09-21', to: '2026-09-30' }, { file: 'Raiffeisen/okt.xml', from: '2026-10-01', to: '2026-10-10' }], 'in part, clipped');
  assert.equal(coversAll(part, '2026-09-21', '2026-10-15'), false, '11 to 15 October are no source\'s');
  assert.equal(coversAll(part, '2026-09-21', '2026-10-10'), true, 'end to end');
  assert.deepEqual([isCovered(part, '2026-10-10'), isCovered(part, '2026-10-11')], [true, false]);
  assert.deepEqual(coveredDays(spans, '1021', '2026-10-01', '2026-10-31', { csv: false }), [], 'a CSV read beside a CSV is not covered');
  assert.deepEqual(coveredDays(spans, '1022', '2026-09-01', '2026-09-30'), []);
  const { parseIban } = await import('../src/workspace/banks.js');
  const accounts = [{ ...account, bank: 'Raiffeisen', iban: parseIban('CH6580808000000000001')! }];
  const by = (text: string, name: string, list: Parameters<typeof placeByText>[2] = accounts) => { const p = placeByText(text, name, list); return [p.account?.account, p.period?.to]; };
  assert.deepEqual(by('Kontoauszug 21.09.2026 - 15.10.2026\nIBAN CH65 8080 8000 0000 0000 1', 'x.pdf'), ['1021', '2026-10-15']);
  assert.deepEqual(by('Kontoauszug 21.09.2026 - 15.10.2026', 'x.pdf'), [undefined, '2026-10-15'], 'no IBAN in the text: the read gives the account');
  assert.deepEqual(by('', 'Kontoauszug 01.09.2026 - 30.09.2026.pdf'), ['1021', '2026-09-30'], 'a monthly PDF of its bank\'s naming: placed as the upload places it');
  const wise = { ...account, account: '1023', bank: 'Wise', currency: 'EUR', statements: 'wise' as const };
  assert.deepEqual(by('', 'statement_1_EUR_2026-08-01_2026-08-31.pdf', [...accounts, wise]), ['1023', '2026-08-31']);
  const { truth } = await inventedStatement(DEMO_OCTOBER);
  assert.deepEqual(readDays(truth), { from: '2026-10-01', to: '2026-10-31' });
});

test('an empty hand table is blank: no movement and both balances 0.00; a month without movements is not', async () => {
  const { isBlank } = await import('../src/books/statement-check.js');
  const day = { date: '2026-10-28', amount: 0 };
  assert.equal(isBlank({ movements: [], opening: day, closing: day }), true);
  assert.equal(isBlank({ movements: [], opening: { ...day, amount: 120 }, closing: { ...day, amount: 120 } }), false);
});

test('the AI switched off while a statement is read: the hand table says «no AI», not that the read failed', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { readStatementPdf } = await import('../src/intake/statement-read.js');
  const { AiRefused } = await import('../src/llm/provider.js');
  const { pdf } = await inventedStatement(DEMO_OCTOBER);
  const path = join(mkdtempSync(join(tmpdir(), 'read-off-')), 'okt.pdf');
  writeFileSync(path, pdf);
  const off = await readStatementPdf(path, async () => { throw new AiRefused({ reason: 'off' }, 'aus'); });
  assert.deepEqual([off.by, off.why, off.statement.iban], ['hand', 'noAi', DEMO_OCTOBER.iban]);
  const failed = await readStatementPdf(path, async () => { throw new Error('timeout after 300 s\nstack'); });
  assert.deepEqual([failed.why, failed.error], ['failed', 'timeout after 300 s'], 'the provider\'s words say why (#254)');
  const unusable = await readStatementPdf(path, async () => 'no json here');
  assert.deepEqual([unusable.why, unusable.error], ['failed', undefined], 'an answer code cannot take: failed, no words of a provider');
  const none = await readStatementPdf(path, undefined, 'noProvider');
  assert.equal(none.why, 'noProvider', 'no provider answers here: said so, not «AI off»');
});

test('the first bank export after a read (#254): the same movement stays, one a few days off takes the bank\'s day, one the bank lacks leaves the read file and is named; nothing of a filed day changes', () => {
  const statement = (movements: ReadStatement['movements'], amount: number): ReadStatement => ({
    iban: 'CH6580808000000000001', currency: 'CHF', period: { from: '2026-03-01', to: '2026-04-30' },
    opening: { date: '2026-03-01', amount: 1000 }, closing: { date: '2026-04-30', amount }, movements,
  });
  const read = statement([
    { date: '2026-03-30', amount: -100, text: 'filed, read a day early' },
    { date: '2026-04-03', amount: -50, text: 'value date read' },
    { date: '2026-04-10', amount: -20, text: 'the bank has none' },
    { date: '2026-04-15', amount: 500, text: 'the same' },
  ], 1330);
  const bank = statement([
    { date: '2026-03-31', amount: -100, text: 'filed' },
    { date: '2026-04-02', amount: -50, text: 'booked' },
    { date: '2026-04-15', amount: 500, text: 'the same' },
  ], 1350);
  const readXml = toStatementXml(read, { id: 'read-r', source: 'r.pdf', by: 'model' });
  const bankXml = toStatementXml(bank, { id: 'BANK', source: 'b', by: 'model' }).replace(/<AddtlStmtInf>.*<\/AddtlStmtInf>\n/, '');
  const files = [fileOf('Musterbank/r.xml', readXml), fileOf('Musterbank/bank.xml', bankXml)];
  const { files: out, unmatched } = alignReads(files, 'Musterbank/bank.xml', (d) => d <= '2026-03-31', () => readXml);
  assert.deepEqual(unmatched.map((u) => [u.file, u.date, u.amount]), [['Musterbank/r.xml', '2026-04-10', 20]]);
  const after = transactionsOf(readCamt(out.get('Musterbank/r.xml')!).statements[0], account);
  assert.deepEqual(after.map((t) => [t.date, t.amount]), [['2026-03-30', 100], ['2026-04-02', 50], ['2026-04-15', 500]], 'the filed line as it was, the value date now the bank\'s, the lacking one gone');
  assert.deepEqual(transactionsOf(readCamt(out.get('Musterbank/r.xml')!).statements[0], account).map((t) => t.ref), ['read-r#1', 'read-r#2', 'read-r#4'], 'each keeps its ref');
  assert.equal(alignReads(files, 'Musterbank/r.xml', () => false, () => readXml).files.size, 0, 'a read file aligns nothing');
});
