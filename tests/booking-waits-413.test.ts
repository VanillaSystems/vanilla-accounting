/**
 * #413: every booking by the firm's rules or the model honours the approval of `booking`. A rule
 * file changed by hand (not through the app's own controls) makes «Buchen» wait for «Einschalten»:
 * a drop then reads, matches and links, but books nothing by that rule; the drop's report waits in
 * its row; «Automatisch buchen» for all and «Neu buchen» say why. «Einschalten» books what waited.
 * A fresh workspace (as `npm run init` makes it) starts switched on, its first drop books as before,
 * and what the app's own code learns from confirmed links (a merchant's name, #190) makes nothing wait.
 * The webshop persona's own files, no model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { checkAnswers } from '../src/workspace/create.js';
import { PRESETS, type Answers } from '../src/workspace/setup.js';
import { applyPlan, planWorkspace } from '../src/workspace/scaffold.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_FOLDER, type Uid } from '../src/workspace/workspace.js';
import type { Iban } from '../src/workspace/banks.js';
import type { DropSession } from '../src/types/drop.js';
import { loadBooks, receiptFile, saveBooks } from '../src/books/store.js';
import type { Receipt } from '../src/types/index.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { noBrowser, openApp } from './support/e2e.js';
import './support/jurisdiction.js';

// @ts-expect-error a plain ES module of the verify skill, without types
import webshop from '../.claude/skills/verify/persona-files/webshop.mjs';

const FILES = (webshop as () => { files: Record<string, string> })().files;
const IBAN = /<Acct>\s*<Id>\s*<IBAN>([A-Z0-9]+)</.exec(FILES['camt053_LUKB_Q3-2026.xml'])![1] as Iban;
const GUIDE = join('knowledge', 'rules', 'booking.guide.yaml');
/** A rule written into the firm's file by hand: Julia Studer's payment is a sale at the normal rate. */
const RULE = 'process: booking\nsteps:\n  classify:\n    rules:\n      - id: studer-verkauf\n        when: { text: "Studer", direction: in }\n        then: { account: "3200", vat: 81 }\n        source: hand 2026-11-13\n';

/** The webshop's new books as `npm run init` makes them. */
function shopBooks(): string {
  const root = mkdtempSync(join(tmpdir(), 'webshop-413-'));
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
    add: (name: string, bytes = Buffer.from(FILES[name])) => post(`/api/drop/${s.id}/files?name=${encodeURIComponent(name)}`, bytes),
    act: (key: string, body: object) => post(`/api/drop/${s.id}/rows/${key}`, body),
  };
}

interface View { pending: Array<{ workflow: string; files: string[] }>; runs: Array<{ id: string; workflow: string }> }
const view = async (api: ApiServer) => (await api.send('GET', '/api/automation')).json as unknown as View;
const bookingPending = async (api: ApiServer) => (await view(api)).pending.find((p) => p.workflow === 'booking');
const studer = (api: ApiServer) => loadBooks(api.ws).transactions.find((t) => t.counterparty === 'Julia Studer')!;
const entriesOf = (api: ApiServer, ref: string) => loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === ref).map((e) => `${e.accountDebit}/${e.accountCredit} ${e.vatCode ?? ''}`);
/** The notes the inbox runs' book steps left. */
async function bookNotes(api: ApiServer): Promise<Array<{ code: string; files?: string[]; waiting?: number }>> {
  const runs = (await view(api)).runs.filter((r) => r.workflow === 'receipt-intake');
  const out = [];
  for (const r of runs) {
    const d = (await api.send('GET', `/api/automation/runs/${r.id}`)).json as { steps: Array<{ step: string; output?: { notes?: Array<{ code: string }> } }> };
    out.push(...d.steps.filter((s) => s.step === 'book').flatMap((s) => s.output?.notes ?? []));
  }
  return out;
}

