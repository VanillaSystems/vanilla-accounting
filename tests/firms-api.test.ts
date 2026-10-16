/**
 * The books API for the other kinds of firm (persona round 5): on the net tax rate method and
 * without VAT registration, the server takes only the codes the firm's form takes, a check of the
 * year close that fails answers an error instead of hanging, and a firm without returns closes its
 * year without one. On the real API server (tests/support/api-server.ts) with the demo manifest of
 * each kind of firm and a temp copy of tests/fixtures/sale-vat-index.json.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { APP_FOLDER, APP_ROOT, yearPaths } from '../src/workspace/workspace.js';
import { loadBooks, saveBooks } from '../src/books/store.js';
import type { Question } from '../src/questions/model.js';

const FIXTURE = 'tests/fixtures/sale-vat-index.json';
const servers: ApiServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); });
async function start(manifestOf?: string): Promise<ApiServer> {
  const api = await startApi(FIXTURE, {}, manifestOf ? { manifestOf: join(APP_ROOT, manifestOf, APP_FOLDER) } : {});
  servers.push(api);
  return api;
}

const ENTRY = { date: '2026-08-12', accountDebit: '4000', accountCredit: '1020', amount: 540.5, description: 'Holz Beispiel' };

test('a year-close check that cannot be computed answers an error, never a request that hangs (r5f-23)', async () => {
  const api = await start();
  const filings = yearPaths(api.ws.paths, '2026').filings;
  mkdirSync(filings, { recursive: true });
  writeFileSync(join(filings, 'mwst-ech0217-2026-Q1.xml'), '<?xml version="1.0"?><VATDeclaration>broken</VATDeclaration>');
  const res = await api.fetch('/api/year-close/2026', { signal: AbortSignal.timeout(8000) });
  assert.equal(res.status, 500);
  const body = await res.json() as { error: string };
  assert.match(body.error, /2026-Q1|reportingPeriod|VATDeclaration/);
});

test('net tax rate method: the server refuses an input-tax code on an entry, a change and a payment booked by hand; the firm\'s own code passes (r5f-17)', async () => {
  const api = await start('demo-schreinerei');
  const refused = await api.send('POST', '/api/journal-entries', { ...ENTRY, vatCode: 'I81' });
  assert.deepEqual([refused.status, refused.json.code], [400, 'codeNotTaken'], JSON.stringify(refused.json));
  assert.deepEqual(refused.json.params, { code: 'I81', method: 'net-rate' });
  assert.ok(!loadBooks(api.ws).journalEntries.some((e) => e.vatCode === 'I81'), 'nothing was saved');

  const ok = await api.send('POST', '/api/journal-entries', { date: '2026-08-12', accountDebit: '1020', accountCredit: '3400', amount: 1000, description: 'Barverkauf', vatCode: 'F1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const id = (ok.json.entry as { id: string }).id;
  const changed = await api.send('PATCH', `/api/journal-entries/${id}`, { vatCode: 'I81' });
  assert.deepEqual([changed.status, changed.json.code], [400, 'codeNotTaken']);
  assert.equal(loadBooks(api.ws).journalEntries.find((e) => e.id === id)?.vatCode, 'F1');

  const booked = loadBooks(api.ws).journalEntries.find((e) => e.transactionRef === 'S-CH')!;
  assert.equal((await api.send('DELETE', `/api/journal-entries/${booked.id}`)).status, 200);
  const payment = await api.send('POST', '/api/transactions/S-CH/entries', { lines: [{ accountDebit: '1020', accountCredit: '3400', amount: 1081, vatCode: 'I81', description: 'Beratung' }] });
  assert.deepEqual([payment.status, payment.json.code], [400, 'codeNotTaken']);
});

test('not registered: the server refuses every VAT code, a code typed by hand included (r5f-5)', async () => {
  const api = await start('demo-coiffeur');
  const refused = await api.send('POST', '/api/journal-entries', { ...ENTRY, vatCode: 'M81' });
  assert.deepEqual([refused.status, refused.json.code, refused.json.params], [400, 'codeNotTaken', { code: 'M81', method: 'none' }], JSON.stringify(refused.json));
  const ok = await api.send('POST', '/api/journal-entries', ENTRY);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('not registered: the year closes without a return, and the private-use entry debits the owner\'s own account (r5f-11, seams: 2850)', async () => {
  const api = await start('demo-coiffeur');
  const res = await api.send('GET', '/api/year-close/2026');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const close = res.json as { checks: Array<{ id: string; status: string; problems: Array<{ code: string }> }>; blockers: Array<{ code: string }>; templates: Array<{ id: string; accountDebit: string }> };
  assert.ok(!close.checks.some((c) => c.id === 'q4Filed'), 'no return to file');
  const sealed = close.checks.find((c) => c.id === 'quartersSealed')!;
  assert.deepEqual([sealed.status, sealed.problems], ['ok', []], 'a firm without returns closes its periods with the year');
  assert.ok(!close.blockers.some((b) => b.code === 'q4NotFiled' || b.code === 'notClosed'), JSON.stringify(close.blockers));
  assert.equal(close.templates.find((tp) => tp.id === 'privateUse')?.accountDebit, '2850', 'an Einzelfirma\'s private account, not the GmbH\'s 2451');
});

test('not registered: a sidebar block that sets a receipt\'s VAT facts and then a code on its booking is refused for the code, not as «entry not found» (r6f-8)', async () => {
  const log = mkdtempSync(join(tmpdir(), 'firms-sidebar-'));
  const file = join(log, 'changes.json');
  const api = await startApi(FIXTURE, { PATH: `${join(process.cwd(), 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: file }, { manifestOf: join(APP_ROOT, 'demo-coiffeur', APP_FOLDER) });
  servers.push(api);
  writeFileSync(file, JSON.stringify([
    { kind: 'receipt', id: 'rk', set: { vat: { hasSwissVat: true, vatId: 'CHE-123.456.789 MWST', vatSummary: [{ ratePercent: 8.1, net: 370.03, vat: 29.97, gross: 400 }] } } },
    { kind: 'entry', id: 'e-doc', set: { vatCode: 'M81' } },
  ]));
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify({ text: 'Bitte mit M81', language: 'de', context: [{ kind: 'entry', id: 'e-doc', label: 'Verkauf' }] }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as { type: string; refusal?: { code: string; params?: Record<string, string> } });
  const refused = events.find((e) => e.type === 'refused');
  assert.ok(refused, JSON.stringify(events.map((e) => e.type)));
  assert.deepEqual([refused!.refusal?.code, refused!.refusal?.params?.code], ['codeNotTaken', 'M81'], JSON.stringify(refused));
  const books = loadBooks(api.ws);
  assert.ok(books.journalEntries.some((e) => e.id === 'e-doc' && e.vatCode === 'V0'), 'the booking is as it was');
  assert.equal(books.receipts.find((r) => r.id === 'rk')?.hasSwissVat, undefined, 'the receipt is as it was');
});

test('net tax rate method: «kein Umsatz» on the sale question takes the payment out of the turnover (owner\'s account, no F-code), keeps a payer rule on that account, and the undo puts the sale back (r7f-28)', async () => {
  const api = await start('demo-schreinerei');
  // The rule's facts come from the chart: the owner's account and the revenue account must be in it.
  appendFileSync(join(api.ws.paths.history, 'prior-year.Konten.txt'), '2451\tKontokorrent\n3400\tDienstleistungsertrag\n');
  const b = loadBooks(api.ws);
  b.journalEntries.find((e) => e.id === 'e-ch')!.vatCode = 'F1';
  saveBooks(api.ws, b);
  const id = 'q-r7f28';
  appendFileSync(yearPaths(api.ws.paths, '2026').questions, `${JSON.stringify({ v: 1, event: 'asked', id, at: new Date().toISOString(), by: 'app', to: 'Reto Beispiel', origin: 'booking', topic: 'saleVat', on: { kind: 'payment', id: 'S-CH' }, text: '?', choices: ['saleDomestic', 'saleAbroad', 'notSale'] })}\n`);
  const res = await api.send('POST', `/api/questions/${id}/answer`, { by: 'Reto Beispiel', choice: 'notSale' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const acted = (res.json as unknown as Question).answer?.acted;
  assert.ok(acted && 'marked' in acted && acted.marked, JSON.stringify(acted));
  assert.deepEqual([acted.booked, acted.undo.length, acted.account, acted.vatCode], [['e-ch'], 1, '2451', ''], 'the answer card says what changed');
  const e = loadBooks(api.ws).journalEntries.find((x) => x.id === 'e-ch')!;
  assert.deepEqual([e.accountDebit, e.accountCredit, e.vatCode, e.origin], ['1021', '2451', undefined, 'manual'], 'off the revenue account, no F-code: the half year\'s turnover drops by the payment');
  assert.equal(loadBooks(api.ws).transactions.find((t) => t.ref === 'S-CH')?.noReceiptNeeded, true);
  const rules = (parse(readFileSync(join(api.root, 'knowledge/rules/booking.guide.yaml'), 'utf8')) as { steps: { classify?: { rules?: Array<{ id: string; then: unknown }> } } }).steps.classify?.rules ?? [];
  assert.deepEqual(rules.find((r) => r.id === `sale-${id}`)?.then, { account: '2451', vat: 'none' }, 'the payer\'s next payment is booked off the turnover too, never on 3000 as «kein Umsatz»');
  const undone = await api.send('POST', `/api/questions/${id}/undo`, { by: 'Reto Beispiel' });
  assert.equal(undone.status, 200, JSON.stringify(undone.json));
  const back = loadBooks(api.ws).journalEntries.find((x) => x.id === 'e-ch')!;
  assert.deepEqual([back.accountCredit, back.vatCode, back.origin], ['3400', 'F1', 'classify']);
});

test('net tax rate method: a wrong activity code typed under Firma › MWST is refused with a code the page words, never with the manifest\'s English path (r7f-30)', async () => {
  const api = await start('demo-schreinerei');
  const before = readFileSync(join(api.root, 'belege.workspace.yaml'), 'utf8');
  const res = await api.send('PATCH', '/api/workspace', { vat: { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '4105' }] } });
  assert.equal(res.status, 400, JSON.stringify(res.json));
  assert.deepEqual([res.json.code, res.json.params], ['vatSetup', { reason: 'activityId', rate: 1 }]);
  assert.equal(readFileSync(join(api.root, 'belege.workspace.yaml'), 'utf8'), before, 'nothing saved');
  const ok = await api.send('PATCH', '/api/workspace', { vat: { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '41050' }] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});
