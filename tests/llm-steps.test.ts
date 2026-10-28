/**
 * Call sites name their step; the resolver picks provider and model (issue #48). Runs the real
 * ask() against tests/support/stub-bin/claude, which logs each call's arguments.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, ledgerPath, resolveStep, type LedgerRow } from '../src/llm/ask.js';
import { parseSettings } from '../src/llm/settings.js';
import { STEP_IDS, STEPS, type StepId } from '../src/llm/steps.js';
import { DEMO_ROOT } from './support/workspace.js';

let dir: string;
let args: string;
let settings: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'llm-steps-'));
  args = join(dir, 'args');
  settings = join(dir, 'ai.json');
  process.env.VANILLA_WORKSPACE = join(dir, 'ws');
  cpSync(DEMO_ROOT, process.env.VANILLA_WORKSPACE, { recursive: true });
  process.env.CLAUDE_BIN = join(process.cwd(), 'tests/support/stub-bin/claude');
  process.env.CLAUDE_STUB_ARGS = args;
  process.env.VANILLA_AI_SETTINGS = settings;
});
beforeEach(() => { writeFileSync(args, ''); writeFileSync(settings, '{}'); });

const calls = (): string[][] => readFileSync(args, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ledger = (): LedgerRow[] => readFileSync(ledgerPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('with no setting every step asks its shipped default and ledgers the name it had before #48', async () => {
  const before: Record<StepId, [string, string]> = {
    'receipt-vision': ['sonnet', 'receipt-intake.guide.yaml#vision'],
    // Haiku since #48 step 2: it read the VAT facts of 100 receipts as well as Sonnet (#64).
    'receipt-vat': ['haiku', 'receipt-intake.guide.yaml#vat_facts'],
    'receipt-kind': ['haiku', 'receipt-intake.guide.yaml#kind'],
    'receipt-titles': ['haiku', 'receipt-intake.guide.yaml#titles'],
    'statement-read': ['sonnet', 'bank-import.guide.yaml#read'],
    'receipt-match': ['sonnet', 'evidence.guide.yaml#ai'],
    'receipt-pair': ['haiku', 'evidence.guide.yaml#pair'],
    classify: ['sonnet', 'booking.guide.yaml#classify'],
    'learn-rule': ['haiku', 'learn.correction'],
    saving: ['sonnet', 'saving'],
    tutti: ['sonnet', 'receipt-collection.guide.yaml#tutti'],
    sidebar: ['sonnet', 'assistant'],
    'mail-triage': ['haiku', 'receipt-collection.guide.yaml#triage'],
    'setup-conversation': ['sonnet', 'setup.conversation'],
  };
  const resolved = await Promise.all(STEP_IDS.map((s) => resolveStep(s)));
  assert.deepEqual(Object.fromEntries(STEP_IDS.map((s, i) => [s, [resolved[i].model, STEPS[s].ledger]])), before);
  assert.ok(resolved.every((r) => r.provider.id === 'claude-cli'));
});

test('the CLI gets the same arguments as before: no tools, or Read on the attachment\'s folder', async () => {
  await ask('hallo', { step: 'receipt-titles' });
  await ask('lies', { step: 'receipt-vision', attachments: [join(dir, 'scans', 'a.pdf'), join(dir, 'scans', 'b.pdf')], system: 'S' });
  const lean = ['--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--no-session-persistence'];
  assert.deepEqual(calls(), [
    ['-p', '--model', 'haiku', '--output-format', 'json', '--system-prompt', 'You are a careful assistant for a Swiss GmbH\'s bookkeeping. Follow the instructions in the message exactly and answer only in the format they ask for.', ...lean, '--tools', ''],
    ['-p', '--model', 'sonnet', '--output-format', 'json', '--system-prompt', 'S', ...lean, '--tools', 'Read', '--permission-mode', 'dontAsk', '--add-dir', join(dir, 'scans')],
  ]);
});

test('the ledger names the provider, and a step\'s part after its name', async () => {
  await ask('{}', { step: 'saving', detail: 'talk' });
  const row = ledger().at(-1)!;
  assert.deepEqual([row.step, row.provider, row.model, row.ok], ['saving#talk', 'claude-cli', 'sonnet', true]);
});

test('a setting on this machine picks the model; one that cannot serve the step is ignored', async () => {
  writeFileSync(settings, JSON.stringify({ steps: { classify: { provider: 'claude-cli', model: 'opus' }, 'receipt-vat': { provider: 'claude-cli', model: 'no-such-model' } } }));
  const [classify, vat] = [await resolveStep('classify'), await resolveStep('receipt-vat')];
  assert.deepEqual([classify.model, classify.source], ['opus', 'setting']);
  assert.deepEqual([vat.model, vat.source], ['haiku', 'default']);
  await ask('{}', { step: 'classify' });
  assert.deepEqual(calls()[0].slice(1, 3), ['--model', 'opus']);
});

test('the settings file keeps only steps and providers the app knows', () => {
  assert.deepEqual(parseSettings({ steps: { classify: { provider: 'claude-cli', model: 'haiku' }, nope: { provider: 'claude-cli' }, saving: { provider: 'someone' }, tutti: { provider: 'claude-cli', model: '' } } }),
    { steps: { classify: { provider: 'claude-cli', model: 'haiku' }, tutti: { provider: 'claude-cli' } } });
  assert.deepEqual(parseSettings(null), { steps: {} });
});
