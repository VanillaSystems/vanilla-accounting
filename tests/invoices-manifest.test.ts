/**
 * The company's invoicing settings in belege.workspace.yaml (src/workspace/manifest.ts): where
 * customers pay (a bank account of the manifest, its IBAN, a QR-IBAN), accounts, terms, layout,
 * texts, and the company's address. Everything is checked at the boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { workspaceAt } from '../src/workspace/workspace.js';
import { tempWorkspace } from './support/workspace.js';

test('the demo invoices: QR-IBAN for CHF, the Wise IBAN for EUR, its layout and texts', () => {
  const ws = tempWorkspace('invoicing-');
  assert.deepEqual(ws.company.address, { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' });
  assert.deepEqual(ws.invoicing?.payTo, {
    CHF: { account: '1021', iban: 'CH6580808000000000001', qrIban: 'CH4431999123000889012', bank: 'Raiffeisen' },
    EUR: { account: '1023', iban: 'BE29967000000164', bank: 'Wise' },
  });
  assert.equal(ws.invoicing?.revenueAccount, '3300');
  assert.deepEqual([ws.invoicing?.layout.font, ws.invoicing?.layout.accent, ws.invoicing?.layout.logo, ws.invoicing?.layout.show.qrBill], ['Inter', '#5a3a22', 'invoices/logo.svg', true]);
  assert.match(ws.invoicing?.texts.fr?.closing ?? '', /^Payable dans les \{days\} jours\./);
});

function refused(edit: (yaml: string) => string, message: RegExp) {
  const ws = tempWorkspace('invoicing-');
  writeFileSync(ws.paths.manifest, edit(readFileSync(ws.paths.manifest, 'utf8')));
  assert.throws(() => workspaceAt(ws.paths.root), message);
}

test('refused: a currency a QR-bill cannot carry, an account that is no bank account, a plain IBAN as QR-IBAN', () => {
  refused((y) => y.replace('EUR: { account: "1023" }', 'USD: { account: "1023" }'), /invoicing\.payTo\.USD: a QR-bill is in CHF or EUR/);
  refused((y) => y.replace('EUR: { account: "1023" }', 'EUR: { account: "1021" }'), /must be a EUR account of bankAccounts/);
  refused((y) => y.replace(', iban: BE29967000000164', ''), /needs its iban to be printed on invoices/);
  refused((y) => y.replace('qrIban: CH44 3199 9123 0008 8901 2', 'qrIban: CH6580808000000000001'), /is not a QR-IBAN/);
  refused((y) => y.replace('accent: "#5a3a22"', 'accent: brown'), /accent must be a colour/);
  refused((y) => y.replace('revenueAccount: "3300"', 'revenueAccount: Ertrag'), /revenueAccount "Ertrag" must be a 4-digit ledger account/);
  refused((y) => y.replace('postcode: "8000", ', ''), /company\.address needs postcode and town/);
});

test('a workspace without an invoicing block reads as before', () => {
  const ws = tempWorkspace('invoicing-');
  writeFileSync(ws.paths.manifest, readFileSync(ws.paths.manifest, 'utf8').replace(/^invoicing:[\s\S]*$/m, ''));
  assert.equal(workspaceAt(ws.paths.root).invoicing, undefined);
});
