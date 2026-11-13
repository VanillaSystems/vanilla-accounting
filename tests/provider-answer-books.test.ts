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
import { APP_FOLDER, type Uid } from '../src/workspace/workspace.js';
import type { Iban } from '../src/workspace/banks.js';
import type { DropSession } from '../src/types/drop.js';
import { loadBooks } from '../src/books/store.js';
import { startApi, type ApiServer } from './support/api-server.js';
import './support/jurisdiction.js';

// @ts-expect-error a plain ES module of the verify skill, without types
import webshop from '../.claude/skills/verify/persona-files/webshop.mjs';

const FILES = (webshop as () => { files: Record<string, string> })().files;
const IBAN = 'CH2300778004711223301' as Iban;

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
async function walk(api: ApiServer) {
  const one = await dropper(api);
  await one.add('camt053_LUKB_Q3-2026.xml');
  await api.rest();
  const before = await books(api);
  assert.equal(payoutsOf(before).length, 40, 'her statement has 40 payouts of Shopify');
  assert.equal(before.journalEntries.filter((e) => payoutsOf(before).some((t) => t.ref === e.transactionRef)).length, 0, 'before her answers no payout is booked');
  const two = await dropper(api);
  await two.add('orders_export_1.csv');
  const both = await two.add('payment_transactions_export_1.csv');
  const orders = both.s.rows.find((r) => r.name === 'orders_export_1.csv')!;
  assert.equal(orders.askProvider?.missing, 'clearing');
  const answered = await two.act(orders.key, { kind: 'provider', account: orders.askProvider!.propose!.account, since: orders.askProvider!.since, ...(orders.askProvider!.propose!.name ? { create: true } : {}) });
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
    assert.equal(orders.payouts?.booked, 40, 'the row says how many payouts the answer booked');
    await api.rest();
    const b = await books(api);
    const payouts = payoutsOf(b);
    const lines = payouts.map((t) => b.journalEntries.filter((e) => e.transactionRef === t.ref).map((e) => `${e.accountDebit}/${e.accountCredit} ${e.vatCode ?? ''}`).join());
    assert.deepEqual([...new Set(lines)], ['1020/1093 '], 'each payout bank / clearing account, without a code');
    assert.deepEqual((await pendingOf(api)).filter((p) => p.workflow === 'booking'), [], 'her answer is her switching on');
    // The same file changed by hand: booking waits for «Einschalten» as before.
    const file = join(api.root, 'knowledge', 'suppliers', 'shopify.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/since: \S+/, 'since: 2026-08-01'));
    assert.ok((await pendingOf(api)).some((p) => p.workflow === 'booking' && p.files.includes('knowledge/suppliers/shopify.yaml')), 'a change by hand waits');
  } finally {
    await api.stop();
  }
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
    const on = await api.send('POST', '/api/automation', { kind: 'approve', workflow: 'booking' });
    assert.equal(on.json.ok, true);
    await api.rest();
    const b = await books(api);
    const booked = payoutsOf(b).filter((t) => b.journalEntries.some((e) => e.transactionRef === t.ref && e.accountDebit === '1020' && e.accountCredit === '1093' && !e.vatCode));
    assert.equal(booked.length, 40, 'switched on, the 40 payouts are booked from the clearing account');
  } finally {
    await api.stop();
  }
});
