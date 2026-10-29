/**
 * A drop of a bank's camt.053 with the account's monthly PDFs (#273): the camt.053 of an IBAN no
 * account carries yet lands on the one account of the bank it names, says so in its row and keeps
 * the IBAN there; it asks only when the bank is unclear. The PDFs of that IBAN in the same drop are
 * the account's statements without a question, whichever file came first and however the camt.053
 * found its account. Invented bank, IBANs and movements throughout.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { testIban } from './support/iban.js';
import { inventedStatement } from './support/statement-pdf.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import type { BankStatement, StatementAsk } from '../src/types/index.js';
import type { DropRow } from '../src/types/drop.js';

const COIFFEUR = join(APP_ROOT, 'demo-coiffeur', APP_FOLDER);
const IBAN = testIban('80808000000000031');

const camt = (bank: string) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>M-273</MsgId><CreDtTm>2026-11-01T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>S-273</Id><FrToDt><FrDtTm>2017-01-01T00:00:00</FrDtTm><ToDtTm>2026-10-31T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${IBAN}</IBAN></Id><Ccy>CHF</Ccy><Ownr><Nm>Muster Coiffeur</Nm></Ownr><Svcr><FinInstnId><Nm>${bank}</Nm></FinInstnId></Svcr></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-01</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">1210.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-31</Dt></Dt></Bal>
<Ntry><Amt Ccy="CHF">250.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-10-03</Dt></BookgDt><AcctSvcrRef>R-273-1</AcctSvcrRef><NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Kundin Muster</Nm></Dbtr></RltdPties></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="CHF">40.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-05</Dt></BookgDt><AcctSvcrRef>R-273-2</AcctSvcrRef><NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Strom AG</Nm></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

const OCTOBER = 'Kontoauszug 01.10.2026 - 31.10.2026.pdf';
const octoberPdf = async () => (await inventedStatement({
  bank: 'Raiffeisenbank Beispiel', owner: 'Muster Coiffeur', iban: IBAN, currency: 'CHF', from: '2026-10-01', to: '2026-10-31', opening: 1000,
  movements: [{ date: '2026-10-03', amount: 250, counterparty: 'Kundin Muster', text: 'Gutschrift' }, { date: '2026-10-05', amount: -40, counterparty: 'Strom AG', text: 'Zahlung' }],
})).pdf;

/** The coiffeur's books with a second CHF account without IBAN: a camt.053 of an IBAN no account has could be of either. */
async function twoChfAccounts(): Promise<ApiServer> {
  const api = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: COIFFEUR });
  const added = await api.send('PATCH', '/api/workspace', { addBank: { bank: 'ZKB', currency: 'CHF', account: '1022', label: 'ZKB Geschäftskonto' } });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  return api;
}

const ibanOf = (api: ApiServer, account: string) => readFileSync(join(api.root, 'belege.workspace.yaml'), 'utf8').split('\n').find((l) => l.includes(`account: "${account}"`))?.match(/iban: (\w+)/)?.[1];
const books = async (api: ApiServer) => (await (await api.fetch('/books.json')).json()) as { bankStatements: BankStatement[]; statementAsks?: StatementAsk[] };
const pdfRow = (rows: DropRow[]) => rows.find((r) => r.name === OCTOBER)!;
const camtRow = (rows: DropRow[]) => rows.find((r) => r.name === 'oktober.xml')!;

