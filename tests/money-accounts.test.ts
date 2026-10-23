/**
 * Money accounts as equals (#88): the manifest's roles (schema 2), the books at schema 3, a
 * movement's money account and whether a statement confirms it, and a statement imported after
 * movements made by hand: its rows are matched to them, never added beside them.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseDocument } from 'yaml';
import type { BankTransaction, Index } from '../src/types/index.js';
import { BOOKS_MIGRATIONS, BOOKS_SCHEMA, MANIFEST_MIGRATIONS, SchemaTooNewError, WORKSPACE_SCHEMA, climb } from '../src/workspace/schema.js';
import { parseManifest } from '../src/workspace/manifest.js';
import { patchManifestText } from '../src/workspace/manifest-write.js';
import { accountOf, bankAccountFor, byStatement, madeByHand, roleOf, UnknownMoneyAccountError } from '../src/workspace/money-accounts.js';
import type { LedgerBankAccount } from '../src/workspace/workspace.js';
import { APP_FOLDER, workspaceAt } from '../src/workspace/workspace.js';
import { upgradeWorkspace } from '../src/workspace/upgrade.js';
import { loadBooks, saveBooks, sealsOf } from '../src/books/store.js';
import { MATCH_DAYS, matchStatementRows, mergeIndex, type Scan } from '../src/books/bank-import.js';
import { DEMO_ROOTS } from './support/workspace.js';
import { testIban } from './support/iban.js';
import { startApi, type ApiServer } from './support/api-server.js';

const OLD_MANIFEST = `# kept by hand
schema: 1
company:
  name: Muster GmbH
  uid: CHE-123.456.789
  owner: Anna Muster
  vat: { method: effective, reporting: received }
bankAccounts:
  - { bank: Raiffeisen, currency: CHF, account: "1021", label: Raiffeisen, statements: camt053 }
  - { bank: Kreditkarte, currency: CHF, account: "2030", label: Visa }
  - { bank: manual, currency: CHF, account: "2451", label: Kontokorrent Anna }
`;

test('manifest 1 → 2: each account gets the role it had, the comments stay, and a second climb changes nothing', () => {
  const m = parseManifest(OLD_MANIFEST, 'belege.workspace.yaml');
  assert.deepEqual(m.bankAccounts.map((a) => `${a.bank} ${a.role}`), ['Raiffeisen bank', 'Kreditkarte card', 'manual owner']);
  const once = climb(parseDocument(OLD_MANIFEST), 1, WORKSPACE_SCHEMA, MANIFEST_MIGRATIONS, 'm', (d) => d.clone());
  const twice = climb(parseDocument(once.toString()), 1, WORKSPACE_SCHEMA, MANIFEST_MIGRATIONS, 'm', (d) => d.clone());
  assert.equal(twice.toString(), once.toString(), 'a role a manifest names is never replaced');
  // A change from the Firma page writes the old manifest at the current schema, its comment and one-line style kept.
  const { text } = patchManifestText(OLD_MANIFEST, {}, 'belege.workspace.yaml');
  assert.match(text, /^# kept by hand\nschema: 2\n/);
  assert.match(text, /- \{ bank: manual, currency: CHF, account: "2451", label: Kontokorrent Anna, role: owner \}/);
  assert.equal(patchManifestText(text, {}, 'belege.workspace.yaml').text, text, 'idempotent: the written manifest changes no further');
});

test('manifest 2 refuses an account without role, `manual` as anything but the owner, and two owners', () => {
  const v2 = patchManifestText(OLD_MANIFEST, {}, 'm').text;
  assert.throws(() => parseManifest(v2.replace(', role: bank', ''), 'm'), /bankAccounts\[0\]\.role must be one of/);
  assert.throws(() => parseManifest(v2.replace('role: owner', 'role: cash'), 'm'), /the label manual is the owner's account/);
  assert.throws(() => parseManifest(v2.replace('role: card', 'role: owner'), 'm'), /one account at most has the role owner/);
  const own = testIban('00762011623852957');
  const iban = parseManifest(v2.replace('label: Kontokorrent Anna, role: owner', `label: Kontokorrent Anna, role: owner, iban: ${own}`), 'm');
  assert.equal(iban.bankAccounts[2].iban, own, 'the owner\'s account carries the owner\'s own IBAN');
});

const ACCOUNTS: LedgerBankAccount[] = [
  { bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Raiffeisen', role: 'bank' },
  { bank: 'Kasse', currency: 'CHF', account: '1000', label: 'Kasse', role: 'cash' },
  { bank: 'Lea', currency: 'CHF', account: '2270', label: 'Lea Muster', role: 'employee' },
  { bank: 'manual', currency: 'CHF', account: '2451', label: 'Kontokorrent', role: 'owner' },
];

test('a movement\'s money account: by label and currency, the owner\'s in any currency, an unknown one refused', () => {
  assert.equal(bankAccountFor({ bank: 'Kasse', currency: 'CHF' }, ACCOUNTS), '1000');
  assert.equal(roleOf({ bank: 'Lea', currency: 'CHF' }, ACCOUNTS), 'employee');
  assert.equal(accountOf({ bank: 'manual', currency: 'EUR' }, ACCOUNTS)?.account, '2451');
  assert.throws(() => bankAccountFor({ ref: 'X1', bank: 'PayPal', currency: 'CHF' }, ACCOUNTS), (e: Error) => e instanceof UnknownMoneyAccountError && /X1 moved on PayPal CHF/.test(e.message), 'never the first bank account');
});

test('one predicate: a statement row and a hand movement a row confirmed are confirmed; a hand movement alone is not', () => {
  const row = { source: undefined, statement: undefined };
  assert.deepEqual([byStatement(row), byStatement({ source: 'manual' }), byStatement({ source: 'manual', statement: 'R1' })], [true, false, true]);
  assert.deepEqual([madeByHand(row), madeByHand({ source: 'manual' })], [false, true]);
});

test('books 2 → 3: every record keeps every byte, an app of schema 2 refuses the books', () => {
  const books = { schema: 2, config: { closedThrough: '2026-03-31' }, transactions: [{ ref: 'M1', bank: 'manual', source: 'manual', date: '2026-02-01', amount: 5, currency: 'CHF', direction: 'DBIT', description: 'x' }], journalEntries: [], mappings: [] };
  const clone = (d: Record<string, unknown>) => structuredClone(d);
  const now = climb<Record<string, unknown>>(books, 2, BOOKS_SCHEMA, BOOKS_MIGRATIONS, 'ledger.json', clone);
  assert.deepEqual(now, books);
  assert.throws(() => climb(now, 3, 2, BOOKS_MIGRATIONS, 'ledger.json', clone), (e: Error) => e instanceof SchemaTooNewError && /schema 3; this version of the app reads up to 2/.test(e.message));
});

/** Every file under `dir`, by path, as bytes in hex: to prove what a step left alone. */
function filesOf(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f !== 'data') walk(p); } else out.set(relative(dir, p), readFileSync(p).toString('hex'));
    }
  };
  walk(dir);
  return out;
}

