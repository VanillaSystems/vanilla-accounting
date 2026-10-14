/**
 * Any Swiss bank's camt.053 lands on the right ledger account: the manifest routes a statement
 * by its IBAN, else by its folder and currency. Synthetic statements in the shapes UBS,
 * PostFinance and a cantonal bank export (tests/fixtures/camt053/) go through the same loader
 * extract and reconcile-balances use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bankAccountFor } from '../src/accounting/bank-accounts.js';
import { assignUniqueRefs, transactionsOf } from '../src/providers/camt053/camt053.js';
import { parseStatementBalances } from '../src/providers/camt053/statement-balances.js';
import { readBankStatements, type StatementFile } from '../src/workspace/bank-statements.js';
import { parseIban } from '../src/workspace/banks.js';
import { WorkspaceError, workspaceAt, yearPaths, type Workspace } from '../src/workspace/workspace.js';
import { testIban, withTestIbans } from './support/iban.js';
import { tempWorkspace } from './support/workspace.js';

const FIXTURES = join(import.meta.dirname, 'fixtures/camt053');
const UBS = testIban('00230000000000001');
const KB = testIban('00790000000000004');
const OTHER = testIban('00790000000000005');
/** The UBS IBAN as people write it: in groups of four. */
const UBS_GROUPED = UBS.replace(/(.{4})(?!$)/g, '$1 ');

const BANK_ACCOUNTS = `bankAccounts:
  - { bank: UBS, currency: CHF, account: "1020", label: UBS Geschäftskonto, iban: ${UBS_GROUPED} }
  - { bank: PostFinance, currency: CHF, account: "1021", label: PostFinance CHF }
  - { bank: PostFinance, currency: EUR, account: "1022", label: PostFinance EUR }
  - { bank: BEKB, currency: CHF, account: "1023", label: BEKB }
  - { bank: manual, currency: CHF, account: "2451", label: Kontokorrent }
`;

/** A workspace with the banks above and the given statement files (path under bank-statements/ → fixture). */
function workspaceWith(files: Record<string, string>, bankAccounts = BANK_ACCOUNTS): Workspace {
  const { paths } = tempWorkspace('belege-banks-');
  const manifest = readFileSync(paths.manifest, 'utf8');
  writeFileSync(paths.manifest, manifest.slice(0, manifest.indexOf('bankAccounts:')) + bankAccounts);
  for (const [to, fixture] of Object.entries(files)) {
    const statements = yearPaths(paths, '2026').statements;
    mkdirSync(dirname(join(statements, to)), { recursive: true });
    writeFileSync(join(statements, to), withTestIbans(fixture.startsWith('<') ? fixture : readFileSync(join(FIXTURES, fixture), 'utf8')));
  }
  return workspaceAt(paths.root);
}

const read = (files: StatementFile[]) => files.filter((f): f is Extract<StatementFile, { status: 'read' }> => f.status === 'read');

