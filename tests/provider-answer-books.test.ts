/**
 * A provider's payouts after her answers (#404), the webshop persona's first two drops without any
 * model (the provider path is code): her bank statement with 40 payouts of Shopify, then the orders
 * export and the payments export. Her answers in the drop row (the clearing account with the
 * cut-over day, the fee account) are her switching on: the booking workflow does not wait for
 * «Einschalten» because of them, and the 40 payouts are booked bank / clearing account without a
 * code at once, the row saying so. The same file changed by hand still makes booking wait.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { checkAnswers } from '../src/workspace/create.js';
import { PRESETS, type Answers } from '../src/workspace/setup.js';
import { applyPlan, planWorkspace } from '../src/workspace/scaffold.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_FOLDER, workspaceAt, type Uid } from '../src/workspace/workspace.js';
import type { Iban } from '../src/workspace/banks.js';
import type { DropSession } from '../src/types/drop.js';
import { loadBooks, saveBooks } from '../src/books/store.js';
import { readCamt, transactionsOf } from '../src/providers/camt053/camt053.js';
import { handStart } from '../src/saving/hand-rule.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { noBrowser, openApp } from './support/e2e.js';
import './support/jurisdiction.js';

// @ts-expect-error a plain ES module of the verify skill, without types
import webshop from '../.claude/skills/verify/persona-files/webshop.mjs';

const FILES = (webshop as () => { files: Record<string, string> })().files;
/** Her own account, as her statement names it. */
const IBAN = /<Acct>\s*<Id>\s*<IBAN>([A-Z0-9]+)</.exec(FILES['camt053_LUKB_Q3-2026.xml'])![1] as Iban;

/** The webshop's new books as the setup makes them: effective method, quarterly, payouts yes; its bank account at the LUKB. */
function shopBooks(): string {
  const root = mkdtempSync(join(tmpdir(), 'webshop-'));
  const { answers, vat } = checkAnswers({ ...PRESETS.webshop.answers } as Answers, []);
  applyPlan(root, planWorkspace({ name: 'Teegarten Beispiel GmbH', uid: 'CHE-153.004.184' as Uid, owner: 'Corinne Beispiel', preset: 'webshop', answers, vat, banks: [{ bank: 'LUKB', currency: 'CHF', account: '1020', iban: IBAN }] }, loadChart(), '2026'));
  return relative(process.cwd(), join(root, APP_FOLDER));
}

type Session = DropSession & { code?: string };

async function dropper(api: ApiServer) {
  const post = async (path: string, body?: Buffer | object): Promise<{ status: number; s: Session }> => {
    const json = body && !Buffer.isBuffer(body);
    const res = await api.fetch(path, { method: 'POST', body: json ? JSON.stringify(body) : body ? new Uint8Array(body as Buffer) : undefined, headers: { 'Content-Type': json ? 'application/json' : 'application/octet-stream' } });
    return { status: res.status, s: (await res.json()) as Session };
  };
  const { s } = await post('/api/drop');
  return {
    add: (name: string) => post(`/api/drop/${s.id}/files?name=${encodeURIComponent(name)}`, Buffer.from(FILES[name])),
    act: (key: string, body: object) => post(`/api/drop/${s.id}/rows/${key}`, body),
  };
}

const books = async (api: ApiServer) => loadBooks(api.ws);
const payoutsOf = (b: Awaited<ReturnType<typeof books>>) => b.transactions.filter((t) => /SHOPIFY PAYOUT/.test(t.description) && t.direction === 'CRDT');
const pendingOf = async (api: ApiServer) => ((await api.send('GET', '/api/automation')).json as { pending?: Array<{ workflow: string; files: string[] }> }).pending ?? [];

