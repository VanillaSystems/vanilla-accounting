/**
 * TypeSafe Jev as an optional provider (issue #48 step 3), against a local stand-in of its API:
 * it answers only typed steps, below the step's confidence the default answers, and a source's
 * code asks it through io.mail.triage with nothing but a mail's sender and subject.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerPath, resolveStep, type LedgerRow } from '../src/llm/ask.js';
import { judge, judgePrompt, parseJudgement } from '../src/llm/judge.js';
import { forgetKey } from '../src/llm/providers/index.js';
import { imageSize } from '../src/llm/providers/jev.js';
import { mailChannel, type MailBackend } from '../src/platform/sources/mail-channel.js';
import { parseSender } from '../src/platform/sources/reach.js';
import { DEMO_ROOT } from './support/workspace.js';
import { providerStub, type ProviderStub } from './support/provider-stub.js';

const KEY = 'test-key-jev-0005';
const anyone = (() => { const p = parseSender('*'); if (!p.ok) throw new Error('*'); return p.value; })();
const TRIAGE = { type: 'noul' as const, instructions: 'Does this mail bring a receipt?' };
const MAIL = { from: 'billing@shop.example', subject: 'Ihre Rechnung Nr. 1' };
let dir: string;
let stub: ProviderStub;

const choose = (steps: Record<string, unknown>) => writeFileSync(join(dir, 'ai.json'), JSON.stringify({ steps }));
const ledger = (): LedgerRow[] => readFileSync(ledgerPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const jevCalls = () => stub.seen.filter((s) => s.path === '/v1/systemone');

/** A PNG of `w`×`h` as far as its header says: enough for the size check and the upload. */
const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

before(async () => {
  stub = await providerStub();
  dir = mkdtempSync(join(tmpdir(), 'jev-'));
  process.env.VANILLA_WORKSPACE = join(dir, 'ws');
  cpSync(DEMO_ROOT, process.env.VANILLA_WORKSPACE, { recursive: true });
  process.env.VANILLA_SECRETS_FILE = join(dir, 'secrets.json');
  process.env.VANILLA_AI_SETTINGS = join(dir, 'ai.json');
  process.env.VANILLA_JEV_URL = stub.url;
  process.env.CLAUDE_BIN = join(process.cwd(), 'tests/support/stub-bin/claude');
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ 'ai:jev': KEY }));
  writeFileSync(join(dir, 'ok.png'), png(600, 800));
  writeFileSync(join(dir, 'huge.png'), png(3000, 2000));
});
after(() => stub.stop());
beforeEach(() => {
  stub.seen.length = 0;
  stub.reply.clear();
  forgetKey('jev');
  choose({ 'mail-triage': { provider: 'jev', model: 'jev-latest' } });
  process.env.CLAUDE_STUB_ANSWER = '{"yes": 0.1}';
});

test('a sure answer is Jev\'s: the key as bearer, the typed question, the state, the ledger', async () => {
  const v = await judge(MAIL, TRIAGE, { step: 'mail-triage' });
  assert.deepEqual(v, { type: 'noul', yes: 0.93, confidence: 0.93, provider: 'jev', model: 'jev-latest' });
  const [sent, ...more] = jevCalls();
  assert.equal(more.length, 0, 'one call: Jev lists no models, so nothing is asked before the question');
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(sent.body, { model: 'jev-latest', state: MAIL, questions: { q: { type: 'noul', instructions: TRIAGE.instructions, criteria: null } } });
  const row = ledger().at(-1)!;
  assert.deepEqual([row.step, row.provider, row.model, row.ok, row.input], ['receipt-collection.guide.yaml#triage', 'jev', 'jev-latest', true, 40]);
});

test('below the step\'s confidence the default model answers instead', async () => {
  stub.reply.set('POST /v1/systemone', { status: 200, body: { answers: { q: { type: 'noul', noul: 0.6 } }, usage: { input_tokens: 40, output_tokens: 1 } } });
  const v = await judge(MAIL, TRIAGE, { step: 'mail-triage' });
  assert.deepEqual(v, { type: 'noul', yes: 0.1, confidence: 0.9, provider: 'claude-cli', model: 'haiku' });
  assert.deepEqual(ledger().slice(-2).map((r) => [r.provider, r.ok]), [['jev', true], ['claude-cli', true]]);
});

