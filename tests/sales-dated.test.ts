/**
 * Values that change over time in invoicing (docs/specs/invoicing.md 4.12, P3.8, P4.6 in part): the
 * steps that turn the plain values of the demos into histories without changing what any document
 * reads; a new IBAN from a later day (documents before it print the old one, from it the new one, the
 * card names the open Rechnungen with the old one, and their payments are still matched); a price from
 * 1 January entered in November (a December draft keeps 28, a January one gets 29); the preview's
 * difference on a position; the card of a price dated before an issued Rechnung and its
 * «Nachbelastung als Entwurf»; a contact's address and terms by «gilt ab».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, parseDocument, type YAMLMap } from 'yaml';
import './support/jurisdiction.js';
import { tempWorkspace } from './support/workspace.js';
import { plainManifest } from './support/dated.js';
import { APP_FOLDER, APP_ROOT, MANIFEST_FILE, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { INVOICES_MIGRATIONS, MANIFEST_MIGRATIONS, manifestText } from '../src/workspace/schema.js';
import { parseManifest } from '../src/workspace/manifest.js';
import { invoiceBookOf, loadInvoices } from '../src/invoices/store.js';
import { contactOn, invoicingOn, SINCE_START } from '../src/invoices/dated-values.js';
import { changeDated } from '../src/invoices/dated-change.js';
import { articleLine, articlePriceNotes } from '../src/invoices/articles.js';
import { createArticle, createCustomer, createDraft, issueInvoice, sendPayToNotice, updateContact, type Printer } from '../src/invoices/service.js';
import { matchPayments, type PaymentContext } from '../src/invoices/payments.js';
import { status } from '../src/invoices/rules.js';
import type { Contact, Issued } from '../src/invoices/model.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction } from '../src/types/index.js';
import type { WorkspaceChange } from '../src/types/assistant.js';
import { changesOf } from '../src/assistant/changes.js';

const DEMOS = ['demo', 'demo-consulting', 'demo-coiffeur', 'demo-schreinerei'];
/** A demo file as the last generator before the histories wrote it (invoices.json schema 4, manifest schema 6): the fixture of the steps. */
const before4 = (demo: string, file: string): string => readFileSync(join(APP_ROOT, 'tests', 'fixtures', 'dated', demo, file), 'utf8');
const printer: Printer = { pdf: async (d) => ({ html: '', pages: 1, pdf: Buffer.from(`%PDF-1.4 ${d.number ?? ''} ${d.sender.payTo?.iban ?? ''}`) }), html: async () => ({ html: '', pages: 1 }) };
const CUSTOMER = { name: 'Café Kette AG', address: { street: 'Marktgasse', number: '4', postcode: '3011', town: 'Bern', country: 'CH' }, language: 'de' as const, paymentTermsDays: 30 };
const NEW_IBAN = 'CH3880808000000000002';

test('invoices.json step 4 → 5 on every demo: each plain value one entry from the start, every document reads what it read before', () => {
  for (const demo of DEMOS) {
    const raw = JSON.parse(before4(demo, 'invoices.json')) as Record<string, unknown>;
    const before = raw.contacts as Array<Record<string, unknown>>;
    const after = INVOICES_MIGRATIONS[4](structuredClone(raw)) as { contacts: Contact[]; articles: Array<{ price: unknown }>; invoices: Array<{ date: string; customerId: string }> };
    after.contacts.forEach((c, k) => {
      const was = before[k];
      for (const key of ['addresses', 'terms', 'discount', 'revenueAccount'] as const) {
        for (const e of c[key]) assert.equal(e.validFrom, SINCE_START, `${demo} ${c.name} ${key}`);
      }
      // Read on any document's date, the contact is what it was.
      for (const day of ['2020-01-01', ...after.invoices.filter((i) => i.customerId === c.id).map((i) => i.date)]) {
        const on = contactOn(c, day);
        assert.deepEqual(on.addresses, was.addresses ?? [], `${demo} ${c.name} addresses on ${day}`);
        assert.equal(on.paymentDays, was.paymentDays);
        assert.equal(on.paymentTerms, was.paymentTerms);
        assert.equal(on.discount, was.discount);
        assert.equal(on.revenueAccount, was.revenueAccount);
      }
    });
    const prices = (raw.articles as Array<{ price: number }> | undefined) ?? [];
    after.articles.forEach((a, k) => assert.deepEqual(a.price, [{ validFrom: SINCE_START, enteredAt: '1900-01-01T00:00:00.000Z', value: prices[k].price }], `${demo} Artikel ${k}`));
    // The step is the read: a file of schema 4 and the stepped one read alike, and stepping twice changes nothing.
    assert.deepEqual(INVOICES_MIGRATIONS[4](structuredClone(after) as unknown as Record<string, unknown>), after);
    assert.deepEqual(invoiceBookOf({ ...raw, schema: 4 }, 'x').contacts, after.contacts);
  }
});

