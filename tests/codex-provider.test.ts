/**
 * The Codex CLI as a provider (issue #121), run against tests/support/stub-bin/codex: what a call
 * hands the program (only answers: no shell, no web, no config, read-only, the step's own
 * instructions), how a PDF reaches it, how its JSONL is read, its refusals as the app's, and which subscription serves a
 * step with only Codex, with both, and with only a key.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ask, ledgerPath, modelReady, resolveStep, type LedgerRow } from '../src/llm/ask.js';
import { judge } from '../src/llm/judge.js';
import { AiRefused, CallFailed } from '../src/llm/provider.js';
import { forgetKey, subscriptions } from '../src/llm/providers/index.js';
import { NoClaudeError } from '../src/llm/providers/claude-cli.js';
import { codexCli } from '../src/llm/providers/codex-cli.js';
import { DEMO_ROOT } from './support/workspace.js';
import { providerStub, type ProviderStub } from './support/provider-stub.js';
import { textPdf } from './support/pdf.js';

const STUB_BIN = join(process.cwd(), 'tests/support/stub-bin');
let dir: string;
let calls: string;
let stub: ProviderStub;

interface Seen { args: string[]; prompt: string; instructions?: string; cwd: string; home?: string }
const seen = (): Seen[] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ledger = (): LedgerRow[] => readFileSync(ledgerPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const settings = (s: object) => writeFileSync(join(dir, 'ai.json'), JSON.stringify({ steps: {}, ...s }));
const keys = (k: Record<string, string>) => {
  writeFileSync(join(dir, 'secrets.json'), JSON.stringify(k));
  forgetKey('anthropic');
  forgetKey('openai');
};
const onlyCodex = () => { process.env.CLAUDE_BIN = join(dir, 'no-such-claude'); process.env.CODEX_BIN = join(STUB_BIN, 'codex'); };
const both = () => { process.env.CLAUDE_BIN = join(STUB_BIN, 'claude'); process.env.CODEX_BIN = join(STUB_BIN, 'codex'); };
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const configs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));

before(async () => {
  stub = await providerStub();
  dir = mkdtempSync(join(tmpdir(), 'codex-provider-'));
  calls = join(dir, 'codex-calls.jsonl');
  process.env.VANILLA_WORKSPACE = join(dir, 'ws');
  cpSync(DEMO_ROOT, process.env.VANILLA_WORKSPACE, { recursive: true });
  process.env.VANILLA_SECRETS_FILE = join(dir, 'secrets.json');
  process.env.VANILLA_AI_SETTINGS = join(dir, 'ai.json');
  process.env.VANILLA_ANTHROPIC_URL = stub.url;
  process.env.VANILLA_OPENAI_URL = stub.url;
  process.env.CODEX_STUB_ARGS = calls;
  writeFileSync(join(dir, 'photo.png'), 'png stub');
  writeFileSync(join(dir, 'six.pdf'), textPdf(6));
  writeFileSync(join(dir, 'notes.txt'), 'text');
  // The person's own CODEX_HOME: their sign-in and their own instructions for every run, which no app call may carry.
  process.env.CODEX_HOME = join(dir, 'person-codex');
  mkdirSync(process.env.CODEX_HOME);
  writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), '{"stub":"sign-in"}');
  writeFileSync(join(process.env.CODEX_HOME, 'AGENTS.md'), 'CANARY: the person\'s own instructions');
  process.env.VANILLA_CODEX_HOME = join(dir, 'app-codex');
  // A claude whose plan limit is reached, as Claude Code prints it.
  writeFileSync(join(dir, 'claude-limit'), `#!/bin/sh\n[ "$1" = --version ] && exit 0\ncat >/dev/null\necho '{"type":"result","is_error":true,"result":"You\\u0027ve hit your limit · resets 6pm (Europe/Zurich)"}'\nexit 1\n`);
  chmodSync(join(dir, 'claude-limit'), 0o755);
});
after(() => stub.stop());
beforeEach(() => {
  writeFileSync(calls, '');
  delete process.env.CODEX_STUB_MODE;
  delete process.env.CODEX_STUB_STATUS;
  keys({});
  settings({});
  both();
});

test('a call only answers: read-only, no shell, web, apps, config, rules or AGENTS.md, no session; the step\'s instructions replace Codex\'s, the prompt on stdin', async () => {
  onlyCodex();
  let by: unknown;
  const text = await ask('## Chart of Accounts', { step: 'classify', system: 'SYS: answer in JSON', answered: (b) => { by = b; } });
  assert.equal(text, '{"stub":"codex"}');
  assert.deepEqual(by, { provider: 'codex-cli', model: 'gpt-6.1-sol' });
  const [call] = seen();
  assert.equal(call.prompt, '## Chart of Accounts');
  assert.equal(call.instructions, 'SYS: answer in JSON');
  assert.deepEqual(call.args.slice(0, 6), ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules']);
  assert.equal(flag(call.args, '--sandbox'), 'read-only');
  assert.equal(flag(call.args, '--model'), 'gpt-6.1-sol');
  assert.equal(realpathSync(flag(call.args, '--cd')), realpathSync(call.cwd), 'runs where it says it runs');
  assert.ok(!existsSync(join(call.cwd, 'AGENTS.md')), 'an empty folder');
  for (const c of ['approval_policy="never"', 'features.shell_tool=false', 'features.unified_exec=false', 'features.apps=false', 'features.view_image=false', 'features.multi_agent=false',
    'features.browser_use=false', 'features.computer_use=false', 'web_search="disabled"', 'project_doc_max_bytes=0', 'history.persistence="none"', 'features.plugins=false', 'skills.include_instructions=false']) {
    assert.ok(configs(call.args).includes(c), c);
  }
  assert.ok(!call.args.includes('--image'), 'no attachment, no image');
  assert.ok(!call.args.some((a) => /dangerously|workspace-write|full-access|approve-for-me/.test(a)));
  const row = ledger().at(-1)!;
  assert.deepEqual([row.step, row.provider, row.model, row.ok, row.input, row.cacheRead, row.output, row.turns], ['booking.guide.yaml#classify', 'codex-cli', 'gpt-6.1-sol', true, 15, 5, 7, 1]);
});

test('Codex runs in the app\'s own CODEX_HOME: signed in through a link to the person\'s sign-in, without their AGENTS.md', async () => {
  onlyCodex();
  await ask('{}', { step: 'classify' });
  const { home } = seen()[0];
  assert.equal(home, process.env.VANILLA_CODEX_HOME);
  assert.ok(lstatSync(join(home!, 'auth.json')).isSymbolicLink(), 'the sign-in is linked, not copied');
  assert.equal(readlinkSync(join(home!, 'auth.json')), join(process.env.CODEX_HOME!, 'auth.json'));
  assert.deepEqual(readdirSync(home!), ['auth.json'], 'nothing else of the person\'s: no AGENTS.md, no config, no skills');
  writeFileSync(join(home!, 'AGENTS.md'), 'CANARY');
  await ask('{}', { step: 'classify' });
  assert.ok(!existsSync(join(home!, 'AGENTS.md')), 'an AGENTS.md put there is gone before the next run');
  assert.equal(await codexCli.ready(), true);
  assert.equal(seen().length, 2, '`codex login status` asks in the same home (the stub logs exec calls only)');
});

test('an image goes as --image; another file never reaches Codex', async () => {
  const sent = await codexCli.ask({ prompt: 'Was zeigt das Bild?', system: 'S', model: 'gpt-6-luna', attachments: [join(dir, 'photo.png')], timeoutMs: 10_000 });
  assert.equal(sent.text, '{"stub":"codex"}');
  assert.equal(flag(seen()[0].args, '--image'), join(dir, 'photo.png'));
  await assert.rejects(codexCli.ask({ prompt: 'x', system: 'S', model: 'gpt-6-luna', attachments: [join(dir, 'notes.txt')], timeoutMs: 10_000 }), /Codex liest keine \.txt/);
  assert.equal(seen().length, 1, 'refused before the program starts');
});

test('a PDF reaches Codex as its first four pages drawn as PNG, with its own text and which pages it sees; drawn once, the PDF untouched', async () => {
  onlyCodex();
  const pdf = join(dir, 'six.pdf');
  const before = readFileSync(pdf);
  assert.equal((await resolveStep('receipt-vision')).provider.id, 'codex-cli', 'with only Codex, the step that reads a PDF is served');
  assert.equal(await ask('Lies den Beleg', { step: 'receipt-vision', attachments: [pdf] }), '{"stub":"codex"}');
  const [call] = seen();
  const images = call.args.flatMap((a, i) => (call.args[i - 1] === '--image' ? [a] : []));
  assert.equal(images.length, 4, 'a page cap: four of six pages');
  const cache = join(dirname(ledgerPath()), 'pdf-pages');
  for (const [i, img] of images.entries()) {
    assert.ok(img.startsWith(cache + '/'), 'kept in the books\' data/ cache');
    assert.ok(img.endsWith(`/p${i + 1}.png`));
    assert.deepEqual([...readFileSync(img).subarray(1, 4)].map((b) => String.fromCharCode(b)).join(''), 'PNG');
  }
  assert.match(call.prompt, /^Lies den Beleg\n\n/);
  assert.match(call.prompt, /six\.pdf' is a PDF; pages 1-4 of 6 \(the others are not attached\) are attached to this message as images, in order/);
  assert.match(call.prompt, /Seite 1\fSeite 2\fSeite 3\fSeite 4\fSeite 5\fSeite 6/, 'the PDF\'s own text, all pages');
  const drawn = statSync(images[0]).mtimeMs;
  await ask('Lies den Beleg', { step: 'receipt-match', attachments: [pdf] });
  assert.deepEqual(seen()[1].args.filter((a, i) => seen()[1].args[i - 1] === '--image'), images, 'the same pages again');
  assert.equal(statSync(images[0]).mtimeMs, drawn, 'from the cache, not drawn again');
  assert.deepEqual(readFileSync(pdf), before, 'the original is only read');
});

test('Claude Code still gets the PDF itself, and nothing is drawn for it', async () => {
  const pdf = join(dir, 'six.pdf');
  const args = join(dir, 'claude-args.jsonl');
  process.env.CLAUDE_STUB_ARGS = args;
  const cache = join(dirname(ledgerPath()), 'pdf-pages');
  const drawn = existsSync(cache) ? readdirSync(cache).length : 0;
  try {
    await ask(`Lies ${pdf}`, { step: 'receipt-vision', attachments: [pdf] });
  } finally {
    delete process.env.CLAUDE_STUB_ARGS;
  }
  assert.equal(seen().length, 0, 'Codex is not asked');
  assert.ok(readFileSync(args, 'utf8').includes(dir), 'Claude Code reads the PDF\'s folder');
  assert.equal(existsSync(cache) ? readdirSync(cache).length : 0, drawn, 'no page drawn for Claude Code');
});

test('the plan limit, signed out and a missing program come back as the app\'s refusals, with what Codex said', async () => {
  onlyCodex();
  process.env.CODEX_STUB_MODE = 'limit';
  await assert.rejects(ask('{}', { step: 'classify' }), (e: unknown) => e instanceof AiRefused
    && e.refusal.reason === 'limit' && e.refusal.cli === 'codex' && /try again at 6:00 PM/.test(e.refusal.said) && /usage limit/.test(e.message));
  assert.equal(ledger().at(-1)!.ok, false, 'a failed call is ledgered too');
  process.env.CODEX_STUB_MODE = 'signedOut';
  await assert.rejects(ask('{}', { step: 'classify' }), (e: unknown) => e instanceof AiRefused && e.refusal.reason === 'signedOut');
  process.env.CODEX_BIN = join(dir, 'no-such-codex');
  await assert.rejects(codexCli.ask({ prompt: 'x', system: 'S', model: 'gpt-6-luna', attachments: [], timeoutMs: 5000 }),
    (e: unknown) => e instanceof AiRefused && e.refusal.reason === 'missing' && e.refusal.cli === 'codex');
});

test('a run that starts a command is ended at once and fails', async () => {
  process.env.CODEX_STUB_MODE = 'act';
  const started = Date.now();
  await assert.rejects(codexCli.ask({ prompt: 'x', system: 'S', model: 'gpt-6-luna', attachments: [], timeoutMs: 20_000 }),
    (e: unknown) => e instanceof CallFailed && !(e instanceof AiRefused) && /wanted to act \(command_execution\)/.test(e.message));
  assert.ok(Date.now() - started < 10_000, 'killed, not waited for');
});

test('any item but an answer ends the run: an edit, a search, a sub-agent, a tool', async () => {
  process.env.CODEX_STUB_MODE = 'act';
  try {
    for (const item of [{ type: 'file_change', changes: [{ path: '/tmp/x', kind: 'add' }] }, { type: 'web_search', query: 'x' }, { type: 'collab_tool_call', tool: 'spawn_agent' }, { type: 'mcp_tool_call', server: 'vanilla', tool: 'Write' }, { type: 'something_new' }]) {
      process.env.CODEX_STUB_ITEM = JSON.stringify({ id: 'item_1', ...item });
      await assert.rejects(codexCli.ask({ prompt: 'x', system: 'S', model: 'gpt-6-luna', attachments: [], timeoutMs: 20_000 }), new RegExp(`wanted to act \\(${item.type}`), item.type);
    }
  } finally {
    delete process.env.CODEX_STUB_ITEM;
  }
});

test('signed in is what `codex login status` says, and nothing else', async () => {
  assert.equal(await codexCli.ready(), true);
  process.env.CODEX_STUB_STATUS = '1';
  assert.equal(await codexCli.ready(), false);
  process.env.CODEX_BIN = join(dir, 'no-such-codex');
  assert.equal(await codexCli.ready(), false);
});

test('routing: Claude Code first with both, Codex when chosen or alone, Claude Code when none is found', async () => {
  assert.deepEqual(subscriptions(undefined).map((p) => p.id), ['claude-cli', 'codex-cli']);
  assert.deepEqual(subscriptions('codex').map((p) => p.id), ['codex-cli', 'claude-cli']);
  settings({ cli: 'codex' });
  assert.deepEqual([(await resolveStep('classify')).provider.id, (await resolveStep('receipt-vision')).provider.id], ['codex-cli', 'codex-cli'], 'Codex reads PDFs too');
  assert.equal((await resolveStep('sidebar')).provider.id, 'codex-cli', 'the KI column runs on the CLI chosen first, Codex too');
  onlyCodex();
  settings({});
  assert.equal((await resolveStep('mail-triage')).provider.id, 'codex-cli');
  const verdict = await judge('Von: shop@example.com, Betreff: Ihre Rechnung', { type: 'noul', instructions: 'Bringt die Mail einen Beleg?' }, { step: 'mail-triage' }).catch((e: Error) => e);
  assert.ok(verdict instanceof Error && /no answer to the question/.test(verdict.message), 'a typed question goes to Codex as a prompt');
  assert.equal(seen().length, 1);
  process.env.CODEX_BIN = join(dir, 'no-such-codex');
  assert.deepEqual(subscriptions('codex').map((p) => p.id), ['claude-cli'], 'nothing found: Claude Code, whose call says what to install');
});

test('a test run never finds the developer\'s own codex on the PATH', () => {
  delete process.env.CODEX_BIN;
  const path = process.env.PATH;
  process.env.PATH = `${STUB_BIN}:${path}`;
  try {
    assert.deepEqual(subscriptions('codex').map((p) => p.id), ['claude-cli']);
  } finally {
    process.env.PATH = path;
  }
});

test('with only a key, the key serves the step set to it; nothing else asks it on its own', async () => {
  process.env.CLAUDE_BIN = join(dir, 'no-such-claude');
  process.env.CODEX_BIN = join(dir, 'no-such-codex');
  keys({ 'ai:openai': 'test-key-openai-0009' });
  await assert.rejects(ask('{}', { step: 'classify' }), NoClaudeError);
  assert.equal(stub.seen.filter((s) => s.method === 'POST').length, 0);
  settings({ steps: { classify: { provider: 'openai', model: 'gpt-6.1-sol' } } });
  assert.equal(await ask('{}', { step: 'classify' }), '{"stub":"openai"}');
  assert.equal(await modelReady(), true);
});

test('a key that fails asks the step\'s default subscription, Codex when it is the one here', async () => {
  onlyCodex();
  keys({ 'ai:anthropic': 'test-key-anthropic-0009' });
  stub.reply.set('POST /v1/messages', { status: 529, body: { error: { message: 'Overloaded' } } });
  settings({ steps: { 'receipt-titles': { provider: 'anthropic', model: 'claude-haiku-5-5' } } });
  assert.equal(await ask('{}', { step: 'receipt-titles' }), '{"stub":"codex"}');
  assert.deepEqual(ledger().slice(-2).map((r) => [r.provider, r.model, r.ok]), [['anthropic', 'claude-haiku-5-5', false], ['codex-cli', 'gpt-6-luna', true]]);
  stub.reply.clear();
});

test('at its limit Claude Code is not replaced by Codex unless Firma › KI says so', async () => {
  process.env.CLAUDE_BIN = join(dir, 'claude-limit');
  await assert.rejects(ask('{}', { step: 'classify' }), (e: unknown) => e instanceof AiRefused && e.refusal.reason === 'limit' && e.refusal.cli === 'claude' && /resets 6pm/.test(e.refusal.said));
  assert.equal(seen().length, 0, 'off by default: Codex is not asked');
  settings({ askOther: true });
  assert.equal(await ask('{}', { step: 'classify' }), '{"stub":"codex"}');
  assert.deepEqual(ledger().slice(-2).map((r) => [r.provider, r.ok]), [['claude-cli', false], ['codex-cli', true]]);
});

test('the other is asked only for a CLI\'s refusal, and only when it serves the step', async () => {
  settings({ askOther: true, cli: 'codex' });
  process.env.CODEX_STUB_MODE = 'limit';
  assert.ok((await ask('{}', { step: 'classify' })).length, 'Claude Code answers for Codex at its limit');
  process.env.CODEX_STUB_MODE = 'act';
  await assert.rejects(ask('{}', { step: 'classify', timeoutMs: 20_000 }), /wanted to act/, 'a run that broke the rules is no reason to ask the other');
});
