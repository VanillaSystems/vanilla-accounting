/**
 * A statement that cannot be read in is refused with a typed reason the UI says in the person's
 * language, never with the manifest file (r8k-3, r8c-4, r8k-10). A firm with one account in the
 * statement's currency and no IBAN in the books takes a camt.053 as it takes a PDF; a statement
 * of another IBAN under the same bank is another account, offered for adding; an IBAN the books
 * know is never asked for; a camt holding filed-period payments the books lack writes nothing.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';
import { testIban } from './support/iban.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import type { Index } from '../src/types/index.js';

const COIFFEUR = join(APP_ROOT, 'demo-coiffeur', APP_FOLDER);
/** Made-up IBANs with valid check digits: the coiffeur demo's account and another one. */
const SALON = 'CH8180808000000000004';
const OTHER = testIban('80808000000000005');
/** The demo's Raiffeisen account named in its manifest (tests/fixtures/*-index.json run on the demo manifest). */
const DEMO = 'CH6580808000000000001';

const camt = (id: string, iban: string, entries: Array<[date: string, amount: number, ref: string]>, bankName = 'Raiffeisenbank Beispiel') => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>2026-10-16T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>CHF</Ccy><Svcr><FinInstnId><Nm>${bankName}</Nm></FinInstnId></Svcr></Acct>
${entries.map(([d, a, r]) => `<Ntry><Amt Ccy="CHF">${Math.abs(a).toFixed(2)}</Amt><CdtDbtInd>${a < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><BookgDt><Dt>${d}</Dt></BookgDt><AcctSvcrRef>${r}</AcctSvcrRef><AddtlNtryInf>Zahlung ${r}</AddtlNtryInf></Ntry>`).join('\n')}
</Stmt></BkToCstmrStmt></Document>`;

const folder = (root: string) => join(root, 'transactional-data/2026/bank-statements/Raiffeisen');

test('a firm with one CHF account and no IBAN in the books reads its camt.053 like a PDF; a statement of another IBAN is another account, offered for adding, nothing written', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: COIFFEUR });
  try {
    const first = await api.fetch('/api/statements?name=okt.xml', { method: 'POST', body: camt('S-OKT', SALON, [['2026-10-02', -89.9, '91000000001'], ['2026-10-05', 180, '91000000002']]) });
    assert.equal(first.status, 200, await first.clone().text());
    const done = await first.json() as { account: string; added: number };
    assert.deepEqual([done.account, done.added], ['1020', 2], 'read into the firm\'s only CHF account');
    const info = await (await api.fetch('/api/workspace')).json() as { statementIbans: Record<string, string> };
    assert.deepEqual(info.statementIbans, { 1020: SALON }, 'Firma › Bankkonten offers the IBAN the statements show');

    const other = await api.fetch('/api/statements?name=privat.xml', { method: 'POST', body: camt('S-PRIV', OTHER, [['2026-10-03', -40, '55000000001']], 'Zürcher Kantonalbank') });
    assert.equal(other.status, 400);
    const body = await other.json() as { error: string; code: string; params: { reason: string; problem: { kind: string; ibans?: string[] }; unknown?: { iban: string; currency: string; bankName?: string } } };
    assert.equal(body.code, 'statement');
    assert.equal(body.params.reason, 'account');
    assert.deepEqual(body.params.problem, { kind: 'twoAccounts', currency: 'CHF', bank: 'Raiffeisen', ibans: [SALON, OTHER], iban: OTHER });
    assert.deepEqual(body.params.unknown, { iban: OTHER, currency: 'CHF', bankName: 'Zürcher Kantonalbank' }, 'the newcomer is the account to add');
    assert.doesNotMatch(body.error, /belege\.workspace\.yaml|bank-statements\//, 'no file for the person to edit');
    assert.deepEqual(readdirSync(folder(api.root)), ['okt.xml'], 'the refused file is not kept');
    const books = await (await api.fetch('/books.json')).json() as Index;
    assert.deepEqual(books.transactions.map((t) => t.ref), ['91000000001', '91000000002']);
  } finally { await api.stop(); }
});

test('two CHF accounts without IBAN: the camt.053 asks which one instead of refusing; the drop dialog takes the answer and reads it into that account (#25)', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: COIFFEUR });
  const { SESSION } = await import('./support/inbox-run.js');
  try {
    // The runs' engine opens before the account is added, as it does whenever the server looked at its runs first:
    // the run that reads the statement in must still know the new account (#246).
    await api.fetch('/api/automation');
    const added = await api.send('PATCH', '/api/workspace', { addBank: { bank: 'ZKB', currency: 'CHF', account: '1022', label: 'ZKB Geschäftskonto' } });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    const file = camt('S-ZKB', OTHER, [['2026-10-03', -40, '55000000001']], 'Zürcher Kantonalbank');
    const res = await api.fetch('/api/statements?name=zkb.xml', { method: 'POST', body: file });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; params: { reason: string; problem: unknown; unknown?: unknown } };
    assert.deepEqual(body.params.problem, { kind: 'whichAccount', currency: 'CHF', iban: OTHER, accounts: [{ account: '1020', bank: 'Raiffeisen', label: 'Bank Raiffeisen' }, { account: '1022', bank: 'ZKB', label: 'ZKB Geschäftskonto' }] });
    assert.doesNotMatch(body.error, /Kein Bankkonto/, 'not «no account takes it»: two do');

    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=zkb.xml`, Buffer.from(file));
    const row = s.rows[0];
    assert.deepEqual([row.state, row.chooseAccount?.accounts.map((a) => a.account)], ['asks', ['1020', '1022']], 'the row asks which account');
    await assert.rejects(post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'account', account: '1021' }), /400/, 'only an account it offered');
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'account', account: '1022' });
    assert.deepEqual([s.rows[0].state, s.rows[0].chooseAccount, s.rows[0].statement?.file], ['taken', undefined, 'ZKB/zkb.xml']);
    await rest();
    const books = await (await api.fetch('/books.json')).json() as Index;
    assert.deepEqual(books.transactions.map((t) => [t.ref, t.bank]), [['55000000001', 'ZKB']], 'read into the account the person chose');

    const second = camt('S-PRIV-2', testIban('80808000000000077'), [['2026-10-04', -15, '55000000002']], 'Bank Beispiel');
    s = await post(`/api/drop/${s.id}/files?name=privat.xml`, Buffer.from(second));
    const asked = s.rows.find((r) => r.name === 'privat.xml')!;
    assert.ok(asked.chooseAccount, 'asked which account');
    s = await post(`/api/drop/${s.id}/rows/${asked.key}`, { kind: 'private' });
    const aside = s.rows.find((r) => r.name === 'privat.xml')!;
    assert.deepEqual([aside.reason, aside.chooseAccount], ['private', undefined], '«Nein, privat» ends the question too');
    await assert.rejects(post(`/api/drop/${s.id}/rows/${asked.key}`, { kind: 'account', account: '1022' }), /400/, 'a file set aside is not read in afterwards');
  } finally {
    await api.stop();
  }
});

