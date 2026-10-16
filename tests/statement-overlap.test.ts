/**
 * A bank's exports overlap: the next file begins where the last one ended, a year-to-date export
 * repeats every month (r8k-1, r8k-2). A payment is the same transaction in every file that holds
 * it (same account, bank reference, date, direction, amount, currency), so it keeps its ref and
 * its bookings; only the payments the books lack are added. «Rückgängig» on a statement removes
 * the payments this statement alone brought, and the other files' payments stay.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';
import { SESSION } from './support/inbox-run.js';
import type { Index } from '../src/types/index.js';

/** The demo's Raiffeisen account (tests/fixtures/fresh-books-index.json runs on the demo manifest). */
const IBAN = 'CH6580808000000000001';

type Entry = { date: string; amount: number; ref: string; text: string; parts?: Array<[amount: number, name: string, reference: string]> };

const camt = (id: string, opbd: [date: string, amount: number], clbd: [date: string, amount: number], entries: Entry[]) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>${clbd[0]}T21:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>${IBAN}</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${opbd[1]}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${opbd[0]}</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${clbd[1]}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${clbd[0]}</Dt></Dt></Bal>
${entries.map((e) => `<Ntry><Amt Ccy="CHF">${Math.abs(e.amount).toFixed(2)}</Amt><CdtDbtInd>${e.amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${e.date}</Dt></BookgDt><ValDt><Dt>${e.date}</Dt></ValDt><AcctSvcrRef>${e.ref}</AcctSvcrRef><AddtlNtryInf>${e.text}</AddtlNtryInf>${e.parts ? `<NtryDtls><Btch><NbOfTxs>${e.parts.length}</NbOfTxs></Btch>${e.parts.map(([a, n, r]) => `<TxDtls><Amt Ccy="CHF">${a.toFixed(2)}</Amt><RltdPties><Cdtr><Nm>${n}</Nm></Cdtr></RltdPties><RmtInf><Ustrd>${r}</Ustrd></RmtInf></TxDtls>`).join('')}</NtryDtls>` : ''}</Ntry>`).join('\n')}
</Stmt></BkToCstmrStmt></Document>`;

const first: Entry[] = [
  { date: '2026-10-02', amount: 180, ref: '91000000001', text: 'TWINT Gutschrift' },
  { date: '2026-10-05', amount: -1250, ref: '91000000002', text: 'Miete Oktober' },
  { date: '2026-10-08', amount: -812.5, ref: '91000000003', text: 'Sammelauftrag', parts: [[512.5, 'Haarkosmetik AG', 'HK-2026-10'], [200, 'Druckerei', 'D-77'], [100, 'Stadtwerk', 'SW-9']] },
  { date: '2026-10-12', amount: 1187.3, ref: '91000000004', text: 'SumUp Auszahlung' },
  { date: '2026-10-14', amount: -89.9, ref: '91000000005', text: 'Telecom' },
];
const overlap: Entry[] = [first[2], first[3], first[4], { date: '2026-10-16', amount: -45, ref: '91000000006', text: 'Coop' }];
/** 1.–15.10.: five payments. 10.–16.10.: the last three again, and a new Coop. */
const A = camt('STM-A', ['2026-09-30', 6500], ['2026-10-15', 5714.9], first);
const B = camt('STM-B', ['2026-10-09', 6500 + 180 - 1250], ['2026-10-16', 5669.9], overlap);
const RENT = { accountDebit: '6000', accountCredit: '1021', amount: 1250, description: 'Miete Oktober' };
const SALES = { accountDebit: '1021', accountCredit: '3400', amount: 1187.3, description: 'SumUp Auszahlung' };

test('the next export repeats the last days: the shared payments stay the same transactions with their bookings, only the new one is added, and the same file again changes nothing', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json');
  try {
    const books = async () => (await (await api.fetch('/books.json')).json()) as Index;
    assert.equal((await api.fetch('/api/statements?name=a.xml', { method: 'POST', body: A })).status, 200);
    assert.deepEqual((await books()).transactions.map((t) => t.ref), first.map((e) => e.ref));
    const booked = await api.send('POST', '/api/transactions/91000000002/entries', { lines: [RENT] });
    assert.equal(booked.status, 200, JSON.stringify(booked.json));

    const res = await api.fetch('/api/statements?name=b.xml', { method: 'POST', body: B });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json() as { added: number }).added, 1, 'one payment is new');
    const after = await books();
    assert.deepEqual(after.transactions.map((t) => t.ref), [...first.map((e) => e.ref), '91000000006'], 'the refs as the bank gave them, none twice, no ~ legs');
    assert.deepEqual(after.transactions.find((t) => t.ref === '91000000003')?.parts?.map((p) => p.amount), [512.5, 200, 100], 'the collective payment stays one transaction with its parts');
    assert.deepEqual(after.journalEntries?.map((e) => [e.transactionRef, e.accountDebit]), [['91000000002', '6000']], 'the hand booking still points at its payment');
    assert.deepEqual(after.bankStatements.map((s) => [s.filename, s.fromDate, s.toDate]), [['a.xml', '2026-10-01', '2026-10-15'], ['b.xml', '2026-10-10', '2026-10-16']]);
    assert.deepEqual(after.bankStatements.map((s) => s.refs), [first.map((e) => e.ref), overlap.map((e) => e.ref)], 'each statement names the payments its file holds, with the refs the books carry (r10c-2)');

    const again = await api.fetch('/api/statements?name=b.xml', { method: 'POST', body: B });
    assert.equal(again.status, 409, 'the same file again is refused as read already');
    assert.deepEqual(await books(), after, 'and the books did not change');
  } finally { await api.stop(); }
});

test('«Rückgängig» on an overlapping statement removes only what it alone brought; undoing the first keeps what the second still holds', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json');
  try {
    const { post, rest } = SESSION(api);
    const books = async () => (await (await api.fetch('/books.json')).json()) as Index;
    const folder = join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen');
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=a.xml`, Buffer.from(A));
    await rest();
    assert.equal((await api.send('POST', '/api/transactions/91000000004/entries', { lines: [SALES] })).status, 200);
    s = await post(`/api/drop/${s.id}/files?name=b.xml`, Buffer.from(B));
    await rest();
    const [a, b] = s.rows;
    assert.deepEqual([a.state, b.state], ['taken', 'taken']);
    assert.deepEqual(b.statement, { file: 'Raiffeisen/b.xml', refs: ['91000000006'] }, 'the second statement brought one payment');

    s = await post(`/api/drop/${s.id}/rows/${b.key}`, { kind: 'undo' });
    assert.equal(s.rows[1].state, 'undone');
    const afterB = await books();
    assert.deepEqual(afterB.transactions.map((t) => t.ref), first.map((e) => e.ref), 'the first statement\'s payments are all there');
    assert.deepEqual(afterB.journalEntries?.map((e) => e.transactionRef), ['91000000004'], 'with their bookings');
    assert.deepEqual(afterB.bankStatements.map((x) => x.filename), ['a.xml'], 'the undone statement is not listed any more');
    assert.equal(existsSync(join(folder, 'b.xml')), false);

    s = await post(`/api/drop/${s.id}/files?name=b.xml`, Buffer.from(B));
    await rest();
    const b2 = s.rows[2];
    assert.deepEqual([b2.state, b2.statement], ['taken', { file: 'Raiffeisen/b.xml', refs: ['91000000006'] }], 'the file can be dropped again');

    s = await post(`/api/drop/${s.id}/rows/${a.key}`, { kind: 'undo' });
    assert.equal(s.rows[0].state, 'undone');
    const afterA = await books();
    assert.deepEqual(afterA.transactions.map((t) => t.ref), overlap.map((e) => e.ref), 'what the second statement holds stays, the first two payments leave');
    assert.deepEqual(afterA.journalEntries?.map((e) => e.transactionRef), ['91000000004'], 'the hand booking on a shared payment stays with it');
    assert.deepEqual(afterA.bankStatements.map((x) => [x.filename, x.fromDate, x.toDate]), [['b.xml', '2026-10-10', '2026-10-16']]);
    assert.equal(existsSync(join(folder, 'a.xml')), false);
  } finally {
    await SESSION(api).rest().catch(() => {});
    await api.stop();
  }
});
