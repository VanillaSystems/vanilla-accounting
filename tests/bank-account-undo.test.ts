/**
 * A bank account added by mistake can be taken back (r9k-1). The question «Gehört dieses Konto der
 * Firma?» names the statement's account holder, so the owner sees it is another firm; adding an
 * account adds its ledger account to the chart (or reuses one), so the year close never blocks on
 * an account missing from the chart; Firma › Bankkonten removes an account again (the toast's
 * «Rückgängig» does the same), refused with a reason while statements, bookings or invoices use it.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startApi } from './support/api-server.js';
import { testIban } from './support/iban.js';
import { APP_FOLDER, APP_ROOT, MANIFEST_FILE } from '../src/workspace/workspace.js';
import type { ApiRefusal } from '../src/types/api-error.js';

const COIFFEUR = join(APP_ROOT, 'demo-coiffeur', APP_FOLDER);
const SALON = 'CH8180808000000000004';
const NEIGHBOUR = testIban('80808000000077712');

const camt = (id: string, iban: string, owner: string, entries: Array<[date: string, amount: number, ref: string]>) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>2026-10-16T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>CHF</Ccy><Ownr><Nm>${owner}</Nm></Ownr><Svcr><FinInstnId><Nm>Raiffeisenbank Beispiel</Nm></FinInstnId></Svcr></Acct>
${entries.map(([d, a, r]) => `<Ntry><Amt Ccy="CHF">${Math.abs(a).toFixed(2)}</Amt><CdtDbtInd>${a < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><BookgDt><Dt>${d}</Dt></BookgDt><AcctSvcrRef>${r}</AcctSvcrRef><AddtlNtryInf>Zahlung ${r}</AddtlNtryInf></Ntry>`).join('\n')}
</Stmt></BkToCstmrStmt></Document>`;

type Account = { number: string; name: string };
type Refused = { error: string } & Extract<ApiRefusal, { code: 'bankInUse' }>;

test('the question names the account holder; the added account gets its chart account; removal is refused while a statement uses it, works once nothing does, and takes the chart account along', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: COIFFEUR });
  try {
    const own = await api.fetch('/api/statements?name=okt.xml', { method: 'POST', body: camt('S-OKT', SALON, 'Salon Beispiel', [['2026-10-02', -89.9, '91000000001']]) });
    assert.equal(own.status, 200, await own.clone().text());

    const other = await api.fetch('/api/statements?name=nachbar.xml', { method: 'POST', body: camt('S-NB', NEIGHBOUR, 'Coiffure Nachbar GmbH', [['2026-10-03', -120, '77000000001']]) });
    assert.equal(other.status, 400);
    const body = await other.json() as { params: { unknown?: { iban: string; currency: string; bankName?: string; owner?: string } } };
    assert.deepEqual(body.params.unknown, { iban: NEIGHBOUR, currency: 'CHF', bankName: 'Raiffeisenbank Beispiel', owner: 'Coiffure Nachbar GmbH' }, 'the owner sees whose account it is');

    const accounts = async () => (await api.send('GET', '/api/accounts')).json as unknown as Account[];
    assert.ok(!(await accounts()).some((a) => a.number === '1021'), 'the coiffeur\'s chart has no 1021 yet');
    const added = await api.send('PATCH', '/api/workspace', { addBank: { bank: 'Raiffeisen 2', currency: 'CHF', account: '1021', label: 'Coiffure Nachbar GmbH', iban: NEIGHBOUR } });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    assert.deepEqual((await accounts()).find((a) => a.number === '1021'), { number: '1021', name: 'Coiffure Nachbar GmbH' }, 'the ledger account is in the chart with the bank');

    const read = await api.fetch('/api/statements?name=nachbar.xml', { method: 'POST', body: camt('S-NB', NEIGHBOUR, 'Coiffure Nachbar GmbH', [['2026-10-03', -120, '77000000001']]) });
    assert.equal(read.status, 200, await read.clone().text());
    const inUse = await api.send('PATCH', '/api/workspace', { removeBank: { bank: 'Raiffeisen 2', currency: 'CHF' } });
    assert.equal(inUse.status, 400, JSON.stringify(inUse.json));
    const refusal = inUse.json as unknown as Refused;
    assert.equal(refusal.code, 'bankInUse');
    assert.deepEqual(refusal.params, { account: '1021', label: 'Coiffure Nachbar GmbH', statements: 1, entries: 1, invoices: 0 }, 'the statement and its payment use the account');
    assert.doesNotMatch(refusal.error, /belege\.workspace\.yaml/, 'no file for the person to edit');
    assert.ok(parse(readFileSync(join(api.root, MANIFEST_FILE), 'utf8')).bankAccounts.some((b: { account: string }) => b.account === '1021'), 'still there');
  } finally { await api.stop(); }
});

test('an account nobody uses is removed with its chart account (the toast\'s «Rückgängig» after adding it); an account the chart had before stays in the chart', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: COIFFEUR });
  try {
    const accounts = async () => (await api.send('GET', '/api/accounts')).json as unknown as Account[];
    const manifest = () => parse(readFileSync(join(api.root, MANIFEST_FILE), 'utf8')) as { bankAccounts: Array<{ bank: string; account: string }> };
    assert.equal((await api.send('PATCH', '/api/workspace', { addBank: { bank: 'Raiffeisen 2', currency: 'CHF', account: '1021', label: 'Nachbar', iban: NEIGHBOUR } })).status, 200);
    const removed = await api.send('PATCH', '/api/workspace', { removeBank: { bank: 'Raiffeisen 2', currency: 'CHF' } });
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.ok(!manifest().bankAccounts.some((b) => b.bank === 'Raiffeisen 2'), 'the account is gone from the books\' setup');
    assert.ok(!(await accounts()).some((a) => a.number === '1021'), 'and its chart account, which nothing booked on, with it');

    // An account the chart knew before the bank came stays: it may hold the owner's own bookings.
    assert.equal((await api.send('PUT', '/api/accounts/1021', { name: 'Zweitkonto' })).status, 200);
    assert.equal((await api.send('PATCH', '/api/workspace', { addBank: { bank: 'Raiffeisen 2', currency: 'CHF', account: '1021', label: 'Nachbar' } })).status, 200);
    assert.equal((await accounts()).find((a) => a.number === '1021')?.name, 'Zweitkonto', 'an existing chart account is reused, not renamed');
    assert.equal((await api.send('PATCH', '/api/workspace', { removeBank: { bank: 'Raiffeisen 2', currency: 'CHF' } })).status, 200);
    assert.equal((await accounts()).find((a) => a.number === '1021')?.name, 'Zweitkonto', 'and stays when the bank goes');

    const gone = await api.send('PATCH', '/api/workspace', { removeBank: { bank: 'Raiffeisen 2', currency: 'CHF' } });
    assert.equal(gone.status, 400, 'removing twice is refused');
    const manual = await api.send('PATCH', '/api/workspace', { removeBank: { bank: 'manual', currency: 'CHF' } });
    assert.equal(manual.status, 400, 'the owner\'s private account is no bank account to remove');
  } finally { await api.stop(); }
});

/**
 * A second bank account on a ledger account another bank account already uses (r10h-2): the add is
 * refused with the account that has it, so one statement never lists twice. Books set up that way
 * before the refusal keep working: removing the bank account counts what is its own (its statements,
 * its payments and their bookings, invoices paid to it), not everything on the shared ledger account.
 */