test('manifest step 6 → 7 on every demo: payTo, terms, write-off and fee accounts become histories; each day reads the settings of before', () => {
  for (const demo of DEMOS) {
    const text = plainManifest(readFileSync(join(APP_ROOT, demo, APP_FOLDER, MANIFEST_FILE), 'utf8'));
    const stepped = manifestText(MANIFEST_MIGRATIONS[6](parseDocument(text)));
    const plain = parseManifest(text, 'before').invoicing;
    const dated = parseManifest(stepped.replace(/^schema: \d+/m, 'schema: 7'), 'after').invoicing;
    if (!plain) { assert.equal(dated, undefined); continue; }
    const doc = parseDocument(stepped).toJS() as { invoicing: Record<string, unknown> };
    for (const v of Object.values(doc.invoicing.payTo as Record<string, unknown>)) assert.ok(Array.isArray(v) && v[0].validFrom === SINCE_START, `${demo} payTo`);
    if ('paymentTerms' in doc.invoicing) assert.equal((doc.invoicing.paymentTerms as Array<{ validFrom: string }>)[0].validFrom, SINCE_START);
    for (const day of ['1999-12-31', '2026-07-01', '2027-03-01']) assert.deepEqual(invoicingOn(dated!, day), invoicingOn(plain, day), `${demo} on ${day}`);
    // Again: nothing more to step.
    assert.equal(manifestText(MANIFEST_MIGRATIONS[6](parseDocument(stepped))), stepped);
  }
});

/** The demo firm with a second CHF account at another bank: the one it moves to. */
function shop(): Workspace {
  const ws = tempWorkspace('sales-dated-');
  const text = readFileSync(ws.paths.manifest, 'utf8')
    .replace(/^bankAccounts:\n/m, `bankAccounts:\n  - { bank: PostFinance, currency: CHF, account: "1022", label: PostFinance, iban: ${NEW_IBAN}, role: bank }\n`);
  writeFileSync(ws.paths.manifest, text);
  return workspaceAt(ws.paths.root);
}

const books = (transactions: BankTransaction[]): Books => ({ receipts: [], transactions, mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } } as unknown as Books);
const payCtx: PaymentContext = {
  bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1021', label: 'Bank', role: 'bank' }, { bank: 'PostFinance', currency: 'CHF', account: '1022', label: 'PostFinance', role: 'bank' }],
  revenueAccount: '3300', openItems: { receivable: '1100', payable: '2000', fxDifference: '6960' }, fx: { daily: () => undefined },
  pdfOf: () => Buffer.from('%PDF'), receiptId: () => 'r_invoice', indexedAt: (tx) => `${tx.date}T18:00:00Z`, held: () => new Set(),
};