test('a rule changed by hand, then a drop: nothing is booked by it, the run says why; «Einschalten» books the payment', async () => {
  const api = await startApi(shopBooks(), {}, { whole: true });
  try {
    assert.equal(await bookingPending(api), undefined, 'a fresh workspace starts switched on');
    mkdirSync(join(api.root, 'knowledge', 'rules'), { recursive: true });
    writeFileSync(join(api.root, GUIDE), RULE);
    assert.deepEqual((await bookingPending(api))?.files, ['knowledge/rules/booking.guide.yaml'], 'the change by hand waits');
    const one = await dropper(api);
    await one.add('camt053_LUKB_Q3-2026.xml');
    await api.rest();
    assert.deepEqual(entriesOf(api, studer(api).ref), [], 'the rule she has not seen books nothing');
    const notes = await bookNotes(api);
    const waits = notes.find((n) => n.code === 'bookingWaits');
    assert.ok(waits, `the book step says why: ${JSON.stringify(notes)}`);
    assert.deepEqual(waits.files, ['knowledge/rules/booking.guide.yaml']);
    assert.ok(waits.waiting! > 0);
    assert.equal(loadBooks(api.ws).journalEntries.length, 0, 'nothing at all is booked while it waits');
    // «Automatisch buchen» for all, and «Neu buchen» on the payment: the same reason, nothing booked.
    const all = await api.send('POST', '/api/rules/book-open', {});
    assert.deepEqual([all.json.booked, all.json.waits], [0, ['knowledge/rules/booking.guide.yaml']]);
    const again = await api.send('POST', `/api/journal-entries/classify/${encodeURIComponent(studer(api).ref)}`, {});
    assert.deepEqual([again.status, (again.json as { code?: string }).code], [409, 'bookingWaits']);
    assert.deepEqual(entriesOf(api, studer(api).ref), []);
    // «Einschalten»: the inbox run it starts books the payment by the rule now switched on.
    const on = await api.send('POST', '/api/automation', { kind: 'approve', workflow: 'booking' });
    assert.equal(on.json.ok, true);
    await api.rest();
    assert.equal(await bookingPending(api), undefined);
    assert.deepEqual(entriesOf(api, studer(api).ref), ['1020/3200 V81'], 'switched on, the payment that waited is booked by the rule');
  } finally {
    await api.stop();
  }
});

test('a provider\'s report dropped while «Buchen» waits: its row waits with the changed files, nothing booked; switched on and taken again, it goes on', async () => {
  const api = await startApi(shopBooks(), {}, { whole: true });
  try {
    await view(api);
    const one = await dropper(api);
    await one.add('camt053_LUKB_Q3-2026.xml');
    await api.rest();
    mkdirSync(join(api.root, 'knowledge', 'rules'), { recursive: true });
    writeFileSync(join(api.root, GUIDE), RULE);
    const two = await dropper(api);
    const added = await two.add('orders_export_1.csv');
    const row = added.s.rows.find((r) => r.name === 'orders_export_1.csv')!;
    assert.deepEqual([row.state, row.reason, row.bookingWaits], ['unclear', 'booking-waits', ['knowledge/rules/booking.guide.yaml']]);
    assert.equal(loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef?.startsWith('SR-')).length, 0, 'no sale of the report booked');
    // Taken again while it still waits: the same row, the same words.
    const still = await two.act(row.key, { kind: 'take' });
    assert.equal(still.s.rows.find((r) => r.key === row.key)?.reason, 'booking-waits');
    assert.equal((await api.send('POST', '/api/automation', { kind: 'approve', workflow: 'booking' })).json.ok, true);
    const taken = await two.act(row.key, { kind: 'take' });
    const after = taken.s.rows.find((r) => r.key === row.key)!;
    assert.notEqual(after.reason, 'booking-waits', 'switched on, the report is taken up');
    assert.equal(after.bookingWaits, undefined);
    assert.equal(after.askProvider?.missing, 'clearing', 'and asks what a fresh firm\'s report asks');
    await api.rest();
  } finally {
    await api.stop();
  }
});

