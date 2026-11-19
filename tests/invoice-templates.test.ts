/**
 * Vorlagen, texts and attachments of invoicing phase 3 (docs/specs/invoicing.md 4.4.11, P3.6) and the
 * Kontoauszug (4.4.5, P3.7), through the invoicing service on a temp workspace with a stand-in printer.
 * Sending through the SMTP path is in tests/invoice-mail.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import './support/jurisdiction.js';
import { DEMO_ROOTS, tempWorkspace } from './support/workspace.js';
import { workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { createCreditNote, createCustomer, createDraft, issueInvoice, sendStatement, statementPdf, updateDraft, type Printer } from '../src/invoices/service.js';
import { loadInvoices, saveInvoices, sha256 } from '../src/invoices/store.js';
import { patchManifest, patchManifestText } from '../src/workspace/manifest-write.js';
import { readManifest } from '../src/workspace/manifest.js';
import { fillPlaceholders, templateOf } from '../src/invoices/templates.js';
import { onLetterhead, storeAttachment } from '../src/invoices/attachments.js';
import { statementOf } from '../src/invoices/statement.js';
import { openItems } from '../src/invoices/lists.js';
import { liveDocuments } from '../src/invoices/rules.js';
import { mailText } from '../src/invoices/documents.js';
import type { SheetData } from '../src/invoices/sheet.js';
import type { Issued } from '../src/invoices/model.js';

const seen: SheetData[] = [];
const printer: Printer = {
  pdf: async (d) => { seen.push(d); return { html: '', pages: 1, pdf: Buffer.from(`%PDF-1.4 ${d.kind} ${d.number ?? ''} ${seen.length}`) }; },
  html: async () => ({ html: '', pages: 1 }),
  page: async (html) => Buffer.from(`%PDF-1.4 page ${sha256(Buffer.from(html)).slice(0, 8)}`),
};

/** A one-page PDF of `text`, a real one (pdf-lib), as a letterhead or a Rapport would be. */
async function realPdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]).drawText(text, { x: 50, y: 800, size: 12 });
  return Buffer.from(await doc.save());
}

const CUSTOMER = { name: 'Regie Muster AG', address: { street: 'Werkstrasse', number: '5', postcode: '3000', town: 'Bern', country: 'CH' }, language: 'de' as const, paymentTermsDays: 30 };
const item = (text: string, quantity: number, price: number) => ({ text, quantity, price, vatRate: 8.1, unit: 'h' });

function workspace(): Workspace {
  return workspaceAt(tempWorkspace('templates-').paths.root);
}

test('a manifest without Vorlagen has one, «Standard» of its layout; the first change of the list turns the layout into it, and a kind takes its Vorlage', () => {
  const ws = workspace();
  const before = readManifest(ws.paths.manifest).invoicing!;
  assert.deepEqual(before.templates.map((t) => [t.id, t.name]), [['standard', 'Standard']]);
  assert.equal(before.templates[0].layout.accent, '#5a3a22', 'the demo layout is the Standard\'s');
  assert.deepEqual(before.layout, before.templates[0].layout);
  // A layout change while there is one Vorlage writes invoicing.layout as before.
  patchManifest(ws.paths.manifest, { invoicing: { layout: { font: 'Helvetica' } } });
  assert.match(readFileSync(ws.paths.manifest, 'utf8'), /^ {2}layout: .*Helvetica/m);
  const after = patchManifest(ws.paths.manifest, { invoicing: { templates: { add: { id: 'regie', name: 'Regie' } } } }).invoicing!;
  const text = readFileSync(ws.paths.manifest, 'utf8');
  assert.doesNotMatch(text, /^ {2}layout:/m, 'the one layout went into the list');
  assert.deepEqual(after.templates.map((t) => [t.id, t.name, t.layout.font, t.layout.accent]), [['standard', 'Standard', 'Helvetica', '#5a3a22'], ['regie', 'Regie', 'Helvetica', '#5a3a22']]);
  const regie = patchManifest(ws.paths.manifest, { invoicing: { template: 'regie', layout: { accent: '#0f766e' }, templateTexts: { invoice: { de: { title: 'Regierapport' } } }, templateFor: { invoice: 'regie' } } }).invoicing!;
  assert.equal(regie.templates[0].layout.accent, '#5a3a22', 'Standard keeps its colour');
  assert.equal(regie.templates[1].layout.accent, '#0f766e');
  assert.equal(templateOf(regie, { kind: 'invoice' }).id, 'regie', 'the kind takes its Vorlage');
  assert.equal(templateOf(regie, { kind: 'quote' }).id, 'standard', 'a kind it names not takes the first');
  assert.equal(templateOf(regie, { kind: 'invoice', templateId: 'standard' }).id, 'standard', 'a document picks another');
  assert.equal(templateOf(regie, { kind: 'invoice', templateId: 'gone' }).id, 'regie', 'one removed since falls back');
  const removed = patchManifest(ws.paths.manifest, { invoicing: { templates: { remove: 'regie' } } }).invoicing!;
  assert.deepEqual([removed.templates.map((t) => t.id), removed.templateFor], [['standard'], {}], 'its kinds take the first again');
  assert.throws(() => patchManifest(ws.paths.manifest, { invoicing: { templates: { remove: 'standard' } } }), /last Vorlage stays/);
  assert.throws(() => patchManifestText(readFileSync(ws.paths.manifest, 'utf8').replace(/^invoicing:\n/m, 'invoicing:\n  templateFor: { invoice: nope }\n'), {}, ws.paths.manifest), /templateFor\.invoice "nope"/);
});

