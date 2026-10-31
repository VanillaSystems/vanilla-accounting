/**
 * The API-key providers (issue #48 step 2) against a local stand-in of their APIs
 * (tests/support/provider-stub.ts): what each request carries, the ledger, the model list, and
 * the fallback rule: a key that fails asks the Claude subscription, never the other way round.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, ledgerPath, modelReady, resolveStep, type LedgerRow } from '../src/llm/ask.js';
import { forgetCli, forgetKey, keyedStates } from '../src/llm/providers/index.js';
import { STEP_IDS } from '../src/llm/steps.js';
import { DEMO_ROOT } from './support/workspace.js';
import { providerStub, type ProviderStub } from './support/provider-stub.js';

const ANTHROPIC_KEY = 'test-key-anthropic-0001';
const OPENAI_KEY = 'test-key-openai-0002';
const STUB_CLI = join(process.cwd(), 'tests/support/stub-bin/claude');
let STUB_SIGNED_OUT = '';
let dir: string;
let stub: ProviderStub;

const keys = (k: Record<string, string>) => {
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify(k));
  forgetKey('anthropic');
  forgetKey('openai');
};
const choose = (steps: Record<string, unknown>) => writeFileSync(join(dir, 'ai.json'), JSON.stringify({ steps }));
const ledger = (): LedgerRow[] => readFileSync(ledgerPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const calls = (path: string) => stub.seen.filter((s) => s.path === path);

before(async () => {
  stub = await providerStub();
  dir = mkdtempSync(join(tmpdir(), 'llm-providers-'));
  process.env.VANILLA_WORKSPACE = join(dir, 'ws');
  cpSync(DEMO_ROOT, process.env.VANILLA_WORKSPACE, { recursive: true });
  process.env.VANILLA_SECRETS_FILE = join(dir, 'secrets.json');
  process.env.VANILLA_AI_SETTINGS = join(dir, 'ai.json');
  process.env.VANILLA_ANTHROPIC_URL = stub.url;
  process.env.VANILLA_OPENAI_URL = stub.url;
  writeFileSync(join(dir, 'scan.pdf'), '%PDF-1.4 stub');
  writeFileSync(join(dir, 'photo.png'), 'png stub');
  STUB_SIGNED_OUT = join(dir, 'signed-out-claude');
  writeFileSync(STUB_SIGNED_OUT, `#!/bin/sh\nCLAUDE_STUB_SIGNED_OUT=1 exec ${JSON.stringify(STUB_CLI)} "$@"\n`, { mode: 0o755 });
});
after(() => stub.stop());
beforeEach(() => {
  stub.seen.length = 0;
  stub.reply.clear();
  process.env.CLAUDE_BIN = STUB_CLI;
  forgetCli();
  keys({ 'ai:anthropic': ANTHROPIC_KEY, 'ai:openai': OPENAI_KEY });
  choose({});
});

test('a step set to Anthropic sends the key in its header, the system, the PDF as a document, and ledgers the call', async () => {
  choose({ 'receipt-vision': { provider: 'anthropic', model: 'claude-haiku-5-5' } });
  let by: unknown;
  const text = await ask('Lies den Beleg', { step: 'receipt-vision', system: 'SYS', attachments: [join(dir, 'scan.pdf')], answered: (b) => { by = b; } });
  assert.equal(text, '{"stub":"anthropic"}', 'the text blocks, the thinking left out');
  const [sent] = calls('/v1/messages');
  assert.equal(sent.headers['x-api-key'], ANTHROPIC_KEY);
  assert.equal(sent.body.model, 'claude-haiku-5-5');
  assert.equal(sent.body.system, 'SYS');
  assert.deepEqual(sent.body.messages[0].content, [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.4 stub').toString('base64') } },
    { type: 'text', text: 'Lies den Beleg' },
  ]);
  assert.deepEqual(by, { provider: 'anthropic', model: 'claude-haiku-5-5' });
  const row = ledger().at(-1)!;
  assert.deepEqual([row.step, row.provider, row.model, row.ok, row.input, row.cacheCreate, row.cacheRead, row.output], ['receipt-intake.guide.yaml#vision', 'anthropic', 'claude-haiku-5-5', true, 11, 2, 3, 5]);
  assert.ok(!readFileSync(ledgerPath(), 'utf8').includes(ANTHROPIC_KEY), 'the ledger never holds the key');
});

test('a step set to OpenAI sends a PDF as file data and an image as an image, the key as bearer', async () => {
  choose({ 'receipt-match': { provider: 'openai', model: 'gpt-6.1-sol' } });
  assert.equal(await ask('Finde die Zahlung', { step: 'receipt-match', attachments: [join(dir, 'scan.pdf'), join(dir, 'photo.png')] }), '{"stub":"openai"}');
  const [sent] = calls('/v1/chat/completions');
  assert.equal(sent.headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(sent.body.messages[0].role, 'system');
  assert.deepEqual(sent.body.messages[1].content.map((c: { type: string }) => c.type), ['file', 'image_url', 'text']);
  assert.match(sent.body.messages[1].content[0].file.file_data, /^data:application\/pdf;base64,/);
  assert.equal(sent.body.messages[1].content[0].file.filename, 'scan.pdf');
  const row = ledger().at(-1)!;
  assert.deepEqual([row.provider, row.input, row.cacheRead, row.output], ['openai', 12, 8, 4]);
});

test('without its key a step set to a provider asks the default', async () => {
  keys({});
  choose({ classify: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
  assert.deepEqual([(await resolveStep('classify')).provider.id, (await resolveStep('classify')).source], ['claude-cli', 'default']);
  await ask('## Chart of Accounts', { step: 'classify' });
  assert.equal(stub.seen.length, 0, 'no request to the provider without its key');
  assert.equal(ledger().at(-1)!.provider, 'claude-cli');
});

test('a key that fails asks the Claude subscription instead; the ledger shows both calls', async () => {
  stub.reply.set('POST /v1/messages', { status: 529, body: { error: { message: 'Overloaded' } } });
  choose({ 'receipt-titles': { provider: 'anthropic', model: 'claude-haiku-5-5' } });
  const answer = await ask('{}', { step: 'receipt-titles' });
  assert.ok(answer.length);
  assert.deepEqual(ledger().slice(-2).map((r) => [r.provider, r.model, r.ok]), [['anthropic', 'claude-haiku-5-5', false], ['claude-cli', 'haiku', true]]);
});

test('a failing subscription never asks a key that costs money', async () => {
  // Installed and signed in, but every call fails (a limit, an outage): the CLI stays the default.
  const failing = join(dir, 'failing-claude');
  writeFileSync(failing, `#!/bin/sh\ncase "$1" in --version) echo 2.1.0; exit 0;; auth) echo '{"loggedIn":true}'; exit 0;; esac\ncat >/dev/null; echo 'usage limit reached' >&2; exit 1\n`, { mode: 0o755 });
  process.env.CLAUDE_BIN = failing;
  await assert.rejects(ask('{}', { step: 'classify' }), /usage limit reached/);
  assert.equal(stub.seen.filter((s) => s.method === 'POST').length, 0, 'the keys are there, and nothing was sent to them');
});

test('when the default cannot answer either, the key\'s own reason is the one given, without the key', async () => {
  process.env.CLAUDE_BIN = join(dir, 'no-such-claude');
  stub.reply.set('POST /v1/chat/completions', { status: 401, body: { error: { message: 'Incorrect API key provided' } } });
  choose({ classify: { provider: 'openai', model: 'gpt-6.1-sol' } });
  await assert.rejects(ask('{}', { step: 'classify' }), (e: Error) => /OpenAI answered 401: Incorrect API key/.test(e.message) && !e.message.includes(OPENAI_KEY));
});

test('the model list adds what each provider lists that serves these steps; a listed model can be chosen', async () => {
  const states = await keyedStates();
  const models = (id: string) => Object.fromEntries(states.find((s) => s.spec.id === id)!.provider!.models.map((m) => [m.id, m.can.includes('pdf') ? 'reads' : 'text']));
  assert.deepEqual(models('anthropic'), {
    'claude-haiku-5-5': 'reads', 'claude-sonnet-5-5': 'reads', 'claude-opus-5-5': 'reads', 'claude-sonnet-4-6': 'reads',
    'claude-mythos-5-1': 'reads',
  }, 'a Claude line the app has never heard of reads receipts too');
  assert.deepEqual(models('openai'), {
    'gpt-6-luna': 'reads', 'gpt-6.1-sol': 'reads', 'gpt-6-astra': 'reads', 'gpt-4o': 'reads',
    'gpt-7-nova': 'reads', 'gpt-3.5-turbo': 'text',
  }, 'a later generation reads without a code change; no image, speech, Responses-only, embedding or Claude model at OpenAI');
  choose({ classify: { provider: 'anthropic', model: 'claude-sonnet-4-6' } });
  await ask('{}', { step: 'classify' });
  assert.equal(calls('/v1/messages').at(-1)!.body.model, 'claude-sonnet-4-6');
});

test('no API model serves the sidebar: it needs Claude Code\'s tools and session', async () => {
  choose({ sidebar: { provider: 'anthropic', model: 'claude-opus-5-5' } });
  assert.equal((await resolveStep('sidebar')).provider.id, 'claude-cli');
});

test('#175: with no claude CLI a saved key serves every step but the KI column, unasked for each step', async () => {
  for (const missing of [join(dir, 'no-such-claude'), STUB_SIGNED_OUT]) {
    process.env.CLAUDE_BIN = missing;
    forgetCli();
    assert.equal(await modelReady(), true, `${missing}: the key answers`);
    for (const step of STEP_IDS) {
      const r = await resolveStep(step);
      assert.equal(r.provider.id, step === 'sidebar' ? 'claude-cli' : 'anthropic', `${missing}: ${step}`);
    }
  }
  assert.equal(await ask('{}', { step: 'classify' }), '{"stub":"anthropic"}');
  assert.equal(calls('/v1/messages').at(-1)!.body.model, 'claude-sonnet-5-5', 'the key\'s model for the step\'s tier');

  keys({ 'ai:openai': OPENAI_KEY });
  forgetCli();
  assert.equal((await resolveStep('receipt-vat')).provider.id, 'openai', 'only OpenAI: OpenAI serves');
  keys({});
  forgetCli();
  assert.equal(await modelReady(), false, 'no CLI and no key: no AI');
  assert.equal((await resolveStep('classify')).provider.id, 'claude-cli');
});

test('#175: with Claude Code signed in, a key serves only the steps set to it', async () => {
  forgetCli();
  assert.equal((await resolveStep('classify')).provider.id, 'claude-cli');
  choose({ classify: { provider: 'anthropic', model: 'claude-haiku-5-5' } });
  assert.equal((await resolveStep('classify')).provider.id, 'anthropic');
  assert.equal((await resolveStep('receipt-vision')).provider.id, 'claude-cli');
});
