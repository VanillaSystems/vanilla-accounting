/**
 * «KI ganz ausschalten» (Firma › KI, issue #212): with the switch on, no path of the app reaches a
 * model provider. Every way the app starts a model is driven here against providers that record
 * each call: the `claude` and `codex` stubs (CLAUDE_STUB_ARGS, CODEX_STUB_ARGS log only model
 * calls, not `--version` or `auth status`) and a fetch that records every request an API key's
 * provider sends. Driven in process (ask for every step, judge, each provider, the KI column on
 * Claude Code and Codex) and through the real API server (the chat, Terminal, «Neu lesen»,
 * «Neu klassifizieren», pairing, «Vorschlag der KI», the setup's test call, an inbox run with a
 * scan only a model can read). Then the switch goes off: the same stubs answer, and the receipt
 * that waited is read by the run that starts at once.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import type { Index } from '../src/types/index.js';
import type { AssistantEvent } from '../src/types/assistant.js';

const STUB = join(process.cwd(), 'tests/support/stub-bin');
const dir = mkdtempSync(join(tmpdir(), 'ai-off-'));
const settings = join(dir, 'ai.json');
const claudeCalls = join(dir, 'claude-args');
const codexCalls = join(dir, 'codex-args');
const httpCalls: string[] = [];

const switchOn = (off: boolean) => writeFileSync(settings, JSON.stringify({ steps: {}, ...(off ? { off: true } : {}) }));
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
/** Every call that reached a provider since the logs were emptied. */
const reached = () => [...lines(claudeCalls).map((l) => `claude ${l}`), ...lines(codexCalls).map((l) => `codex ${l.slice(0, 120)}`), ...httpCalls.map((u) => `http ${u}`)];
const empty = () => { writeFileSync(claudeCalls, ''); writeFileSync(codexCalls, ''); httpCalls.length = 0; };
const isOff = (e: unknown) => (e as { refusal?: { reason?: string } }).refusal?.reason === 'off';

before(() => {
  switchOn(true);
  empty();
  process.env.VANILLA_AI_SETTINGS = settings;
  // ask() ledgers into the process's workspace: a copy, so the repo's demo gets no data/.
  process.env.VANILLA_WORKSPACE = join(dir, 'ws');
  cpSync(DEMO_ROOT, process.env.VANILLA_WORKSPACE, { recursive: true });
  process.env.CLAUDE_BIN = join(STUB, 'claude');
  process.env.CODEX_BIN = join(STUB, 'codex');
  process.env.CLAUDE_STUB_ARGS = claudeCalls;
  process.env.CODEX_STUB_ARGS = codexCalls;
  process.env.CODEX_HOME = join(dir, 'codex-home');
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return real(url, init);
    httpCalls.push(`${init?.method ?? 'GET'} ${u}`);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], choices: [{ message: { content: '{}' } }], usage: {} }), { status: 200 });
  }) as typeof fetch;
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('in process: every step, the typed question, each provider and the KI column on both CLIs are refused at the gate, and nothing reaches a provider', async () => {
  const { ask, modelReady } = await import('../src/llm/ask.js');
  const { judge } = await import('../src/llm/judge.js');
  const { STEP_IDS } = await import('../src/llm/steps.js');
  const { claudeCli } = await import('../src/llm/providers/claude-cli.js');
  const { codexCli } = await import('../src/llm/providers/codex-cli.js');
  const { KEYED, keyedProvider } = await import('../src/llm/providers/keyed.js');
  const { callClaude } = await import('../src/assistant/claude.js');
  const { callCodex } = await import('../src/assistant/codex.js');
  const { workspaceAt } = await import('../src/workspace/workspace.js');
  switchOn(true);
  empty();

  assert.equal(await modelReady(), false, 'the steps that can do without the model are told there is none');
  for (const step of STEP_IDS) await assert.rejects(ask('Antworte mit ok', { step }), isOff, step);
  await assert.rejects(judge({ from: 'a@b.ch', subject: 'Rechnung' }, { type: 'noul', instructions: 'Bringt die Mail einen Beleg?' }, { step: 'mail-triage' }), isOff);
  const call = { prompt: 'ok?', system: 'Answer.', attachments: [], timeoutMs: 10_000 };
  await assert.rejects(claudeCli.ask({ ...call, model: 'haiku' }), isOff, 'the setup test call on Claude Code');
  await assert.rejects(codexCli.ask({ ...call, model: codexCli.defaults.fast }), isOff, 'the setup test call on Codex');
  for (const spec of KEYED) {
    const p = keyedProvider(spec, 'sk-test', spec.shipped);
    const model = p.models[0].id;
    if (p.models.some((m) => m.can.includes('json'))) await assert.rejects(p.ask({ ...call, model }), isOff, spec.id);
    if (p.judge) await assert.rejects(p.judge({ state: 'x', question: { type: 'noul', instructions: '?' }, model, images: [], timeoutMs: 10_000 }), isOff, spec.id);
  }
  const ws = workspaceAt(process.env.VANILLA_WORKSPACE!);
  for (const agent of [(c: Parameters<typeof callClaude>[0]) => callClaude(c), (c: Parameters<typeof callClaude>[0]) => callCodex(c, codexCli.defaults.standard)]) {
    const events: AssistantEvent[] = [];
    await agent({ ws, send: { text: 'Hallo', language: 'de', context: [] }, map: '', session: undefined, prompt: 'Hallo', onEvent: (e) => events.push(e), signal: new AbortController().signal });
    assert.ok(events.some((e) => e.type === 'error' && /ausgeschaltet/.test(e.message)), JSON.stringify(events));
  }
  assert.deepEqual(reached(), [], 'no call reached a provider');

  // The same paths with the switch off: the stubs answer, so the paths above were live ones.
  switchOn(false);
  assert.equal(await ask('Antworte mit ok', { step: 'classify' }).then(() => 'answered'), 'answered');
  await keyedProvider(KEYED[0], 'sk-test', KEYED[0].shipped).ask({ ...call, model: KEYED[0].shipped[0].id }).catch(() => undefined);
  assert.ok(lines(claudeCalls).length > 0 && httpCalls.length > 0, `the stubs record calls: ${reached().join(' | ')}`);
  switchOn(true);
});

