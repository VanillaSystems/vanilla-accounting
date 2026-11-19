/**
 * The QR-bill after the SIX Implementation Guidelines v2.4 (#506, spec invoicing.md F1, P1.1): a
 * QR-IBAN and its QR reference are for CHF only; a EUR invoice carries the plain IBAN with a SCOR
 * reference. Saving a QR-IBAN under EUR warns (code `qrIbanNotChf`) and is kept only with the
 * person's «Trotzdem speichern»; an invoice once issued keeps the reference and account it printed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { issue } from '../src/invoices/rules.js';
import { issuedSheet, senderFor, type InvoicingContext } from '../src/invoices/documents.js';
import { assembleSheets, paginate, qrBillData, sheetBlocks } from '../src/invoices/sheet.js';
import { DEFAULT_LAYOUT, type Draft, type InvoiceBook, type InvoicingSettings, type Issued, type Sender } from '../src/invoices/model.js';
import { asContact, type Customer } from './support/invoice-fixtures.js';
import { prettyReference, qrIbanTakes, qrReference, referenceFor, scorReference } from '../src/providers/qr-bill/reference.js';
import { parseManifest } from '../src/workspace/manifest.js';
import { patchManifestText } from '../src/workspace/manifest-write.js';
import { MANIFEST_FILE } from '../src/workspace/workspace.js';
import { startApi } from './support/api-server.js';
import type { CompanyInfo } from '../src/books/company.js';
import './support/jurisdiction.js';
import { invoicingOn } from '../src/invoices/dated-values.js';

/** Today as the server writes it (UTC): a change without «gilt ab» holds from it. */
const TODAY = new Date().toISOString().slice(0, 10);

const QR_IBAN = 'CH4431999123000889012';
// The demo's account: the leak guard knows it as public. A EUR account at the same Swiss bank.
const EUR_IBAN = 'CH6580808000000000001';
const company = { name: 'Muster Kaffee GmbH', uid: 'CHE-123.456.789', owner: 'Anna Muster', address: { street: 'Musterstrasse', number: '1', postcode: '8000', town: 'Zürich', country: 'CH' } } as InvoicingContext['company'];
const customer: Customer = {
  id: 'cu_1', createdAt: '2026-07-01T08:00:00Z', origin: 'manual', deleted: false,
  name: 'Beispiel Bistro GmbH', address: { street: 'Ring', number: '4', postcode: '1010', town: 'Wien', country: 'AT' }, language: 'de', paymentTermsDays: 30,
};
const settings = (eur: InvoicingSettings['payTo']['EUR']): InvoicingSettings => ({
  payTo: { CHF: { account: '1021', iban: 'CH6580808000000000001', qrIban: QR_IBAN, bank: 'Raiffeisen' }, ...(eur ? { EUR: eur } : {}) },
  revenueAccount: '3400', paymentTermsDays: 30, layout: DEFAULT_LAYOUT, texts: {},
} as InvoicingSettings);
const draft = (id: string, currency: 'CHF' | 'EUR'): Draft => ({
  id, createdAt: '2026-11-16T09:00:00Z', origin: 'manual', deleted: false, status: 'draft', comments: [], kind: 'invoice', customerId: 'cu_1',
  date: '2026-11-16', currency, language: 'de', exemption: 'abroad', lines: [{ text: 'Beratung', quantity: 1, price: 1000, vatRate: 0 }],
});
function issueWith(ctx: InvoicingContext, d: Draft, invoices: Issued[] = []): Issued {
  const sender = senderFor(ctx, d.currency) as Sender;
  return { ...issue(d, { customer, sender, layout: DEFAULT_LAYOUT, invoices, now: '2026-11-16T10:00:00Z' }), pdf: { file: 'x.pdf', sha256: 'x' } };
}
const printed = (inv: Issued): string => {
  const book: InvoiceBook = { schema: 2, contacts: [asContact(customer)], invoices: [inv], articles: [], sent: [] } as InvoiceBook;
  const d = issuedSheet(book, inv);
  const blocks = sheetBlocks(d);
  return assembleSheets(d, blocks, paginate(blocks, blocks.map(() => 10), { footer: true, qrBill: true }));
};