test('P3.8: a new IBAN from 01.12.2026 entered on 15.11.: before it the old IBAN, from it the new; the card names the open Rechnungen with the old one; their payments are still matched', async () => {
  let ws = shop();
  const c = createCustomer(ws, CUSTOMER, '2026-11-01T08:00:00Z');
  const line = { text: 'Beratung', quantity: 1, price: 500, vatRate: 8.1 };
  const early = createDraft(ws, { customerId: c.id, date: '2026-11-10', lines: [line] }, '2026-11-10T08:00:00Z');
  const old = await issueInvoice(ws, early.id, { now: '2026-11-10T09:00:00Z', printer });
  const oldIban = old.sender.payTo.iban;
  assert.notEqual(oldIban, NEW_IBAN);

  // Entered on 15.11. from 01.12.: the card names the open Rechnung with the old IBAN and saves nothing yet.
  const change = { path: 'invoicing/payTo/CHF', value: { account: '1022' }, validFrom: '2026-12-01' };
  const card = changeDated(ws, change, '2026-11-15T10:00:00.000Z');
  assert.equal(card.saved, false);
  if (card.saved) return;
  assert.equal(card.kind, 'payTo');
  assert.deepEqual(card.affected.map((a) => [a.number, a.printed, a.now]), [[old.number, old.sender.payTo.qrIban, NEW_IBAN]]);
  assert.deepEqual(card.ways, ['notice', 'keep']);
  assert.equal(workspaceAt(ws.paths.root).invoicing!.payTo.CHF!.length, 1, 'nothing saved before the person chose');

  const kept = changeDated(ws, { ...change, way: 'keep' }, '2026-11-15T10:00:00.000Z');
  assert.equal(kept.saved, true);
  ws = workspaceAt(ws.paths.root);
  assert.deepEqual(ws.invoicing!.payTo.CHF!.map((e) => [e.validFrom, e.value.iban]), [[SINCE_START, oldIban], ['2026-12-01', NEW_IBAN]]);

  // A Rechnung dated 30.11. prints the old account, one dated 01.12. the new; both issued on 20.11.
  const before = await issueInvoice(ws, createDraft(ws, { customerId: c.id, date: '2026-11-30', lines: [line] }, '2026-11-20T08:00:00Z').id, { now: '2026-11-20T09:00:00Z', printer });
  const after = await issueInvoice(ws, createDraft(ws, { customerId: c.id, date: '2026-12-01', lines: [line] }, '2026-11-20T08:00:00Z').id, { now: '2026-11-20T09:01:00Z', printer });
  assert.equal(before.sender.payTo.iban, oldIban);
  assert.equal(before.sender.payTo.account, '1021');
  assert.equal(after.sender.payTo.iban, NEW_IBAN);
  assert.equal(after.sender.payTo.account, '1022');
  assert.equal(after.sender.payTo.qrIban, undefined, 'the new account has no QR-IBAN: a SCOR reference');
  assert.match(after.reference, /^RF/);

  // The first Rechnung keeps its QR-bill: paid to the old account with its reference in December, it is matched.
  const book = loadInvoices(ws);
  const tx: BankTransaction = { ref: 'B9', date: '2026-12-04', amount: 540.5, currency: 'CHF', direction: 'CRDT', bank: 'Raiffeisen', reference: old.reference, description: 'Gutschrift' } as BankTransaction;
  const out = matchPayments(books([tx]), book, payCtx);
  assert.deepEqual(out.paid.map((p) => [p.number, p.booked]), [[old.number, true]]);
  const paid = book.invoices.find((i) => i.id === old.id) as Issued;
  assert.equal(paid.payments[0].by, 'reference');
  assert.equal(status(paid, book.invoices), 'paid');
});

test('«Zahlungsaufforderung mit neuer IBAN»: the open Rechnung printed with the account of the day, kept in the sent log; its QR reference needs a QR-IBAN, so with a plain IBAN it names the number', async () => {
  let ws = shop();
  const c = createCustomer(ws, CUSTOMER, '2026-11-01T08:00:00Z');
  const inv = await issueInvoice(ws, createDraft(ws, { customerId: c.id, date: '2026-11-10', lines: [{ text: 'Beratung', quantity: 1, price: 500, vatRate: 8.1 }] }, '2026-11-10T08:00:00Z').id, { now: '2026-11-10T09:00:00Z', printer });
  changeDated(ws, { path: 'invoicing/payTo/CHF', value: { account: '1022' }, validFrom: '2026-12-01', way: 'notice' }, '2026-11-15T10:00:00.000Z');
  ws = workspaceAt(ws.paths.root);
  const seen: Array<{ iban?: string; reference?: string; title?: true }> = [];
  const spy: Printer = { ...printer, pdf: async (d) => { seen.push({ iban: d.sender.payTo?.iban, reference: d.reference, title: d.payToNotice }); return printer.pdf(d, ''); } };
  const sent = await sendPayToNotice(ws, inv.id, { date: '2026-12-01' }, { now: '2026-12-01T08:00:00Z', printer: spy });
  assert.equal(sent.kind, 'notice');
  assert.deepEqual(seen, [{ iban: NEW_IBAN, reference: '', title: true }]);
  assert.ok(loadInvoices(ws).sent.some((x) => x.id === sent.id));
  assert.equal((loadInvoices(ws).invoices.find((i) => i.id === inv.id) as Issued).sender.payTo.iban, inv.sender.payTo.iban, 'the Rechnung keeps what it printed');
});

