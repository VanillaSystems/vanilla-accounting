/**
 * Geschäftspartner and Wissen as data (src/knowledge/partners.ts, src/knowledge/wissen.ts) and as
 * pages (src/app/areas/partners/model.ts, src/app/shell/route.ts): on the demo, what the open year's
 * books hold for each partner is found by the booking's own routing, a Sammelzahlung's entries go
 * to the payee of their part, a customer of Rechnungen is a partner with its invoices and their
 * payments, and a public business shows only when the company works with it. Lücken counts who
 * decided each payment; Von der App lists the public layer. The URLs round-trip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBooks } from '../src/books/store.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { partnersOf, partnerDetailOf, refsOf } from '../src/knowledge/partners.js';
import { appLayerOf, decidedShares, deciderOf, openByPartner } from '../src/knowledge/wissen.js';
import { loadInvoices } from '../src/invoices/store.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { formatLocation, parseLocation, type Location } from '../src/app/shell/route.js';
import { linkedOf, passes, proseBlocks, topicRules } from '../src/app/areas/partners/model.js';
import type { RuleLine } from '../src/app/areas/company/rules-model.js';
import type { Question } from '../src/questions/model.js';
import { DEMO_ROOT } from './support/workspace.js';

const ws = workspaceAt(DEMO_ROOT);
const books = loadBooks(ws);
const knowledge = loadKnowledge(APP_ROOT, DEMO_ROOT);
const invoices = loadInvoices(ws);
const input = { year: '2026', counterparties: knowledge.counterparties, noted: new Map([['gruenkaffee-muster', 'supplier' as const]]), books, invoices, questions: [] as Question[], rules: [] };
const view = partnersOf(input);
const row = (id: string) => view.partners.find((p) => p.id === id)!;

test('a partner holds the open year\'s payments its routing claims, their entries and receipts', () => {
  const g = row('gruenkaffee-muster');
  assert.deepEqual([g.layers, g.notes, g.payments.length, g.receipts.length], [{ app: false, workspace: true, customer: false }, true, 9, 9]);
  const txs = new Map(books.transactions.map((t) => [t.ref, t]));
  assert.ok(g.payments.every((ref) => txs.get(ref)!.date.startsWith('2026')));
  const entries = (books.journalEntries ?? []).filter((e) => g.entries.includes(e.id));
  assert.ok(entries.length >= 9);
  assert.ok(entries.every((e) => e.accountDebit === '4000' || e.accountCredit === '4000'), `only green coffee: ${entries.map((e) => e.description).join('; ')}`);
});

test('a Sammelzahlung\'s entries go to the payee of their part, not to every partner of the payment', () => {
  const batch = books.transactions.find((t) => (t.parts?.length ?? 0) > 1 && row('gruenkaffee-muster').payments.includes(t.ref));
  assert.ok(batch, 'the demo pays green coffee with others in one Sammelzahlung');
  const all = (books.journalEntries ?? []).filter((e) => e.transactionRef === batch.ref);
  const mine = all.filter((e) => row('gruenkaffee-muster').entries.includes(e.id));
  assert.ok(all.length > mine.length && mine.length >= 1, 'the rent in the same payment is not the supplier\'s');
});

test('a customer of Rechnungen is a partner with its invoices and the payments that paid them; a public business only when the company works with it', () => {
  const customers = invoices.customers.filter((c) => !c.deleted);
  for (const c of customers) assert.equal(row(c.id).role, 'customer', c.name);
  const paid = customers.map((c) => row(c.id)).find((r) => r.payments.length)!;
  assert.ok(paid.invoices.length && paid.entries.length, 'its invoices and the entries of their payments');
  assert.ok(row('coop-pronto').layers.app && row('coop-pronto').payments.length, 'a public business the payments route to');
  assert.equal(view.partners.find((p) => p.id === 'aliexpress'), undefined, 'a public business the company never paid is no partner');
});

test('open questions count on the partner of their payment, receipt or entry', () => {
  const ref = row('swiss-post').payments[0];
  const q = (id: string, on: Question['on'], status: Question['status'] = 'open') => ({ id, on, text: 'Wofür?', choices: [], by: 'x', origin: 'person', askedAt: '2026-10-01T00:00:00Z', status }) as unknown as Question;
  const asked = partnersOf({ ...input, questions: [q('a', { kind: 'payment', id: ref }), q('b', { kind: 'payment', id: ref }, 'closed'), q('c', { kind: 'payment', id: 'unknown' })] });
  const post = asked.partners.find((p) => p.id === 'swiss-post')!;
  assert.equal(post.open, 1);
  assert.deepEqual(openByPartner(asked.partners, 2), [{ partner: 'swiss-post', name: post.name, count: 1 }, { count: 1 }]);
  const d = partnerDetailOf(post, knowledge.counterparties.find((c) => c.id === 'swiss-post'), knowledge.counterpartyFiles, [q('a', { kind: 'payment', id: ref })], refsOf(post));
  assert.deepEqual(d.questions.map((x) => x.id), ['a']);
  assert.deepEqual(d.files, ['processes/suppliers/swiss-post.yaml', 'knowledge/suppliers/swiss-post.yaml']);
  assert.ok(d.fileNotes.some((n) => n.layer === 'workspace' && n.id === 'demo-post-parcels'), 'the company\'s sentence in its file');
});

test('Lücken counts each payment once, by who decided its booking, a person before any other', () => {
  assert.equal(deciderOf({ by: { kind: 'rule', rule: 'r' } }), 'rule');
  assert.equal(deciderOf({ by: { kind: 'assistant', at: '', conversation: 'c' } }), 'person');
  assert.equal(deciderOf({ origin: 'invoice' }), 'code');
  assert.equal(deciderOf({}), 'unknown');
  const s = decidedShares({
    transactions: [{ ref: 'a', date: '2026-01-01' }, { ref: 'b', date: '2026-01-02' }, { ref: 'c', date: '2026-01-03' }, { ref: 'd', date: '2025-12-31' }] as never,
    journalEntries: [{ transactionRef: 'a', by: { kind: 'rule', rule: 'x' } }, { transactionRef: 'a', origin: 'manual' }, { transactionRef: 'b', by: { kind: 'model', model: 'm' } }] as never,
  }, '2026');
  assert.deepEqual(s, { payments: 3, unbooked: 1, decided: { rule: 0, code: 0, model: 1, person: 1, unknown: 0 } });
});

test('Von der App lists the public businesses and the steps\' rules, and knows which the company works with', () => {
  const app = appLayerOf(knowledge, new Set(view.partners.map((p) => p.id)));
  assert.ok(app.partners.find((p) => p.id === 'coop-pronto')!.known);
  assert.equal(app.partners.find((p) => p.id === 'aliexpress')!.known, false);
  assert.equal(app.partners.some((p) => p.id === 'gruenkaffee-muster'), false, 'the company\'s own private supplier is not the app\'s');
  assert.ok(app.processes.find((p) => p.process === 'booking')!.steps.find((s) => s.id === 'classify')!.rules.length > 0);
});

test('the routes of both areas round-trip; a topic may not be named gaps or app', () => {
  const locs: Location[] = [
    { route: { area: 'partners' }, query: {} },
    { route: { area: 'partners', id: 'cu_5GQVervgd2rF' }, query: {} },
    { route: { area: 'knowledge' }, query: {} },
    { route: { area: 'knowledge', page: 'gaps' }, query: {} },
    { route: { area: 'knowledge', page: 'app' }, query: {} },
    { route: { area: 'knowledge', topic: 'fahrzeug' }, query: {} },
  ];
  assert.deepEqual(locs.map(formatLocation), ['/partners', '/partners/cu_5GQVervgd2rF', '/knowledge', '/knowledge/gaps', '/knowledge/app', '/knowledge/fahrzeug']);
  for (const l of locs) assert.deepEqual(parseLocation(formatLocation(l), ''), l);
});

test('the page model: filters, prose without HTML, what the books hold newest first, a topic\'s rules by its steps', () => {
  const g = row('gruenkaffee-muster');
  assert.ok(passes(g, 'supplier') && !passes(g, 'customer') && !passes(g, 'open') && passes(g, 'all', 'grün') && !passes(g, 'all', 'post'));
  assert.deepEqual(proseBlocks('Erster Satz\nzweite Zeile.\n\n- auf **4000**\n- 2.6 %\n\n# Titel\n\n<b>kein HTML</b>'), [
    { kind: 'p', parts: [{ text: 'Erster Satz zweite Zeile.' }] },
    { kind: 'ul', items: [[{ text: 'auf ' }, { text: '4000', bold: true }], [{ text: '2.6 %' }]] },
    { kind: 'h', text: 'Titel' },
    { kind: 'p', parts: [{ text: '<b>kein HTML</b>' }] },
  ]);
  const l = linkedOf(g, books);
  assert.ok(l.entries.length >= 9 && l.entries[0].date >= l.entries[l.entries.length - 1].date);
  const line = (step: string, business?: string) => ({ key: step, row: { id: step, file: 'f', step, ...(business ? { business } : {}), kind: 'rule', origin: 'wish', off: false }, line: step, acts: true, applied: 0, asked: 0 }) as RuleLine;
  assert.deepEqual(topicRules([line('booking.guide.yaml#private'), line('booking.guide.yaml#classify'), line('booking.guide.yaml#private', 'coop-pronto')], ['booking#private']).map((x) => x.key), ['booking.guide.yaml#private']);
});
