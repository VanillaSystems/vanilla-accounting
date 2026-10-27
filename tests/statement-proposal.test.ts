/**
 * A camt.053 asking which account it is of (#208): the row shows what the file says about itself
 * (bank, currency, period, movements, balances, a preview of the first movements with the rest
 * counted), proposes the one account whose bank the file names (never two, never a guess), and is
 * listed among the statements as waiting for an answer, not among the files not taken.
 */
import './support/jurisdiction.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApi } from './support/api-server.js';
import { testIban } from './support/iban.js';
import { textPdf } from './support/text-pdf.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import { camtDetails } from '../src/providers/camt053/details.js';
import { STATEMENT_PREVIEW } from '../src/providers/statement-files.js';
import { bankCodeOf, proposedAccount } from '../src/accounting/statement-bank.js';
import { needsYou, tabOf } from '../src/app/shell/drop-tabs.js';
import type { AccountChoice } from '../src/types/api-error.js';
import type { DropRow, DropSession } from '../src/types/drop.js';

const COIFFEUR = join(APP_ROOT, 'demo-coiffeur', APP_FOLDER);
/** Invented IBANs with valid check digits: clearing 80808 and 70000. */
const AT_80808 = testIban('80808000000000031');
const AT_70000 = testIban('70000000000000042');