test('P4.6 in part: Hausmischung 29 from 01.01.2027, entered in November: a December draft keeps 28, a January one gets 29; the Artikel says so', () => {
  const ws = shop();
  const a = createArticle(ws, { code: 'HM-1', type: 'goods', name: 'Hausmischung 1 kg', unit: 'kg', price: 28, vatKind: 'reduced' }, '2026-07-01T08:00:00Z');
  const saved = changeDated(ws, { path: `articles/${a.id}/price`, value: 29, validFrom: '2027-01-01' }, '2026-11-15T10:00:00.000Z');
  assert.equal(saved.saved, true, 'no Rechnung dated in 2027: no card');
  const art = loadInvoices(ws).articles[0];
  assert.deepEqual(art.price.map((e) => [e.validFrom, e.value]), [[SINCE_START, 28], ['2027-01-01', 29]]);
  assert.equal(articleLine(art, { date: '2026-12-01', prices: 'net' }).price, 28);
  assert.equal(articleLine(art, { date: '2027-01-01', prices: 'net' }).price, 29);
  // The draft of 15.12. moved to 05.01.: the preview names the difference on its position, the position keeps 28.
  const lines = [articleLine(art, { date: '2026-12-15', prices: 'net' })];
  assert.deepEqual(articlePriceNotes({ date: '2026-12-15', prices: 'net', lines }, [art]), []);
  assert.deepEqual(articlePriceNotes({ date: '2027-01-05', prices: 'net', lines }, [art]), [{ line: 0, price: 28, article: 29, since: '2027-01-01' }]);
});

test('a price dated before an issued Rechnung: the card names it and its position; «Nachbelastung als Entwurf» makes one draft of the difference for its contact, a lower price a Gutschrift draft', async () => {
  const ws = shop();
  const c = createCustomer(ws, CUSTOMER, '2026-11-01T08:00:00Z');
  const a = createArticle(ws, { code: 'HM-1', type: 'goods', name: 'Hausmischung 1 kg', unit: 'kg', price: 28, vatKind: 'reduced' }, '2026-07-01T08:00:00Z');
  const art = loadInvoices(ws).articles[0];
  const d = createDraft(ws, { customerId: c.id, date: '2026-12-10', lines: [{ ...articleLine(art, { date: '2026-12-10', prices: 'net' }), quantity: 10 }] }, '2026-12-10T08:00:00Z');
  const inv = await issueInvoice(ws, d.id, { now: '2026-12-10T09:00:00Z', printer });

  const change = { path: `articles/${a.id}/price`, value: 29, validFrom: '2026-12-01' };
  const card = changeDated(ws, change, '2026-12-15T10:00:00.000Z');
  assert.equal(card.saved, false);
  if (card.saved) return;
  assert.deepEqual(card.affected.map((x) => [x.number, x.lines]), [[inv.number, [{ line: 0, text: 'Hausmischung 1 kg', quantity: 10, price: 28, now: 29 }]]]);
  assert.deepEqual(card.ways, ['charge', 'keep']);

  const charged = changeDated(ws, { ...change, way: 'charge' }, '2026-12-15T10:00:00.000Z');
  assert.ok(charged.saved);
  if (!charged.saved) return;
  assert.deepEqual(charged.drafts.map((x) => x.kind), ['invoice']);
  const draft = loadInvoices(ws).invoices.find((i) => i.id === charged.drafts[0].id)!;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.customerId, c.id);
  assert.deepEqual(draft.lines.map((l) => ('price' in l ? [l.quantity, l.price, l.vatRate] : [])), [[10, 1, 2.6]]);
  assert.equal((loadInvoices(ws).invoices.find((i) => i.id === inv.id) as Issued).lines[0].kind, 'article', 'the issued Rechnung stays as issued');

  // Lower than printed from the same day: a Gutschrift draft of that Rechnung.
  const lower = changeDated(ws, { path: `articles/${a.id}/price`, value: 27, validFrom: '2026-12-01', way: 'charge' }, '2026-12-16T10:00:00.000Z');
  assert.ok(lower.saved && lower.drafts[0].kind === 'credit-note');
  const credit = loadInvoices(ws).invoices.find((i) => lower.saved && i.id === lower.drafts[0].id)!;
  assert.equal(credit.creditFor, inv.id);
  assert.deepEqual(credit.lines.map((l) => ('price' in l ? [l.quantity, l.price] : [])), [[10, -1]]);
});

