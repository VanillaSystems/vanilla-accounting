/**
 * A statement read in on Kontoauszüge (not through the drop dialog) can be taken back too (r9k-3):
 * DELETE /api/statements/<bank>/<file> is the same convergent undo the drop dialog's «Rückgängig»
 * uses (src/server/routes/statements.ts removeStatement): the file, its balances, the payments it
 * alone brought and their links and entries leave; what another file still holds stays; a payment
 * with a person's booking refuses the whole removal. The toast after an import and the statement
 * page's «Auszug entfernen» call it.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';
import type { Index } from '../src/types/index.js';

/** The demo's Raiffeisen account (tests/fixtures/fresh-books-index.json runs on the demo manifest). */
const IBAN = 'CH6580808000000000001';
type Entry = { date: string; amount: number; ref: string; text: string };
const camt = (id: string, opbd: [string, number], clbd: [string, number], entries: Entry[]) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>${id}</MsgId><CreDtTm>${clbd[0]}T21:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${id}</Id><Acct><Id><IBAN>${IBAN}</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${opbd[1]}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${opbd[0]}</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${clbd[1]}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${clbd[0]}</Dt></Dt></Bal>
${entries.map((e) => `<Ntry><Amt Ccy="CHF">${Math.abs(e.amount).toFixed(2)}</Amt><CdtDbtInd>${e.amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${e.date}</Dt></BookgDt><AcctSvcrRef>${e.ref}</AcctSvcrRef><AddtlNtryInf>${e.text}</AddtlNtryInf></Ntry>`).join('\n')}
</Stmt></BkToCstmrStmt></Document>`;

const first: Entry[] = [
  { date: '2026-10-02', amount: 180, ref: '91000000001', text: 'TWINT Gutschrift' },
  { date: '2026-10-05', amount: -1250, ref: '91000000002', text: 'Miete Oktober' },
  { date: '2026-10-14', amount: -89.9, ref: '91000000005', text: 'Telecom' },
];
const overlap: Entry[] = [first[2], { date: '2026-10-16', amount: -45, ref: '91000000006', text: 'Coop' }];
const A = camt('STM-A', ['2026-09-30', 6500], ['2026-10-15', 5340.1], first);
const B = camt('STM-B', ['2026-10-13', 5430], ['2026-10-16', 5295.1], overlap);
const RENT = { accountDebit: '6000', accountCredit: '1021', amount: 1250, description: 'Miete Oktober' };

test('a statement is removed again as the drop dialog would: refused over a hand booking, else file, balances, payments and links leave; the books are as before', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json');
  try {
    const books = async () => (await (await api.fetch('/books.json')).json()) as Index;
    const folder = join(api.root, 'transactional-data/2026/bank-statements/Raiffeisen');
    const before = await books();
    assert.equal((await api.fetch('/api/statements?name=a.xml', { method: 'POST', body: A })).status, 200);
    const booked = await api.send('POST', '/api/transactions/91000000002/entries', { lines: [RENT] });
    assert.equal(booked.status, 200, JSON.stringify(booked.json));

    const refused = await api.send('DELETE', '/api/statements/Raiffeisen/a.xml');
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.match(String(refused.json.error), /von Hand/);
    assert.ok(existsSync(join(folder, 'a.xml')), 'the file stays');
    assert.equal((await books()).transactions.length, 3, 'the payments stay');

    const entry = (await books()).journalEntries!.find((e) => e.transactionRef === '91000000002')!;
    assert.equal((await api.send('DELETE', `/api/journal-entries/${entry.id}`)).status, 200);
    const removed = await api.send('DELETE', '/api/statements/Raiffeisen/a.xml');
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    const after = await books();
    assert.deepEqual(after.transactions, before.transactions, 'the payments it brought are gone');
    assert.deepEqual(after.bankStatements, before.bankStatements, 'the statement is not listed any more');
    assert.deepEqual(after.statementBalances ?? [], before.statementBalances ?? [], 'its balances left with it');
    assert.equal(existsSync(join(folder, 'a.xml')), false, 'the file is gone');
    assert.equal((await api.send('DELETE', '/api/statements/Raiffeisen/a.xml')).status, 404, 'gone is gone');
  } finally { await api.stop(); }
});

test('with overlapping exports the removal takes only what the file alone brought', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json');
  try {
    const books = async () => (await (await api.fetch('/books.json')).json()) as Index;
    assert.equal((await api.fetch('/api/statements?name=a.xml', { method: 'POST', body: A })).status, 200);
    assert.equal((await api.fetch('/api/statements?name=b.xml', { method: 'POST', body: B })).status, 200);
    assert.deepEqual((await books()).transactions.map((t) => t.ref), [...first.map((e) => e.ref), '91000000006']);
    assert.equal((await api.send('DELETE', '/api/statements/Raiffeisen/b.xml')).status, 200);
    const after = await books();
    assert.deepEqual(after.transactions.map((t) => t.ref), first.map((e) => e.ref), 'the Telecom payment both files hold stays, the Coop payment leaves');
    assert.deepEqual(after.bankStatements.map((s) => s.filename), ['a.xml']);
  } finally { await api.stop(); }
});

test('r10h-3: the removal answers with the bookings and links it took, so that the undo of «Auszug entfernen» puts the payment back with its booking', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json');
  try {
    const books = async () => (await (await api.fetch('/books.json')).json()) as Index;
    assert.equal((await api.fetch('/api/statements?name=a.xml', { method: 'POST', body: A })).status, 200);
    const byRule = { id: 'rb1', transactionRef: '91000000001', date: '2026-10-02', accountDebit: '1021', accountCredit: '3400', amount: 180, description: 'TWINT Gutschrift', origin: 'classify', by: { kind: 'rule', rule: 'twint-3400', at: '2026-10-16T08:00:00Z' } };
    const booked = await api.send('POST', '/api/journal-entries', byRule);
    assert.equal(booked.status, 200, JSON.stringify(booked.json));

    const removed = await api.send('DELETE', '/api/statements/Raiffeisen/a.xml');
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    const taken = removed.json as { removed: { entries: Array<Record<string, unknown>>; mappings: unknown[] } };
    assert.deepEqual(taken.removed.entries.map((e) => [e.id, e.transactionRef, e.origin, (e.by as { kind: string }).kind]), [['rb1', '91000000001', 'classify', 'rule']], 'the booking the removal took, with who made it');
    assert.deepEqual(taken.removed.mappings, []);
    assert.equal((await books()).journalEntries?.length ?? 0, 0);

    assert.equal((await api.fetch('/api/statements?name=a.xml', { method: 'POST', body: A })).status, 200, 'the undo reads the file again');
    const back = await api.send('POST', '/api/journal-entries', taken.removed.entries[0]);
    assert.equal(back.status, 200, JSON.stringify(back.json));
    const e = (await books()).journalEntries!.find((x) => x.id === 'rb1')!;
    assert.deepEqual([e.transactionRef, e.origin, e.by?.kind], ['91000000001', 'classify', 'rule'], 'and the booking is back as it was');
  } finally { await api.stop(); }
});