test('the rule of v2.4: a QR-IBAN only in CHF', () => {
  assert.equal(qrIbanTakes('CHF'), true);
  assert.equal(qrIbanTakes('EUR'), false);
});

test('a EUR account without a QR-IBAN: the EUR invoice prints its plain IBAN with a SCOR reference, never QRR; CHF keeps QRR', () => {
  const ctx: InvoicingContext = { company, settings: settings({ account: '1025', iban: EUR_IBAN, bank: 'Raiffeisen' }) };
  const eur = issueWith(ctx, draft('in_e', 'EUR'));
  assert.equal(eur.reference, scorReference(eur.number));
  assert.equal(eur.sender.payTo.qrIban, undefined, 'the CHF QR-IBAN never reaches a EUR invoice');
  const sheet = printed(eur);
  assert.ok(sheet.includes(prettyReference(eur.reference)), 'the SCOR reference is on the QR-bill');
  assert.ok(!sheet.includes(prettyReference(qrReference(eur.number))), 'no QR reference');
  const chf = issueWith(ctx, draft('in_c', 'CHF'), [eur]);
  assert.equal(chf.reference, qrReference(chf.number));
});

test('a EUR QR-IBAN kept with «Trotzdem speichern» (or from before v2.4): the invoice uses it, the person decided; issued, it keeps what it printed when the account changes', () => {
  const kept: InvoicingContext = { company, settings: settings({ account: '1025', iban: EUR_IBAN, qrIban: QR_IBAN, bank: 'Raiffeisen' }) };
  const before = issueWith(kept, draft('in_1', 'EUR'));
  assert.equal(before.reference, qrReference(before.number));
  const sheetBefore = printed(before);
  // The person takes the QR-IBAN out afterwards: a new EUR invoice gets SCOR, the issued one stays as it was.
  const now: InvoicingContext = { company, settings: settings({ account: '1025', iban: EUR_IBAN, bank: 'Raiffeisen' }) };
  const after = issueWith(now, draft('in_2', 'EUR'), [before]);
  assert.equal(after.reference, scorReference(after.number));
  assert.equal(before.reference, qrReference(before.number), 'the issued reference is frozen');
  assert.equal(before.sender.payTo.qrIban, QR_IBAN, 'and the account it printed');
  assert.equal(printed(before), sheetBefore, 'the issued sheet reads the same');
  assert.equal(referenceFor(before.number, before.sender.payTo), before.reference);
});

test('a manifest written before v2.4 with a QR-IBAN under EUR still reads (the page shows the warning as a fact); the writer keeps it while the account stays and drops it with null', () => {
  const text = readFileSync(join('demo/vanilla-accounting', MANIFEST_FILE), 'utf8')
    .replace('EUR: { account: "1023" }', `EUR: { account: "1023", qrIban: ${QR_IBAN} }`);
  assert.equal(invoicingOn(parseManifest(text, 'm.yaml').invoicing!, TODAY).payTo.EUR?.qrIban, QR_IBAN);
  const same = patchManifestText(text, { invoicing: { payTo: { EUR: { account: '1023' } } } }, 'm.yaml');
  assert.equal(invoicingOn(same.manifest.invoicing!, TODAY).payTo.EUR?.qrIban, QR_IBAN, 'the same account keeps its QR-IBAN');
  const dropped = patchManifestText(text, { invoicing: { payTo: { EUR: { account: '1023', qrIban: null } } } }, 'm.yaml');
  assert.equal(invoicingOn(dropped.manifest.invoicing!, TODAY).payTo.EUR?.qrIban, undefined);
  // Written as a history: the value from the start keeps its QR-IBAN (a document dated before reads it), today's has none.
  const eur = (parse(dropped.text) as { invoicing: { payTo: { EUR: Array<{ validFrom: string; value: unknown }> } } }).invoicing.payTo.EUR;
  assert.deepEqual(eur.map((e) => [e.validFrom, e.value]), [['1900-01-01', { account: '1023', qrIban: QR_IBAN }], [TODAY, { account: '1023' }]]);
});