test('a contact moves from 01.12.: its December Rechnung goes to the new address, the November one to the old; a change dated before an issued one shows the card first', async () => {
  const ws = shop();
  const c = createCustomer(ws, CUSTOMER, '2026-11-01T08:00:00Z');
  const line = { text: 'Beratung', quantity: 1, price: 100, vatRate: 8.1 };
  const nov = await issueInvoice(ws, createDraft(ws, { customerId: c.id, date: '2026-11-20', lines: [line] }, '2026-11-20T08:00:00Z').id, { now: '2026-11-20T09:00:00Z', printer });
  const stored = loadInvoices(ws).contacts[0];
  const moved = [{ ...contactOn(stored, '2026-11-20').addresses[0], street: 'Bahnhofplatz', number: '1' }];
  updateContact(ws, c.id, { addresses: moved, paymentDays: 20 }, '2026-12-01', '2026-11-25T08:00:00.000Z');
  const dec = await issueInvoice(ws, createDraft(ws, { customerId: c.id, date: '2026-12-02', lines: [line] }, '2026-12-02T08:00:00Z').id, { now: '2026-12-02T09:00:00Z', printer });
  assert.equal(nov.customer.address.street, 'Marktgasse');
  assert.equal(dec.customer.address.street, 'Bahnhofplatz');
  assert.equal(dec.customer.paymentTermsDays, 20);
  assert.equal(dec.dueDate, '2026-12-22');

  // Back to 15.11.: the November Rechnung printed the old address; the card names it before anything is saved.
  const card = changeDated(ws, { path: `contacts/${c.id}/addresses`, value: moved, validFrom: '2026-11-15' }, '2026-12-03T08:00:00.000Z');
  assert.equal(card.saved, false);
  if (card.saved) return;
  assert.equal(card.kind, 'address');
  assert.deepEqual(card.affected.map((x) => x.number), [nov.number]);
  assert.deepEqual(card.ways, ['keep']);
  assert.equal(changeDated(ws, { path: `contacts/${c.id}/addresses`, value: moved, validFrom: '2026-11-15', way: 'keep' }, '2026-12-03T08:00:00.000Z').saved, true);
  assert.equal((loadInvoices(ws).invoices.find((i) => i.id === nov.id) as Issued).customer.address.street, 'Marktgasse', 'issued documents keep theirs');
});

test('the AI: «Hausmischung ab Januar 29 Franken» becomes { path, value, validFrom }; code writes it as «gilt ab» does, the card says what held, its undo withdraws it', async () => {
  const ws = shop();
  // The server's edits open a workspace when loaded: this one.
  process.env.VANILLA_WORKSPACE = ws.paths.root;
  const { applyWorkspaceChange } = await import('../src/server/workspace-edits.js');
  const a = createArticle(ws, { code: 'HM-1', type: 'goods', name: 'Hausmischung 1 kg', unit: 'kg', price: 28, vatKind: 'reduced' }, '2026-07-01T08:00:00Z');
  const [change] = changesOf([{ kind: 'datedValue', path: `articles/${a.id}/price`, value: 29, validFrom: '2027-01-01' }]);
  assert.deepEqual(change, { kind: 'datedValue', path: `articles/${a.id}/price`, value: 29, validFrom: '2027-01-01' });
  const applied = applyWorkspaceChange(ws, {} as never, change as WorkspaceChange);
  assert.deepEqual(applied.note?.dated, { before: 28, covers: [] });
  assert.deepEqual(loadInvoices(ws).articles[0].price.map((e) => e.value), [28, 29]);
  applyWorkspaceChange(ws, {} as never, applied.undo!);
  assert.deepEqual(loadInvoices(ws).articles[0].price.map((e) => e.value), [28]);
  assert.throws(() => changesOf([{ kind: 'datedValue', path: 'x', value: 1, validFrom: 'Januar' }]));
});
