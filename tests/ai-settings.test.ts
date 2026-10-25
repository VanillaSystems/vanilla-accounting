/**
 * Firma › KI's API (issue #48): a key is checked by the provider before it is kept, kept in the
 * secret store and never sent back or written into the workspace; a step's model is kept in this
 * computer's settings and must serve the step.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { providerStub, type ProviderStub } from './support/provider-stub.js';
import type { AiView } from '../src/llm/view.js';

const KEY = 'test-key-anthropic-0003';
let api: ApiServer;
let stub: ProviderStub;
let dir: string;

before(async () => {
  stub = await providerStub();
  dir = mkdtempSync(join(tmpdir(), 'ai-settings-'));
  api = await startApi('tests/fixtures/classify-index.json', {
    VANILLA_SECRETS_FILE: join(dir, 'secrets.json'), VANILLA_AI_SETTINGS: join(dir, 'ai.json'), VANILLA_ANTHROPIC_URL: stub.url, VANILLA_OPENAI_URL: stub.url, VANILLA_JEV_URL: stub.url,
  });
});
after(async () => {
  await api?.stop();
  await stub?.stop();
});

const view = async () => (await api.send('GET', '/api/ai')).json as unknown as AiView;

/** Every file under `root`, read as text. */
function everyFile(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).map((p) => join(root, p)).filter((p) => statSync(p).isFile()).map((p) => readFileSync(p, 'latin1'));
}

test('without any key the view offers the Claude subscription and every step its default', async () => {
  const v = await view();
  assert.deepEqual(v.providers.map((p) => [p.id, p.billing, p.state]), [['claude-cli', 'subscription', 'missing'], ['codex-cli', 'subscription', 'missing'], ['anthropic', 'key', 'unset'], ['openai', 'key', 'unset'], ['jev', 'key', 'unset']]);
  assert.equal(v.askOther, false, 'asking the other CLI by itself is off unless set');
  assert.deepEqual(v.steps.find((s) => s.id === 'classify')!.resolved, { provider: 'claude-cli', model: 'sonnet', source: 'default' });
  assert.equal(v.keysInApp, true, 'the secrets file stands for the keychain');
});

test('a key the provider refuses is not kept', async () => {
  stub.reply.set('GET /v1/models', { status: 401, body: { error: { message: 'invalid x-api-key' } } });
  const r = await api.send('PUT', '/api/ai/keys/anthropic', { key: 'wrong-key' });
  stub.reply.clear();
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'aiKeyRefused');
  assert.ok(!existsSync(join(dir, 'secrets.json')) || !readFileSync(join(dir, 'secrets.json'), 'utf8').includes('wrong-key'));
});

test('a key is kept in the secret store, never sent back, never in the workspace', async () => {
  const r = await api.send('PUT', '/api/ai/keys/anthropic', { key: `  ${KEY}\n` });
  assert.equal(r.status, 200, String(r.json.error));
  assert.equal(stub.seen.at(-1)!.headers['x-api-key'], KEY, 'checked against the model list, trimmed');
  assert.equal(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))['ai:anthropic'], KEY);
  const v = await view();
  assert.equal(v.providers.find((p) => p.id === 'anthropic')!.state, 'set');
  assert.ok(!JSON.stringify(v).includes(KEY), 'the view never carries the key');
  assert.ok(everyFile(api.root).every((text) => !text.includes(KEY)), 'no file of the workspace holds the key');
});

test('a step takes a model that serves it, kept on this computer; one that cannot serve it is refused', async () => {
  const unfit = await api.send('PUT', '/api/ai/steps/sidebar', { provider: 'anthropic', model: 'claude-opus-5-5' });
  assert.equal(unfit.status, 400);
  assert.deepEqual([unfit.json.code, (unfit.json.params as { model: string }).model], ['aiModelUnfit', 'claude-opus-5-5']);
  const ok = await api.send('PUT', '/api/ai/steps/receipt-vision', { provider: 'anthropic', model: 'claude-haiku-5-5' });
  assert.equal(ok.status, 200, String(ok.json.error));
  const step = (ok.json as unknown as AiView).steps.find((s) => s.id === 'receipt-vision')!;
  assert.deepEqual([step.resolved, step.standard], [{ provider: 'anthropic', model: 'claude-haiku-5-5', source: 'setting' }, { provider: 'claude-cli', model: 'sonnet' }]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'ai.json'), 'utf8')), { steps: { 'receipt-vision': { provider: 'anthropic', model: 'claude-haiku-5-5' } } });
  const back = await api.send('PUT', '/api/ai/steps/receipt-vision', { provider: null });
  assert.deepEqual((back.json as unknown as AiView).steps.find((s) => s.id === 'receipt-vision')!.resolved.source, 'default');
});