test('an account the person names never takes a statement whose IBAN the books give another account (#25)', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: COIFFEUR });
  try {
    const added = await api.send('PATCH', '/api/workspace', { addBank: { bank: 'ZKB', currency: 'CHF', account: '1022', label: 'ZKB', iban: OTHER } });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    const res = await api.fetch('/api/statements?name=zkb.xml&account=1020', { method: 'POST', body: camt('S-Z', OTHER, [['2026-10-03', -40, '55000000001']]) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as { account: string }).account, '1022', 'the IBAN the books know decides, not the account it was dropped on');
  } finally { await api.stop(); }
});

test('an account whose IBAN the books know takes only its own statements; another IBAN names the known one and offers the new account', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json');
  try {
    const file = camt('S-X', OTHER, [['2026-10-03', -40, '55000000001']]);
    const res = await api.fetch('/api/statements?name=x.xml', { method: 'POST', body: file });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; params: { problem: unknown; unknown?: unknown } };
    assert.deepEqual(body.params.problem, { kind: 'noAccount', currency: 'CHF', iban: OTHER }, 'dropped anywhere: no account of the books has this IBAN, and none is without one');
    assert.deepEqual(body.params.unknown, { iban: OTHER, currency: 'CHF', bankName: 'Raiffeisenbank Beispiel' });
    assert.doesNotMatch(body.error, /belege\.workspace\.yaml|Add iban/);
    const onAccount = await api.fetch('/api/statements?name=x.xml&account=1021', { method: 'POST', body: file });
    assert.equal(onAccount.status, 400);
    const hinted = await onAccount.json() as { error: string; params: { problem: unknown; unknown?: unknown } };
    assert.deepEqual(hinted.params.problem, { kind: 'otherIban', currency: 'CHF', iban: OTHER, account: { bank: 'Raiffeisen', iban: DEMO } }, 'dropped on the account: its known IBAN is named, not asked for');
    assert.deepEqual(hinted.params.unknown, { iban: OTHER, currency: 'CHF', bankName: 'Raiffeisenbank Beispiel' });
    assert.equal(existsSync(folder(api.root)), false, 'nothing written');
  } finally { await api.stop(); }
});

test('a camt.053 holding a filed-period payment the books lack is refused in words, and nothing is written', async () => {
  const api = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const before = await (await api.fetch('/books.json')).json() as Index;
    const res = await api.fetch('/api/statements?name=q2q3.xml', { method: 'POST', body: camt('S-Q2', DEMO, [['2026-06-25', -120, '90000000099'], ['2026-07-02', 55, '90000000100']]) });
    assert.equal(res.status, 403, await res.clone().text());
    const body = await res.json() as { error: string; code: string; params: { reason: string; closed: unknown } };
    assert.equal(body.code, 'statement');
    assert.equal(body.params.reason, 'filedPayments');
    assert.deepEqual(body.params.closed, { n: 1, through: '2026-06-30', refs: ['90000000099'] });
    assert.doesNotMatch(body.error, /added/);
    assert.equal(existsSync(join(folder(api.root), 'q2q3.xml')), false, 'the file is not kept');
    assert.deepEqual(await (await api.fetch('/books.json')).json(), before, 'the books did not change');
  } finally { await api.stop(); }
});

test('an IBAN typed with wrong check digits is refused with a typed code, naming the account and the text', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json');
  try {
    const bad = await api.send('PATCH', '/api/workspace', { banks: [{ bank: 'Raiffeisen', currency: 'CHF', iban: 'CH00 8080 8000 0000 0000 4' }] });
    assert.equal(bad.status, 400);
    assert.deepEqual({ code: bad.json.code, params: bad.json.params }, { code: 'iban', params: { bank: 'Raiffeisen CHF', detail: 'CH00 8080 8000 0000 0000 4' } });
  } finally { await api.stop(); }
});