test('placeholders are filled in all four languages: the contact person, the number, the due date and the total', () => {
  const values = { person: 'Anna Beispiel', number: '2026-042', dueDate: '2026-12-31', total: { amount: 1234.5, currency: 'CHF' } };
  const text = '{person}: {number}, {total}, {dueDate}';
  assert.equal(fillPlaceholders(text, values, 'de'), 'Anna Beispiel: 2026-042, CHF 1’234.50, 31.12.2026');
  assert.equal(fillPlaceholders(text, values, 'fr'), 'Anna Beispiel: 2026-042, CHF 1\u202f234.50, 31.12.2026');
  assert.equal(fillPlaceholders(text, values, 'it'), 'Anna Beispiel: 2026-042, CHF 1’234.50, 31.12.2026');
  assert.equal(fillPlaceholders(text, values, 'en'), 'Anna Beispiel: 2026-042, CHF 1,234.50, 31 December 2026');
  assert.equal(fillPlaceholders('{number} {unknown}', {}, 'de'), '{number} {unknown}', 'what is not known yet stays as written');
});

test('P3.6 a second Vorlage «Regie» with the Rapport as its attachment, picked on one Rechnung: issued with its layout, title, texts and both PDFs frozen', async () => {
  const ws = workspace();
  const rapport = storeAttachment(ws, 'Rapport.pdf', await realPdf('Regierapport KW 46'), '2026-11-19');
  assert.match(rapport.file, /^transactional-data\/2026\/invoices\/files\/[0-9a-f]{12}-Rapport\.pdf$/);
  assert.deepEqual(storeAttachment(ws, 'Rapport.pdf', readFileSync(join(ws.paths.root, rapport.file)), '2026-11-19'), rapport, 'the same bytes are the same file');
  patchManifest(ws.paths.manifest, { invoicing: { templates: { add: { id: 'regie', name: 'Regie' }, attachment: { id: 'regie', value: { name: 'Rapport.pdf', file: rapport.file, kinds: ['invoice'] } } } } });
  patchManifest(ws.paths.manifest, { invoicing: { template: 'regie', layout: { accent: '#0f766e' }, templateTexts: { invoice: { de: { title: 'Regierechnung', intro: 'Guten Tag {person}\n\nFür die Arbeiten laut Rapport: Rechnung {number} über {total}, zahlbar bis {dueDate}.', mailSubject: 'Regie {number}' } } } } });
  const live = workspaceAt(ws.paths.root);
  const c = createCustomer(live, CUSTOMER);
  const plain = createDraft(live, { customerId: c.id, date: '2026-11-19', lines: [item('Beratung', 2, 150)] }, '2026-11-19T08:00:00Z');
  const regie = createDraft(live, { customerId: c.id, date: '2026-11-19', lines: [item('Regiearbeit', 10, 95)] }, '2026-11-19T08:00:00Z');
  updateDraft(live, regie.id, { templateId: 'regie' });
  const a = await issueInvoice(live, plain.id, { now: '2026-11-19T09:00:00Z', printer });
  const b = await issueInvoice(live, regie.id, { now: '2026-11-19T09:05:00Z', printer });
  assert.equal(a.layout.accent, '#5a3a22', 'the other Rechnung keeps Standard');
  assert.equal(a.attachments, undefined);
  assert.equal(b.templateId, 'regie');
  assert.equal(b.layout.accent, '#0f766e', 'its Vorlage\'s layout, frozen');
  assert.equal(b.title, 'Regierechnung');
  assert.equal(b.intro, `Guten Tag Regie Muster AG\n\nFür die Arbeiten laut Rapport: Rechnung ${b.number} über CHF 1’026.95, zahlbar bis 19.12.2026.`);
  assert.deepEqual(b.attachments, [rapport], 'the Vorlage\'s fixed attachment, with its checksum');
  assert.equal(seen.at(-1)!.title, 'Regierechnung');
  assert.equal(mailText(live.invoicing, b, { kind: 'invoice' }, 'Muster').subject, `Regie ${b.number}`, 'its Vorlage\'s mail');
  // A Vorlage changed later changes nothing issued.
  patchManifest(ws.paths.manifest, { invoicing: { template: 'regie', layout: { accent: '#141a26' } } });
  assert.equal((loadInvoices(ws).invoices.find((i) => i.id === b.id) as Issued).layout.accent, '#0f766e');
});