for (const root of DEMO_ROOTS) {
  const name = relative(join(root, '..', '..'), join(root, '..'));
  test(`${name}: a copy of the books before #88 migrates; every seal verifies, every record keeps every byte, a second run changes nothing`, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'money-migrate-'));
    const ws = join(repo, APP_FOLDER);
    cpSync(root, ws, { recursive: true });
    // The workspace as the app before #88 wrote it: manifest 1 without roles, books 2.
    const manifest = join(ws, 'belege.workspace.yaml');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^schema: \d+$/m, 'schema: 1').replace(/, role: \w+/g, ''));
    const ledger = join(ws, 'ledger.json');
    writeFileSync(ledger, readFileSync(ledger, 'utf8').replace(/"schema": \d+/, '"schema": 2'));
    const before = filesOf(ws);

    const { done } = await upgradeWorkspace(workspaceAt(ws));
    assert.deepEqual(done.map((u) => [relative(ws, u.file), u.from, u.to]), [['belege.workspace.yaml', 1, WORKSPACE_SCHEMA], ['ledger.json', 2, BOOKS_SCHEMA]]);
    const after = filesOf(ws);
    const changed = [...after.keys()].filter((f) => after.get(f) !== before.get(f)).sort();
    assert.deepEqual(changed, ['belege.workspace.yaml', 'ledger.json'], 'no book record, seal, filing or receipt changed');
    assert.equal(readFileSync(manifest, 'utf8'), readFileSync(join(root, 'belege.workspace.yaml'), 'utf8'), 'the migrated manifest is the one the app ships');
    const books = loadBooks(workspaceAt(ws));
    const seals = sealsOf(books).checks;
    assert.ok(seals.every((c) => c.status === 'intact'), seals.map((c) => `${c.quarter} ${c.status}`).join(', '));
    assert.equal(books.schema, BOOKS_SCHEMA);
    assert.deepEqual((await upgradeWorkspace(workspaceAt(ws))).done, [], 'idempotent');
    assert.deepEqual(filesOf(ws), after);
    rmSync(repo, { recursive: true, force: true });
  });
}

