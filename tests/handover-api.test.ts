/**
 * The hand-over through the API (src/server/routes/handover.ts): «Teilen» writes a version and the
 * `.vanilla` file; «Öffnen…» of it opens a Durchsicht copy as the books of the server, where filing,
 * the year close, the company's settings and sharing onward are the sharer's (roleRefused), and
 * «Zu meinen Büchern» goes back.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { readPackage } from '../src/handover/package.js';

let api: ApiServer;
const copies = mkdtempSync(join(tmpdir(), 'durchsicht-api-'));
before(async () => { api = await startApi('tests/fixtures/period-lock-index.json', { VANILLA_DURCHSICHT_DIR: copies }); });
after(() => api?.stop());

let file: Uint8Array;

test('«Teilen»: the plan names what goes, the share is a .vanilla file and Version 1', async () => {
  const plan = await api.send('GET', '/api/handover/plan?name=Ernst%20Beispiel');
  assert.equal(plan.status, 200);
  assert.equal(plan.json.kind, 'full');
  assert.ok((plan.json.bytes as number) > 0);
  assert.equal((await api.send('POST', '/api/handover/share', { to: { name: '' } })).status, 400, 'a name is needed');
  const res = await api.fetch('/api/handover/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: { name: 'Ernst Beispiel', email: 'ernst@example.ch' }, message: 'Bitte Q3 ansehen' }) });
  assert.equal(res.status, 200);
  assert.match(decodeURIComponent(res.headers.get('content-disposition') ?? ''), /Buchhaltung v1 \(\d{4}-\d{2}-\d{2}\)\.vanilla/);
  file = new Uint8Array(await res.arrayBuffer());
  assert.equal(readPackage(file).index.message, 'Bitte Q3 ansehen');
  const view = await api.send('GET', '/api/handover');
  assert.equal((view.json.version as { n: number }).n, 1);
});

test('«Öffnen…» of the hand-over: a Durchsicht copy, where the sharer\'s steps are refused, and back', async () => {
  const opened = await api.fetch('/api/handover/open', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(file) });
  assert.equal(opened.status, 200);
  assert.equal((await opened.json() as { kind: string }).kind, 'full');
  const view = await api.send('GET', '/api/handover');
  const d = view.json.durchsicht as { sharer: { name: string }; me: { name: string }; changes: number; back: boolean };
  assert.equal(d.me.name, 'Ernst Beispiel');
  assert.equal(d.changes, 0);
  assert.ok(d.back);
  for (const [method, path, body] of [
    ['PATCH', '/api/workspace', { company: { business: 'x' } }],
    ['POST', '/api/handover/share', { to: { name: 'Jemand' } }],
    ['POST', '/api/automation', { kind: 'start', workflow: 'vat-filing', item: { kind: 'period', id: '2026-Q3' } }],
    ['POST', '/api/year-close/2026/close', {}],
  ] as const) {
    const r = await api.send(method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.code, 'roleRefused');
    assert.equal((r.json.params as { name: string }).name, d.sharer.name);
  }
  // He books as a person; his change is counted for the return.
  const entries = (await api.send('GET', '/books.json')).json.journalEntries as Array<{ id: string; date: string }> | undefined;
  const open = entries?.find((e) => e.date > '2026-06-30');
  assert.ok(open, 'an open entry to correct');
  {
    assert.equal((await api.send('PATCH', `/api/journal-entries/${open.id}`, { description: 'von Ernst korrigiert' })).status, 200);
    assert.equal(((await api.send('GET', '/api/handover')).json.durchsicht as { changes: number }).changes, 1);
    const ret = await api.fetch('/api/handover/return', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Ein Punkt' }) });
    assert.equal(ret.status, 200);
    assert.equal(readPackage(new Uint8Array(await ret.arrayBuffer())).index.kind, 'return');
  }
  assert.equal((await api.send('POST', '/api/handover/close')).status, 200);
  assert.equal((await api.send('GET', '/api/handover')).json.durchsicht, undefined);
});