test('a camt.053 of an IBAN no account has lands on the one account of the bank it names, says so, keeps the IBAN there; «ändern» takes it back and asks', async () => {
  const api = await twoChfAccounts();
  const { SESSION } = await import('./support/inbox-run.js');
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.xml`, Buffer.from(camt('Raiffeisenbank Beispiel')));
    let row = camtRow(s.rows);
    assert.deepEqual([row.state, row.chooseAccount, row.statement?.account, row.byBank?.proposed], ['taken', undefined, '1020', '1020'], 'no question: the bank names Raiffeisen');
    assert.equal(ibanOf(api, '1020'), IBAN, 'the IBAN is kept on the account');
    assert.equal(ibanOf(api, '1022'), undefined);
    await rest();

    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'otherAccount' });
    row = camtRow(s.rows);
    assert.deepEqual([row.state, row.chooseAccount?.proposed, row.chooseAccount?.accounts.map((a) => a.account), row.statement, row.byBank], ['asks', '1020', ['1020', '1022'], undefined, undefined], '«ändern» asks which account, as it would have');
    assert.equal(ibanOf(api, '1020'), undefined, 'the IBAN it kept goes with it');
    assert.equal((await books(api)).bankStatements.some((b) => b.filename === 'oktober.xml'), false, 'the statement left the books');
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'account', account: '1022' });
    assert.deepEqual([camtRow(s.rows).state, camtRow(s.rows).statement?.file], ['taken', 'ZKB/oktober.xml'], 'the person\'s account takes it');
    await rest();
  } finally {
    await api.stop();
  }
});

test('a camt.053 whose bank names no account of the books asks which; an IBAN an account carries never asks', async () => {
  const api = await twoChfAccounts();
  const { SESSION } = await import('./support/inbox-run.js');
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.xml`, Buffer.from(camt('Bank Beispiel AG')));
    assert.deepEqual([camtRow(s.rows).state, camtRow(s.rows).chooseAccount?.proposed, camtRow(s.rows).byBank], ['asks', undefined, undefined]);
    await rest();
    const kept = await api.send('PATCH', '/api/workspace', { banks: [{ bank: 'ZKB', currency: 'CHF', iban: IBAN.replace(/(.{4})/g, '$1 ').trim().toLowerCase() }] });
    assert.equal(kept.status, 200, JSON.stringify(kept.json));
    let again = await post('/api/drop');
    again = await post(`/api/drop/${again.id}/files?name=oktober.xml`, Buffer.from(camt('Bank Beispiel AG')));
    assert.deepEqual([camtRow(again.rows).state, camtRow(again.rows).statement?.file, camtRow(again.rows).byBank], ['taken', 'ZKB/oktober.xml', undefined], 'its IBAN, typed spaced and in lower case, places it');
    await rest();
  } finally {
    await api.stop();
  }
});

test('the account\'s PDF dropped before its camt.053 asks until the camt.053 is read in, then is its statement without a question', async () => {
  const api = await twoChfAccounts();
  const { SESSION } = await import('./support/inbox-run.js');
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=${encodeURIComponent(OCTOBER)}`, await octoberPdf());
    assert.equal(pdfRow(s.rows).state, 'asks', 'no account has its IBAN yet');
    s = await post(`/api/drop/${s.id}/files?name=oktober.xml`, Buffer.from(camt('Raiffeisenbank Beispiel')));
    assert.deepEqual([camtRow(s.rows).state, pdfRow(s.rows).state, pdfRow(s.rows).read, pdfRow(s.rows).statement?.file], ['taken', 'taken', undefined, `Raiffeisen/${OCTOBER}`], 'the PDF is the account\'s statement in the same answer');
    const b = await books(api);
    assert.deepEqual([b.statementAsks ?? [], b.bankStatements.filter((x) => x.bank === 'Raiffeisen').map((x) => x.filename).sort()], [[], [OCTOBER, 'oktober.xml']]);
    await rest();
  } finally {
    await api.stop();
  }
});

test('answering the camt.053\'s question closes the question of its account\'s PDF in the open dialog at once, though the IBAN is not kept', async () => {
  const api = await twoChfAccounts();
  const { SESSION } = await import('./support/inbox-run.js');
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=${encodeURIComponent(OCTOBER)}`, await octoberPdf());
    s = await post(`/api/drop/${s.id}/files?name=oktober.xml`, Buffer.from(camt('Bank Beispiel AG')));
    assert.deepEqual([pdfRow(s.rows).state, camtRow(s.rows).state], ['asks', 'asks']);
    s = await post(`/api/drop/${s.id}/rows/${camtRow(s.rows).key}`, { kind: 'account', account: '1020' });
    assert.equal(ibanOf(api, '1020'), undefined, 'the person did not keep the IBAN');
    assert.deepEqual([camtRow(s.rows).state, pdfRow(s.rows).state, pdfRow(s.rows).statement?.file], ['taken', 'taken', `Raiffeisen/${OCTOBER}`]);
    assert.deepEqual((await books(api)).statementAsks ?? [], []);
    await rest();
  } finally {
    await api.stop();
  }
});

test('a PDF dropped after its camt.053 in the same drop is kept at once', async () => {
  const api = await twoChfAccounts();
  const { SESSION } = await import('./support/inbox-run.js');
  try {
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.xml`, Buffer.from(camt('Raiffeisenbank Beispiel')));
    s = await post(`/api/drop/${s.id}/files?name=${encodeURIComponent(OCTOBER)}`, await octoberPdf());
    assert.deepEqual([pdfRow(s.rows).state, pdfRow(s.rows).read, pdfRow(s.rows).keep], ['taken', undefined, { month: '2026-10' }]);
    await rest();
  } finally {
    await api.stop();
  }
});