// ─── A statement imported after movements made by hand ─────────────────────

const tx = (t: Partial<BankTransaction> & Pick<BankTransaction, 'ref'>): BankTransaction =>
  ({ bank: 'Raiffeisen', currency: 'CHF', direction: 'DBIT', amount: 42.5, date: '2026-08-10', description: t.ref, ...t });
const hand = (t: Partial<BankTransaction> & Pick<BankTransaction, 'ref'>) => tx({ source: 'manual', ...t });
const open = () => false;

const index = (transactions: BankTransaction[], closedThrough?: string): Index =>
  ({ receipts: [], transactions, mappings: [], bankStatements: [], journalEntries: [], config: closedThrough ? { closedThrough } : {} }) as Index;
const scan = (rows: BankTransaction[]): Scan => ({ receipts: [], bankTransactions: rows, wiseRefs: new Map(), bankStatements: [], camtBalances: [] });

test('a row confirms the hand movement of its account, direction and amount within the days; the closest day wins', () => {
  const rows = [tx({ ref: 'R1', date: '2026-08-12', description: 'Belastung Papeterie Muster' })];
  const books = [hand({ ref: 'M1', date: '2026-08-02' }), hand({ ref: 'M2', date: '2026-08-11' }), hand({ ref: 'M3', date: '2026-08-11', bank: 'Kasse' }), hand({ ref: 'M4', date: '2026-08-11', direction: 'CRDT' }), hand({ ref: 'M5', date: '2026-08-11', amount: 42.55 })];
  assert.deepEqual([...matchStatementRows(rows, books, open)], [['M2', 'R1']]);
  assert.deepEqual([...matchStatementRows([tx({ ref: 'R9', date: '2026-08-25' })], [hand({ ref: 'M9', date: `2026-08-${String(25 - MATCH_DAYS - 1).padStart(2, '0')}` })], open)], [], 'too far apart');
  assert.deepEqual([...matchStatementRows([tx({ ref: 'R', counterparty: 'Swisscom AG' })], [hand({ ref: 'M', counterparty: 'Papeterie Muster' })], open)], [], 'two names that share no word');
  assert.deepEqual([...matchStatementRows([tx({ ref: 'R', description: 'Papeterie Muster' }), tx({ ref: 'S', description: 'Kiosk' })], [hand({ ref: 'M', description: 'Kiosk am Bahnhof' })], open)], [['M', 'S']], 'on the same day the pair whose texts share a word');
  assert.deepEqual([...matchStatementRows(rows, [hand({ ref: 'M', date: '2026-06-30' })], (d) => d <= '2026-06-30')], [], 'a filed movement keeps every byte');
});

