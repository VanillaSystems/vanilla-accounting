/**
 * #344 on the real API server: a rule started from a payment says how many open payments it would
 * hold for and names the wider start by the payment's lasting words (six wages to two people are
 * one rule «Lohn», chosen by the person), the firm's default accounts reach the page, and a
 * sidebar answer of a CLI that is not signed in is the app's refusal, not «Please run /login».
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import type { AssistantEvent, Conversation, Turn } from '../src/types/assistant.js';
import type { HandStart } from '../src/saving/hand-rule.js';

const servers: ApiServer[] = [];
const dirs: string[] = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('a rule started from a wage: the payer\'s three payments, and the wider start «Lohn» for all four of the fixture; by=text takes it', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json');
  servers.push(api);
  const start = async (q: string) => (await api.send('GET', `/api/rules/hand?payment=${q}`)).json.start as unknown as HandStart;
  const byPayer = await start('L1');
  assert.deepEqual([byPayer.match.kind, byPayer.direction, byPayer.similar, byPayer.wider], ['payer', 'out', 2, { text: 'Lohn', similar: 4 }]);
  const byText = await start('L1&by=text');
  assert.deepEqual([byText.match, byText.similar, byText.wider], [{ kind: 'text', text: 'Lohn' }, 4, undefined]);
  const sale = await start('K1');
  assert.deepEqual([sale.direction, sale.similar, sale.wider, sale.rule], ['in', 1, undefined, undefined], 'one payment of its kind: no count to offer');

  // A booked wage is no longer one of the open ones.
  const booked = await api.send('POST', '/api/transactions/L3/entries', { lines: [{ accountDebit: '5000', accountCredit: '1021', amount: 5200, description: 'Lohn August' }] });
  assert.equal(booked.status, 200, JSON.stringify(booked.json));
  assert.deepEqual([(await start('L1')).similar, (await start('L1')).wider], [1, { text: 'Lohn', similar: 3 }]);
});

/** The demo's manifest with the setup's answers of a trades firm (it makes goods and sells services), as `npm run init --preset trades` writes them. */
function tradesManifest(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trades-manifest-'));
  dirs.push(dir);
  const demo = readFileSync(join(APP_ROOT, 'demo', APP_FOLDER, 'belege.workspace.yaml'), 'utf8');
  writeFileSync(join(dir, 'belege.workspace.yaml'), `${demo.trimEnd()}
profile:
  preset: trades
  fiscalYear: calendar
  start: new
  sells: both
  foreignCustomers: no
  imports: no
  employees: staff
  ownerPaysPrivately: yes
  privateUse: [car, phone]
  payouts: no
  goods: [made]
`);
  return dir;
}

test('the workspace tells the page the firm\'s default accounts, as the setup wrote them; a manifest without the answers tells none', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: tradesManifest() });
  servers.push(api);
  const { json } = await api.send('GET', '/api/workspace');
  assert.deepEqual(json.defaults, {
    sales: '3400', purchase: '4000',
    all: { kinds: ['made', 'services'], purchase: [{ kind: 'made', account: '4000' }], sales: [{ kind: 'made', account: '3000' }, { kind: 'services', account: '3400' }] },
  });
  const bare = await startApi('tests/fixtures/by-hand-index.json');
  servers.push(bare);
  assert.equal((await bare.send('GET', '/api/workspace')).json.defaults, undefined);
});

/** A `claude` that answers as Claude Code does when it is installed and not signed in: the refusal as the answer's text and as the result. */
function signedOutClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'signed-out-claude-'));
  dirs.push(dir);
  const said = 'Not logged in · Please run /login';
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's-1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: said }] }, error: 'authentication_failed' },
    { type: 'result', subtype: 'success', is_error: true, result: said, session_id: 's-1' },
  ];
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('0.0.0 (stub)\\n'); process.exit(0); }
if (process.argv[2] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: false })); process.exit(1); }
require('node:fs').readFileSync(0, 'utf8');
process.stdout.write(${JSON.stringify(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')});
process.exit(1);
`);
  chmodSync(bin, 0o755);
  return bin;
}

test('the AI column with a CLI that is not signed in: one refusal `signedOut` for the UI\'s own sentence, the CLI\'s «Please run /login» nowhere in the answer', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json', { CLAUDE_BIN: signedOutClaude() });
  servers.push(api);
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Richte mit mir ein, wie meine Belege hereinkommen.', language: 'de', context: [] }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  const errors = events.filter((e) => e.type === 'error');
  assert.deepEqual(errors.map((e) => e.type === 'error' && e.why), [{ reason: 'signedOut', cli: 'claude' }], JSON.stringify(events));
  assert.ok(events.some((e) => e.type === 'replace' && e.text === ''), 'the CLI\'s words are taken out of the answer');
  const id = (events[0] as { id: string }).id;
  const turn = ((await api.send('GET', `/api/assistant/${id}`)).json as unknown as Conversation).turns.at(-1) as Extract<Turn, { role: 'ai' }>;
  assert.deepEqual([turn.text, turn.errorWhy], ['', { reason: 'signedOut', cli: 'claude' }]);
});