test('a letterhead: every page of the PDF lies on its first page, the same print gives the same bytes', async () => {
  const content = await (async () => { const d = await PDFDocument.create(); for (const k of [1, 2]) d.addPage([595.28, 841.89]).drawText(`Rechnung, Seite ${k}`, { x: 50, y: 700 }); return Buffer.from(await d.save()); })();
  const paper = await realPdf('Briefkopf Muster GmbH');
  const one = await onLetterhead(content, paper, '2026-11-19T09:00:00Z');
  const two = await onLetterhead(content, paper, '2026-11-19T09:00:00Z');
  assert.ok(one.equals(two), 'deterministic');
  const doc = await PDFDocument.load(one);
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.getCreationDate()?.toISOString(), '2026-11-19T09:00:00.000Z');
  // Issued on a Vorlage with a letterhead: it freezes the letterhead's checksum and prints on it.
  const ws = workspace();
  const lh = storeAttachment(ws, 'Briefpapier.pdf', paper, '2026-11-19');
  patchManifest(ws.paths.manifest, { invoicing: { templates: { letterhead: { id: 'standard', file: lh.file } } } });
  const live = workspaceAt(ws.paths.root);
  const c = createCustomer(live, CUSTOMER);
  const d = createDraft(live, { customerId: c.id, date: '2026-11-19', lines: [item('Beratung', 1, 100)] }, '2026-11-19T08:00:00Z');
  const real: Printer = { ...printer, pdf: async (s) => { seen.push(s); return { html: '', pages: 1, pdf: content }; } };
  const inv = await issueInvoice(live, d.id, { now: '2026-11-19T09:00:00Z', printer: real });
  assert.deepEqual(inv.letterhead, { file: lh.file, sha256: lh.sha256 });
  assert.equal(seen.at(-1)!.letterhead, lh.file, 'the sheet knows it is printed on a letterhead (see-through)');
  assert.equal((await PDFDocument.load(readFileSync(join(ws.paths.root, inv.pdf.file)))).getPageCount(), 2);
});

/** The demos' Offene Posten for one contact on a day, per currency. */
const openOf = (docs: Parameters<typeof openItems>[0], contactId: string, date: string) => {
  const out: Record<string, number> = {};
  for (const x of openItems(docs, date).filter((x) => x.inv.customerId === contactId)) out[x.inv.currency] = Math.round(((out[x.inv.currency] ?? 0) + x.open) * 100) / 100;
  return out;
};