test('UBS, PostFinance and a cantonal bank: each statement on its ledger account, refs unique, OPBD + movements = CLBD', () => {
  const ws = workspaceWith({
    // The UBS file sits in a folder named after nothing: its IBAN routes it.
    'downloads/2026-07 Kontoauszug.xml': 'ubs_camt053_001_04.xml',
    'PostFinance/camt053_20260731.xml': 'postfinance_camt053_001_08.xml',
    'bekb/KB-2026-07.XML': 'kantonalbank_camt053_001_04.xml',
  });
  const files = readBankStatements(ws);
  assert.deepEqual(files.map((f) => f.status), ['read', 'read', 'read', 'read']);
  assert.deepEqual(read(files).map((f) => `${f.statement.id} → ${f.account.account} by ${f.by}`).sort(), [
    'KB-STMT-0042 → 1023 by folder',
    'PF-20260731-CHF → 1021 by folder',
    'PF-20260731-EUR → 1022 by folder',
    'UBS-STMT-2026-07-0001 → 1020 by iban',
  ]);

  const txs = assignUniqueRefs(read(files).flatMap((f) => transactionsOf(f.statement, f.account)));
  assert.equal(new Set(txs.map((t) => t.ref)).size, txs.length, 'every ref unique');
  assert.deepEqual(txs.map((t) => `${t.ref} ${t.bank} ${t.currency} → ${bankAccountFor(t, ws.bankAccounts)}`).sort(), [
    '8000000000001AB UBS CHF → 1020',
    '8000000000002AB UBS CHF → 1020',
    '8000000000003AB UBS CHF → 1020',
    '8000000000004AB UBS CHF → 1020',
    'KB-STMT-0042#2 BEKB CHF → 1023',
    'KB-STMT-0042#3 BEKB CHF → 1023',
    'KB-TX-0001 BEKB CHF → 1023',
    'PF-NREF-0001 PostFinance CHF → 1021',
    'PF-NREF-0002 PostFinance CHF → 1021',
    'PF-NREF-0003 PostFinance EUR → 1022',
  ]);

  for (const f of read(files)) {
    const bals = parseStatementBalances(f.statement, f.account.bank, f.file);
    const open = bals.find((b) => b.type === 'OPBD')!;
    const close = bals.find((b) => b.type === 'CLBD')!;
    const cents = transactionsOf(f.statement, f.account).reduce((s, t) => s + Math.round(t.amount * 100) * (t.direction === 'CRDT' ? 1 : -1), 0);
    assert.equal(Math.round(open.amount * 100) + cents, Math.round(close.amount * 100), `${f.statement.id}: OPBD + movements = CLBD`);
    assert.equal(close.bank, f.account.bank);
  }
  rmSync(ws.paths.root, { recursive: true, force: true });
});

test('what each bank shape reads as: QR batch parts, Ustrd lines, SCOR reference, a TxDtls-only ref, a counterparty as text', () => {
  const ws = workspaceWith({
    'UBS/a.xml': 'ubs_camt053_001_04.xml',
    'PostFinance/b.xml': 'postfinance_camt053_001_08.xml',
    'BEKB/c.xml': 'kantonalbank_camt053_001_04.xml',
  });
  const txs = read(readBankStatements(ws)).flatMap((f) => transactionsOf(f.statement, f.account));
  const byRef = (ref: string) => txs.find((t) => t.ref === ref);
  assert.deepEqual(byRef('8000000000001AB'), {
    ref: '8000000000001AB', bank: 'UBS', date: '2026-07-06', amount: 1200, currency: 'CHF', direction: 'CRDT',
    description: 'Gutschrift QR-Rechnung', reference: '000000000000000000000012342',
  });
  assert.deepEqual(byRef('8000000000002AB')?.parts, [
    { amount: 500, currency: 'CHF', counterparty: 'Coworking Beispiel AG', reference: '000000000000000000000056781' },
    { amount: 250, currency: 'CHF', counterparty: 'Treuhand Muster GmbH', reference: '000000000000000000000099990' },
  ]);
  assert.deepEqual(byRef('PF-NREF-0001')?.parts?.map((p) => `${p.amount} ${p.counterparty}`), ['100 Kunde Beta GmbH', '200 Kunde Gamma AG'], 'two NtryDtls blocks are one booking');
  assert.equal(byRef('PF-NREF-0002')?.description, 'Rechnung 4711 Kundennummer 12');
  assert.equal(byRef('PF-NREF-0003')?.reference, 'RF19539007547034');
  assert.equal(byRef('KB-TX-0001')?.description, 'Lohn Juli 2026');
  assert.deepEqual(byRef('KB-STMT-0042#3'), {
    ref: 'KB-STMT-0042#3', bank: 'BEKB', date: '2026-07-30', amount: 12, currency: 'CHF', direction: 'DBIT', description: 'Beispiel Telecom AG',
  });
  rmSync(ws.paths.root, { recursive: true, force: true });
});