test('the first run is not worse: a fresh workspace\'s first drop books as before, and nothing waits for «Einschalten»', async () => {
  const api = await startApi(shopBooks(), {}, { whole: true });
  try {
    const one = await dropper(api);
    await one.add('camt053_LUKB_Q3-2026.xml');
    await api.rest();
    assert.equal(await bookingPending(api), undefined);
    assert.deepEqual((await bookNotes(api)).filter((n) => n.code === 'bookingWaits'), [], 'its book step booked');
    const b = loadBooks(api.ws);
    assert.ok(b.journalEntries.length > 0, 'code and the app\'s rules booked what they decide');
  } finally {
    await api.stop();
  }
});

test('a merchant name the app learns from two confirmed links (#190) is no change she must switch on: «Buchen» goes on', async () => {
  const api = await startApi(shopBooks(), {}, { whole: true });
  try {
    await view(api);
    const uid = 'CHE-111.222.333';
    // The business's file, written by hand and switched on: the starting point.
    writeFileSync(join(api.root, 'knowledge', 'suppliers', 'kontor.yaml'), `id: kontor\nname: Kontorwaren Muster AG\nmatch:\n  uid: [ "${uid}" ]\n`);
    assert.equal((await api.send('POST', '/api/automation', { kind: 'approve', workflow: 'booking' })).json.ok, true);
    assert.equal(await bookingPending(api), undefined);
    // Two of her statement's payments to the same merchant, each linked by her to a receipt of the business.
    const one = await dropper(api);
    await one.add('camt053_LUKB_Q3-2026.xml');
    await api.rest();
    const b = loadBooks(api.ws);
    const pays = b.transactions.filter((t) => t.counterparty === 'Jana Imhof').slice(0, 2);
    assert.equal(pays.length, 2);
    pays.forEach((t, k) => {
      const r = { id: `kontor-${k}`, filename: `kontor-${k}.pdf`, originalFilename: `kontor-${k}.pdf`, extractionMethod: 'pdftotext', fileSize: 4, indexedAt: '', location: 'archived', date: t.date, amount: Math.abs(t.amount), currency: 'CHF', vatId: uid, title: { vendor: 'Kontorwaren Muster AG', what: 'Papier' }, extractedText: 'Kontorwaren Muster AG Rechnung' } as never as Receipt;
      b.receipts.push(r);
      b.mappings.push({ transactionRef: t.ref, receiptId: r.id, by: 'human' } as never);
      const file = receiptFile(api.ws, b, r);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '%PDF');
    });
    saveBooks(api.ws, b);
    const run = await api.send('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } });
    assert.equal(run.json.ok, true, JSON.stringify(run.json));
    await api.rest();
    assert.match(readFileSync(join(api.root, 'knowledge', 'suppliers', 'kontor.yaml'), 'utf8'), /Jana Imhof/, 'the name is learned');
    assert.equal(await bookingPending(api), undefined, 'what the app learned makes nothing wait');
  } finally {
    await api.stop();
  }
});

