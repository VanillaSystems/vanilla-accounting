/**
 * The two knowledge layers merge by field ownership: a company's binding adds to a vendor's
 * public facts and never redeclares them, and the app layer never carries a company's chart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mergeCounterparty, companySpecific, loadKnowledge } from '../src/knowledge/layers.js';
import { identify } from '../src/knowledge/counterparties.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';

const files = { vendor: 'processes/suppliers/acme.yaml', binding: 'knowledge/suppliers/acme.yaml' };
const vendor = {
  id: 'acme', name: 'Acme', grouped: true, match: { tx: ['acme'] },
  steps: { 'booking.guide.yaml#classify': { rules: [{ id: 'acme-vendor' }] } },
};
const binding = {
  id: 'acme', accounts: ['4000'], match: { file: ['^acme-shop'] },
  steps: { 'booking.guide.yaml#classify': { rules: [{ id: 'acme-ours' }], precedents: [{ id: 'prec-acme' }] } },
};

test('a binding adds accounts, signals and rules after the vendor facts', () => {
  const cp = mergeCounterparty(vendor, binding, files, 'supplier');
  assert.equal(cp.name, 'Acme');
  assert.equal(cp.grouped, true);
  assert.deepEqual(cp.accounts, ['4000']);
  assert.deepEqual(cp.match.tx, ['acme']);
  assert.deepEqual(cp.match.file.map(String), ['/^acme-shop/i']);
  assert.deepEqual(cp.steps['booking.guide.yaml#classify'], {
    rules: [{ id: 'acme-vendor' }, { id: 'acme-ours' }], precedents: [{ id: 'prec-acme' }],
  });
  assert.deepEqual(cp.origin, files);
});

test('a binding with no vendor is a private counterparty', () => {
  const cp = mergeCounterparty(undefined, { ...binding, name: 'Acme' }, { binding: files.binding }, 'supplier');
  assert.equal(cp.name, 'Acme');
  assert.deepEqual(cp.accounts, ['4000']);
});

test('each field has one owner', () => {
  assert.throws(() => mergeCounterparty({ ...vendor, accounts: ['4000'] }, binding, files, 'supplier'), /accounts are one company's chart — move them to knowledge\/suppliers\/acme\.yaml/);
  assert.throws(() => mergeCounterparty(vendor, { ...binding, name: 'Acme AG' }, files, 'supplier'), /name belongs to the vendor file/);
  assert.throws(() => mergeCounterparty(vendor, { ...binding, match: { tx: ['acme'] } }, files, 'supplier'), /match\.tx "acme" is also in processes\/suppliers\/acme\.yaml/);
});

/** An app root and a workspace root holding `files` (path → YAML). */
function layers(files: Record<string, string>): { app: string; ws: string } {
  const root = mkdtempSync(join(tmpdir(), 'vanilla-layers-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { app: join(root, 'app'), ws: join(root, 'ws') };
}
const acme = 'id: acme\nname: Acme\nmatch: { tx: [acme] }\n';

test('the folder of a file is its main role; roles: names the others', () => {
  const { app, ws } = layers({
    'app/processes/suppliers/acme.yaml': `${acme}roles: [customer]\n`,
    'ws/knowledge/suppliers/acme.yaml': 'id: acme\naccounts: ["4000"]\n',
    'ws/knowledge/authorities/amt.yaml': 'id: amt\nname: Amt\nmatch: { tx: [amt] }\n',
    'ws/knowledge/customers/_example.yaml': '# a template, never read\n',
    'ws/knowledge/rules/booking.guide.yaml': 'steps: { classify: { rules: [] } }\n',
  });
  const k = loadKnowledge(app, ws);
  assert.deepEqual(k.counterparties.map((c) => [c.id, c.role, c.roles, c.accounts]), [
    ['acme', 'supplier', ['customer'], ['4000']],
    ['amt', 'authority', [], undefined],
  ]);
  assert.deepEqual(k.guides.filter((g) => g.layer === 'workspace').map((g) => g.path), ['knowledge/rules/booking.guide.yaml']);
});

test('a business has one file per layer, and both layers file it under the same role', () => {
  const twice = layers({ 'app/processes/.keep': '', 'ws/knowledge/suppliers/acme.yaml': acme, 'ws/knowledge/customers/acme.yaml': acme });
  assert.throws(() => loadKnowledge(twice.app, twice.ws), /knowledge\/suppliers\/acme\.yaml and knowledge\/customers\/acme\.yaml: one business has one file/);
  const split = layers({ 'app/processes/suppliers/acme.yaml': acme, 'ws/knowledge/customers/acme.yaml': 'id: acme\n' });
  assert.throws(() => loadKnowledge(split.app, split.ws), /processes\/suppliers\/acme\.yaml files it under suppliers — move it to knowledge\/suppliers\/acme\.yaml/);
  const self = layers({ 'app/processes/.keep': '', 'ws/knowledge/suppliers/acme.yaml': `${acme}roles: [supplier]\n` });
  assert.throws(() => loadKnowledge(self.app, self.ws), /roles: "supplier" is already its main role/);
});

test('a workspace in the layout before knowledge/ is refused, never read half', () => {
  const { app, ws } = layers({ 'app/processes/.keep': '', 'ws/counterparties/acme.yaml': acme, 'ws/policy/.keep': '' });
  assert.throws(() => loadKnowledge(app, ws), /counterparties\/ and policy\/, the layout before knowledge\/ — run npm run migrate-workspace/);
});

test('the app layer refuses one company’s items', () => {
  assert.equal(companySpecific({ id: 'x', when: 'a purchase under about CHF 150', then: 'expense it', source: 'AGENTS.md § VAT code rules' }), undefined);
  assert.equal(companySpecific({ id: 'x', when: 'w', then: 't', source: 'proposed 2026-10-07 by Claude — confirm or replace' }), undefined);
  assert.equal(companySpecific({ id: 'x', when: 'w', then: 't', source: 'AHVG Art. 14 Abs. 1; BVG Art. 66 Abs. 1' }), undefined, 'a social-insurance law is a law');
  assert.equal(companySpecific({ id: 'x', when: 'w', then: 't', source: 'OR 959b Abs. 2 Ziff. 10' }), undefined, 'the Code of Obligations is a law');
  assert.match(companySpecific({ id: 'x', when: 'w', then: 't', source: 'proposed 2026-10-08 by Claude — CARD-1234567890' })!, /source .* is not generic/);
  assert.match(companySpecific({ id: 'x', when: 'w', then: 't', source: 'commit 0123abc' })!, /source .* is not generic/, 'a private commit resolves to nothing in the public repo');
  assert.match(companySpecific({ id: 'x', when: 'w', then: 't', source: 'memory — blank PDF captures' })!, /source .* is not generic/);
  assert.match(companySpecific({ id: 'x', when: 'w', then: 't', why: 'Q3 2026, CHF 12.34 output tax missed', source: 'definition' })!, /why names an amount/);
  assert.match(companySpecific({ id: 'x', when: 'transfer reference 1000000001', then: 't', source: 'definition' })!, /when names a long number/);
});

test('a payment to an authority routes to its app file, and each tells its facts', () => {
  const { counterparties } = loadKnowledge(APP_ROOT, DEMO_ROOT);
  const route = (merchant: string) => {
    const r = identify({ uids: [], domains: [], merchant, filenames: [] }, counterparties);
    return r.kind === 'known' ? r.counterparty : r.kind;
  };
  assert.equal(route('Eidg. Steuerverwaltung ESTV, Hauptabteilung MWST'), 'estv');
  assert.equal(route('Kantonale Steuerverwaltung Musterkanton'), 'steuerverwaltung');
  assert.equal(route('Ausgleichskasse Musterkanton'), 'ausgleichskasse');
  assert.equal(route('BAZG Bern'), 'bazg');
  for (const id of ['estv', 'ausgleichskasse', 'steuerverwaltung', 'bazg']) {
    const cp = counterparties.find((c) => c.id === id)!;
    assert.equal(cp.role, 'authority', id);
    assert.ok(cp.facts.length > 0 && cp.facts.every((f) => f.source), `${id} has sourced facts`);
  }
});