interface Svcr { name?: string; bic?: string }
const camt = (iban: string, svcr: Svcr, entries: Array<[date: string, amount: number, who: string]>) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>M-${iban}</MsgId><CreDtTm>2026-11-01T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>S-${iban}</Id><FrToDt><FrDtTm>2026-10-01T00:00:00</FrDtTm><ToDtTm>2026-10-31T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>CHF</Ccy><Ownr><Nm>Muster Coiffeur</Nm></Ownr><Svcr><FinInstnId>${svcr.bic ? `<BICFI>${svcr.bic}</BICFI>` : ''}${svcr.name ? `<Nm>${svcr.name}</Nm>` : ''}</FinInstnId></Svcr></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-01</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${(1000 + entries.reduce((s, [, a]) => s + a, 0)).toFixed(2)}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-31</Dt></Dt></Bal>
${entries.map(([d, a, who], i) => `<Ntry><Amt Ccy="CHF">${Math.abs(a).toFixed(2)}</Amt><CdtDbtInd>${a < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><BookgDt><Dt>${d}</Dt></BookgDt><AcctSvcrRef>R-${iban.slice(-4)}-${i + 1}</AcctSvcrRef><NtryDtls><TxDtls><RltdPties>${a < 0 ? `<Cdtr><Nm>${who}</Nm></Cdtr>` : `<Dbtr><Nm>${who}</Nm></Dbtr>`}</RltdPties><RmtInf><Ustrd>Rechnung ${i + 1}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`).join('\n')}
</Stmt></BkToCstmrStmt></Document>`;

const SEVEN: Array<[string, number, string]> = [
  ['2026-10-20', -12.5, 'Papeterie Beispiel'], ['2026-10-03', 250, 'Kundin Muster'], ['2026-10-05', -40, 'Strom AG'],
  ['2026-10-07', -8.9, 'Kiosk'], ['2026-10-09', 120, 'Kunde Beispiel'], ['2026-10-12', -60, 'Miete GmbH'], ['2026-10-28', 75, 'Kundin Zwei'],
];

test('a camt.053\'s details: bank and BIC, currency, IBAN, owner, the stated period and the booked days, movements, balances, and the first movements with the rest counted', () => {
  const d = camtDetails(camt(AT_80808, { name: 'Raiffeisenbank Beispiel', bic: 'RAIFCH22XXX' }, SEVEN), 'okt.xml', STATEMENT_PREVIEW)!;
  assert.deepEqual([d.bankName, d.bic, d.currency, d.iban, d.owner], ['Raiffeisenbank Beispiel', 'RAIFCH22XXX', 'CHF', AT_80808, 'Muster Coiffeur']);
  assert.deepEqual(d.period, { from: '2026-10-01', to: '2026-10-31' }, 'the period as the bank states it');
  assert.deepEqual(d.booked, { first: '2026-10-03', last: '2026-10-28' }, 'and the days it booked');
  assert.equal(d.movements, 7);
  assert.deepEqual([d.opening, d.closing], [{ date: '2026-10-01', amount: 1000 }, { date: '2026-10-31', amount: 1323.6 }]);
  assert.equal(d.preview.length, STATEMENT_PREVIEW);
  assert.equal(d.more, 7 - STATEMENT_PREVIEW, 'the movements not shown are counted');
  assert.deepEqual(d.preview[0], { date: '2026-10-03', amount: 250, counterparty: 'Kundin Muster', text: 'Rechnung 2' }, 'in date order, money in positive');
  assert.equal(d.preview[1].amount, -40, 'money out negative');
  assert.equal(camtDetails('<x/>', 'x.xml', STATEMENT_PREVIEW), undefined, 'no camt.053, no details');
});

const CHOICE: AccountChoice = { kind: 'whichAccount', currency: 'CHF', accounts: [{ account: '1020', bank: 'Raiffeisen', label: 'Bank Raiffeisen' }, { account: '1022', bank: 'ZKB', label: 'ZKB Geschäftskonto' }] };
const none = () => [];

test('the one account whose bank the file names is proposed: by the servicer\'s name, by the BIC, by the IBAN\'s bank code beside an IBAN known under that label', () => {
  assert.equal(proposedAccount(CHOICE, { bankName: 'Raiffeisenbank Beispiel' }, none), '1020', 'the name holds the label');
  assert.equal(proposedAccount(CHOICE, { bic: 'ZKBKCHZZ80A' }, none), '1022', 'the BIC\'s institution code begins like the label');
  assert.equal(proposedAccount(CHOICE, { bic: 'RAIFCH22' }, none), '1020');
  assert.equal(bankCodeOf(AT_70000), 'CH:70000');
  const known = (bank: string) => (bank === 'ZKB' ? [testIban('70000000000000099')] : []);
  assert.equal(proposedAccount(CHOICE, { iban: AT_70000 }, known), '1022', 'the bank code of an IBAN the label already shows');
  assert.equal(proposedAccount(CHOICE, { iban: AT_80808 }, known), undefined, 'another bank code is no match');
});

test('no proposal when no account\'s bank matches, or several do', () => {
  assert.equal(proposedAccount(CHOICE, { bankName: 'Bank Beispiel AG' }, none), undefined, 'none matches');
  assert.equal(proposedAccount(CHOICE, {}, none), undefined, 'the file names no bank');
  assert.equal(proposedAccount(CHOICE, { bankName: 'Raiffeisenbank', bic: 'ZKBKCHZZ80A' }, none), undefined, 'the name says one, the BIC the other: both match');
  const twins: AccountChoice = { ...CHOICE, accounts: [{ account: '1020', bank: 'Raiffeisen', label: 'Raiffeisen Konto' }, { account: '1025', bank: 'Raiffeisen', label: 'Raiffeisen Sparkonto' }] };
  assert.equal(proposedAccount(twins, { bankName: 'Raiffeisenbank Beispiel' }, none), undefined, 'two accounts of that bank: the person picks');
});

test('a statement asking for its account is listed among the statements as waiting for an answer; a refused file stays under «Nicht übernommen»', () => {
  const row = (state: DropRow['state'], kind: DropRow['kind'] = 'camt'): DropRow => ({ key: 'k', id: 'i', name: 'okt.xml', size: 1, kind, state });
  assert.deepEqual([tabOf(row('asks')), needsYou(row('asks'))], ['statements', true]);
  assert.deepEqual([tabOf(row('asks', 'statement-pdf')), needsYou(row('asks', 'statement-pdf'))], ['statements', true]);
  assert.deepEqual([tabOf(row('refused')), needsYou(row('refused'))], ['out', false]);
  assert.equal(tabOf(row('taken')), 'statements');
});

test('the drop row of a camt.053 asking for its account carries its details and the proposal, and waits for the answer (#208)', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: COIFFEUR });
  const { SESSION } = await import('./support/inbox-run.js');
  try {
    const added = await api.send('PATCH', '/api/workspace', { addBank: { bank: 'ZKB', currency: 'CHF', account: '1022', label: 'ZKB Geschäftskonto' } });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=raiffeisen-oktober.xml`, Buffer.from(camt(AT_80808, { name: 'Raiffeisenbank Beispiel' }, SEVEN)));
    s = await post(`/api/drop/${s.id}/files?name=unbekannt.xml`, Buffer.from(camt(AT_70000, { name: 'Bank Beispiel AG' }, SEVEN.slice(0, 2))));
    const [one, other] = s.rows;
    assert.deepEqual([one.state, one.chooseAccount?.proposed, one.details?.bankName, one.details?.movements, one.details?.more], ['asks', '1020', 'Raiffeisenbank Beispiel', 7, 2]);
    assert.deepEqual([other.state, other.chooseAccount?.proposed, other.details?.movements], ['asks', undefined, 2], 'no bank matches: asked plainly');
    s = await post(`/api/drop/${s.id}/rows/${one.key}`, { kind: 'account', account: '1020' });
    const taken = s.rows.find((r) => r.key === one.key)!;
    assert.deepEqual([taken.state, taken.details, taken.chooseAccount], ['taken', undefined, undefined], 'the person confirmed: read in, the question gone');
    // Kontoauszüge › Dateien asks the file read in for its own words, and the day it was read in.
    const own = await (await api.fetch(`/api/statements/${taken.statement!.file.split('/').map(encodeURIComponent).join('/')}/details`)).json() as { details?: { bankName?: string; owner?: string; movements: number; preview: unknown[] }; importedAt?: string };
    assert.deepEqual([own.details?.bankName, own.details?.owner, own.details?.movements, own.details?.preview], ['Raiffeisenbank Beispiel', 'Muster Coiffeur', 7, []]);
    assert.match(own.importedAt ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await api.fetch('/api/statements/Raiffeisen/none.xml/details')).status, 404);
    await rest();
  } finally {
    await api.stop();
  }
});

