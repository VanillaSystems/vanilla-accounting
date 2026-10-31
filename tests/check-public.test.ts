/**
 * The leak guard (src/publish/leak-guard.ts): secrets derived from a synthetic workspace are
 * found wherever they are planted, the README may name the company and owner and nothing else,
 * and the structural half (what the public repo's CI runs) holds on this repo's public view.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileCounterparty } from '../src/knowledge/counterparties.js';
import { parseAllowlist, scan, secretsOf, type PublicFile, type SecretSources } from '../src/publish/leak-guard.js';
import { checkTree } from '../src/publish/sources.js';
import { APP_ROOT, type Company, type Uid } from '../src/workspace/workspace.js';

// The guard's own test plants IBANs and UIDs; written in parts so this file passes the guard too.
const j = (...parts: string[]) => parts.join('');
const company: Company = {
  name: 'Beispiel Velo GmbH', uid: j('CHE-', '987.654.321') as Uid, owner: 'Petra Beispiel',
  vat: { registered: true, method: 'effective', reporting: 'received', period: 'quarterly' },
};
const IBAN = j('CH93', '00762011623852957');
const sources: SecretSources = {
  company,
  mailboxes: ['buchhaltung@velobuero.ch', 'petra.beispiel@gmail.com'],
  books: {
    transactions: [
      { ref: 'CARD-1111222233', bank: 'Wise', date: '2026-07-01', amount: -214.53, currency: 'CHF', direction: 'DBIT', description: '' },
      { ref: 'WEUR000042', bank: 'Wise', date: '2026-07-02', amount: -12, currency: 'EUR', direction: 'DBIT', description: '' },
    ],
    receipts: [{
      id: '0a0b0c0d0e0f1a1b', filename: '20260701-rahmenwerk-rechnung-4711.pdf', originalFilename: 'invoice.pdf',
      extractedText: 'Kunde: max.kunde@gmail.com, Lieferant: info@vendor.example', extractionMethod: 'pdftotext',
      fileSize: 1, indexedAt: '', location: 'archived',
    }],
    journalEntries: [{ id: '1f1e1d1c1b1a0f0e', transactionRef: 'CARD-1111222233', date: '2026-07-01', accountDebit: '4000', accountCredit: '1021', amount: 214.53 }],
    bankStatements: [],
  },
  counterparties: [
    compileCounterparty({ id: 'rahmenwerk', name: 'Rahmenwerk AG', match: { tx: ['rahmenwerk'], domain: ['rahmenwerk.ch'] } }, { binding: 'knowledge/suppliers/rahmenwerk.yaml' }, 'supplier'),
    compileCounterparty({ id: 'fedex', name: 'FedEx', match: { tx: ['fedex'] } }, { vendor: 'processes/suppliers/fedex.yaml' }, 'supplier'),
  ],
  bindings: [{ id: 'fedex', match: { tx: ['fedex kundennr 77881'] } }],
  statements: [{ name: `Kontoauszug 01.07.2026 - ${IBAN} - 2026-07-31.pdf`, text: null }, { name: 'statement_98765432_EUR_2026-07-01_2026-07-31.pdf', text: null }],
  terms: ['Geheimschmiede', 'Nabe', 'Speiche*'],
};
const secrets = secretsOf(sources);
const allowlist = parseAllowlist('README.md\ntests/**\nsrc/**\ndocs/**\nprocesses/**\ndemo/**\nexamples/**\npublic/logo.png\n');
const kindsIn = (text: string, path = 'src/x.ts') =>
  scan([{ path, text }], secrets, allowlist, { requireAllowlisted: true }).map((f) => f.kind);

test('secretsOf: identity, private counterparties, bank ids and book items, never a generated ref', () => {
  const terms = new Set(secrets.map((s) => s.term.toLowerCase()));
  for (const t of ['Beispiel Velo GmbH', 'Beispiel Velo', '987654321', 'Petra Beispiel', 'rahmenwerk.ch', 'Rahmenwerk AG',
    IBAN, '98765432', 'CARD-1111222233', '0a0b0c0d0e0f1a1b', '1f1e1d1c1b1a0f0e', '20260701-rahmenwerk-rechnung-4711.pdf',
    '214.53', 'fedex kundennr 77881', 'velobuero.ch', 'max.kunde@gmail.com', 'Geheimschmiede']) {
    assert.ok(terms.has(t.toLowerCase()), `missing secret ${t}`);
  }
  for (const t of ['WEUR000042', 'FedEx', 'fedex', 'info@vendor.example', 'invoice.pdf']) assert.ok(!terms.has(t.toLowerCase()), `${t} is not a secret`);
});

test('scan: each planted secret is caught in code and in prose', () => {
  assert.deepEqual(kindsIn(`const uid = '${company.uid}';`), ['foreign-uid', 'uid']);
  assert.deepEqual(kindsIn(`<uid>${j('CHE', '987654321')}</uid>`), ['foreign-uid', 'uid']);
  assert.deepEqual(kindsIn(`// paid to ${IBAN}`), ['iban-pattern', 'iban']);
  assert.deepEqual(kindsIn('see CARD-1111222233~2026-07-01-DBIT-1.00CHF'), ['tx-ref']);
  assert.deepEqual(kindsIn('the RAHMENWERK invoice'), ['private-counterparty']);
  assert.deepEqual(kindsIn('file 20260701-rahmenwerk-rechnung-4711.pdf'), ['receipt-filename', 'private-counterparty']);
  assert.deepEqual(kindsIn('mail buchhaltung@velobuero.ch'), ['mailbox', 'company-domain', 'company-domain']);
  assert.deepEqual(kindsIn('the 214.53 charge', 'docs/a.md'), ['amount']);
  assert.deepEqual(kindsIn('// a 214.53 charge'), ['amount'], 'app code holds no figure of the books');
  assert.deepEqual(kindsIn('expect(214.53)', 'tests/x.test.ts'), [], 'a test amount may equal a real one by chance');
  assert.deepEqual(kindsIn('fees 23.50', 'src/x.ts'), [], 'only prose bans every amount');
});

test('scan: a declared term counts however short, and a trailing * finds its compounds', () => {
  assert.deepEqual(kindsIn('the Nabe order'), ['secret-term']);
  assert.deepEqual(kindsIn('Naben and Radnabe'), [], 'a plain term matches the whole word only');
  assert.deepEqual(kindsIn('"Aliexpress, Speichenmaterial"'), ['secret-term']);
  assert.deepEqual(kindsIn('Speiche\nspeichen'), ['secret-term', 'secret-term']);
  assert.deepEqual(kindsIn('Radspeiche'), [], 'the prefix still starts at a word boundary');
});

test('scan: the README may say whose books these are, nothing more', () => {
  assert.deepEqual(kindsIn('Runs the books of Beispiel Velo GmbH, built by Petra Beispiel.', 'README.md'), []);
  assert.deepEqual(kindsIn(`UID ${company.uid}`, 'README.md'), ['foreign-uid', 'uid']);
  assert.deepEqual(kindsIn('Beispiel Velo GmbH'), ['company', 'company']);
});

test('scan, structural half: allowlist, binaries, IBANs, UIDs, prose amounts and numbers', () => {
  const run = (files: PublicFile[]) => scan(files, [], allowlist, { requireAllowlisted: true }).map((f) => `${f.path} ${f.kind}`);
  assert.deepEqual(run([{ path: 'books.json', text: '{}' }]), ['books.json not-allowlisted']);
  assert.deepEqual(run([{ path: 'public/logo.png', text: null }, { path: 'demo/r.pdf', text: null }, { path: 'docs/scan.pdf', text: null }]),
    ['docs/scan.pdf binary-not-listed']);
  assert.deepEqual(run([{ path: 'src/a.ts', text: `${j('CH93', '00762011623852958')} is no IBAN, ${j('CH93 ', '0076 2011 6238 5295 7')} is` }]), ['src/a.ts iban-pattern']);
  assert.deepEqual(run([{ path: 'demo/m.yaml', text: `iban: ${IBAN}\nuid: CHE-123.456.789` },
    { path: 'src/a.ts', text: `demo ${IBAN} CHE-123.456.789, other ${j('CHE-', '111.222.333')}` }]), ['src/a.ts foreign-uid']);
  assert.deepEqual(run([{ path: 'processes/suppliers/v.yaml', text: 'uid: [CHE-447.613.666]' },
    { path: 'docs/a.md', text: 'Alibaba (CHE-447.613.666) charged 8.1%' }]), []);
  assert.deepEqual(run([{ path: 'docs/a.md', text: 'fees 23.50, order 304-9462744, rate 0.91 at 31.12, ref WEUR000042' }]),
    ['docs/a.md amount-in-prose', 'docs/a.md long-number']);
  assert.deepEqual(run([{ path: 'examples/cases/c.yaml', text: 'Total CHF 108.10, order 304-9462744' }]), ['examples/cases/c.yaml long-number'],
    'casebook figures are invented; long numbers are still refused');
  assert.deepEqual(run([{ path: 'demo/m.yaml', text: `key: x${j('sk-ant-', 'api03-', 'A'.repeat(30))}` }, { path: 'src/a.ts', text: `const k = '${j('sk-proj-', 'b'.repeat(40))}'; const s = 'sk-learn', id = 'task-${'c'.repeat(36)}';` }]),
    ['demo/m.yaml api-key', 'src/a.ts api-key'], 'an API key nowhere, a demo neither');
});

test("this repo's public view passes the structural half", () => {
  assert.deepEqual(checkTree(APP_ROOT, []), []);
});