/** Her first two drops, and her answers in the rows as the dialog sends them. */
async function walk(api: ApiServer, beforeAnswer: () => void = () => undefined) {
  const one = await dropper(api);
  await one.add('camt053_LUKB_Q3-2026.xml');
  await api.rest();
  const before = await books(api);
  assert.equal(payoutsOf(before).length, 40, 'her statement has 40 payouts of Shopify');
  assert.equal(before.journalEntries.filter((e) => payoutsOf(before).some((t) => t.ref === e.transactionRef)).length, 0, 'before her answers no payout is booked');
  // Aufgaben names them as the payouts of Shopify, by the provider's name, not the processor's, and what they wait for.
  const groups = ((await api.send('GET', '/api/payouts')).json as { groups: Array<{ name: string; why: string; refs: string[]; sales: boolean }> }).groups;
  assert.deepEqual(groups.map((g) => [g.name, g.why, g.refs.length, g.sales]), [['Shopify', 'clearing', 40, true]], 'its file names a sales report: it waits for the order export');
  const two = await dropper(api);
  await two.add('orders_export_1.csv');
  const both = await two.add('payment_transactions_export_1.csv');
  const orders = both.s.rows.find((r) => r.name === 'orders_export_1.csv')!;
  assert.equal(orders.askProvider?.missing, 'clearing');
  // The revenue account comes with the clearing account, proposed from what she sells, never taken silently.
  assert.deepEqual(orders.askProvider?.revenue, { account: '3200', sells: ['traded'] });
  assert.equal(orders.askProvider?.since, '2026-07-01');
  // A revenue account that is none (the bank) is refused with its code; nothing is kept.
  const wrong = await two.act(orders.key, { kind: 'provider', account: orders.askProvider!.propose!.account, since: orders.askProvider!.since, revenue: '1020', ...(orders.askProvider!.propose!.name ? { create: true } : {}) });
  assert.deepEqual([wrong.status, wrong.s.code], [400, 'revenueNotRevenue']);
  beforeAnswer();
  const answered = await two.act(orders.key, { kind: 'provider', account: orders.askProvider!.propose!.account, since: orders.askProvider!.since, revenue: orders.askProvider!.revenue!.account, ...(orders.askProvider!.propose!.name ? { create: true } : {}) });
  assert.equal(answered.status, 200, JSON.stringify(answered.s));
  const fees = answered.s.rows.find((r) => r.name === 'payment_transactions_export_1.csv')!;
  assert.equal(fees.askProvider?.missing, 'fees');
  const done = await two.act(fees.key, { kind: 'provider', account: fees.askProvider!.propose!.account, vat: fees.askProvider!.propose!.vat });
  assert.equal(done.status, 200, JSON.stringify(done.s));
  return { answered: answered.s, done: done.s };
}