test('P3.7 the Kontoauszug of every contact of every demo for 2026 equals Offene Posten for that contact, at its start and its end', () => {
  let checked = 0;
  for (const root of DEMO_ROOTS) {
    const docs = liveDocuments(loadInvoices(workspaceAt(root)));
    const contacts = [...new Set(docs.filter((d) => d.status === 'issued' && d.kind === 'invoice').map((d) => d.customerId))];
    for (const id of contacts) {
      for (const [from, to] of [['2026-01-01', '2026-12-31'], ['2026-04-01', '2026-09-30'], ['2026-01-01', '2026-06-30']]) {
        const s = statementOf(docs, id, from, to);
        const closing = Object.fromEntries(s.sections.filter((x) => x.closing !== 0).map((x) => [x.currency, x.closing]));
        assert.deepEqual(closing, openOf(docs, id, to), `${root} ${id} ${to}`);
        const before = new Date(Date.parse(`${from}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
        assert.deepEqual(Object.fromEntries(s.sections.filter((x) => x.opening !== 0).map((x) => [x.currency, x.opening])), openOf(docs, id, before), `${root} ${id} opening ${from}`);
        for (const sec of s.sections) {
          assert.equal(Math.round((sec.opening + sec.rows.reduce((t, r) => t + r.debit - r.credit, 0)) * 100) / 100 + 0, sec.closing + 0, 'the rows add up');
          assert.equal(Math.round(sec.open.reduce((t, o) => t + o.open, 0) * 100) / 100 + 0, sec.closing + 0, 'its open items are its balance');
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 10, `${checked} statements checked`);
});

test('P3.7 a Kontoauszug for 2026: an invoice paid in part, a Gutschrift, a write-off, a payment beyond, a Storno, each dated, the balance after each', async () => {
  const ws = workspace();
  const c = createCustomer(ws, CUSTOMER);
  const mk = async (date: string, price: number) => issueInvoice(ws, createDraft(ws, { customerId: c.id, date, prices: 'gross', lines: [{ text: 'Arbeit', quantity: 1, price, vatRate: 8.1, unit: 'h' }] }, `${date}T08:00:00Z`).id, { now: `${date}T09:00:00Z`, printer });
  const a = await mk('2025-12-10', 500);
  const b = await mk('2026-02-01', 1000);
  const x = await mk('2026-03-01', 300);
  const d = await mk('2026-04-01', 200);
  const note = await issueInvoice(ws, createCreditNote(ws, b.id, { amount: 100, reason: 'Mangel' }, '2026-03-20T08:00:00Z').id, { now: '2026-03-20T09:00:00Z', printer });
  const book = loadInvoices(ws);
  const at = (id: string) => book.invoices.find((i) => i.id === id) as Issued;
  at(a.id).payments.push({ transactionRef: 't1', date: '2026-01-15', amount: 500, by: 'reference' });
  at(b.id).payments.push({ transactionRef: 't2', date: '2026-03-10', amount: 600, by: 'reference' });
  at(b.id).writeOffs = [{ id: 'wo-1', date: '2026-03-12', amount: 20, reason: 'skonto', by: 'person' }];
  at(x.id).cancelled = { date: '2026-03-05', reason: 'doppelt' };
  at(d.id).payments.push({ transactionRef: 't3', date: '2026-04-20', amount: 250, by: 'reference' });
  saveInvoices(ws, book);
  const docs = liveDocuments(loadInvoices(ws));
  const s = statementOf(docs, c.id, '2026-01-01', '2026-12-31');
  const sec = s.sections[0];
  assert.equal(sec.opening, 500, 'the Rechnung of 2025 was open on 1 January');
  assert.deepEqual(sec.rows.map((r) => [r.date, r.kind, r.debit, r.credit, r.balance, r.beyond ?? 0]), [
    ['2026-01-15', 'payment', 0, 500, 0, 0],
    ['2026-02-01', 'invoice', 1000, 0, 1000, 0],
    ['2026-03-01', 'invoice', 300, 0, 1300, 0],
    ['2026-03-05', 'cancellation', 0, 300, 1000, 0],
    ['2026-03-10', 'payment', 0, 600, 400, 0],
    ['2026-03-12', 'write-off', 0, 20, 380, 0],
    ['2026-03-20', 'credit-note', 0, 100, 280, 0],
    ['2026-04-01', 'invoice', 200, 0, 480, 0],
    ['2026-04-20', 'payment', 0, 200, 280, 50],
  ]);
  assert.equal(sec.rows[6].number, note.number, 'the Gutschrift by its own number');
  assert.deepEqual(sec.open.map((o) => [o.number, o.open]), [[b.number, 280]]);
  assert.deepEqual({ CHF: sec.closing }, openOf(docs, c.id, '2026-12-31'));
  // As a PDF, sent as a download: kind `statement`, its contact and period in the sent log.
  const made = await statementPdf(ws, c.id, '2026-01-01', '2026-12-31', '2026-11-19T10:00:00Z', printer);
  assert.equal(made.title, 'Kontoauszug 01.01.2026–31.12.2026');
  const sent = await sendStatement(ws, c.id, { from: '2026-01-01', to: '2026-12-31' }, { now: '2026-11-19T10:00:00Z', printer });
  assert.deepEqual([sent.kind, sent.contactId, sent.period, sent.channel, sent.invoiceId], ['statement', c.id, { from: '2026-01-01', to: '2026-12-31' }, 'download', '']);
  assert.equal(sha256(readFileSync(join(ws.paths.root, sent.file))), sent.sha256);
  assert.equal(loadInvoices(ws).sent.at(-1)!.id, sent.id);
});