let api: ApiServer;

test('through the API: the chat, Terminal, «Neu lesen», «Neu klassifizieren», pairing, «Vorschlag der KI», the test call and an inbox run ask no model; switched back on, the waiting scan is read at once', async () => {
  switchOn(true);
  empty();
  api = await startApi('tests/fixtures/classify-index.json', {
    PATH: `${STUB}:${process.env.PATH}`, VANILLA_AI_SETTINGS: settings, CLAUDE_STUB_ARGS: claudeCalls, CODEX_STUB_ARGS: codexCalls,
    CODEX_HOME: join(dir, 'codex-home-api'), CLAUDE_BIN: '', CODEX_BIN: '',
  });
  try {
    const receipts = join(api.root, 'transactional-data/2026/receipts');
    mkdirSync(receipts, { recursive: true });
    writeFileSync(join(receipts, '2026-08-12_shop-eu_rechnung.pdf'), 'PDF rw');

    assert.equal((await api.send('GET', '/api/status')).json.aiOff, true);
    const off = (r: { status: number; json: Record<string, unknown> }, what: string) => {
      assert.equal(r.status, 503, `${what}: ${JSON.stringify(r.json)}`);
      assert.deepEqual([r.json.code, (r.json.params as { reason?: string }).reason], ['aiRefused', 'off'], what);
    };
    off(await api.send('POST', '/api/assistant', { text: 'Hallo', language: 'de', context: [] }), 'the KI column');
    off(await api.send('POST', '/api/terminal/open', { request: 'mach' }), 'Terminal');
    off(await api.send('POST', '/api/vision/extract', { receiptId: 'rw' }), '«Neu lesen (KI)»');
    const classify = await api.send('POST', '/api/journal-entries/classify/W1');
    assert.ok(classify.status === 503 || classify.status === 200, `«Neu klassifizieren» books by rules or says the AI is off: ${JSON.stringify(classify.json)}`);
    if (classify.status === 503) off(classify, '«Neu klassifizieren»');
    const pair = await api.send('POST', '/api/receipts/rw/find-payment');
    assert.equal(pair.status, 200, JSON.stringify(pair.json));
    assert.equal(pair.json.model, false, 'pairing by amount, date and name only');
    const learn = await api.send('POST', '/api/rules/learn', { ref: 'W1' });
    assert.ok(learn.status === 404 || learn.status === 503, `«Vorschlag der KI»: ${JSON.stringify(learn.json)}`);
    const test = await api.send('POST', '/api/ai/setup/claude/test');
    assert.deepEqual(test.json, { ok: false, why: 'off' }, 'the setup test call is not made');

    // A scan whose text only a model can read: the run takes the rest and leaves it waiting.
    mkdirSync(join(api.root, 'beleg-import'), { recursive: true });
    writeFileSync(join(api.root, 'beleg-import', 'Scan 7.pdf'), '%PDF-1.4\n% a scan: no text a program can read\n%%EOF\n');
    const started = await api.send('POST', '/api/automation', { kind: 'start', workflow: 'receipt-intake', item: { kind: 'company', id: 'inbox' } });
    assert.equal(started.json.ok, true, JSON.stringify(started.json));
    await api.rest();
    assert.deepEqual(reached(), [], 'no call reached a provider');
    assert.deepEqual(lines(join(api.root, 'data', 'llm-ledger.jsonl')), [], 'and none is ledgered as tried');
    const unread = ((await (await api.fetch('/books.json')).json()) as Index).receipts.filter((r) => !r.extractedText);
    assert.ok(unread.length > 0, 'the scan waits unread');

    // Switched back on: the work that waited starts by itself and the model reads the scan.
    const on = await api.send('PUT', '/api/ai/off', { off: false });
    assert.equal(on.json.off, false);
    assert.equal((await api.send('GET', '/api/status')).json.aiOff, undefined);
    for (let i = 0; i < 200 && !lines(claudeCalls).length; i++) await new Promise((r) => setTimeout(r, 50));
    await api.rest();
    assert.ok(lines(claudeCalls).length > 0, 'the resumed run asked the model');
    const read = ((await (await api.fetch('/books.json')).json()) as Index).receipts.filter((r) => unread.some((u) => u.id === r.id));
    assert.ok(read.some((r) => r.extractedText.includes('Stub-OCR')), `the waiting scan is read: ${JSON.stringify(read.map((r) => r.extractedText))}`);
  } finally {
    await api.stop();
  }
});

