/**
 * The AI sidebar does what the app does (src/server/workspace-edits.ts, src/server/edits.ts
 * applyAnswer, src/server/routes/assistant.ts), end to end with the claude stub's
 * CLAUDE_STUB_CHANGES on a copy of the demo: an account added and booked on in one answer (and
 * refused without it), a purchase code following the account, a receipt set aside as a duplicate
 * (refused in a filed quarter, never linked again by a later answer), the payment term and the
 * invoice texts, an invoice draft for a customer or a new one, the Treuhänder-Paket, and the
 * inbox run's booking. Each with its undo; a refused answer leaves every file as it was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { findBrowser } from '../src/invoices/pdf.js';
import type { AssistantEvent, MadeChange } from '../src/types/assistant.js';
import type { ApiRefusal } from '../src/types/api-error.js';
import type { Index } from '../src/types/index.js';
import type { InvoiceBook } from '../src/invoices/model.js';
import { appMap } from '../src/server/app-map.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';

const REPO = process.cwd();
const demo = loadBooks(workspaceAt(DEMO_ROOT));
const closedThrough = demo.config.closedThrough!;

async function sidebar(t: { after(fn: () => unknown): void }) {
  const log = mkdtempSync(join(tmpdir(), 'assistant-app-'));
  const file = join(log, 'changes.json');
  const api = await startApi('demo/vanilla-accounting', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: file, CLAUDE_STUB_ARGS: join(log, 'args.txt') });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  // Every request on a connection of its own: a run blocks the server for seconds, and a kept connection it closed meanwhile resets the next request.
  const get = async <T>(path: string) => (await (await fetch(`http://127.0.0.1:${api.port}${path}`, { headers: { Connection: 'close' } })).json()) as T;
  const rest = async () => {
    for (let i = 0; i < 400; i++) {
      if (!(await get<{ runs: Array<{ status: string }> }>('/api/automation')).runs.some((r) => r.status === 'running' || r.status === 'queued')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the inbox run did not come to rest');
  };
  t.after(async () => { await rest().catch(() => {}); api.stop(); rmSync(log, { recursive: true, force: true }); });
  let conversation: string | undefined;
  /** One answer asking for `asked`, in one conversation unless `fresh`. */
  const answer = async (asked: unknown, fresh = false) => {
    writeFileSync(file, JSON.stringify(asked));
    const res = await fetch(`http://127.0.0.1:${api.port}/api/assistant`, {
      // The answer streams for seconds: its connection is not kept for the next request, which the server may have closed meanwhile.
      method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ text: 'Bitte so', language: 'de', context: [], ...(conversation && !fresh ? { conversation } : {}) }),
    });
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
    if (!fresh || !conversation) conversation = (events[0] as { id: string }).id;
    const made = (events.find((e) => e.type === 'changes') as Extract<AssistantEvent, { type: 'changes' }> | undefined)?.changes ?? [];
    const refused = events.find((e) => e.type === 'refused') as Extract<AssistantEvent, { type: 'refused' }> | undefined;
    return { made, refused, refusal: refused?.refusal as ApiRefusal | undefined };
  };
  const undo = async (m: MadeChange) => {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/assistant/${conversation}/changes/${m.id}/undo`, { method: 'POST', headers: { Connection: 'close' } });
    return { status: res.status, json: await res.json() as unknown };
  };
  const books = () => get<Index>('/books.json');
  const chart = () => JSON.parse(readFileSync(api.ws.paths.accounts, 'utf8')) as Array<{ number: string; name: string }>;
  const invoices = () => JSON.parse(readFileSync(api.ws.paths.invoices, 'utf8')) as InvoiceBook;
  const manifest = () => readFileSync(api.ws.paths.manifest, 'utf8');
  const send = async (method: string, path: string) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, { method, headers: { Connection: 'close' } });
    return { status: res.status, json: await res.json() as unknown };
  };
  /** The system prompt of each answer so far. */
  const prompts = () => readFileSync(join(log, 'args.txt'), 'utf8').trim().split('\n').map((l) => { const a = JSON.parse(l) as string[]; return a[a.indexOf('--append-system-prompt') + 1]; });
  return { api, answer, undo, send, get, books, chart, invoices, manifest, rest, prompts };
}

/** An entry of the open quarter, alone on its payment, with an input-tax code on an operating account. */
const operating = demo.journalEntries.find((e) => e.date > closedThrough && /^6\d{3}$/.test(e.accountDebit) && e.vatCode === 'I81'
  && demo.journalEntries.filter((x) => x.transactionRef === e.transactionRef).length === 1)!;

test('the prompt carries the map of the app in the person\'s language', async (t) => {
  const s = await sidebar(t);
  await s.answer([]);
  assert.ok(s.prompts()[0].includes(appMap('de')), 'the route gives the map to the prompt');
  assert.match(s.prompts()[0], /Firma › Rechnungslayout: /);
});

test('an account and the bookings on it come in one answer: without it they are refused, the account goes back with them', async (t) => {
  const s = await sidebar(t);
  assert.ok(operating, 'the demo has an operating expense with I81 in the open quarter');
  const before = s.chart();
  assert.ok(!before.some((a) => a.number === '6999'));

  const alone = await s.answer([{ kind: 'entry', id: operating.id, set: { accountDebit: '6999' } }]);
  assert.deepEqual(alone.refusal, { code: 'unknownAccount', params: { account: '6999' } });
  assert.equal((await s.books()).journalEntries!.find((e) => e.id === operating.id)!.accountDebit, operating.accountDebit, 'the refused booking left the books as they were');

  const both = await s.answer([{ kind: 'entry', id: operating.id, set: { accountDebit: '6999' } }, { kind: 'account', number: '6999', name: 'Übriger Aufwand Test' }]);
  assert.equal(both.refused, undefined, both.refused?.message);
  assert.deepEqual(both.made.map((m) => m.change.kind), ['account', 'entry'], 'the account is added first, whatever the order asked');
  assert.deepEqual(s.chart().find((a) => a.number === '6999'), { number: '6999', name: 'Übriger Aufwand Test' });
  assert.equal((await s.books()).journalEntries!.find((e) => e.id === operating.id)!.accountDebit, '6999');

  const res = await s.undo(both.made[0]);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal((res.json as unknown as MadeChange[]).length, 2, 'taking back the account takes back the booking on it');
  assert.deepEqual(s.chart(), before, 'the chart is as it was');
  assert.equal((await s.books()).journalEntries!.find((e) => e.id === operating.id)!.accountDebit, operating.accountDebit);
});

test('a purchase code follows the account: on material it becomes M, back on operating costs I; the undo restores both', async (t) => {
  const s = await sidebar(t);
  const moved = await s.answer([{ kind: 'entry', id: operating.id, set: { accountDebit: '4210' } }]);
  assert.equal(moved.refused, undefined, moved.refused?.message);
  assert.deepEqual(moved.made[0].note, { vatFollowed: { from: 'I81', to: 'M81' } });
  const e = (await s.books()).journalEntries!.find((x) => x.id === operating.id)!;
  assert.deepEqual([e.accountDebit, e.vatCode], ['4210', 'M81']);

  const told = await s.answer([{ kind: 'entry', id: operating.id, set: { accountDebit: operating.accountDebit, vatCode: 'M81' } }]);
  assert.deepEqual(told.made[0].note, { vatFollowed: { from: 'M81', to: 'I81' } }, 'an explicit M code on an operating account is set to I (w02)');

  assert.equal((await s.undo(told.made[0])).status, 200);
  assert.equal((await s.undo(moved.made[0])).status, 200);
  const back = (await s.books()).journalEntries!.find((x) => x.id === operating.id)!;
  assert.deepEqual([back.accountDebit, back.vatCode], [operating.accountDebit, 'I81']);
});

test('a receipt set aside as a duplicate loses its links and its payment is booked again; a later answer never links it again; refused in a filed quarter', async (t) => {
  const s = await sidebar(t);
  const dateOf = (ref: string) => demo.transactions.find((x) => x.ref === ref)?.date ?? '';
  const linksOf = (books: Pick<Index, 'mappings'>, id: string) => books.mappings.filter((m) => m.receiptId === id).map((m) => m.transactionRef).sort();
  const open = demo.receipts.find((r) => { const d = linksOf(demo, r.id).map(dateOf); return d.length > 0 && d.every((x) => x > closedThrough); })!;
  const filed = demo.receipts.find((r) => { const d = linksOf(demo, r.id).map(dateOf); return d.length > 0 && d.every((x) => x <= closedThrough); })!;
  const links = linksOf(demo, open.id);

  const set = await s.answer([{ kind: 'receiptKind', id: open.id, as: 'duplicate' }]);
  assert.equal(set.refused, undefined, set.refused?.message);
  await s.rest();
  let books = await s.books();
  const r = books.receipts.find((x) => x.id === open.id)!;
  assert.deepEqual([r.kind, r.kindBy], ['duplicate', 'human']);
  assert.deepEqual(linksOf(books, open.id), [], 'a duplicate pays nothing');

  const relink = await s.answer([{ kind: 'link', receipt: open.id, payment: links[0] }]);
  assert.equal(relink.refusal?.code, 'setAside', 'a later answer of the same conversation does not link it again (w06)');
  const elsewhere = await s.answer([{ kind: 'link', receipt: open.id, payment: links[0] }], true);
  assert.equal(elsewhere.refusal?.code, 'setAside', 'nor does another conversation');

  const res = await s.undo(set.made[0]);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  await s.rest();
  books = await s.books();
  const again = books.receipts.find((x) => x.id === open.id)!;
  assert.deepEqual([again.kind, again.kindBy, again.kindRule], [open.kind, open.kindBy, open.kindRule]);
  assert.deepEqual(linksOf(books, open.id), links, 'the undo links it again');

  const closed = await s.answer([{ kind: 'receiptKind', id: filed.id, as: 'noise' }]);
  assert.equal(closed.refusal?.code, 'periodClosed');
  assert.deepEqual(linksOf(await s.books(), filed.id), linksOf(demo, filed.id));
});

test('an earlier answer\'s change is not taken back by a later one: its own «Rückgängig» does that', async (t) => {
  const s = await sidebar(t);
  const m = demo.mappings.find((x) => dateOf(x.transactionRef) > closedThrough)!;
  function dateOf(ref: string) { return demo.transactions.find((x) => x.ref === ref)?.date ?? ''; }
  const off = await s.answer([{ kind: 'unlink', receipt: m.receiptId, payment: m.transactionRef }]);
  assert.equal(off.refused, undefined, off.refused?.message);
  await s.rest();
  const on = await s.answer([{ kind: 'link', receipt: m.receiptId, payment: m.transactionRef }]);
  assert.equal(on.refusal?.code, 'takesBack');
  assert.equal((await s.undo(off.made[0])).status, 200);
  await s.rest();
  assert.ok((await s.books()).mappings.some((x) => x.receiptId === m.receiptId && x.transactionRef === m.transactionRef));
});

test('the payment term and the invoice texts change at once: for every customer who had the old term; the undo puts all back', async (t) => {
  const s = await sidebar(t);
  const terms = () => Object.fromEntries(s.invoices().customers.map((c) => [c.name, c.paymentTermsDays]));
  const was = terms();
  const made = await s.answer([{ kind: 'invoicing', set: { paymentTermsDays: 10, texts: { de: { intro: 'Grüezi mitenand' }, fr: { closing: null } } } }]);
  assert.equal(made.refused, undefined, made.refused?.message);
  assert.equal(made.made[0].note?.customers, 3);
  assert.match(s.manifest(), /paymentTermsDays: 10/);
  assert.match(s.manifest(), /intro: Grüezi mitenand/);
  assert.doesNotMatch(s.manifest(), /Payable dans les/);
  assert.deepEqual(terms(), { ...was, 'Beispiel Bistro AG': 10, 'Café Exemple Sàrl': 10, 'Kaffeehaus Beispiel GmbH': 10 }, 'the customer with a term of their own keeps it');
  const info = (await s.send('GET', '/api/workspace')).json as { invoicing?: { paymentTermsDays: number; texts: Record<string, Record<string, string>> } };
  assert.equal(info.invoicing?.paymentTermsDays, 10, 'the server reads the new settings at once');
  assert.equal(info.invoicing?.texts.de.intro, 'Grüezi mitenand');

  assert.equal((await s.undo(made.made[0])).status, 200);
  assert.deepEqual(terms(), was);
  assert.match(s.manifest(), /paymentTermsDays: 30/);
  assert.doesNotMatch(s.manifest(), /Grüezi mitenand/);
  assert.match(s.manifest(), /Payable dans les \{days\} jours/);

  const bad = await s.answer([{ kind: 'invoicing', set: { paymentTermsDays: 500 } }]);
  assert.match(bad.refused?.message ?? '', /1 bis 120/);
});

test('an invoice draft for a customer, or for a new one; the undo drops it (and the new customer); a refused answer writes no draft', async (t) => {
  const s = await sidebar(t);
  const customer = s.invoices().customers.find((c) => c.name === 'Beispiel Bistro AG')!;
  const drafts = () => s.invoices().invoices.filter((i) => i.status === 'draft' && !i.deleted);
  const n = drafts().length;
  const lines = [{ text: 'Malerarbeiten Küche', quantity: 12, unit: 'h', price: 95, vatRate: 8.1 }];

  const one = await s.answer([{ kind: 'invoiceDraft', customer: customer.id, draft: { subject: 'Küche', lines } }]);
  assert.equal(one.refused, undefined, one.refused?.message);
  const draft = drafts().find((d) => d.id === one.made[0].note?.draft?.id)!;
  assert.deepEqual([draft.customerId, draft.subject, draft.lines], [customer.id, 'Küche', lines]);
  assert.equal(one.made[0].note?.draft?.customer, 'Beispiel Bistro AG');
  const view = await s.send('GET', `/api/invoices/${draft.id}`);
  assert.equal(view.status, 200, 'Rechnungen opens it');

  const fresh = await s.answer([{ kind: 'invoiceDraft', newCustomer: { name: 'Familie Keller', address: { street: 'Hauptstrasse', number: '1', postcode: '9500', town: 'Wil', country: 'CH' } }, draft: { lines } }]);
  assert.equal(fresh.refused, undefined, fresh.refused?.message);
  const keller = s.invoices().customers.find((c) => c.name === 'Familie Keller')!;
  assert.deepEqual([keller.language, keller.paymentTermsDays, keller.deleted], ['de', 30, false]);
  assert.equal(drafts().length, n + 2);

  assert.equal((await s.undo(fresh.made[0])).status, 200);
  assert.equal((await s.undo(one.made[0])).status, 200);
  assert.equal(drafts().length, n);
  assert.equal(s.invoices().customers.find((c) => c.name === 'Familie Keller')!.deleted, true, 'the customer added with it goes too');

  const filedReceipt = demo.receipts.find((r) => demo.mappings.some((m) => m.receiptId === r.id && demo.transactions.find((x) => x.ref === m.transactionRef)!.date <= closedThrough))!;
  const none = await s.answer([{ kind: 'invoiceDraft', customer: customer.id, draft: { lines } }, { kind: 'receipt', id: filedReceipt.id, set: { description: 'x' } }]);
  assert.equal(none.refusal?.code, 'periodClosed');
  assert.equal(drafts().length, n, 'the draft of a refused answer is taken back');

  const wrong = await s.answer([{ kind: 'invoiceDraft', customer: customer.id, draft: { lines: [{ ...lines[0], vatRate: 7 }] } }]);
  assert.match(wrong.refused?.message ?? '', /vatRate/);
  assert.equal(drafts().length, n);
});

test('the Treuhänder-Paket of a quarter is packed and downloaded from the card', { skip: !findBrowser() && 'no Chromium browser for the PDFs' }, async (t) => {
  const s = await sidebar(t);
  const { made, refused } = await s.answer([{ kind: 'export', preset: 'treuhand', period: '2026-Q3' }]);
  assert.equal(refused, undefined, refused?.message);
  const file = made[0].note?.file;
  assert.ok(file && existsSync(file.path), JSON.stringify(made[0].note));
  assert.match(file.name, /2026-07-01_2026-09-30\.zip$/);
  assert.equal(made[0].undo, undefined, 'an export has nothing to undo');
  const res = await fetch(`http://127.0.0.1:${s.api.port}/api/assistant/exports/${encodeURIComponent(file.name)}`, { headers: { Connection: 'close' } });
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});

test('«buch alles neu» is the inbox run: it books an open payment that has no booking', async (t) => {
  const s = await sidebar(t);
  const tx = demo.transactions.find((x) => x.date > closedThrough && demo.journalEntries.filter((e) => e.transactionRef === x.ref).length === 1 && !demo.journalEntries.find((e) => e.transactionRef === x.ref)!.origin)
    ?? demo.transactions.find((x) => x.date > closedThrough && demo.journalEntries.filter((e) => e.transactionRef === x.ref).length === 1)!;
  const entry = demo.journalEntries.find((e) => e.transactionRef === tx.ref)!;
  const gone = await s.send('DELETE', `/api/journal-entries/${entry.id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.ok(!(await s.books()).journalEntries!.some((e) => e.transactionRef === tx.ref), 'the payment has no booking');

  const { made, refused } = await s.answer([{ kind: 'bookAgain' }]);
  assert.equal(refused, undefined, refused?.message);
  assert.deepEqual([made[0].change.kind, made[0].undo, made[0].note], ['bookAgain', undefined, undefined]);
  await s.rest();
  assert.ok((await s.books()).journalEntries!.some((e) => e.transactionRef === tx.ref), 'the run booked it');
});