test('a ledger account in use refuses a second bank account; a bank sharing one from before is removed by its own uses', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: COIFFEUR });
  try {
    const own = await api.fetch('/api/statements?name=okt.xml', { method: 'POST', body: camt('S-OKT', SALON, 'Salon Beispiel', [['2026-10-02', -89.9, '91000000001']]) });
    assert.equal(own.status, 200, await own.clone().text());
    const twice = await api.send('PATCH', '/api/workspace', { addBank: { bank: 'PostFinance', currency: 'CHF', account: '1020', label: 'PostFinance CHF' } });
    assert.equal(twice.status, 400, JSON.stringify(twice.json));
    const refusal = twice.json as unknown as { error: string } & Extract<ApiRefusal, { code: 'ledgerAccountTaken' }>;
    assert.equal(refusal.code, 'ledgerAccountTaken');
    assert.deepEqual(refusal.params, { account: '1020', bank: 'Raiffeisen', currency: 'CHF', label: 'Bank Raiffeisen' }, 'names the bank account that has it');
    const manifest = () => parse(readFileSync(join(api.root, MANIFEST_FILE), 'utf8')) as { bankAccounts: Array<{ bank: string; account: string }> };
    assert.deepEqual(manifest().bankAccounts.filter((b) => b.account === '1020').map((b) => b.bank), ['Raiffeisen'], 'nothing added');
    const owners = await api.send('PATCH', '/api/workspace', { addBank: { bank: 'PostFinance', currency: 'CHF', account: '2850', label: 'PostFinance CHF' } });
    assert.equal((owners.json as { code?: string }).code, 'ledgerAccountTaken', 'the owner\'s private account is taken too');
  } finally { await api.stop(); }

  // Books from before the refusal: PostFinance CHF sits on Raiffeisen's 1020.
  const shared = mkdtempSync(join(tmpdir(), 'shared-bank-'));
  writeFileSync(join(shared, MANIFEST_FILE), readFileSync(join(COIFFEUR, MANIFEST_FILE), 'utf8')
    .replace(/^bankAccounts:\n/m, `bankAccounts:\n  - { bank: PostFinance, currency: CHF, account: "1020", label: PostFinance CHF, iban: ${NEIGHBOUR} }\n`)
    .replace('label: Bank Raiffeisen,', `label: Bank Raiffeisen, iban: ${SALON},`));
  const legacy = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: shared });
  try {
    const own = await legacy.fetch('/api/statements?name=okt.xml', { method: 'POST', body: camt('S-OKT', SALON, 'Salon Beispiel', [['2026-10-02', -89.9, '91000000001']]) });
    assert.equal(own.status, 200, await own.clone().text());
    const raiffeisen = await legacy.send('PATCH', '/api/workspace', { removeBank: { bank: 'Raiffeisen', currency: 'CHF' } });
    assert.equal(raiffeisen.status, 400);
    assert.deepEqual((raiffeisen.json as unknown as Refused).params, { account: '1020', label: 'Bank Raiffeisen', statements: 1, entries: 1, invoices: 0 }, 'Raiffeisen\'s own statement and payment');
    assert.equal((await legacy.send('PUT', '/api/accounts/1020', { name: 'Bank Raiffeisen' })).status, 200);
    const postfinance = await legacy.send('PATCH', '/api/workspace', { removeBank: { bank: 'PostFinance', currency: 'CHF' } });
    assert.equal(postfinance.status, 200, JSON.stringify(postfinance.json));
    const accounts = (await legacy.send('GET', '/api/accounts')).json as unknown as Account[];
    assert.ok(accounts.some((a) => a.number === '1020'), 'the shared ledger account stays with Raiffeisen');
    const after = parse(readFileSync(join(legacy.root, MANIFEST_FILE), 'utf8')) as { bankAccounts: Array<{ bank: string }> };
    assert.deepEqual(after.bankAccounts.map((b) => b.bank), ['Raiffeisen', 'manual']);
  } finally { await legacy.stop(); rmSync(shared, { recursive: true, force: true }); }
});
