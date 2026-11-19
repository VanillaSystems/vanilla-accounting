/**
 * «Immer so» on the real API (src/server/routes/payroll.ts, docs/specs/payroll.md §22 decision 59): the GET names the
 * payments the click books, the POST books exactly those (never one a company rule decides) and then writes the fund's
 * file, «davor» is never kept, the insurer's page shows the kept way, «Rückgängig» takes it out, (a fund's file that is no YAML map is refused with a code: tests/payroll-insurer-way.test.ts). Invented firm: payroll runs here from October, the Akontos of October to December are paid ahead.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { savePayroll } from '../src/payroll/store.js';
import { loadBooks } from '../src/books/store.js';
import { loadChart } from '../src/workspace/chart.js';
import { firm, owner } from './support/payroll.js';

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/payroll-insurer-way-index.json');
  mkdirSync(dirname(api.ws.paths.accounts), { recursive: true });
  writeFileSync(api.ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  savePayroll(api.ws, firm([owner({ opening: { 2026: { through: '2026-09', bases: { ahv: 90000 } } } })]));
  // A company rule that asks about «Sonderfall» payments: the one that matches stays the rule's.
  mkdirSync(join(api.root, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(api.root, 'knowledge', 'rules', 'booking.guide.yaml'), 'steps:\n  classify:\n    rules:\n      - id: sonderfall\n        when: { text: "Sonderfall", direction: out }\n        then: { ask: "Was ist das?", account: "5720", vat: none }\n        source: wish 2026-11-01\n');
});
after(() => api?.stop());

const booked = () => loadBooks(api.ws).journalEntries.map((e) => [e.transactionRef, e.accountDebit, e.accountCredit, e.amount, e.by?.kind]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

test('«Immer so»: named first, then exactly those booked; a rule\'s payment left alone; «davor» never kept; undone from the insurer\'s page', async () => {
  const list = await api.send('GET', '/api/payroll/insurer-payments');
  assert.ok((list.json.refs as string[]).includes('PK-OCT'));
  const plan = await api.send('GET', '/api/payroll/insurer-way?ref=PK-OCT');
  assert.equal(plan.status, 200);
  assert.deepEqual((plan.json.payments as Array<{ ref: string }>).map((p) => p.ref), ['PK-OCT', 'PK-DEC'], 'the rule\'s «Sonderfall» payment is not among them');
  assert.equal(plan.json.path, 'knowledge/suppliers/pensionskasse-beispiel.yaml');
  assert.ok(!existsSync(join(api.root, String(plan.json.path))), 'the GET writes nothing');
  assert.deepEqual(booked(), []);

  const before = await api.send('POST', '/api/payroll/insurer-way', { ref: 'KTG-1', way: 'before' });
  assert.equal(before.status, 400, '«für Monate davor» is chosen per payment, never kept');
  assert.equal(before.json.code, 'payroll');

  const kept = await api.send('POST', '/api/payroll/insurer-way', { ref: 'PK-OCT', way: 'after' });
  assert.equal(kept.status, 200);
  assert.deepEqual(kept.json.booked, ['PK-OCT', 'PK-DEC']);
  assert.deepEqual(booked(), [['PK-DEC', '2275', '1021', 600, 'code'], ['PK-OCT', '2275', '1021', 600, 'code']]);
  assert.match(readFileSync(join(api.root, String(kept.json.path)), 'utf8'), /payroll:\n  payments: liability\n/);

  const rows = (await api.send('GET', '/api/payroll/insurances?year=2026')).json.rows as Array<{ id: string; kept?: { business: string; path: string } }>;
  assert.deepEqual(rows.find((r) => r.id === 'pk')?.kept?.business, 'pensionskasse-beispiel', 'the insurer\'s page shows the kept way');
  assert.equal(rows.find((r) => r.id === 'ak')?.kept, undefined);

  const undo = await api.send('DELETE', '/api/payroll/insurer-way?business=pensionskasse-beispiel');
  assert.equal(undo.status, 200);
  assert.doesNotMatch(readFileSync(join(api.root, String(kept.json.path)), 'utf8'), /payroll:/);
  assert.equal(booked().length, 2, 'what was booked stays booked');
  const after = (await api.send('GET', '/api/payroll/insurances?year=2026')).json.rows as Array<{ id: string; kept?: unknown }>;
  assert.equal(after.find((r) => r.id === 'pk')?.kept, undefined);
});