test('the same statement twice is read once; a camt.054 and other XML are skipped with the reason', () => {
  const ws = workspaceWith({
    'UBS/uuid_a.xml': 'ubs_camt053_001_04.xml',
    'UBS/a (1).xml': 'ubs_camt053_001_04.xml',
    'UBS/avis.xml': '<Document><BkToCstmrDbtCdtNtfctn><Ntfctn/></BkToCstmrDbtCdtNtfctn></Document>',
    'UBS/notes.xml': '<notes/>',
  });
  const files = readBankStatements(ws);
  assert.deepEqual(files.map((f) => `${f.file} ${f.status}`).sort(), [
    'UBS/a (1).xml read', 'UBS/avis.xml skipped', 'UBS/notes.xml skipped', 'UBS/uuid_a.xml duplicate',
  ]);
  const skipped = files.filter((f) => f.status === 'skipped');
  assert.match(skipped[0].reason, /camt\.054 is a booking notification/);
  assert.match(skipped[1].reason, /not a camt\.053/);
  rmSync(ws.paths.root, { recursive: true, force: true });
});

test('a statement no account takes names the fix; a folder account with another IBAN is no fallback', () => {
  const other = readFileSync(join(FIXTURES, 'ubs_camt053_001_04.xml'), 'utf8').replace('CH0000230000000000001', OTHER);
  const ws = workspaceWith({ 'UBS/other.xml': other, 'Migros Bank/x.xml': 'kantonalbank_camt053_001_04.xml' });
  const [elsewhere, inUbs] = readBankStatements(ws);
  assert.equal(elsewhere.status, 'unmatched');
  assert.match((elsewhere as { problem: string }).problem, new RegExp(`IBAN ${KB} in CHF in bank-statements/Migros Bank/ matches no bank account\\. Add \\{ bank: Migros Bank, currency: CHF, .*iban: ${KB} \\}`));
  assert.equal(inUbs.status, 'unmatched');
  assert.match((inUbs as { problem: string }).problem, new RegExp(`is in bank-statements/UBS/, but UBS CHF has IBAN ${UBS}`));
  rmSync(ws.paths.root, { recursive: true, force: true });
});

test('one folder account never takes statements of two IBANs: both would book on one ledger account', () => {
  const savings = readFileSync(join(FIXTURES, 'kantonalbank_camt053_001_04.xml'), 'utf8')
    .replace('CH0000790000000000004', OTHER).replace('KB-STMT-0042', 'KB-STMT-0043');
  const ws = workspaceWith({ 'BEKB/1.xml': 'kantonalbank_camt053_001_04.xml', 'BEKB/2.xml': savings });
  assert.deepEqual(readBankStatements(ws).map((f) => f.status), ['read', 'unmatched']);
  assert.match((readBankStatements(ws)[1] as { problem: string }).problem, new RegExp(`holds statements of two CHF accounts: IBAN ${KB} \\(BEKB/1\\.xml\\) and IBAN ${OTHER}\\. Add iban: ${KB} to BEKB CHF`));
  rmSync(ws.paths.root, { recursive: true, force: true });
});

test('the manifest checks an IBAN and keeps it without spaces', () => {
  const ws = workspaceWith({});
  assert.equal(ws.bankAccounts[0].iban, UBS);
  rmSync(ws.paths.root, { recursive: true, force: true });
  assert.equal(parseIban(UBS_GROUPED.toLowerCase()), UBS);
  const typo = UBS_GROUPED.replace(/^CH\d\d/, 'CH00');
  assert.equal(parseIban(typo), undefined, 'wrong check digits');
  assert.throws(() => workspaceWith({}, BANK_ACCOUNTS.replace(UBS_GROUPED, typo)),
    (e: Error) => e instanceof WorkspaceError && e.message.includes(`bankAccounts[0].iban "${typo}" is not an IBAN`));
  const mixed = workspaceWith({}, `bankAccounts:
  - { bank: Wise, currency: EUR, account: "1023", label: Wise EUR }
  - { bank: Wise Business, currency: USD, account: "1024", label: Wise USD, statements: wise }
  - { bank: Valiant, currency: CHF, account: "1020", label: Valiant }
  - { bank: manual, currency: CHF, account: "2451", label: Kontokorrent }
`);
  assert.deepEqual(mixed.bankAccounts.map((a) => `${a.bank} ${a.statements ?? '-'}`), ['Wise wise', 'Wise Business wise', 'Valiant camt053', 'manual -'], 'the manifest names the kind, else the bank registry');
  rmSync(mixed.paths.root, { recursive: true, force: true });
});