test('in the app: the drop says why it booked nothing, with «Einschalten» right there; one click books what waited and takes the report', { skip: noBrowser, timeout: 300_000 }, async () => {
  const app = await openApp(shopBooks());
  const shots = process.env.SHOTS ?? mkdtempSync(join(tmpdir(), 'booking-waits-'));
  try {
    const { page, api } = app;
    await app.open('/receipts', '#root > *');
    await view(api);
    mkdirSync(join(api.root, 'knowledge', 'rules'), { recursive: true });
    writeFileSync(join(api.root, GUIDE), RULE);
    const drop = (name: string, type: string) => page.evaluate((text, file, kind) => {
      const files = new DataTransfer();
      files.items.add(new File([text], file, { type: kind }));
      dispatchEvent(new DragEvent('drop', { dataTransfer: files, clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
    }, FILES[name], name, type);
    // Her statement: read, nothing booked, and the dialog says why, once, with «Einschalten».
    await drop('camt053_LUKB_Q3-2026.xml', 'application/xml');
    await page.waitForSelector('[data-testid=drop-booking-waits-sum] [data-act=booking-switch-on]', { timeout: 120_000 });
    const said = await page.$eval('[data-testid=drop-booking-waits-sum]', (e) => (e as HTMLElement).innerText);
    assert.match(said, /Die App bucht gerade nicht von selbst: knowledge\/rules\/booking\.guide\.yaml hat sich seit dem letzten Einschalten geändert, und nach Regeln, die du noch nicht gesehen hast, bucht sie nicht\. Mit «Einschalten» gilt die Änderung, und die App bucht, was gewartet hat\./);
    assert.deepEqual(entriesOf(api, studer(api).ref), []);
    await page.screenshot({ path: join(shots, 'drop-statement-booking-waits.png') });
    await page.click('[data-testid=drop-close]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=drop-dialog]'));
    // Her order export: its row waits with the same words.
    await drop('orders_export_1.csv', 'text/csv');
    await page.waitForSelector('[data-testid=drop-booking-waits] [data-act=booking-switch-on]', { timeout: 120_000 });
    assert.match(await page.$eval('[data-testid=drop-booking-waits]', (e) => (e as HTMLElement).innerText), /Die App bucht gerade nicht von selbst: knowledge\/rules\/booking\.guide\.yaml/);
    await page.screenshot({ path: join(shots, 'drop-report-booking-waits.png') });
    // One click: switched on, the payment that waited is booked, and the report's row is taken again.
    await page.click('[data-testid=drop-booking-waits] [data-act=booking-switch-on]');
    await page.waitForSelector('[data-testid=booking-waits-done]');
    await api.rest();
    for (let i = 0; i < 100 && !entriesOf(api, studer(api).ref).length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(entriesOf(api, studer(api).ref), ['1020/3200 V81'], 'switched on, the payment that waited is booked');
    await page.waitForFunction(() => !document.querySelector('[data-testid=drop-booking-waits]') && /Durchlaufkonto|clearing|Konto/i.test(document.querySelector('[data-testid=drop-dialog]')?.textContent ?? ''), { timeout: 30_000 });
    await page.screenshot({ path: join(shots, 'drop-after-switch-on.png') });
    console.log(`screenshots: ${shots}`);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});

test('«Behalten» on a rule while «Buchen» waits for another change: her rule is kept, but books nothing with the change she has not seen', async () => {
  const api = await startApi(shopBooks(), {}, { whole: true });
  try {
    const one = await dropper(api);
    await one.add('camt053_LUKB_Q3-2026.xml');
    await api.rest();
    // A business file changed by hand: «Buchen» waits for it.
    writeFileSync(join(api.root, 'knowledge', 'suppliers', 'kartonage.yaml'), 'id: kartonage\nname: Kartonage Rigi AG\nmatch:\n  tx: [ "Kartonage Rigi" ]\n');
    assert.deepEqual((await bookingPending(api))?.files, ['knowledge/suppliers/kartonage.yaml']);
    // Her rule, drafted and kept on its card.
    const draft = join(api.ws.paths.data, 'draft', GUIDE);
    mkdirSync(dirname(draft), { recursive: true });
    writeFileSync(draft, RULE);
    const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent('knowledge/rules/booking.guide.yaml')}`)).json as { basis: string; confirm: boolean };
    const kept = await api.send('POST', '/api/rules/draft', { kind: 'keep', path: 'knowledge/rules/booking.guide.yaml', basis: card.basis, confirm: card.confirm });
    assert.equal(kept.json.ok, true, JSON.stringify(kept.json));
    // Since the last switching on both files changed: the approval is of the whole, so her file is named beside the other.
    assert.deepEqual(kept.json.bookingWaits, ['knowledge/rules/booking.guide.yaml', 'knowledge/suppliers/kartonage.yaml'], 'the card says why it booked nothing');
    await api.rest();
    assert.deepEqual(entriesOf(api, studer(api).ref), [], 'not booked while the other change waits');
    assert.ok((await bookingPending(api))?.files.includes('knowledge/suppliers/kartonage.yaml'), 'her keep does not switch on what she has not seen');
    assert.equal((await api.send('POST', '/api/automation', { kind: 'approve', workflow: 'booking' })).json.ok, true);
    await api.rest();
    assert.deepEqual(entriesOf(api, studer(api).ref), ['1020/3200 V81'], 'switched on, her rule books it');
  } finally {
    await api.stop();
  }
});