test('removing the key gives its steps back to the default', async () => {
  await api.send('PUT', '/api/ai/steps/classify', { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  const r = await api.send('PUT', '/api/ai/keys/anthropic', { key: null });
  const step = (r.json as unknown as AiView).steps.find((s) => s.id === 'classify')!;
  assert.deepEqual([step.choice?.provider, step.resolved.provider, step.resolved.source], ['anthropic', 'claude-cli', 'default'], 'the choice stays for when the key comes back');
  assert.equal(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'))['ai:anthropic'], undefined);
});

test('a Jev key is checked with one synthetic question; Jev serves the typed step and is refused for a text step', async () => {
  const r = await api.send('PUT', '/api/ai/keys/jev', { key: 'test-key-jev-0006' });
  assert.equal(r.status, 200, String(r.json.error));
  assert.equal(stub.seen.at(-1)!.body.state, 'Hallo');
  assert.equal((await api.send('PUT', '/api/ai/steps/classify', { provider: 'jev', model: 'jev-latest' })).json.code, 'aiModelUnfit');
  const ok = await api.send('PUT', '/api/ai/steps/mail-triage', { provider: 'jev', model: 'jev-latest' });
  const step = (ok.json as unknown as AiView).steps.find((s) => s.id === 'mail-triage')!;
  assert.deepEqual([step.resolved.provider, step.confident], ['jev', 0.8]);
});

test('with Codex signed in, «Die App fragt» chooses it for the steps and the terminal, and the other is asked only when set', async (t) => {
  const own = mkdtempSync(join(tmpdir(), 'ai-settings-codex-'));
  const codex = await startApi('tests/fixtures/classify-index.json', {
    VANILLA_SECRETS_FILE: join(own, 'secrets.json'), VANILLA_AI_SETTINGS: join(own, 'ai.json'), CODEX_BIN: join(process.cwd(), 'tests/support/stub-bin/codex'),
  });
  t.after(() => codex.stop());
  const before = (await codex.send('GET', '/api/ai')).json as unknown as AiView;
  assert.deepEqual(before.providers.slice(0, 2).map((p) => [p.id, p.state]), [['claude-cli', 'missing'], ['codex-cli', 'ready']]);
  assert.equal(before.steps.find((s) => s.id === 'classify')!.standard.provider, 'claude-cli', 'Claude Code first while nothing is chosen');
  const chosen = await codex.send('PUT', '/api/ai/cli', { cli: 'codex' });
  assert.equal(chosen.status, 200, String(chosen.json.error));
  const v = chosen.json as unknown as AiView;
  assert.equal(v.cli, 'codex');
  assert.deepEqual(v.steps.find((s) => s.id === 'classify')!.standard, { provider: 'codex-cli', model: 'gpt-6.1-sol' });
  assert.deepEqual(v.steps.find((s) => s.id === 'receipt-vision')!.standard, { provider: 'codex-cli', model: 'gpt-6.1-sol' }, 'Codex reads a PDF as its pages drawn');
  assert.deepEqual(v.steps.find((s) => s.id === 'sidebar')!.standard, { provider: 'codex-cli', model: 'gpt-6.1-sol' }, 'Codex serves the KI column');
  assert.equal((await codex.send('GET', '/api/terminal')).json.preferred, 'codex', 'the terminal opens the same one');
  assert.equal(((await codex.send('PUT', '/api/ai/cli', { askOther: true })).json as unknown as AiView).askOther, true);
  assert.deepEqual(JSON.parse(readFileSync(join(own, 'ai.json'), 'utf8')), { steps: {}, cli: 'codex', askOther: true });
  assert.equal((await codex.send('PUT', '/api/ai/cli', { cli: 'gemini' })).status, 400);
  const back = (await codex.send('PUT', '/api/ai/cli', { cli: null, askOther: false })).json as unknown as AiView;
  assert.deepEqual([back.cli, back.askOther], [undefined, false]);
});

test('Codex: each tier\'s model from the account\'s list, a borrowed one said so, and «Nochmals prüfen» reads the list again', async (t) => {
  const own = mkdtempSync(join(tmpdir(), 'ai-settings-tiers-'));
  const models = join(own, 'models.json');
  const listed = (slugs: string[]) => writeFileSync(models, JSON.stringify({ models: slugs.map((slug, priority) => ({ slug, visibility: 'list', priority, input_modalities: ['text', 'image'] })) }));
  listed(['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  mkdirSync(join(own, 'person-codex'));
  writeFileSync(join(own, 'person-codex', 'auth.json'), '{}');
  const codex = await startApi('tests/fixtures/classify-index.json', {
    VANILLA_SECRETS_FILE: join(own, 'secrets.json'), VANILLA_AI_SETTINGS: join(own, 'ai.json'), CODEX_BIN: join(process.cwd(), 'tests/support/stub-bin/codex'),
    CODEX_HOME: join(own, 'person-codex'), VANILLA_CODEX_HOME: join(own, 'app', 'codex-home'), CODEX_STUB_MODELS: models,
  });
  t.after(() => codex.stop());
  const shown = ((await codex.send('GET', '/api/ai')).json as unknown as AiView).providers.find((p) => p.id === 'codex-cli')!;
  assert.deepEqual(shown.tiers, { fast: { model: 'gpt-6-luna' }, standard: { model: 'gpt-5.6-terra' }, strong: { model: 'gpt-5.6-terra', from: 'standard' } });
  assert.ok(shown.checkedAt, 'when the list was read');
  assert.deepEqual(shown.models.map((m) => m.id), ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'], 'a step\'s own choice offers the account\'s models');
  listed(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']);
  const kept = ((await codex.send('GET', '/api/ai')).json as unknown as AiView).providers.find((p) => p.id === 'codex-cli')!;
  assert.equal(kept.tiers?.strong.model, 'gpt-5.6-terra', 'the kept list, until checked again');
  const again = ((await codex.send('POST', '/api/ai/codex/models')).json as unknown as AiView).providers.find((p) => p.id === 'codex-cli')!;
  assert.deepEqual(again.tiers, { fast: { model: 'gpt-6-luna' }, standard: { model: 'gpt-6.1-sol' }, strong: { model: 'gpt-6-astra' } });
});