test('her answers in the drop row book the 40 payouts bank / clearing account without a code at once, and booking does not wait for «Einschalten»', async () => {
  const api = await startApi(shopBooks(), {}, { whole: true });
  try {
    const { answered } = await walk(api);
    const orders = answered.rows.find((r) => r.name === 'orders_export_1.csv')!;
    assert.deepEqual(orders.payouts, { provider: 'Shopify', booked: 40, of: 40 }, 'the row says how many payouts the answer booked');
    await api.rest();
    const b = await books(api);
    const payouts = payoutsOf(b);
    const lines = payouts.map((t) => b.journalEntries.filter((e) => e.transactionRef === t.ref).map((e) => `${e.accountDebit}/${e.accountCredit} ${e.vatCode ?? ''}`).join());
    assert.deepEqual([...new Set(lines)], ['1020/1093 '], 'each payout bank / clearing account, without a code');
    assert.deepEqual((await pendingOf(api)).filter((p) => p.workflow === 'booking'), [], 'her answer is her switching on');
    assert.match(readFileSync(join(api.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'utf8'), /revenue: "?3200"?/, 'the revenue account she saw is kept');
    // The same file changed by hand: booking waits for «Einschalten» as before.
    const file = join(api.root, 'knowledge', 'suppliers', 'shopify.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/since: \S+/, 'since: 2026-08-01'));
    assert.ok((await pendingOf(api)).some((p) => p.workflow === 'booking' && p.files.includes('knowledge/suppliers/shopify.yaml')), 'a change by hand waits');
  } finally {
    await api.stop();
  }
});

test('the hand form of a payout never proposes turnover: bank / the clearing account without a code when the company\'s file names it, else no account, and it says what a payout is', () => {
  const ws = workspaceAt(shopBooks());
  const txs = readCamt(FILES['camt053_LUKB_Q3-2026.xml']).statements.flatMap((s) => transactionsOf(s, { bank: 'LUKB', statements: 'camt053' }));
  const b = loadBooks(ws);
  b.transactions.push(...txs);
  saveBooks(ws, b);
  const file = join(ws.paths.root, 'knowledge', 'suppliers', 'shopify.yaml');
  const july = txs.find((t) => t.description.includes('88124415'))!;
  const first = txs.find((t) => t.description.includes('88124406'))!;
  const form = (ref: string) => {
    const start = handStart(ws, ref);
    const draft = bookingDraft(loadBooks(ws), ref, ws.bankAccounts, undefined, { defaults: { sales: '3200' }, nature: start?.nature });
    return { line: draft!.lines.map((l) => `${l.accountDebit}/${l.accountCredit} ${l.vat}`).join(), notes: draft!.notes };
  };
  const states: Array<[string, string, string]> = [
    ['', '1020/ ', 'clearing'],
    ['provider:\n  clearing: "1093"\n', '1020/ ', 'since'],
    ['provider:\n  clearing: "1093"\n  since: 2026-07-01\n', '1020/1093 ', 'ready'],
    ['provider:\n  clearing: "1093"\n  since: 2026-07-20\n', '1020/ ', 'before'],
  ];
  for (const [provider, line, why] of states) {
    writeFileSync(file, `id: shopify\n${provider}`);
    const f = form(why === 'before' ? first.ref : july.ref);
    assert.equal(f.line, line, why);
    assert.deepEqual(f.notes.map((n) => [n.kind, 'why' in n ? n.why : '']), [['payout', why]], why);
  }
  // Before the cut-over day: as the payouts before it were booked (the business's last booking), never the default sale.
  writeFileSync(file, 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-07-20\n');
  const p = loadBooks(ws);
  const second = txs.find((t) => t.description.includes('88124407'))!;
  p.journalEntries.push({ id: 'pre', transactionRef: second.ref, date: second.date, accountDebit: '1020', accountCredit: '3400', amount: second.amount, origin: 'manual' });
  saveBooks(ws, p);
  const before = handStart(ws, first.ref);
  const draft = bookingDraft(loadBooks(ws), first.ref, ws.bankAccounts, undefined, { defaults: { sales: '3200' }, nature: before?.nature })!;
  assert.deepEqual(draft.lines.map((l) => [l.accountDebit, l.accountCredit, l.source?.account?.from]), [['1020', '3400', 'precedent']], 'the business\'s last booking');
  assert.ok(draft.notes.some((n) => n.kind === 'payout' && n.why === 'before') && !draft.notes.some((n) => n.kind === 'sale'));
  const q = loadBooks(ws);
  q.journalEntries = q.journalEntries.filter((e) => e.id !== 'pre');
  saveBooks(ws, q);
  // Before the cut-over day beside sales a report booked onto the clearing account: hers to decide, no account.
  writeFileSync(file, 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-07-05\n');
  const s = loadBooks(ws);
  s.journalEntries.push({ id: 'sr1', transactionRef: 'SR-shopify-1050', date: '2026-06-29', accountDebit: '1093', accountCredit: '3200', amount: 50, vatCode: 'V81', origin: 'classify' });
  saveBooks(ws, s);
  const gap = form(first.ref);
  assert.equal(gap.line, '1020/ ');
  assert.deepEqual(gap.notes.map((n) => [n.kind, 'why' in n ? n.why : '']), [['payout', 'gap']]);
});

test('«Einschalten» books what waited: the payouts a change by hand decided are booked once booking is switched on', async () => {
  const api = await startApi(shopBooks(), {}, { whole: true });
  try {
    const one = await dropper(api);
    await one.add('camt053_LUKB_Q3-2026.xml');
    await api.rest();
    // The clearing account and the cut-over day written into the file by hand: booking waits for «Einschalten».
    writeFileSync(join(api.root, 'knowledge', 'suppliers', 'shopify.yaml'), 'id: shopify\nprovider:\n  clearing: "1093"\n  since: 2026-07-01\n');
    assert.ok((await pendingOf(api)).some((p) => p.workflow === 'booking'));
    const before = await books(api);
    assert.equal(before.journalEntries.filter((e) => payoutsOf(before).some((t) => t.ref === e.transactionRef)).length, 0);
    const inbox = async () => ((await api.send('GET', '/api/automation')).json as { runs: Array<{ workflow: string }> }).runs.filter((r) => r.workflow === 'receipt-intake').length;
    const runs = await inbox();
    const on = await api.send('POST', '/api/automation', { kind: 'approve', workflow: 'booking' });
    assert.equal(on.json.ok, true);
    assert.deepEqual(on.json.payouts, { booked: 40, of: 40 }, 'the payouts code decides, said with the switching on');
    await api.rest();
    // The payments the drop left open are booked by an inbox run «Einschalten» starts (#413): one run more.
    assert.equal(await inbox(), runs + 1, '«Einschalten» starts the inbox run that books what waited');
    const b = await books(api);
    const booked = payoutsOf(b).filter((t) => b.journalEntries.some((e) => e.transactionRef === t.ref && e.accountDebit === '1020' && e.accountCredit === '1093' && !e.vatCode));
    assert.equal(booked.length, 40, 'switched on, the 40 payouts are booked from the clearing account');
  } finally {
    await api.stop();
  }
});

test('the provider\'s questions in four languages: one question each, the fee code said in words, no file path', async () => {
  const keys = ['drop.provider.q.clearing', 'drop.provider.q.since', 'drop.provider.q.revenue', 'drop.provider.q.fees', 'drop.provider.why.since', 'drop.provider.why.feesVat', 'drop.provider.label.clearing', 'drop.provider.sinceLabel', 'bank.payoutWait.clearing', 'bank.payoutWait.since', 'salesReport.noClearing', 'salesReport.noSince', 'journal.byHand.note.payout.ready', 'journal.byHand.note.payout.clearing'];
  for (const lang of ['de', 'en', 'fr', 'it']) {
    const { messages } = ((await import(`../src/app/i18n/locales/${lang}.ts`)) as { default: { messages: Record<string, unknown> } }).default;
    for (const k of keys) {
      const text = String(messages[k] ?? '');
      assert.ok(text, `${lang} ${k}`);
      assert.doesNotMatch(text, /provider\.(clearing|since)|knowledge\/|\{file\}/, `${lang} ${k}: no file path`);
      if (k.startsWith('drop.provider.q.')) assert.equal((text.match(/\?/g) ?? []).length, 1, `${lang} ${k}: one question`);
    }
  }
});

test('in the app: Aufgaben names the 40 payouts as Shopify\'s with the one thing to do, the payout\'s form proposes no turnover; after her answers they are booked', { skip: noBrowser, timeout: 300_000 }, async () => {
  const app = await openApp(shopBooks());
  const shots = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), 'payouts-'));
  try {
    const { page, api } = app;
    const one = await dropper(api);
    await one.add('camt053_LUKB_Q3-2026.xml');
    await api.rest();
    const b = await books(api);
    const payout = payoutsOf(b).find((t) => t.description.includes('88124415'))!;
    await app.open('/automation/tasks?period=2026-Q3', '[data-testid=unbooked-payouts]');
    const group = await page.$eval('[data-testid=unbooked-payouts]', (e) => (e as HTMLElement).innerText);
    assert.match(group, /40 Auszahlungen von Shopify ohne Buchung[\s\S]*Kein Umsatz: sie warten auf den Bestellexport von Shopify/);
    assert.doesNotMatch(await page.$eval('body', (e) => (e as HTMLElement).innerText), /Stripe Technology Europe Ltd CHF/, 'not named by the processor');
    await page.$eval('[data-testid=unbooked-payouts]', (e) => e.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(shots, 'tasks-payouts-waiting.png') });
    await app.open(`/bank/1020-2026-07/${encodeURIComponent(payout.ref)}?period=2026-Q3`, '[data-testid=payout-wait]');
    await page.waitForFunction(() => document.body.innerText.includes('Das ist eine Auszahlung von Shopify'), { timeout: 30_000 }).catch(() => undefined);
    assert.match(await page.$eval('[data-testid=payout-wait]', (e) => (e as HTMLElement).innerText), /Auszahlung von Shopify, kein Umsatz: wartet auf den Bestellexport von Shopify/);
    const pane = await page.$eval('body', (e) => (e as HTMLElement).innerText);
    assert.match(pane, /Das ist eine Auszahlung von Shopify: kein Umsatz/);
    assert.doesNotMatch(pane, /Handelserlöse|nimmt einen Verkauf an|knowledge\//);
    await page.screenshot({ path: join(shots, 'payout-form-waiting.png') });
    // Her answers: the payouts are booked, Aufgaben has nothing of them left.
    const two = await dropper(api);
    await two.add('orders_export_1.csv');
    const s = await two.add('payment_transactions_export_1.csv');
    const orders = s.s.rows.find((r) => r.name === 'orders_export_1.csv')!;
    const answered = await two.act(orders.key, { kind: 'provider', account: '1093', since: '2026-07-01', revenue: '3200' });
    assert.equal(answered.s.rows.find((r) => r.key === orders.key)?.payouts?.booked, 40);
    await api.rest();
    await app.open('/automation/tasks?period=2026-Q3');
    assert.equal(await page.$('[data-testid=unbooked-payouts]'), null);
    await page.screenshot({ path: join(shots, 'tasks-after-answers.png') });
    console.log(`screenshots: ${shots}`);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});

test('her answer while «Buchen» already waits for a change from elsewhere: it keeps waiting, nothing is booked, and the row says why', async () => {
  const api = await startApi(shopBooks(), {}, { whole: true });
  try {
    const file = join(api.root, 'knowledge', 'suppliers', 'shopify.yaml');
    const one = await dropper(api);
    await one.add('camt053_LUKB_Q3-2026.xml');
    await api.rest();
    const two = await dropper(api);
    await two.add('orders_export_1.csv');
    const both = await two.add('payment_transactions_export_1.csv');
    const orders = both.s.rows.find((r) => r.name === 'orders_export_1.csv')!;
    // A change by hand before her answer: «Buchen» waits for «Einschalten».
    writeFileSync(file, 'id: shopify\nprovider:\n  payoutDays: 5\n');
    const answered = await two.act(orders.key, { kind: 'provider', account: orders.askProvider!.propose!.account, since: orders.askProvider!.since, revenue: orders.askProvider!.revenue!.account, ...(orders.askProvider!.propose!.name ? { create: true } : {}) });
    assert.equal(answered.status, 200, JSON.stringify(answered.s));
    const row = answered.s.rows.find((r) => r.key === orders.key)!;
    assert.deepEqual(row.payouts, { provider: 'Shopify', booked: 0, of: 40, waits: 'switchOn', files: ['knowledge/suppliers/shopify.yaml'] });
    // Its reports wait in their rows too, with the same files (#413): nothing of them booked.
    assert.deepEqual(answered.s.rows.filter((r) => r.kind === 'sales-report').map((r) => [r.name, r.reason, r.bookingWaits]), [
      ['orders_export_1.csv', 'booking-waits', ['knowledge/suppliers/shopify.yaml']],
      ['payment_transactions_export_1.csv', 'booking-waits', ['knowledge/suppliers/shopify.yaml']],
    ]);
    assert.ok((await pendingOf(api)).some((p) => p.workflow === 'booking'), 'a workflow that waited keeps waiting');
    const b = await books(api);
    assert.equal(b.journalEntries.filter((e) => payoutsOf(b).some((t) => t.ref === e.transactionRef)).length, 0);
    const book = await api.send('POST', '/api/payouts/book', { provider: 'shopify' });
    assert.deepEqual(book.json, { ok: true, booked: 0, of: 40, waits: 'switchOn', files: ['knowledge/suppliers/shopify.yaml'] }, '«Jetzt buchen» says it too');
  } finally {
    await api.stop();
  }
});
