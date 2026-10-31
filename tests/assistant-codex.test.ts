/**
 * The KI column on Codex keeps the Claude sidebar's write boundary (#121 step 5). Codex runs with
 * no tool of its own that reaches the disk, a shell or the web; its only tools are the app's
 * (src/assistant/codex-tools.ts): reading the books' folder, writing only the draft. A change to
 * the books goes through the answer's block and the books' write door, which refuses a filed
 * quarter. A run that acts on its own (a command, an edit, a web search, a sub-agent) is ended and
 * applies nothing. End to end on the real API server with tests/support/stub-bin/codex, which
 * calls the app's tool server over MCP as a real Codex does.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSidebarArgs, SERVER } from '../src/assistant/codex.js';
import { serveTools, type ToolBounds } from '../src/assistant/codex-tools.js';
import { draftPatterns, NEVER_DRAFTED } from '../src/assistant/claude.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { AssistantEvent, Conversation, Turn } from '../src/types/assistant.js';
import type { Index } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { SESSION } from './support/inbox-run.js';
import './support/jurisdiction.js';

const REPO = process.cwd();
const configs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));

test('the Codex run itself: read-only sandbox, never asks, no shell, exec, web, apps, plugins, skills or user config; the app\'s server its only tools; no writable folder added', () => {
  for (const args of [codexSidebarArgs('gpt-6.1-sol', '/tmp/i.md', 'http://127.0.0.1:1/mcp/x', '/ws', undefined), codexSidebarArgs('gpt-6.1-sol', '/tmp/i.md', 'http://127.0.0.1:1/mcp/x', '/ws', 'thread-1')]) {
    const c = configs(args);
    for (const want of ['approval_policy="never"', 'features.shell_tool=false', 'features.unified_exec=false', 'features.apps=false', 'features.plugins=false', 'features.view_image=false',
      'features.browser_use=false', 'features.computer_use=false', 'features.multi_agent=false', 'web_search="disabled"', 'project_doc_max_bytes=0', 'skills.include_instructions=false',
      `mcp_servers.${SERVER}.url="http://127.0.0.1:1/mcp/x"`, `mcp_servers.${SERVER}.required=true`]) {
      assert.ok(c.includes(want), want);
    }
    assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules'));
    assert.ok(args.includes('read-only') || c.includes('sandbox_mode="read-only"'), 'the read-only sandbox');
    assert.ok(!args.some((a) => /dangerously|workspace-write|full-access|approve-for-me|--add-dir/.test(a)), 'nothing more is writable');
    assert.deepEqual([...new Set(c.filter((x) => x.startsWith('mcp_servers.')).map((x) => x.split('.')[1]))], [SERVER], 'no other tool server');
  }
  const resumed = codexSidebarArgs('gpt-6.1-sol', '/tmp/i.md', 'u', '/ws', 'thread-1');
  assert.deepEqual([resumed[0], resumed[1], resumed.at(-2), resumed.at(-1)], ['exec', 'resume', 'thread-1', '-'], 'the next message continues the session, the prompt on stdin');
  assert.ok(configs(resumed).includes('sandbox_mode="read-only"'), '`exec resume` takes the sandbox as a setting');
});

let dir: string;
let bounds: ToolBounds;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-tools-'));
  const root = join(dir, 'ws');
  mkdirSync(join(root, 'transactional-data/2026/books'), { recursive: true });
  mkdirSync(join(root, 'data/draft/knowledge'), { recursive: true });
  writeFileSync(join(root, 'ledger.json'), '{"config":{}}\n');
  writeFileSync(join(root, 'transactional-data/2026/books/journal.jsonl'), '{"id":"e1"}\n');
  writeFileSync(join(dir, 'secret.txt'), 'outside');
  // A link inside the draft that points at the books: a write through it must not land there.
  symlinkSync(join(root, 'transactional-data'), join(root, 'data/draft/knowledge/books'));
  bounds = { root, readable: [root], writable: draftPatterns(), never: NEVER_DRAFTED, pagesCache: join(dir, 'pages') };
});
after(() => rmSync(dir, { recursive: true, force: true }));

async function call(url: string, name: string, args: object) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return ((await res.json()) as { result: { content: Array<{ text?: string }>; isError?: boolean } }).result;
}

test('the app\'s tools: Write and Edit only into the draft, never the books, the chart\'s draft, a path out or a link out; Read only the books\' folder', async () => {
  const server = await serveTools(bounds);
  try {
    const ok = await call(server.url, 'Write', { file_path: 'data/draft/knowledge/suppliers/swisscom.yaml', content: 'id: swisscom\n' });
    assert.ok(!ok.isError, ok.content[0].text);
    assert.equal(readFileSync(join(bounds.root, 'data/draft/knowledge/suppliers/swisscom.yaml'), 'utf8'), 'id: swisscom\n');
    const edited = await call(server.url, 'Edit', { file_path: join(bounds.root, 'data/draft/knowledge/suppliers/swisscom.yaml'), old_string: 'swisscom', new_string: 'swisscom-ag' });
    assert.ok(!edited.isError);
    for (const target of ['ledger.json', 'transactional-data/2026/books/journal.jsonl', 'data/draft/master-data/accounts.json', 'data/draft/knowledge/../../../ledger.json',
      'data/draft/knowledge/books/2026/books/journal.jsonl', join(dir, 'secret.txt'), 'data/assistant/x.json']) {
      const refused = await call(server.url, 'Write', { file_path: target, content: 'X' });
      assert.equal(refused.isError, true, target);
      assert.match(refused.content[0].text!, /^Abgelehnt: nicht erlaubt/, target);
      const refusedEdit = await call(server.url, 'Edit', { file_path: target, old_string: '{', new_string: 'X' });
      assert.equal(refusedEdit.isError, true, target);
    }
    assert.equal(readFileSync(join(bounds.root, 'ledger.json'), 'utf8'), '{"config":{}}\n', 'the ledger is as it was');
    assert.equal(readFileSync(join(bounds.root, 'transactional-data/2026/books/journal.jsonl'), 'utf8'), '{"id":"e1"}\n', 'the books are as they were');
    assert.equal(readFileSync(join(dir, 'secret.txt'), 'utf8'), 'outside');
    assert.match((await call(server.url, 'Read', { file_path: 'ledger.json' })).content[0].text!, /^1\t\{"config":\{\}\}/);
    assert.match((await call(server.url, 'Grep', { pattern: '"e1"' })).content[0].text!, /journal\.jsonl:1:/);
    assert.match((await call(server.url, 'Glob', { pattern: '**/*.jsonl' })).content[0].text!, /journal\.jsonl/);
    assert.equal((await call(server.url, 'Read', { file_path: join(dir, 'secret.txt') })).isError, true, 'outside the books\' folder');
    assert.equal((await call(server.url, 'Read', { file_path: '/etc/hosts' })).isError, true);
    const wrongPath = await fetch(server.url.replace(/\/mcp\/.*/, '/mcp/guess'), { method: 'POST', body: '{}' });
    assert.equal(wrongPath.status, 404, 'only its own random path');
    const fromBrowser = await fetch(server.url, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' });
    assert.equal(fromBrowser.status, 404, 'never a browser page');
  } finally {
    await server.close();
  }
});