test('API: a QR-IBAN under EUR warns with the rule and is stored only with confirm; under CHF it is stored at once; a text that is none is refused', async () => {
  const api = await startApi('tests/fixtures/period-lock-index.json');
  try {
    const manifest = () => readFileSync(join(api.root, MANIFEST_FILE), 'utf8');
    const before = manifest();
    const warned = await api.send('PATCH', '/api/workspace', { invoicing: { payTo: { EUR: { account: '1023', qrIban: 'CH44 3199 9123 0008 8901 2' } } } });
    assert.equal(warned.status, 400);
    assert.deepEqual([warned.json.code, (warned.json as { params?: { currency?: string } }).params?.currency], ['qrIbanNotChf', 'EUR']);
    assert.match(String(warned.json.error), /v2\.4 nur für CHF.*November 2027/);
    assert.equal(manifest(), before, 'nothing written without «Trotzdem speichern»');

    const anyway = await api.send('PATCH', '/api/workspace', { invoicing: { payTo: { EUR: { account: '1023', qrIban: 'CH44 3199 9123 0008 8901 2' } }, confirm: 'qrIbanNotChf' } });
    assert.equal(anyway.status, 200);
    assert.equal(invoicingOn((anyway.json as unknown as CompanyInfo).invoicing!, TODAY).payTo.EUR?.qrIban, QR_IBAN, 'stored like any other value');
    assert.doesNotMatch(manifest(), /confirm/, 'no override is stored');

    const none = await api.send('PATCH', '/api/workspace', { invoicing: { payTo: { CHF: { account: '1021', qrIban: 'CH6580808000000000001' } } } });
    assert.equal(none.status, 400);
    assert.equal(none.json.code, 'notQrIban');

    const cleared = await api.send('PATCH', '/api/workspace', { invoicing: { payTo: { CHF: { account: '1021', qrIban: null } } } });
    assert.equal(cleared.status, 200);
    assert.equal(invoicingOn((cleared.json as unknown as CompanyInfo).invoicing!, TODAY).payTo.CHF?.qrIban, undefined);
    const chf = await api.send('PATCH', '/api/workspace', { invoicing: { payTo: { CHF: { account: '1021', qrIban: QR_IBAN } } } });
    assert.equal(chf.status, 200, 'CHF needs no confirmation');
    assert.equal(invoicingOn((chf.json as unknown as CompanyInfo).invoicing!, TODAY).payTo.CHF?.qrIban, QR_IBAN);
  } finally {
    await api.stop();
  }
});

test('the payment part carries structured addresses only (address type S, IG v2.3 chapter 4.2.2): street and number apart, postcode and town apart', () => {
  const ctx: InvoicingContext = { company, settings: settings({ account: '1025', iban: EUR_IBAN, bank: 'Raiffeisen' }) };
  const inv = issueWith(ctx, draft('in_s', 'EUR'));
  const book: InvoiceBook = { schema: 2, contacts: [asContact(customer)], invoices: [inv], articles: [], sent: [] } as InvoiceBook;
  const data = qrBillData(issuedSheet(book, inv), EUR_IBAN);
  // The library's own encoder, beside its public export (as src/desktop/qr.ts reaches its QR generator).
  const require = createRequire(import.meta.url);
  const { generateQRData } = require(join(dirname(require.resolve('swissqrbill/svg')), '..', 'shared', 'qr-code.cjs')) as { generateQRData(d: unknown): string };
  const fields = generateQRData(data).split('\n');
  // SPC, 0200, 1, IBAN, then the creditor: type, name, street, number, postcode, town, country.
  assert.deepEqual(fields.slice(3, 11), [EUR_IBAN, 'S', 'Muster Kaffee GmbH', 'Musterstrasse', '1', '8000', 'Zürich', 'CH']);
  assert.deepEqual(fields.slice(20, 27), ['S', 'Beispiel Bistro GmbH', 'Ring', '4', '1010', 'Wien', 'AT'], 'the debtor too');
  assert.ok(!fields.includes('K'), 'never a combined address');
  assert.equal(fields[27], 'SCOR');
});
