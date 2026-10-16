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
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import type { Index } from '../src/types/index.js';

const COIFFEUR = join(APP_ROOT, 'demo-coiffeur', APP_FOLDER);
/** Made-up IBANs with valid check digits: the coiffeur demo's account and another one. */
const SALON = 'CH8180808000000000004';
const OTHER = 'CH5480808000000000005';
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
