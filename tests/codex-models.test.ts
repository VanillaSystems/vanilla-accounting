/**
 * Codex's model per tier from the models the signed-in ChatGPT account offers (issue #180), against
 * tests/support/stub-bin/codex: how `codex debug models` is read, which model each tier takes and
 * which it borrows, the retry when the account refuses a model, and when the kept list is read again.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, resolveStep } from '../src/llm/ask.js';
import { AiRefused } from '../src/llm/provider.js';
import { codexCli, refreshCodexModels } from '../src/llm/providers/codex-cli.js';
import { catalogPath, chooseTier, parseCatalog, readCatalog, tierModels } from '../src/llm/providers/codex-models.js';
import { DEMO_ROOT } from './support/workspace.js';

const STUB = join(process.cwd(), 'tests/support/stub-bin/codex');
/** What `codex debug models` listed for the account of issue #180, hidden models included. */
const ISSUE_180 = [['gpt-reserve', 'hide', 4], ['gpt-6-luna', 'list', 5], ['gpt-5.6-terra', 'list', 8], ['gpt-5.6-luna', 'list', 9], ['codex-auto-review', 'hide', 43]] as const;
let dir: string;
let calls: string;
let debugRuns: string;
let signIns = 0;

const catalogJson = (rows: readonly (readonly [string, string, number])[]) =>
  JSON.stringify({ models: rows.map(([slug, visibility, priority]) => ({ slug, visibility, priority, input_modalities: ['text', 'image'], description: 'x' })) });
const execModels = (): string[] =>
  readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { args: string[] }).map(({ args }) => args[args.indexOf('--model') + 1]);
const debugCount = () => readFileSync(debugRuns, 'utf8').trim().split('\n').filter(Boolean).length;

/** The account lists `rows` (absent: the stub's bundled catalog). */
function account(rows?: readonly (readonly [string, string, number])[]) {
  if (rows) {
    writeFileSync(join(dir, 'models.json'), catalogJson(rows));
    process.env.CODEX_STUB_MODELS = join(dir, 'models.json');
  } else delete process.env.CODEX_STUB_MODELS;
}

/** The person signs in anew: the linked auth.json changes (its time; the app never reads it). */
function signInAgain() {
  const at = new Date(Date.UTC(2026, 9, 1) + ++signIns * 60_000);
  utimesSync(join(process.env.CODEX_HOME!, 'auth.json'), at, at);
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-models-'));
  calls = join(dir, 'calls.jsonl');
  debugRuns = join(dir, 'debug.jsonl');
  process.env.VANILLA_WORKSPACE = join(dir, 'ws');
  cpSync(DEMO_ROOT, process.env.VANILLA_WORKSPACE, { recursive: true });
  process.env.VANILLA_AI_SETTINGS = join(dir, 'ai.json');
  process.env.VANILLA_SECRETS_FILE = join(dir, 'secrets.json');
  process.env.CLAUDE_BIN = join(dir, 'no-such-claude');
  process.env.CODEX_BIN = STUB;
  process.env.CODEX_STUB_ARGS = calls;
  process.env.CODEX_STUB_DEBUG = debugRuns;
  process.env.CODEX_HOME = join(dir, 'person-codex');
  mkdirSync(process.env.CODEX_HOME);
  writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), '{"stub":"sign-in"}');
  process.env.VANILLA_CODEX_HOME = join(dir, 'app', 'codex-home');
});

beforeEach(async () => {
  writeFileSync(join(dir, 'ai.json'), JSON.stringify({ steps: {} }));
  writeFileSync(calls, '');
  delete process.env.CODEX_STUB_REFUSE;
  delete process.env.CODEX_STUB_STATUS;
  account();
  signInAgain();
  await refreshCodexModels({ force: true });
  writeFileSync(debugRuns, '');
});

test('the account\'s list: only the models Codex lists as visible, in its priority order, with whether each takes images', () => {
  const read = parseCatalog(JSON.stringify({ models: [
    { slug: 'b', visibility: 'list', priority: 8, input_modalities: ['text'] },
    { slug: 'hidden', visibility: 'hide', priority: 1, input_modalities: ['text', 'image'] },
    { slug: 'a', visibility: 'list', priority: 5, input_modalities: ['text', 'image'] },
  ] }));
  assert.deepEqual(read, [{ slug: 'a', image: true }, { slug: 'b', image: false }]);
  assert.throws(() => parseCatalog('{"error":"no"}'), /no models list/);
});

test('each tier takes its first preference the account offers; a tier with none borrows the next lower tier\'s, and says so', () => {
  const issue180 = ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'];
  assert.deepEqual(tierModels(issue180), { fast: { model: 'gpt-6-luna' }, standard: { model: 'gpt-5.6-terra' }, strong: { model: 'gpt-5.6-terra', from: 'standard' } });
  assert.deepEqual(tierModels(['gpt-5.6-luna']), { fast: { model: 'gpt-5.6-luna' }, standard: { model: 'gpt-5.6-luna', from: 'fast' }, strong: { model: 'gpt-5.6-luna', from: 'fast' } });
  assert.deepEqual(chooseTier('fast', ['gpt-6-astra']), { model: 'gpt-6-astra', from: 'strong' }, 'nothing lower: a higher tier\'s model');
  assert.deepEqual(chooseTier('standard', ['gpt-7-nova']), { model: 'gpt-7-nova' }, 'a name the table does not know yet: the account\'s first');
  assert.deepEqual(tierModels(undefined), { fast: { model: 'gpt-6-luna' }, standard: { model: 'gpt-6.1-sol' }, strong: { model: 'gpt-6-astra' } }, 'not read yet: the first choices');
});

