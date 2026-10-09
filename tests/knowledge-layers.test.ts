/**
 * The two knowledge layers merge by field ownership: a company's binding adds to a vendor's
 * public facts and never redeclares them, and the app layer never carries a company's chart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCounterparty, companySpecific } from '../src/knowledge/layers.js';

const files = { vendor: 'processes/counterparties/acme.yaml', binding: 'counterparties/acme.yaml' };
const vendor = {
  id: 'acme', name: 'Acme', grouped: true, match: { tx: ['acme'] },
  steps: { 'booking.guide.yaml#classify': { rules: [{ id: 'acme-vendor' }] } },
};
const binding = {
  id: 'acme', accounts: ['4000'], match: { file: ['^acme-shop'] },
  steps: { 'booking.guide.yaml#classify': { rules: [{ id: 'acme-ours' }], precedents: [{ id: 'prec-acme' }] } },
};

test('a binding adds accounts, signals and rules after the vendor facts', () => {
  const cp = mergeCounterparty(vendor, binding, files);
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
  const cp = mergeCounterparty(undefined, { ...binding, name: 'Acme' }, { binding: files.binding });
  assert.equal(cp.name, 'Acme');
  assert.deepEqual(cp.accounts, ['4000']);
});

test('each field has one owner', () => {
  assert.throws(() => mergeCounterparty({ ...vendor, accounts: ['4000'] }, binding, files), /accounts are one company's chart — move them to counterparties\/acme\.yaml/);
  assert.throws(() => mergeCounterparty(vendor, { ...binding, name: 'Acme AG' }, files), /name belongs to the vendor file/);
  assert.throws(() => mergeCounterparty(vendor, { ...binding, match: { tx: ['acme'] } }, files), /match\.tx "acme" is also in processes\/counterparties\/acme\.yaml/);
});

test('the app layer refuses one company’s items', () => {
  assert.equal(companySpecific({ id: 'x', when: 'a purchase under about CHF 150', then: 'expense it', source: 'AGENTS.md § VAT code rules' }), undefined);
  assert.equal(companySpecific({ id: 'x', when: 'w', then: 't', source: 'proposed 2026-10-07 by Claude — confirm or replace' }), undefined);
  assert.match(companySpecific({ id: 'x', when: 'w', then: 't', source: 'proposed 2026-10-08 by Claude — CARD-1234567890' })!, /source .* is not generic/);
  assert.match(companySpecific({ id: 'x', when: 'w', then: 't', source: 'commit 0123abc' })!, /source .* is not generic/, 'a private commit resolves to nothing in the public repo');
  assert.match(companySpecific({ id: 'x', when: 'w', then: 't', source: 'memory — blank PDF captures' })!, /source .* is not generic/);
  assert.match(companySpecific({ id: 'x', when: 'w', then: 't', why: 'Q3 2026, CHF 12.34 output tax missed', source: 'definition' })!, /why names an amount/);
  assert.match(companySpecific({ id: 'x', when: 'transfer reference 1000000001', then: 't', source: 'definition' })!, /when names a long number/);
});
