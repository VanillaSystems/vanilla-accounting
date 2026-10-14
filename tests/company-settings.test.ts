/**
 * The Firma page's writes (src/workspace/manifest-write.ts, accounts-write.ts): a change lands on
 * the known fields only; comments, layout and fields the app does not know stay (ADR 0004); a
 * change the manifest's reader refuses is never written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { patchManifest, patchManifestText } from '../src/workspace/manifest-write.js';
import { setAccountName } from '../src/workspace/accounts-write.js';
import { MANIFEST_FILE, workspacePaths, WorkspaceError } from '../src/workspace/workspace.js';
import { DEMO_ROOTS } from './support/workspace.js';
import { startApi } from './support/api-server.js';
import type { CompanyInfo } from '../src/books/company.js';

const MANIFEST = `# Muster GmbH: hand-kept, keep this comment
schema: 1
company:
  name: Muster GmbH # the legal name
  uid: CHE-123.456.789
  owner: Anna Muster
  address: { street: Weg, number: "1", postcode: "8000", town: Zürich, country: CH, floor: "2" }
  vat: { method: effective, reporting: received }
  futureField: keep me
bankAccounts:
  - { bank: Raiffeisen, currency: CHF, account: "1021", label: Bank, statements: camt053, iban: CH6580808000000000001, note: x }
  - { bank: manual, currency: CHF, account: "2451", label: Kontokorrent }
somethingNew: { nested: [1, 2] }
`;

const at = (path: string) => join(mkdtempSync(join(tmpdir(), 'belege-firma-')), path);

test('an empty change writes every demo manifest back byte for byte', () => {
  for (const root of DEMO_ROOTS) {
    const text = readFileSync(join(root, MANIFEST_FILE), 'utf8');
    assert.equal(patchManifestText(text, {}, root).text, text, root);
  }
});

test('profile: changed fields land, comments, unknown fields and the one-line style stay', () => {
  const { text, manifest } = patchManifestText(MANIFEST, {
    company: { owner: 'Beat Beispiel', business: 'Kaffee', address: { street: 'Gasse', number: '5', postcode: '3000', town: 'Bern', country: 'CH' } },
  }, 'm.yaml');
  assert.equal(manifest.company.owner, 'Beat Beispiel');
  assert.deepEqual(manifest.company.address, { street: 'Gasse', number: '5', postcode: '3000', town: 'Bern', country: 'CH' });
  const raw = parse(text);
  assert.equal(raw.company.futureField, 'keep me');
  assert.equal(raw.company.address.floor, '2', 'an unknown address field stays');
  assert.deepEqual(raw.somethingNew, { nested: [1, 2] });
  assert.equal(raw.company.address.postcode, '3000', 'a postcode stays text');
  assert.match(text, /^# Muster GmbH: hand-kept, keep this comment/);
  assert.match(text, /name: Muster GmbH # the legal name/);
  assert.match(text, /address: \{ street: Gasse/);
  assert.equal(raw.bankAccounts[0].note, 'x');
});

test('business removed with null; a bank label and IBAN changed; a new bank written like its neighbours', () => {
  const { text, manifest } = patchManifestText(MANIFEST.replace('  owner: Anna Muster\n', '  owner: Anna Muster\n  business: Kaffee\n'), {
    company: { business: null },
    banks: [{ bank: 'Raiffeisen', currency: 'CHF', label: 'Raiffeisen Geschäft', iban: 'ch65 8080 8000 0000 0000 1' }],
    addBank: { bank: 'Wise', currency: 'eur', account: '1023', label: 'Wise EUR', iban: 'BE29 9670 0000 0164' },
  }, 'm.yaml');
  assert.equal(manifest.company.business, undefined);
  assert.equal(manifest.bankAccounts[0].label, 'Raiffeisen Geschäft');
  assert.equal(manifest.bankAccounts[0].iban, 'CH6580808000000000001');
  assert.deepEqual(manifest.bankAccounts[2], { bank: 'Wise', currency: 'EUR', account: '1023', label: 'Wise EUR', statements: 'wise', iban: 'BE29967000000164' });
  assert.match(text, /- \{ bank: Wise, currency: EUR, account: "1023", label: Wise EUR, iban: BE29967000000164 \}/);
});

test('refused: a UID of the wrong shape, an IBAN with wrong check digits, a bank listed twice, an unknown bank; the file stays as it was', () => {
  const path = at('belege.workspace.yaml');
  writeFileSync(path, MANIFEST);
  const refusals = [
    { company: { uid: 'CHE-123' } },
    { banks: [{ bank: 'Raiffeisen', currency: 'CHF', iban: 'CH6580808000000000002' }] },
    { addBank: { bank: 'Raiffeisen', currency: 'CHF', account: '1022', label: 'zweimal' } },
    { banks: [{ bank: 'Post', currency: 'CHF', label: 'x' }] },
    { company: { name: '  ' } },
  ];
  for (const patch of refusals) assert.throws(() => patchManifest(path, patch), WorkspaceError, JSON.stringify(patch));
  assert.equal(readFileSync(path, 'utf8'), MANIFEST);
});

test('chart: a rename keeps the account\'s other fields; a new account goes in number order', () => {
  const root = mkdtempSync(join(tmpdir(), 'belege-chart-'));
  const paths = workspacePaths(root);
  mkdirSync(paths.masterData);
  writeFileSync(paths.accounts, JSON.stringify([{ number: '1020', name: 'Bank', group: 'liquid' }, { number: '3200', name: 'Ertrag' }], null, 2));
  assert.deepEqual(setAccountName({ paths }, '1020', ' Bank Raiffeisen '), { number: '1020', name: 'Bank Raiffeisen', added: false });
  assert.deepEqual(setAccountName({ paths }, '1100', 'Debitoren'), { number: '1100', name: 'Debitoren', added: true });
  assert.deepEqual(JSON.parse(readFileSync(paths.accounts, 'utf8')), [
    { number: '1020', name: 'Bank Raiffeisen', group: 'liquid' }, { number: '1100', name: 'Debitoren' }, { number: '3200', name: 'Ertrag' },
  ]);
  assert.throws(() => setAccountName({ paths }, '110', 'x'), WorkspaceError);
  assert.throws(() => setAccountName({ paths }, '1100', ' '), WorkspaceError);
});

test('API: PATCH /api/workspace answers and serves the changed manifest at once; a refused change answers 400 and keeps the file', async () => {
  const api = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const changed = await api.send('PATCH', '/api/workspace', { company: { owner: 'Beat Beispiel' }, banks: [{ bank: 'Wise', currency: 'EUR', label: 'Wise Euro' }] });
    assert.equal(changed.status, 200);
    const now = (await api.send('GET', '/api/workspace')).json as unknown as CompanyInfo;
    assert.equal(now.company.owner, 'Beat Beispiel');
    assert.equal(now.bankAccounts.find((b) => b.bank === 'Wise')?.label, 'Wise Euro');
    const before = readFileSync(join(api.root, MANIFEST_FILE), 'utf8');
    const refused = await api.send('PATCH', '/api/workspace', { company: { uid: 'CHE-1' } });
    assert.equal(refused.status, 400);
    assert.match(String(refused.json.error), /company\.uid/);
    assert.equal(readFileSync(join(api.root, MANIFEST_FILE), 'utf8'), before);
  } finally {
    api.stop();
  }
});

const INVOICING = `${MANIFEST}invoicing:
  payTo:
    CHF: { account: "1021" }
  revenueAccount: "3400"
  layout: { accent: "#5a3a22", logo: invoices/logo.svg }
  texts:
    de: { closing: "Zahlbar innert {days} Tagen." }
`;

test('Rechnungslayout: layout fields, elements and texts land in the invoicing block; null takes the app default again', () => {
  const { text, manifest } = patchManifestText(INVOICING, {
    invoicing: {
      layout: { font: 'Helvetica', window: 'left', logo: null, logoSize: 'l', show: { footer: false, qrBill: true } },
      texts: { de: { closing: null, intro: 'Gerne verrechnen wir:' }, fr: { closing: 'Payable à {days} jours.' } },
    },
  }, 'm.yaml');
  const l = manifest.invoicing!.layout;
  assert.deepEqual([l.font, l.window, l.logo, l.logoSize, l.accent, l.show.footer, l.show.qrBill, l.show.logo], ['Helvetica', 'left', undefined, 'l', '#5a3a22', false, true, true]);
  assert.deepEqual(manifest.invoicing!.texts, { de: { intro: 'Gerne verrechnen wir:' }, fr: { closing: 'Payable à {days} jours.' } });
  assert.match(text, /^# Muster GmbH: hand-kept, keep this comment/);
  assert.equal(parse(text).bankAccounts[0].note, 'x');
});

test('Rechnungslayout refused: no invoicing block, a colour that is none, a font the app does not ship', () => {
  assert.throws(() => patchManifestText(MANIFEST, { invoicing: { layout: { font: 'Inter' } } }, 'm.yaml'), /no invoicing block/);
  assert.throws(() => patchManifestText(INVOICING, { invoicing: { layout: { accent: 'blue' } } }, 'm.yaml'), /accent/);
  assert.throws(() => patchManifestText(INVOICING, { invoicing: { layout: { font: 'Comic Sans' as never } } }, 'm.yaml'), /font/);
});

test('API: a logo upload is stored by its checksum and becomes the layout\'s logo; only a layout\'s logo is served', async () => {
  const api = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="10"><rect width="40" height="10"/></svg>';
    const up = await fetch(`http://127.0.0.1:${api.port}/api/workspace/logo`, { method: 'POST', headers: { 'Content-Type': 'image/svg+xml' }, body: svg });
    assert.equal(up.status, 200);
    const info = await up.json() as CompanyInfo;
    const logo = info.invoicing!.layout.logo!;
    assert.match(logo, /^logos\/logo-[0-9a-f]{12}\.svg$/);
    assert.equal(readFileSync(join(api.root, logo), 'utf8'), svg);
    assert.match(readFileSync(join(api.root, MANIFEST_FILE), 'utf8'), new RegExp(`logo: ${logo.replace('.', '\\.')}`));
    const served = await fetch(`http://127.0.0.1:${api.port}/api/invoice-logo?path=${encodeURIComponent(logo)}`);
    assert.equal(await served.text(), svg);
    assert.equal((await api.send('GET', '/api/invoice-logo?path=books.json')).status, 404, 'no other file of the workspace');
    const bad = await fetch(`http://127.0.0.1:${api.port}/api/workspace/logo`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(bad.status, 400);
    const layout = await api.send('PATCH', '/api/workspace', { invoicing: { layout: { logo: null, accent: '#0f766e' }, texts: { de: { intro: 'Hallo' } } } });
    assert.equal(layout.status, 200);
    const now = (await api.send('GET', '/api/workspace')).json as unknown as CompanyInfo;
    assert.deepEqual([now.invoicing!.layout.logo, now.invoicing!.layout.accent, now.invoicing!.texts.de?.intro], [undefined, '#0f766e', 'Hallo']);
  } finally {
    api.stop();
  }
});