test('when Jev fails the default answers; a choice question works the same way', async () => {
  stub.reply.set('POST /v1/systemone', { status: 503, body: { error: { message: 'busy' } } });
  process.env.CLAUDE_STUB_ANSWER = '{"choice": "receipt", "confidence": 0.7}';
  const v = await judge('Rechnung 1', { type: 'choice', instructions: 'What is it?', options: { receipt: 'an invoice', other: null } }, { step: 'mail-triage' });
  assert.deepEqual([v.type, v.type === 'choice' && v.choice, v.provider], ['choice', 'receipt', 'claude-cli']);
});

test('Jev is never offered for a step that needs text, JSON or a PDF', async () => {
  choose({ classify: { provider: 'jev', model: 'jev-latest' }, 'receipt-vision': { provider: 'jev', model: 'jev-latest' }, 'receipt-titles': { provider: 'jev' } });
  for (const step of ['classify', 'receipt-vision', 'receipt-titles'] as const) assert.equal((await resolveStep(step)).provider.id, 'claude-cli', step);
});

test('an image goes as a multipart part behind the opt-in header; one outside 280–1568 px never leaves', async () => {
  await judge('Quittung', TRIAGE, { step: 'mail-triage', images: [join(dir, 'ok.png')] });
  const [sent] = jevCalls();
  assert.equal(sent.headers['typesafe-danger-zone-images'], 'true');
  assert.match(String(sent.headers['content-type']), /^multipart\/form-data; boundary=/);
  assert.match(sent.body, /name="request"[\s\S]*"assets":\{"<image:0>":\{"type":"image","part":"asset-0"\}\}/);
  assert.match(sent.body, /"state":"Quittung\\n\\n<image:0>"/);
  assert.match(sent.body, /name="asset-0"; filename="asset-0"\r\nContent-Type: image\/png/);
  stub.seen.length = 0;
  await assert.rejects(judge('Quittung', TRIAGE, { step: 'mail-triage', images: [join(dir, 'huge.png')] }), /280 to 1568 pixels a side; huge\.png is 3000×2000/);
  assert.equal(jevCalls().length, 0);
});

test('image sizes are read from a PNG or a JPEG header', () => {
  assert.deepEqual(imageSize(png(281, 1568)), { type: 'image/png', width: 281, height: 1568 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
  assert.deepEqual(imageSize(jpeg), { type: 'image/jpeg', width: 800, height: 600 });
  assert.equal(imageSize(Buffer.from('%PDF-1.4')), undefined);
});

test('a text model answers a typed question through a prompt, and only with a valid answer', () => {
  assert.match(judgePrompt(MAIL, TRIAGE), /"from": "billing@shop\.example"[\s\S]*Question \(yes or no\): Does this mail bring a receipt\?/);
  assert.deepEqual(parseJudgement('Sure: {"yes": 0.25}', TRIAGE), { type: 'noul', yes: 0.25, confidence: 0.75 });
  assert.equal(parseJudgement('{"yes": 7}', TRIAGE), undefined);
  assert.equal(parseJudgement('{"choice": "maybe", "confidence": 1}', { type: 'choice', instructions: '', options: { a: null } }), undefined);
});

test('io.mail.triage asks about a mail the source was shown, by its sender and subject only', async () => {
  const backend: MailBackend = {
    list: async () => ({ validity: '1', messages: [{ uid: 7, from: 'Billing@Shop.example', to: [], subject: 'Ihre Rechnung Nr. 1', date: '2026-10-01', messageId: 'm7' }] }),
    attachments: async () => [],
    close: async () => {},
  };
  const asked: unknown[] = [];
  const channel = mailChannel(backend, { folders: ['INBOX'], from: [anyone], skip: [] }, [], new Date(0), new Map(), async (state, q, o) => {
    asked.push([state, q.type, o.step]);
    return { type: 'noul', yes: 0.95, confidence: 0.95, provider: 'jev', model: 'jev-latest' };
  });
  await assert.rejects(channel.triage(7), /was not handed to this source/);
  await channel.messages();
  assert.deepEqual(await channel.triage(7), { receipt: 0.95, confidence: 0.95, by: 'jev jev-latest' });
  assert.deepEqual(asked, [[{ from: 'billing@shop.example', subject: 'Ihre Rechnung Nr. 1' }, 'noul', 'mail-triage']]);
  const failing = mailChannel(backend, { folders: ['INBOX'], from: [anyone], skip: [] }, [], new Date(0), new Map(), async () => { throw new Error('no model'); });
  await failing.messages();
  assert.deepEqual(await failing.triage(7), { receipt: null, why: 'no model' });
});

test('a Jev key is checked with one question about a word, no company data', async () => {
  const { JEV } = await import('../src/llm/providers/jev.js');
  await JEV.check(KEY);
  assert.deepEqual(jevCalls().at(-1)!.body.state, 'Hallo');
});