test('a statement PDF dropped with the switch on, of an account without a bank export: no model reads it; the row offers the hand table and «Als Monatsauszug behalten», which closes its question with the PDF kept as the month\'s statement', async () => {
  switchOn(true);
  empty();
  const { SESSION } = await import('./support/inbox-run.js');
  const { DEMO_OCTOBER, inventedStatement } = await import('./support/statement-pdf.js');
  const { pdf } = await inventedStatement(DEMO_OCTOBER);
  const demo = await startApi('demo', { PATH: `${STUB}:${process.env.PATH}`, VANILLA_AI_SETTINGS: settings, CLAUDE_STUB_ARGS: claudeCalls, CODEX_STUB_ARGS: codexCalls, CODEX_HOME: join(dir, 'codex-home-drop'), CLAUDE_BIN: '', CODEX_BIN: '' });
  cpSync(DEMO_ROOT, demo.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  // An account with a bank export keeps its PDFs without a question (#254): this one has none.
  const folder = join(demo.root, 'transactional-data/2026/bank-statements/Raiffeisen');
  for (const f of readdirSync(folder).filter((x) => x.endsWith('.xml'))) rmSync(join(folder, f));
  try {
    const { post, rest } = SESSION(demo);
    let s = await post('/api/drop');
    s = await post(`/api/drop/${s.id}/files?name=oktober.pdf`, pdf);
    let [row] = s.rows;
    assert.deepEqual([row.state, row.read?.by, row.read?.why, row.asked?.file], ['asks', 'hand', 'noAi', 'Raiffeisen/Kontoauszug 01.10.2026 - 31.10.2026.pdf']);
    s = await post(`/api/drop/${s.id}/rows/${row.key}`, { kind: 'keep' });
    [row] = s.rows;
    assert.deepEqual([row.state, row.statement?.file, row.asked], ['taken', 'Raiffeisen/Kontoauszug 01.10.2026 - 31.10.2026.pdf', undefined]);
    await rest();
    const books = (await (await demo.fetch('/books.json')).json()) as Index;
    assert.deepEqual(books.transactions.filter((t) => t.date >= '2026-10-01'), [], 'kept as the month\'s statement: no movement imported');
    assert.equal(books.statementAsks, undefined, 'its question is answered');
    assert.deepEqual(reached(), [], 'no call reached a provider');
  } finally {
    await SESSION(demo).rest().catch(() => {});
    await demo.stop();
  }
});

test('the switch is kept per Mac beside the other AI settings, apart from «Ohne KI weitermachen»', async () => {
  const { parseSettings, readSettings, writeNoAi, writeOff } = await import('../src/llm/settings.js');
  assert.deepEqual(parseSettings({ steps: {}, off: true, noAi: true }), { steps: {}, off: true, noAi: true });
  assert.deepEqual(parseSettings({ steps: {}, off: 'yes' }), { steps: {} }, 'only true switches it on');
  writeFileSync(settings, JSON.stringify({ steps: {}, cli: 'codex' }));
  writeNoAi(true);
  writeOff(true);
  assert.deepEqual(readSettings(), { steps: {}, cli: 'codex', noAi: true, off: true });
  writeOff(false);
  assert.deepEqual(readSettings(), { steps: {}, cli: 'codex', noAi: true }, 'switching it on again leaves «Ohne KI weitermachen» as it was');
  switchOn(true);
});

/**
 * Every file outside the browser UI that starts a program or sends a request, and why it asks no
 * model. A new one fails here until it is named: as a model transport (which must pass the gate) or
 * as something that is no model.
 */
const TRANSPORTS: Record<string, string> = {
  'src/llm/providers/claude-cli.ts': 'spawnClaude',
  'src/llm/providers/codex-cli.ts': 'runCodex',
  'src/llm/providers/http.ts': 'requestJson',
  'src/platform/terminal-open.ts': 'openInTerminal',
};
const NO_MODEL: Record<string, string> = {
  'src/cli/browser.ts': 'Playwright trace viewer',
  'src/cli/check-closed-period.ts': 'git',
  'src/cli/doctor.ts': 'program versions',
  'src/cli/fetch-estv-rates.ts': 'the ESTV rates',
  'src/cli/update.ts': 'git and npm',
  'src/cli/workflow.ts': "the app's own API",
  'src/collect/tutti.ts': 'Chrome to PDF, pdftotext',
  'src/desktop/build-key.ts': "codesign reads the app's own signature",
  'src/desktop/dictation.ts': "macOS's dictation",
  'src/desktop/main.ts': "the app's own server",
  'src/parsers/pdf-pages.ts': 'osascript renders PDF pages',
  'src/platform/ai-cli.ts': 'the CLI\'s --version and auth status, no model',
  'src/platform/browser/chrome.ts': 'Chrome for a source',
  'src/platform/git-program.ts': 'xcode-select',
  'src/platform/login-path.ts': 'the login shell\'s PATH',
  'src/platform/sources/api-channel.ts': "a source's API",
  'src/platform/sources/launcher.ts': "a source's child process",
  'src/platform/sources/mac-mail.ts': 'Mail.app',
  'src/platform/sources/web-channel.ts': "a source's web pages",
  'src/platform/sources/web-driver.ts': "a source's web pages",
  'src/publish/sources.ts': 'git',
  'src/secrets/keychain-store.ts': 'the keychain',
  'src/server/mail-evidence.ts': 'plutil',
  'src/version.ts': 'git',
};

test('every file that starts a program or sends a request is a gated model transport or named as no model', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (p !== join('src', 'app')) walk(p); } else if (/\.(ts|tsx|mts|cts)$/.test(f)) files.push(p); } };
  walk('src');
  const calls = /\b(spawn|spawnSync|execFile|execFileSync|execSync|fork)\(|(^|[^.\w])fetch\(|new WebSocket\(|https?\.(request|get)\(/m;
  const found = files.filter((f) => calls.test(readFileSync(f, 'utf8'))).map((f) => f.split('\\').join('/')).sort();
  assert.deepEqual(found.filter((f) => !(f in TRANSPORTS) && !(f in NO_MODEL)), [], 'name each new file in TRANSPORTS (and gate it) or in NO_MODEL');
  for (const [file, fn] of Object.entries(TRANSPORTS)) {
    const src = readFileSync(file, 'utf8');
    const body = src.slice(src.search(new RegExp(`function ${fn}\\b`)));
    assert.match(body.slice(0, body.indexOf('\n}\n')), /\bgate\(\)/, `${file}: ${fn} passes the gate`);
  }
});