let api: ApiServer;
let log: string;
const files = () => ({ changes: join(log, 'changes.json'), tools: join(log, 'tools.json'), control: join(log, 'control.json'), args: join(log, 'args.jsonl') });

async function post(body: unknown): Promise<{ events: AssistantEvent[]; turn: Extract<Turn, { role: 'ai' }>; id: string }> {
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  const id = (events[0] as { id: string }).id;
  const turn = ((await api.send('GET', `/api/assistant/${id}`)).json as unknown as Conversation).turns.at(-1) as Extract<Turn, { role: 'ai' }>;
  return { events, turn, id };
}
const books = async () => (await (await api.fetch('/books.json')).json()) as Index;

test('end to end on Codex: the app\'s tools read and write the draft, a direct write is refused, the block goes through the write door, a filed quarter refuses it, a run that acts is ended and applies nothing', async () => {
  const demo = loadBooks(workspaceAt(DEMO_ROOT));
  const closedThrough = demo.config.closedThrough!;
  const dateOf = (ref: string) => demo.transactions.find((x) => x.ref === ref)?.date ?? '';
  const linkedTo = (id: string) => demo.mappings.filter((m) => m.receiptId === id).map((m) => dateOf(m.transactionRef));
  const open = demo.receipts.find((r) => { const d = linkedTo(r.id); return d.length > 0 && d.every((x) => x > closedThrough); })!;
  const filed = demo.receipts.find((r) => { const d = linkedTo(r.id); return d.length > 0 && d.every((x) => x <= closedThrough); })!;

  log = mkdtempSync(join(tmpdir(), 'assistant-codex-'));
  const f = files();
  const person = join(log, 'person-codex');
  mkdirSync(person);
  writeFileSync(join(person, 'auth.json'), '{"stub":"sign-in"}');
  writeFileSync(join(person, 'AGENTS.md'), 'CANARY');
  writeFileSync(join(log, 'ai.json'), JSON.stringify({ steps: {} }));
  api = await startApi('demo/vanilla-accounting', {
    CODEX_BIN: join(REPO, 'tests/support/stub-bin/codex'), CLAUDE_BIN: join(log, 'no-claude'),
    CODEX_HOME: person, VANILLA_CODEX_HOME: join(log, 'app-codex'), VANILLA_AI_SETTINGS: join(log, 'ai.json'),
    CODEX_STUB_CHANGES: f.changes, CODEX_STUB_TOOLS: f.tools, CODEX_STUB_CONTROL: f.control, CODEX_STUB_ARGS: f.args,
  });
  const { rest } = SESSION(api);
  try {
    const ledger = readFileSync(join(api.root, 'ledger.json'), 'utf8');
    writeFileSync(f.tools, JSON.stringify([
      { tool: 'Read', arguments: { file_path: 'ledger.json' } },
      { tool: 'Write', arguments: { file_path: 'data/draft/knowledge/suppliers/stub.yaml', content: 'id: stub\n' } },
      { tool: 'Write', arguments: { file_path: 'ledger.json', content: '{}' } },
    ]));
    writeFileSync(f.changes, JSON.stringify([{ kind: 'receipt', id: open.id, set: { description: 'Von Codex' } }]));
    const first = await post({ text: 'Bitte richtig eintragen', language: 'de', context: [] });
    assert.deepEqual(first.events.filter((e) => e.type === 'tool').map((e) => [(e as { name: string }).name, (e as { detail: string }).detail, !!(e as { denied?: boolean }).denied]),
      [['Read', 'ledger.json', false], ['Write', 'data/draft/knowledge/suppliers/stub.yaml', false], ['Write', 'ledger.json', true]], 'each tool call, a refused one marked');
    assert.equal(readFileSync(join(api.root, 'data/draft/knowledge/suppliers/stub.yaml'), 'utf8'), 'id: stub\n', 'the draft is written by the app\'s tool');
    assert.equal(readFileSync(join(api.root, 'ledger.json'), 'utf8'), ledger, 'the ledger is never written by a tool');
    assert.match(first.turn.text, /Stub-Codex auf «Bitte richtig eintragen»\. Werkzeuge: Read, Glob, Grep, Write, Edit\. Ein neues Gespräch\./);
    assert.equal(first.turn.changes?.length, 1, 'the block\'s change is made');
    assert.ok(first.turn.changes![0].undo, 'with its undo, as every change of the write door');
    await rest();
    assert.equal((await books()).receipts.find((r) => r.id === open.id)!.description, 'Von Codex');
    const [call1] = readFileSync(f.args, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; home: string; instructions: string; cwd: string });
    assert.equal(call1.home, join(log, 'app-codex'), 'the app\'s CODEX_HOME, without the person\'s AGENTS.md');
    assert.ok(!existsSync(join(call1.home, 'AGENTS.md')));
    assert.match(call1.instructions, /mcp__vanilla__Read/, 'the instructions name its tools');
    assert.match(call1.instructions, /vanilla-changes/, 'and the same block as the Claude sidebar');

    const second = await post({ conversation: first.id, text: 'Und jetzt?', language: 'de', context: [] });
    assert.match(second.turn.text, /Das Gespräch geht weiter/, 'the next message resumes the Codex session');

    writeFileSync(f.tools, '[]');
    writeFileSync(f.changes, JSON.stringify([{ kind: 'receipt', id: filed.id, set: { amount: 1, currency: 'CHF' } }]));
    const closed = await post({ text: 'Den alten Beleg ändern', language: 'de', context: [] });
    assert.ok(closed.events.some((e) => e.type === 'refused' && /geschlossen/.test(e.message)), 'the write door refuses a filed quarter');
    assert.equal((await books()).receipts.find((r) => r.id === filed.id)!.amount, filed.amount, 'nothing of it is written');

    writeFileSync(f.changes, JSON.stringify([{ kind: 'receipt', id: open.id, set: { description: 'Nach einer Tat' } }]));
    for (const item of [
      { id: 'i1', type: 'command_execution', command: 'bash -lc "echo x > ledger.json"', status: 'in_progress' },
      { id: 'i2', type: 'file_change', changes: [{ path: 'ledger.json', kind: 'update' }], status: 'in_progress' },
      { id: 'i3', type: 'web_search', query: 'Kontenplan' },
      { id: 'i4', type: 'collab_tool_call', tool: 'spawn_agent', status: 'in_progress' },
      { id: 'i5', type: 'mcp_tool_call', server: 'other', tool: 'write_file', status: 'in_progress' },
    ]) {
      writeFileSync(f.control, JSON.stringify({ mode: 'act', item }));
      const acted = await post({ text: 'Mach einfach', language: 'de', context: [] });
      const error = acted.events.find((e) => e.type === 'error') as { message: string } | undefined;
      assert.match(error?.message ?? '', /die App hat die Antwort beendet, nichts davon ist gemacht/, item.type);
      assert.deepEqual(acted.events.at(-1), { type: 'done', isError: true }, item.type);
      assert.equal(acted.turn.changes, undefined, `${item.type}: the block of an ended run is not applied`);
    }
    await rest();
    assert.equal((await books()).receipts.find((r) => r.id === open.id)!.description, 'Von Codex', 'no ended run changed the books');
    assert.equal(readFileSync(join(api.root, 'ledger.json'), 'utf8'), ledger);
  } finally {
    await rest().catch(() => {});
    await api.stop();
    rmSync(log, { recursive: true, force: true });
  }
});