test('mergeIndex: the matched row is no new movement, a re-import adds nothing, a statement gone takes the confirmation back', () => {
  const m = hand({ ref: 'M2026-001', date: '2026-08-09', description: 'Druckerpapier' });
  const rows = [tx({ ref: 'R1', date: '2026-08-10' }), tx({ ref: 'R2', amount: 99, date: '2026-08-11' })];
  const first = mergeIndex(index([m]), scan(rows)).index;
  assert.deepEqual(first.transactions.map((t) => [t.ref, t.statement]), [['R2', undefined], ['M2026-001', 'R1']]);
  const again = mergeIndex(first, scan(rows)).index;
  assert.deepEqual(again.transactions, first.transactions, 'idempotent: the row the movement took is not added again');
  const gone = mergeIndex(again, scan([rows[1]])).index;
  assert.deepEqual(gone.transactions.map((t) => [t.ref, t.statement]), [['R2', undefined], ['M2026-001', undefined]], 'the movement stays, unconfirmed');
  const filed = hand({ ref: 'M2026-000', date: '2026-06-30' });
  const kept = mergeIndex(index([filed], '2026-06-30'), scan([tx({ ref: 'R0', date: '2026-07-02' })])).index;
  assert.deepEqual(kept.transactions.find((t) => t.ref === 'M2026-000'), filed, 'a filed hand movement keeps every byte');
});

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json'); });
after(() => api?.stop());

const camt = (date: string, amount: string) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>S-HAND</MsgId><CreDtTm>${date}T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>S-HAND</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>
<Ntry><Amt Ccy="CHF">${amount}</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>${date}</Dt></BookgDt><AcctSvcrRef>REF-HAND</AcctSvcrRef><AddtlNtryInf>Belastung Druckerei</AddtlNtryInf></Ntry>
<Ntry><Amt Ccy="CHF">3.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>${date}</Dt></BookgDt><AcctSvcrRef>REF-FEE</AcctSvcrRef><AddtlNtryInf>Gebühr</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

test('API: a cash purchase adds the cash box with its first movement; a bank payment typed in is confirmed by the statement read later, once', async () => {
  const cash = await api.send('POST', '/api/transactions/manual', { date: '2026-08-04', description: 'Briefmarken', amount: 11, account: '1000', role: 'cash', label: 'Kasse' });
  assert.equal(cash.status, 200, JSON.stringify(cash.json));
  const manifest = readFileSync(api.ws.paths.manifest, 'utf8');
  assert.match(manifest, /- \{ bank: Kasse, currency: CHF, account: "1000", label: Kasse, role: cash \}/, 'the cash box appears when first used');
  const chart = JSON.parse(readFileSync(join(api.ws.paths.root, 'master-data/accounts.json'), 'utf8')) as Array<{ number: string; name: string }>;
  assert.equal(chart.find((a) => a.number === '1000')?.name, 'Kasse', 'its ledger account joins the chart');
  const unknown = await api.send('POST', '/api/transactions/manual', { date: '2026-08-04', description: 'x', amount: 1, account: '1999' });
  assert.equal(unknown.status, 400, 'an account the firm lacks needs its role and label');

  const typed = await api.send('POST', '/api/transactions/manual', { date: '2026-08-18', description: 'Druckerei Muster', amount: 230.4, account: '1021' });
  assert.equal(typed.status, 200, JSON.stringify(typed.json));
  const ref = typed.json.ref as string;
  const up = await api.fetch(`/api/statements?name=${encodeURIComponent('hand.xml')}`, { method: 'POST', body: camt('2026-08-20', '230.40') });
  const json = await up.json() as Record<string, unknown>;
  assert.equal(up.status, 200, JSON.stringify(json));
  assert.deepEqual([json.added, json.confirmed], [1, 1], 'the fee is new; the payment typed in is matched, not added');
  const books = loadBooks(workspaceAt(api.ws.paths.root));
  const own = books.transactions.filter((t) => t.bank === 'Raiffeisen' && Math.abs(t.amount) === 230.4);
  assert.deepEqual(own.map((t) => [t.ref, t.source, t.statement]), [[ref, 'manual', 'REF-HAND']], 'one movement: its origin kept, confirmed by the row');
  assert.equal(books.transactions.find((t) => t.ref === (cash.json.ref as string))?.bank, 'Kasse');

  const removed = await api.send('DELETE', '/api/statements/Raiffeisen/hand.xml');
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  const back = loadBooks(workspaceAt(api.ws.paths.root)).transactions.find((t) => t.ref === ref);
  assert.deepEqual([back?.source, back?.statement], ['manual', undefined], 'the statement gone, the movement stays, unconfirmed');
});