test('with the account of issue #180, the standard tier asks gpt-5.6-terra, read by `codex debug models` in the app\'s CODEX_HOME', async () => {
  account(ISSUE_180);
  await refreshCodexModels({ force: true });
  assert.equal(debugCount(), 1);
  assert.equal(JSON.parse(readFileSync(debugRuns, 'utf8')).home, process.env.VANILLA_CODEX_HOME, 'never the person\'s own CODEX_HOME');
  assert.deepEqual(codexCli.models.map((m) => m.id), ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'], 'a step\'s own choice offers only these');
  assert.deepEqual(codexCli.defaults, { fast: 'gpt-6-luna', standard: 'gpt-5.6-terra', strong: 'gpt-5.6-terra' });
  let by: unknown;
  await ask('{}', { step: 'classify', answered: (b) => { by = b; } });
  assert.deepEqual(by, { provider: 'codex-cli', model: 'gpt-5.6-terra' });
  assert.deepEqual(execModels(), ['gpt-5.6-terra']);
  assert.ok(existsSync(catalogPath()) && !catalogPath().startsWith(process.env.VANILLA_CODEX_HOME!), 'kept beside the app\'s CODEX_HOME, not in it');
});

test('a model the account refuses: the list is read again, the model kept out, and the call asked once more with the tier\'s next model', async () => {
  process.env.CODEX_STUB_REFUSE = 'gpt-6.1-sol';
  let by: unknown;
  assert.equal(await ask('{}', { step: 'classify', answered: (b) => { by = b; } }), '{"stub":"codex"}');
  assert.deepEqual(execModels(), ['gpt-6.1-sol', 'gpt-6-sol']);
  assert.deepEqual(by, { provider: 'codex-cli', model: 'gpt-6-sol' }, 'the answer names the model that gave it');
  assert.equal(debugCount(), 1, 'the list was read again');
  assert.deepEqual(readCatalog()?.refused, ['gpt-6.1-sol']);
  assert.ok(!codexCli.models.some((m) => m.id === 'gpt-6.1-sol'), 'no step offers it any more');
  writeFileSync(calls, '');
  await ask('{}', { step: 'classify' });
  assert.deepEqual(execModels(), ['gpt-6-sol'], 'the next call asks the next model at once');
});

test('refused again, or a model of the person\'s own choice the table does not know: the app\'s refusal names the model', async () => {
  process.env.CODEX_STUB_REFUSE = 'gpt-6.1-sol,gpt-6-sol';
  await assert.rejects(ask('{}', { step: 'classify' }), (e: unknown) => e instanceof AiRefused && e.refusal.reason === 'modelRefused' && e.refusal.model === 'gpt-6-sol'
    && /bietet das Modell gpt-6-sol/.test(e.message));
  assert.deepEqual(execModels(), ['gpt-6.1-sol', 'gpt-6-sol'], 'asked once more, not more');
  writeFileSync(calls, '');
  process.env.CODEX_STUB_REFUSE = 'gpt-5.5';
  writeFileSync(join(dir, 'ai.json'), JSON.stringify({ steps: { classify: { provider: 'codex-cli', model: 'gpt-5.5' } } }));
  await assert.rejects(ask('{}', { step: 'classify' }), (e: unknown) => e instanceof AiRefused && e.refusal.reason === 'modelRefused' && e.refusal.model === 'gpt-5.5');
  assert.deepEqual(execModels(), ['gpt-5.5'], 'the person\'s choice is not replaced by another model');
});

test('the kept list is read again on a new sign-in, not before; signed out, Codex is not asked and the list stays', async () => {
  await resolveStep('classify');
  await ask('{}', { step: 'classify' });
  assert.equal(debugCount(), 0, 'fresh: not read again');
  process.env.CODEX_STUB_REFUSE = 'gpt-6.1-sol';
  await ask('{}', { step: 'classify' });
  assert.deepEqual(readCatalog()?.refused, ['gpt-6.1-sol']);
  account(ISSUE_180);
  signInAgain();
  assert.equal((await resolveStep('classify')).model, 'gpt-5.6-terra', 'another sign-in: the list read again before the step is resolved');
  assert.equal(debugCount(), 2);
  assert.deepEqual(readCatalog()?.refused, [], 'a refusal holds for the sign-in it came from');
  process.env.CODEX_STUB_STATUS = '1';
  account();
  signInAgain();
  await resolveStep('classify');
  assert.equal(debugCount(), 2, 'signed out, Codex prints its bundled list as if it were the account\'s: not asked');
  assert.equal(codexCli.defaults.standard, 'gpt-5.6-terra', 'the kept list stays');
  await resolveStep('classify');
  assert.equal(debugCount(), 2, 'the same sign-in within five minutes: not asked again');
  delete process.env.CODEX_STUB_STATUS;
  signInAgain();
  await resolveStep('classify');
  assert.equal(debugCount(), 3, 'signed in anew right after: read at once, not after five minutes');
  assert.equal(codexCli.defaults.standard, 'gpt-6.1-sol');
});