test('an answer given while the next file of the drop is still being read in is not lost: the statement is read in once and its row stays taken, never «schon eingelesen» (#208)', async () => {
  const api = await startApi('tests/fixtures/fresh-books-index.json', {}, { manifestOf: COIFFEUR });
  const { SESSION } = await import('./support/inbox-run.js');
  try {
    const added = await api.send('PATCH', '/api/workspace', { addBank: { bank: 'ZKB', currency: 'CHF', account: '1022', label: 'ZKB Geschäftskonto' } });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    const { post, rest } = SESSION(api);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.xml`, Buffer.from(camt(AT_80808, { name: 'Raiffeisenbank Beispiel' }, SEVEN)));
    const asked = s.rows[0];
    assert.equal(asked.state, 'asks');
    // The person answers while the drop's next files are still on their way in: every request changes the same session.
    const pdfs = await Promise.all([1, 2, 3, 4].map((n) => textPdf([`Rechnung ${n}`, `Papeterie Beispiel ${n}`, `Total CHF ${n}0.00`, `Datum 0${n}.10.2026`])));
    const others = [1, 2, 3, 4].map((n) => post(`/api/drop/${s.id}/files?name=beleg-${n}.pdf`, pdfs[n - 1]));
    await Promise.all([post(`/api/drop/${s.id}/rows/${asked.key}`, { kind: 'account', account: '1020' }), ...others]);
    const saved = JSON.parse(readFileSync(join(api.root, 'data/drop', s.id, 'session.json'), 'utf8')) as DropSession;
    assert.deepEqual(saved.rows.map((r) => [r.name, r.state]).sort(), [['beleg-1.pdf', 'taken'], ['beleg-2.pdf', 'taken'], ['beleg-3.pdf', 'taken'], ['beleg-4.pdf', 'taken'], ['oktober.xml', 'taken']], 'no request\'s change is lost');
    await rest();

    // The same file dropped again later and answered: it is read in already, said so (not «nicht gespeichert»), with the way to its statement.
    let again = await post('/api/drop');
    again = await post(`/api/drop/${again.id}/files?name=oktober-kopie.xml`, Buffer.from(camt(AT_80808, { name: 'Raiffeisenbank Beispiel' }, SEVEN)));
    again = await post(`/api/drop/${again.id}/files?name=oktober-kopie-2.xml`, Buffer.from(camt(AT_80808, { name: 'Raiffeisenbank Beispiel' }, SEVEN)));
    assert.deepEqual(again.rows.map((r) => [r.state, r.reason]), [['asks', 'not-imported'], ['duplicate', 'duplicate']], 'the same bytes twice in one drop ask once');
    again = await post(`/api/drop/${again.id}/rows/${again.rows[0].key}`, { kind: 'account', account: '1020' });
    const dup = again.rows[0];
    assert.deepEqual([dup.state, dup.reason, dup.readAs?.file, dup.message, dup.chooseAccount], ['duplicate', 'statement-read', 'Raiffeisen/oktober.xml', undefined, undefined], 'names the file that holds it');
    assert.match(dup.readAs?.ref ?? '', /^R-/, 'its first payment opens the statement');
  } finally {
    await api.stop();
  }
});
