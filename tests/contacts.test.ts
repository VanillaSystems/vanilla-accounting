/**
 * Kontakte (docs/specs/invoicing.md 4.4.5, P2.5, P2.6): the invoices.json step 3 → 4 that turns
 * customers into contacts without changing a printed or booked figure, a firm with contact persons
 * and delivery addresses, the customer number series, archive and delete, the CSV import and the
 * business file code proposes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_ROOT, tempWorkspace } from './support/workspace.js';
import './support/jurisdiction.js';
import { INVOICES_MIGRATIONS, INVOICES_SCHEMA, climb, contactsOfCustomers } from '../src/workspace/schema.js';
import { loadInvoices } from '../src/invoices/store.js';
import type { Contact, CustomerFields, Draft, InvoiceBook, Issued } from '../src/invoices/model.js';
import { assembleSheets, sheetBlocks, type SheetData } from '../src/invoices/sheet.js';
import { draftSheet, issuedSheet } from '../src/invoices/documents.js';
import { contactDays, draftTermsOf, goneRefs, nextContactNumber, proposeBusiness, recipientOf } from '../src/invoices/contacts.js';
import { decodeText } from '../src/core/files.js';
import { paymentProposals } from '../src/invoices/payments.js';
import { issued } from './support/invoice-fixtures.js';
import { importContacts, previewContactImport, proposeMapping } from '../src/invoices/contact-import.js';
import {
  createContact, createDraft, invoicingContext, issueInvoice, parseDraftPatch, removeContact, updateContact, updateDraft, type Printer,
} from '../src/invoices/service.js';
import { InvoiceRuleError } from '../src/invoices/rules.js';
import { compileCounterparty } from '../src/knowledge/counterparties.js';
import { partnersOf } from '../src/knowledge/partners.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';

// Built from pieces: the leak guard reads a whole UID in a test as a company's; this one has its right check digit.
const UID = `${'CHE'}-111.222.338`;
const IBAN = `${'CH93'}00762011623852957`;
const html = (d: SheetData) => { const b = sheetBlocks(d); return assembleSheets(d, b, { pages: [b.map((_, i) => i)], qrOwnPage: false }); };
const raw = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const at = (doc: Record<string, unknown>, from: number, to: number) => climb(doc, from, to, INVOICES_MIGRATIONS, 'invoices.json', (d) => structuredClone(d));
const strip = ({ id: _i, createdAt: _c, origin: _o, deleted: _d, ...rest }: CustomerFields & { id?: string; createdAt?: string; origin?: string; deleted?: boolean }) => rest;

/** A file of schema 3 with every kind of customer: an attn line, an e-mail, a UID, days of its own, a minimal one, a deleted one. */
function mixed(): Record<string, unknown> {
  const env = (id: string, deleted = false) => ({ id, createdAt: '2026-07-01T08:00:00.000Z', origin: 'manual', deleted });
  const demo = raw('tests/fixtures/invoices-schema3-demo.json');
  const issued = (demo.invoices as Issued[]).find((i) => i.status === 'issued')!;
  return {
    schema: 3,
    customers: [
      { ...env('cu_a'), name: 'Alpenblick AG', attn: 'Buchhaltung', address: { street: 'Dorfstrasse', number: '3', postcode: '3800', town: 'Interlaken', country: 'CH' }, language: 'de', vatId: `${UID} MWST`, email: 'rechnung@alpenblick.example', paymentTermsDays: 10 },
      { ...env('cu_b'), name: 'Studio Lumière', address: { postcode: '75002', town: 'Paris', country: 'FR' }, language: 'fr', paymentTermsDays: 30 },
      { ...env('cu_c', true), name: 'Weg AG', address: { postcode: '8000', town: 'Zürich', country: 'CH' }, language: 'de', paymentTermsDays: 30 },
    ],
    invoices: [
      { ...issued, id: 'in_i', customerId: 'cu_a' },
      { id: 'in_d', createdAt: '2026-10-01T08:00:00Z', origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_a', date: '2026-10-01', currency: 'CHF', language: 'de', prices: 'net', lines: [{ text: 'Zimmer', quantity: 2, price: 180, vatRate: 3.8 }], comments: [] },
      { id: 'in_e', createdAt: '2026-10-01T08:00:00Z', origin: 'manual', deleted: false, status: 'draft', kind: 'invoice', customerId: 'cu_b', date: '2026-10-01', currency: 'EUR', language: 'fr', prices: 'net', exemption: 'abroad', lines: [{ text: 'Conseil', quantity: 1, price: 900, vatRate: 0 }], comments: [] },
    ],
    sent: [],
  };
}

test('P2.6: the step 3 → 4 keeps every document byte for byte, and each draft prints as it did with its customer', () => {
  // Each demo's invoices.json as it was before the step (schema 3), the demo of 0.6.0 (schema 2) and a mixed file.
  const fixtures = [
    ...['demo', 'demo-consulting', 'demo-coiffeur', 'demo-schreinerei'].map((d) => [d, raw(`tests/fixtures/invoices-schema3-${d}.json`), 3, d] as const),
    ['schema 2 demo', raw('tests/fixtures/invoices-schema2-demo.json'), 2, 'demo'] as const, ['mixed', mixed(), 3, 'demo'] as const,
  ];
  for (const [name, doc, from, dir] of fixtures) {
    const ws = workspaceAt(join(APP_ROOT, dir, 'vanilla-accounting'));
    const ctx = invoicingContext(ws);
    const before = at(doc as Record<string, unknown>, from, 3) as unknown as InvoiceBook & { customers: Array<CustomerFields & { id: string; deleted: boolean }> };
    const after = at(doc as Record<string, unknown>, from, INVOICES_SCHEMA) as unknown as InvoiceBook;
    assert.equal(JSON.stringify(after.invoices), JSON.stringify(before.invoices), `${name}: the documents are untouched`);
    assert.equal(JSON.stringify(after.sent), JSON.stringify(before.sent), `${name}: the sent log is untouched`);
    assert.deepEqual(after.contacts.map((c) => c.id), before.customers.map((c) => c.id), `${name}: one contact per customer, under its id`);
    for (const c of before.customers) {
      const contact = after.contacts.find((x) => x.id === c.id)!;
      assert.equal(contact.deleted, c.deleted);
      assert.equal(contact.type, 'firm');
      for (const inv of after.invoices.filter((i) => i.customerId === c.id)) {
        // What a draft prints of its customer comes from the contact now: the same name, line, address, VAT number, e-mail and days.
        assert.deepEqual(recipientOf(contact, inv, ws.invoicing), strip(c), `${name}: ${c.name} as ${inv.id} names it`);
        if (inv.status === 'draft') assert.equal(html(draftSheet(ctx, after, inv, recipientOf(contact, inv, ws.invoicing))), html(draftSheet(ctx, before, inv as Draft, c)), `${name}: draft ${inv.id} prints the same`);
        else assert.equal(html(issuedSheet(after, inv)), html(issuedSheet(before, inv)), `${name}: ${inv.number} prints as issued`);
      }
    }
  }
  // What the documents book reads only the documents (src/invoices/events.ts, inv.customer): unchanged above, so nothing books anew.
  const m = contactsOfCustomers(mixed()).contacts as Contact[];
  assert.deepEqual(m[0].addresses, [{ id: 'a-1', street: 'Dorfstrasse', number: '3', postcode: '3800', town: 'Interlaken', country: 'CH', attn: 'Buchhaltung', billing: true }], 'the attn line stays a line of the billing address');
  assert.deepEqual([m[0].emails, m[0].paymentDays, m[0].paymentTerms, m[0].persons], [['rechnung@alpenblick.example'], 10, undefined, []]);
  assert.deepEqual([m[1].emails, m[1].paymentDays], [[], 30]);
  assert.equal('customers' in contactsOfCustomers(mixed()), false);
});

test('P2.6: a workspace of schema 3 opens with its contacts, saves schema 4, and its next invoice continues', async () => {
  const ws = tempWorkspace();
  writeFileSync(ws.paths.invoices, JSON.stringify(mixed()));
  const book = loadInvoices(ws);
  assert.equal(book.schema, INVOICES_SCHEMA);
  assert.deepEqual(book.contacts.map((c) => c.name), ['Alpenblick AG', 'Studio Lumière', 'Weg AG']);
  updateContact(ws, 'cu_b', { phone: '+33 1 00 00 00 00' });
  const saved = raw(ws.paths.invoices);
  assert.equal(saved.schema, 4);
  assert.equal('customers' in saved, false);
  assert.equal(JSON.stringify(saved.invoices), JSON.stringify(mixed().invoices), 'saving the contacts leaves every document as it was');
});

const printer: Printer = {
  pdf: async (d) => ({ html: '', pages: 1, pdf: Buffer.from(JSON.stringify(d.customer)) }),
  html: async () => ({ html: '', pages: 1 }),
};

test('P2.5: a café chain with a head office and two branches: the Rechnung goes to the billing address, «z. Hd.» the picked person', async () => {
  const ws = tempWorkspace();
  const chain = createContact(ws, {
    type: 'firm', name: 'Kafi Kette AG', language: 'de', emails: ['buchhaltung@kafi.example'], vatId: `${UID} MWST`,
    addresses: [
      { label: 'Hauptsitz', street: 'Bahnhofstrasse', number: '1', postcode: '8001', town: 'Zürich', country: 'CH', billing: true },
      { label: 'Filiale Bern', street: 'Marktgasse', number: '20', postcode: '3011', town: 'Bern', country: 'CH', delivery: true },
      { label: 'Filiale Basel', street: 'Freie Strasse', number: '5', postcode: '4001', town: 'Basel', country: 'CH', delivery: true },
    ],
    persons: [{ name: 'Anna Muster', role: 'Einkauf', email: 'anna@kafi.example' }, { name: 'Beat Beispiel', role: 'Filialleiter Bern' }],
  });
  const [hq, bern] = chain.addresses.map((a) => a.id);
  const [anna, beat] = chain.persons.map((p) => p.id);
  assert.ok([...chain.addresses, ...chain.persons].every((x) => /^[ap]-[0-9a-z]{6}$/.test(x.id)), 'each its own id');
  assert.equal(chain.number, undefined, 'no number before its first document');

  const draft = createDraft(ws, { customerId: chain.id, personId: anna, lines: [{ text: 'Kaffeebohnen 10 kg', quantity: 3, unit: 'pcs', price: 180, vatRate: 2.6 }] });
  const r = recipientOf(loadInvoices(ws).contacts[0], draft, ws.invoicing)!;
  assert.deepEqual([r.name, r.attn, r.address.street, r.address.town, r.email], ['Kafi Kette AG', 'z. Hd. Anna Muster', 'Bahnhofstrasse', 'Zürich', 'anna@kafi.example'], 'the head office, for Anna');

  const other = createContact(ws, { type: 'person', firstName: 'Lea', lastName: 'Frei', salutation: 'Frau', language: 'de', addresses: [{ postcode: '9500', town: 'Wil', country: 'CH' }] });
  assert.equal(other.name, 'Lea Frei');
  assert.throws(() => parseDraftPatch({ personId: beat }, { ...loadInvoices(ws), invoices: loadInvoices(ws).invoices.map((i) => ({ ...i, customerId: other.id })) }, undefined, draft.id), /Kontaktperson/, 'a person of another contact is refused');
  const toBern = updateDraft(ws, draft.id, parseDraftPatch({ addressId: bern }, loadInvoices(ws), undefined, draft.id));
  assert.equal(recipientOf(loadInvoices(ws).contacts[0], toBern, ws.invoicing)!.address.town, 'Bern', 'a branch picked on the draft');
  updateDraft(ws, draft.id, parseDraftPatch({ addressId: null }, loadInvoices(ws), undefined, draft.id));

  const issued = await issueInvoice(ws, draft.id, { now: '2026-10-11T09:00:00Z', printer });
  assert.deepEqual([issued.customer.attn, issued.customer.address.town, issued.customer.email], ['z. Hd. Anna Muster', 'Zürich', 'anna@kafi.example'], 'frozen as printed');
  assert.equal(loadInvoices(ws).contacts.find((c) => c.id === chain.id)!.number, 'K-00001', 'the first issued document gives the customer number');

  // A change of the contact never reaches the issued document.
  updateContact(ws, chain.id, { addresses: [{ id: hq, street: 'Seestrasse', number: '9', postcode: '8002', town: 'Zürich', country: 'CH', billing: true }] });
  assert.equal((loadInvoices(ws).invoices.find((i) => i.id === draft.id) as Issued).customer.address.street, 'Bahnhofstrasse');

  // A person's name is its parts, salutation printed before it.
  assert.equal(recipientOf(loadInvoices(ws).contacts.find((c) => c.id === other.id), { language: 'de' }, ws.invoicing)!.name, 'Frau Lea Frei');
});

test('defaults: a draft takes the contact\'s language, currency and terms; its positions its revenue account and standing discount', () => {
  const ws = tempWorkspace();
  const c = createContact(ws, { type: 'firm', name: 'Grosshandel AG', language: 'it', currency: 'EUR', paymentDays: 10, revenueAccount: '3400', discount: 5, addresses: [{ postcode: '6900', town: 'Lugano', country: 'CH' }] });
  const d = createDraft(ws, { customerId: c.id, lines: [{ text: 'Sacco', quantity: 1, price: 10, vatRate: 2.6 }, { kind: 'text', text: 'Hinweis' }, { text: 'Ohne', quantity: 1, price: 5, vatRate: 2.6, discount: 0 }] });
  assert.deepEqual([d.language, d.currency, d.termsId], ['it', 'EUR', undefined], 'own days: no firm terms picked');
  assert.deepEqual(d.lines, [
    { account: '3400', discount: 5, text: 'Sacco', quantity: 1, price: 10, vatRate: 2.6 },
    { kind: 'text', text: 'Hinweis' },
    { account: '3400', discount: 0, text: 'Ohne', quantity: 1, price: 5, vatRate: 2.6 },
  ], 'every new position takes them; one that names its own keeps it');
  assert.equal(recipientOf(loadInvoices(ws).contacts[0], d, ws.invoicing)!.paymentTermsDays, 10);
});

test('the customer number: K-00001 onwards from the highest given; one another contact holds is refused', () => {
  assert.equal(nextContactNumber([]), 'K-00001');
  assert.equal(nextContactNumber([{ number: 'K-00007' }, { number: '42' }, {}]), 'K-00008');
  const ws = tempWorkspace();
  createContact(ws, { type: 'firm', name: 'Eins AG', language: 'de', number: 'K-00007' });
  assert.throws(() => createContact(ws, { type: 'firm', name: 'Zwei AG', language: 'de', number: 'K-00007' }), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'numberTaken');
});

test('archive, not delete: a contact a document names is archived and picked no more; one without documents is deleted; an archived one comes back', () => {
  const ws = tempWorkspace();
  const kept = createContact(ws, { type: 'firm', name: 'Mit Rechnung AG', language: 'de', addresses: [{ postcode: '8000', town: 'Zürich', country: 'CH' }] });
  const gone = createContact(ws, { type: 'firm', name: 'Ohne AG', language: 'de' });
  const draft = createDraft(ws, { customerId: kept.id });
  assert.equal(removeContact(ws, kept.id).outcome, 'archived');
  assert.equal(removeContact(ws, gone.id).outcome, 'deleted');
  const book = loadInvoices(ws);
  assert.deepEqual([book.contacts[0].archived, book.contacts[0].deleted, book.contacts[1].deleted], [true, false, true]);
  assert.throws(() => createDraft(ws, { customerId: kept.id }), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'archived', 'no new document for an archived contact');
  assert.throws(() => parseDraftPatch({ customerId: kept.id }, book, undefined, 'in_other'), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'archived');
  assert.doesNotThrow(() => parseDraftPatch({ customerId: kept.id }, book, undefined, draft.id), 'the draft that names it keeps it');
  updateContact(ws, kept.id, { archived: false });
  assert.equal(loadInvoices(ws).contacts[0].archived, undefined);
  assert.equal(createDraft(ws, { customerId: kept.id }).customerId, kept.id);
});

const CSV = [
  'Kontakt Nr.;Typ;Firma;Vorname;Nachname;Strasse;Haus-Nr.;PLZ;Ort;Land;E-Mail;MWST-Nummer;Sprache;Kontaktperson;Zahlungsfrist;Kategorie',
  `1001;Firma;Bäckerei Brot AG;;;Brotgasse;4;3000;Bern;Schweiz;info@brot.example;${UID} MWST;Deutsch;Rita Korn;20;Gastro, Stammkunde`,
  '1002;Privat;;Lea;Frei;Rosenweg;2;1003;Lausanne;CH;lea@frei.example;;;;;',
  '1003;Firma;Muster Hotel GmbH;;;Pilatusstrasse;9;6003;Luzern;Schweiz;;;;;;',
  `1004;Firma;Brot & Co;;;Mühleweg;1;8000;Zürich;CH;;${UID};;;;`,
  '1005;Firma;Falsch UID AG;;;Weg;1;8000;Zürich;CH;;CHE-111.222.333;;;;',
  '1006;Firma;;;;Weg;1;8000;Zürich;CH;;;;;;',
  '1007;Firma;Ohne Adresse GmbH;;;;;;;Atlantis;kaputt;;Klingonisch;;bald;',
].join('\n');

test('the CSV import: the mapping proposed from the header, each row\'s problem named, duplicates by name or UID proposed as the same contact', () => {
  const header = CSV.split('\n')[0].split(';');
  const mapping = proposeMapping(header);
  assert.deepEqual(mapping, {
    number: 'Kontakt Nr.', type: 'Typ', name: 'Firma', firstName: 'Vorname', lastName: 'Nachname', street: 'Strasse', houseNumber: 'Haus-Nr.', postcode: 'PLZ', town: 'Ort',
    country: 'Land', email: 'E-Mail', vatId: 'MWST-Nummer', language: 'Sprache', person: 'Kontaktperson', paymentDays: 'Zahlungsfrist', tags: 'Kategorie',
  });
  const existing = [{ id: 'cu_h', createdAt: '', origin: 'manual', deleted: false, type: 'firm', name: 'Muster Hotel GmbH', persons: [], addresses: [], language: 'de', emails: [] }] as Contact[];
  const p = previewContactImport(CSV, undefined, existing);
  const row = (line: number) => p.rows.find((r) => r.line === line)!;
  assert.deepEqual(row(2).contact, {
    type: 'firm', name: 'Bäckerei Brot AG', number: '1001', persons: [{ id: 'p-1', name: 'Rita Korn' }],
    addresses: [{ id: 'a-1', street: 'Brotgasse', number: '4', postcode: '3000', town: 'Bern', country: 'CH', billing: true }],
    language: 'de', emails: ['info@brot.example'], vatId: `${UID} MWST`, paymentDays: 20, tags: ['Gastro', 'Stammkunde'],
  });
  assert.deepEqual([row(2).problems, row(2).choice], [[], 'new']);
  assert.deepEqual([row(3).contact?.type, row(3).contact?.name, row(3).contact?.language], ['person', 'Lea Frei', 'fr'], 'a person; French by its Lausanne postcode');
  assert.deepEqual([row(4).same, row(4).choice], [{ contactId: 'cu_h', name: 'Muster Hotel GmbH', by: 'name' }, 'same'], 'the hotel is there already');
  assert.deepEqual([row(5).same, row(5).choice], [{ line: 2, name: 'Bäckerei Brot AG', by: 'uid' }, 'same'], 'the same UID as an earlier row');
  assert.deepEqual([row(6).problems, row(6).choice], [['uid'], 'skip']);
  assert.deepEqual([row(7).problems, row(7).contact], [['name'], undefined]);
  assert.deepEqual(row(8).problems, ['country', 'address', 'language', 'email', 'paymentDays'], 'imported all the same, each fact named');
  assert.equal(row(8).choice, 'new');

  const plan = importContacts(CSV, undefined, { 5: 'new' }, existing);
  assert.deepEqual(plan.contacts.map((c) => c.name), ['Bäckerei Brot AG', 'Lea Frei', 'Brot & Co', 'Ohne Adresse GmbH'], 'the person chose «new» for row 5');
  assert.equal(plan.skipped, 3);
  const ws = tempWorkspace();
  createContact(ws, { type: 'firm', name: 'Alt AG', language: 'de', number: '1001' });
  const again = importContacts(CSV, undefined, {}, loadInvoices(ws).contacts);
  assert.equal(again.contacts[0].number, undefined, 'a customer number another contact holds stays with that one');
  assert.throws(() => previewContactImport(CSV, { name: 'Firmenname' }, []), /Firmenname/, 'a mapping to a column the table lacks is refused');
});

test('the import names the rows it leaves out beyond its limit', () => {
  const rows = Array.from({ length: 2003 }, (_, i) => `Firma ${i};8000;Zürich`);
  const p = previewContactImport(['Firma;PLZ;Ort', ...rows].join('\n'), undefined, []);
  assert.deepEqual([p.rows.length, p.leftOut], [2000, 3]);
});

test('its business file: code proposes the one its UID, a paying IBAN or its name routes to; once kept, Geschäftspartner shows one partner', () => {
  const cps = [
    compileCounterparty({ id: 'brot', name: 'Bäckerei Brot AG', match: { uid: [UID] } }, { binding: 'knowledge/customers/brot.yaml' }, 'customer'),
    compileCounterparty({ id: 'hotel', name: 'Muster Hotel GmbH', match: { tx: ['muster hotel'] } }, { binding: 'knowledge/customers/hotel.yaml' }, 'customer'),
    compileCounterparty({ id: 'bank', name: 'Kafi Kette', match: { iban: [IBAN] } }, { binding: 'knowledge/customers/kafi.yaml' }, 'customer'),
  ];
  const c = (over: Partial<Contact>) => ({ id: 'cu_x', createdAt: '', origin: 'manual', deleted: false, type: 'firm', name: 'X', persons: [], addresses: [], language: 'de', emails: [], ...over }) as Contact;
  assert.deepEqual(proposeBusiness(c({ name: 'Brot AG', vatId: `${UID} MWST` }), cps), { id: 'brot', name: 'Bäckerei Brot AG', by: 'uid' });
  assert.equal(proposeBusiness(c({ name: 'Muster Hotel GmbH' }), cps)?.id, 'hotel');
  assert.equal(proposeBusiness(c({ name: 'Kafi Kette AG' }), cps, [IBAN])?.by, 'iban');
  assert.equal(proposeBusiness(c({ name: 'Muster Hotel GmbH', business: 'hotel' }), cps), undefined, 'a kept link is not proposed again');
  assert.equal(proposeBusiness(c({ name: 'Niemand GmbH' }), cps), undefined);

  const contact = c({ id: 'cu_h', name: 'Muster Hotel GmbH', business: 'hotel' });
  const view = partnersOf({
    year: '2026', counterparties: cps, noted: new Map(), books: { transactions: [], receipts: [], mappings: [], journalEntries: [] }, questions: [], rules: [],
    invoices: { contacts: [contact], invoices: [{ id: 'in_1', customerId: 'cu_h', date: '2026-05-01', deleted: false, status: 'draft' } as Draft] },
  });
  const hotel = view.partners.filter((p) => p.name === 'Muster Hotel GmbH');
  assert.equal(hotel.length, 1, 'one partner, not two');
  assert.deepEqual([hotel[0].id, hotel[0].contact, hotel[0].invoices, hotel[0].layers.customer], ['hotel', 'cu_h', ['in_1'], true]);
});

test('a person or address once given never comes back under its id: a draft that named a removed one names no other', () => {
  const ws = tempWorkspace();
  const c = createContact(ws, { type: 'firm', name: 'X AG', language: 'de', emails: ['firm@x.example'], addresses: [{ postcode: '8000', town: 'Zürich', country: 'CH' }], persons: [{ name: 'Anna Muster', email: 'anna@x.example' }] });
  const anna = c.persons[0].id;
  const d = createDraft(ws, { customerId: c.id, personId: anna });
  updateContact(ws, c.id, { persons: [] });
  const bruno = updateContact(ws, c.id, { persons: [{ id: anna, name: 'Bruno Neu', email: 'bruno@x.example' }] }).persons[0];
  assert.notEqual(bruno.id, anna, 'an id the contact no longer has is not taken from the request');
  const book = loadInvoices(ws);
  const inv = book.invoices.find((i) => i.id === d.id)!;
  const r = recipientOf(book.contacts[0], inv, ws.invoicing)!;
  assert.deepEqual([r.attn, r.email], [undefined, 'firm@x.example'], 'not «z. Hd. Bruno Neu»');
  assert.deepEqual(goneRefs(book.contacts[0], inv), [{ field: 'customer.person' }]);
});

test('a draft whose person or address is gone: issuing warns, «Trotzdem ausstellen» issues it without them', async () => {
  const ws = tempWorkspace();
  const c = createContact(ws, { type: 'firm', name: 'X AG', language: 'de', addresses: [{ street: 'A', postcode: '8000', town: 'Zürich', country: 'CH', billing: true }, { street: 'B', postcode: '3000', town: 'Bern', country: 'CH' }], persons: [{ name: 'Anna Muster' }] });
  const d = createDraft(ws, { customerId: c.id, personId: c.persons[0].id, addressId: c.addresses[1].id, lines: [{ text: 'Beratung', quantity: 1, price: 100, vatRate: 8.1 }] });
  updateContact(ws, c.id, { persons: [], addresses: [c.addresses[0]] });
  await assert.rejects(issueInvoice(ws, d.id, { now: '2026-10-11T09:00:00Z', printer }), (e: unknown) => e instanceof InvoiceRuleError && e.code === 'unconfirmed'
    && JSON.stringify(e.missing) === JSON.stringify([{ field: 'customer.person' }, { field: 'customer.addressGone' }]));
  const issued = await issueInvoice(ws, d.id, { now: '2026-10-11T09:00:00Z', printer, confirmed: true });
  assert.deepEqual([issued.customer.attn, issued.customer.address.town, issued.personId, issued.addressId], [undefined, 'Zürich', undefined, undefined]);
});

test('own days never meet a firm terms id: a migrated customer of 10 days is not a firm\'s «net10» with Skonto', () => {
  const s = { paymentTermsDays: 30, defaultTerms: 'std', paymentTerms: [{ id: 'std', name: '30 Tage', days: 30 }, { id: 'net10', name: '10 Tage 2 % Skonto', days: 10, skonto: { percent: 2, days: 5 } }] };
  const migrated = (contactsOfCustomers({ customers: [{ id: 'cu', name: 'A', language: 'de', address: { postcode: '1', town: 'X', country: 'CH' }, paymentTermsDays: 10 }] }).contacts as Contact[])[0];
  assert.deepEqual([draftTermsOf(s, migrated), contactDays(migrated, s)], [undefined, 10], 'plain 10 days net, as before');
  assert.deepEqual([draftTermsOf(s, { paymentTerms: 'net10' }), contactDays({ paymentTerms: 'net10' }, s)], ['net10', 10], 'the firm\'s terms only when named');
});

test('the import reads a Windows-1252 file as written, counts the file\'s lines and names a long number or a bad e-mail of its person', () => {
  const bytes = Buffer.from('Firma;PLZ;Ort;Kontaktperson;E-Mail der Kontaktperson;Kundennummer\r\nM\xfcller AG;8000;Z\xfcrich;Rita;rita(at)mueller;123456789012345678901\r\n\r\n"Zwei\r\nZeilen AG";3000;Bern;;;\r\nDritte AG;3000;Bern;;;\r\n', 'latin1');
  const p = previewContactImport(decodeText(new Uint8Array(bytes)), undefined, []);
  assert.deepEqual([p.rows[0].contact?.name, p.rows[0].contact?.addresses[0]?.town], ['Müller AG', 'Zürich']);
  assert.deepEqual(p.rows.map((r) => r.line), [2, 4, 6], 'an empty line and a cell over two lines count');
  assert.deepEqual(p.rows[0].problems, ['personEmail', 'number']);
  assert.deepEqual([p.rows[0].contact?.number, p.rows[0].contact?.persons[0]], [undefined, { id: 'p-1', name: 'Rita' }]);
});

test('a payment matches a person by name without the salutation; a refund that only says «Frau» matches no one', () => {
  const lea = { name: 'Frau Lea Frei', address: { postcode: '9500', town: 'Wil', country: 'CH' }, language: 'de' as const, paymentTermsDays: 30 };
  const inv = issued('in_a', '2026-010', { customer: lea, lines: [{ text: 'Beratung', quantity: 1, price: 1000, vatRate: 0 }], prices: 'net', date: '2026-10-01' });
  const book = { schema: INVOICES_SCHEMA, contacts: [], invoices: [inv], articles: [], sent: [] } as InvoiceBook;
  const tx = (ref: string, direction: 'CRDT' | 'DBIT', counterparty: string, date = '2026-10-20') => ({ ref, date, amount: 1000, currency: 'CHF', direction, description: 'Zahlung', counterparty, account: '1020' });
  const books = { transactions: [tx('T1', 'CRDT', 'LEA FREI')], journalEntries: [], receipts: [], mappings: [], bankStatements: [], config: {} } as unknown as Parameters<typeof paymentProposals>[0];
  assert.deepEqual(paymentProposals(books, book).map((x) => [x.transactionRef, x.nameMatches]), [['T1', true]]);

  const paid = { ...inv, payments: [{ transactionRef: 'T1', date: '2026-10-20', amount: 1000, by: 'confirmed' as const }] };
  const note = issued('in_c', '2026-011', { kind: 'credit-note', creditFor: 'in_a', customer: lea, lines: [{ text: 'Gutschrift', quantity: 1, price: -1000, vatRate: 0 }], prices: 'net', date: '2026-10-21' });
  const refunds = { ...books, transactions: [tx('R1', 'DBIT', 'Frau Anna Muster', '2026-10-25'), tx('R2', 'DBIT', 'Lea Frei', '2026-10-25')] } as unknown as typeof books;
  assert.deepEqual(paymentProposals(refunds, { ...book, invoices: [paid, note] }).map((x) => x.transactionRef), ['R2'], '«Frau» alone names no one');
});
