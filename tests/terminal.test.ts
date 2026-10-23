/**
 * «Im Terminal öffnen» (issue #146): which CLI opens (src/assistant/terminal.ts), what this
 * computer has (src/assistant/terminal-open.ts), a request that reaches the CLI as one argument
 * whatever it holds, the terminal AI's instructions in every workspace
 * (src/workspace/terminal-agents.ts), the sidebar's offer, and a proposal written from the
 * terminal that the app holds for «Übernehmen» (src/assistant/terminal-drafts.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseCli, copyCommand, shellQuote, type CliState } from '../src/platform/terminal.js';
import { claudeSignedIn, detectClis, openInTerminal } from '../src/platform/terminal-open.js';
import { SECTION_END, SECTION_START, TERMINAL_SECTION, ensureTerminalAgents, withAgentsImport, withSection } from '../src/workspace/terminal-agents.js';
import { createWorkspace } from '../src/workspace/create.js';
import { changesIn, terminalRequest, withoutChanges } from '../src/assistant/changes.js';
import { proposalId } from '../src/assistant/terminal-drafts.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { AssistantEvent, Conversation, ConversationSummary } from '../src/types/assistant.js';
import type { Index } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import { startApi } from './support/api-server.js';

const REPO = process.cwd();
const BIN = join(REPO, 'tests/support/terminal-bin');
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** Requests a shell must take as words, never as code. */
const NASTY = [
  `Fasse die Belege von Q3 zusammen: "alle" & 'jede' $(touch pwned) \`touch pwned\` ; touch pwned`,
  `'; touch pwned; echo '`,
  'Zeile eins\nZeile zwei $HOME ${PATH} \\ \' "',
];

test('the CLI that opens: the one chosen when both are there, the other offered; one alone; signed out says so; none is the guide', () => {
  const both: CliState[] = [{ cli: 'claude', installed: true, signedIn: true }, { cli: 'codex', installed: true, signedIn: true }];
  assert.deepEqual(chooseCli(both, undefined), { kind: 'open', cli: 'claude', signIn: false, other: 'codex' }, 'none chosen: Claude');
  assert.deepEqual(chooseCli(both, 'codex'), { kind: 'open', cli: 'codex', signIn: false, other: 'claude' });
  const codexOnly: CliState[] = [{ cli: 'claude', installed: false }, { cli: 'codex', installed: true, signedIn: false }];
  assert.deepEqual(chooseCli(codexOnly, 'claude'), { kind: 'open', cli: 'codex', signIn: true }, 'the chosen one missing: the one there, which asks to sign in');
  assert.deepEqual(chooseCli([{ cli: 'claude', installed: true, signedIn: undefined }, { cli: 'codex', installed: false }], undefined), { kind: 'open', cli: 'claude', signIn: false }, 'not known is not «signed out»');
  assert.deepEqual(chooseCli([{ cli: 'claude', installed: false }, { cli: 'codex', installed: false }], 'codex'), { kind: 'install' });
});

test('the command to copy: the books folder and the request each one word to the shell, whatever they hold', () => {
  const folder = join(temp('term-copy-'), `Bücher "Muster" & Co's $HOME`);
  mkdirSync(folder);
  const out = join(temp('term-out-'), 'run');
  for (const request of NASTY) {
    const command = copyCommand(folder, 'claude', request);
    execFileSync('/bin/sh', ['-c', command], { cwd: tmpdir(), env: { PATH: `${BIN}:/usr/bin:/bin`, TERMINAL_STUB_OUT: out } });
    assert.equal(readFileSync(`${out}.arg`, 'utf8'), request.trim());
    assert.equal(readFileSync(`${out}.argc`, 'utf8'), '1');
    assert.equal(realpathSync(readFileSync(`${out}.cwd`, 'utf8')), realpathSync(folder));
    assert.equal(existsSync(join(folder, 'pwned')) || existsSync(join(tmpdir(), 'pwned')), false, 'nothing of the request ran');
  }
  assert.equal(shellQuote(`it's`), `'it'\\''s'`);
  assert.equal(copyCommand('/b', 'codex', '  '), `cd '/b' && codex`, 'no request: the CLI alone');
});

test('Terminal runs a script that reads the request from its file: the CLI gets it as one argument in the books folder, and the script\'s folder is gone', async () => {
  const folder = join(temp('term-open-'), `Firma's "Bücher"`);
  mkdirSync(folder);
  const out = join(temp('term-out-'), 'run');
  for (const request of NASTY) {
    const opened: string[][] = [];
    const script = await openInTerminal(folder, join(BIN, 'claude'), request, (command, args, done) => {
      opened.push([command, ...args]);
      execFile('/bin/sh', [args[2]], { env: { PATH: '/usr/bin:/bin', TERMINAL_STUB_OUT: out } }, (err) => done(err));
    });
    assert.deepEqual(opened, [['open', '-a', 'Terminal', script]]);
    assert.equal(readFileSync(`${out}.arg`, 'utf8'), request.trim(), 'the request arrives as it was written');
    assert.equal(readFileSync(`${out}.argc`, 'utf8'), '1');
    assert.equal(realpathSync(readFileSync(`${out}.cwd`, 'utf8')), realpathSync(folder));
    assert.equal(existsSync(script), false, 'the script and the request file are removed');
    assert.equal(existsSync(join(folder, 'pwned')), false);
  }
});

test('detection: a CLI is a program on the login PATH; Codex says itself whether it is signed in, Claude by the app\'s own last call', async () => {
  const empty = temp('term-path-');
  const ledger = join(temp('term-ledger-'), 'llm-ledger.jsonl');
  const env = process.env.CODEX_STUB_STATUS;
  try {
    process.env.CODEX_STUB_STATUS = '0';
    let found = await detectClis({ path: `/nonexistent:${BIN}`, ledger });
    assert.deepEqual(found.map(({ bin: _, ...s }) => s), [{ cli: 'claude', installed: true, signedIn: undefined }, { cli: 'codex', installed: true, signedIn: true }]);
    assert.equal(found[1].bin, join(BIN, 'codex'));
    process.env.CODEX_STUB_STATUS = '1';
    found = await detectClis({ path: BIN, ledger });
    assert.equal(found[1].installed && found[1].signedIn, false, '`codex login status` exits 1: not signed in');
  } finally {
    if (env === undefined) delete process.env.CODEX_STUB_STATUS; else process.env.CODEX_STUB_STATUS = env;
  }
  assert.deepEqual(await detectClis({ path: empty, ledger }), [{ cli: 'claude', installed: false }, { cli: 'codex', installed: false }]);
  assert.equal((await detectClis({ path: empty, ledger, claudeBin: join(BIN, 'claude') }))[0].installed, true, 'the desktop app\'s claude (CLAUDE_BIN) counts');

  writeFileSync(ledger, [{ provider: 'claude-cli', ok: true }, { provider: 'jev', ok: false }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(claudeSignedIn(ledger), true);
  writeFileSync(ledger, `${JSON.stringify({ provider: 'claude-cli', ok: false })}\n`, { flag: 'a' });
  assert.equal(claudeSignedIn(ledger), undefined, 'a failed call proves nothing about the sign-in');
});

test('the terminal AI\'s AGENTS.md: written whole, added to the company\'s own file, renewed between its markers, the company\'s lines kept', () => {
  assert.equal(withSection(undefined), TERMINAL_SECTION);
  const own = '# Muster GmbH\n\nOur own notes for agents.\n';
  const added = withSection(own);
  assert.ok(added.startsWith(own.trimEnd()), 'the company\'s file stays at the top');
  assert.ok(added.includes(TERMINAL_SECTION));
  const old = added.replace(TERMINAL_SECTION.trimEnd(), `${SECTION_START}\nold rules\n${SECTION_END}`) + '\nA line after.\n';
  const renewed = withSection(old);
  assert.ok(renewed.includes(TERMINAL_SECTION.trimEnd()) && !renewed.includes('old rules'));
  assert.ok(renewed.startsWith(own.trimEnd()) && renewed.endsWith('A line after.\n'));
  assert.equal(withSection(renewed), renewed, 'idempotent');
  assert.equal(withAgentsImport(undefined), '@AGENTS.md\n');
  assert.equal(withAgentsImport('Own\n\n@AGENTS.md\n'), 'Own\n\n@AGENTS.md\n');
  assert.equal(withAgentsImport('Own\n'), 'Own\n\n@AGENTS.md\n');
  for (const rule of ['output/', 'data/terminal/', 'closedThrough', '«Übernehmen»', 'Never edit']) assert.ok(TERMINAL_SECTION.includes(rule), rule);

  const root = temp('term-agents-');
  writeFileSync(join(root, 'CLAUDE.md'), 'Our Claude notes.\n');
  assert.deepEqual(ensureTerminalAgents({ root }), ['AGENTS.md', 'CLAUDE.md', 'output/.gitignore']);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), 'Our Claude notes.\n\n@AGENTS.md\n');
  assert.equal(readFileSync(join(root, 'output/.gitignore'), 'utf8'), '*\n', 'what the terminal AI makes is not committed');
  assert.deepEqual(ensureTerminalAgents({ root }), [], 'a second run writes nothing');
});

test('a new workspace has the terminal AI\'s files in vanilla-accounting/, beside the repository\'s own AGENTS.md', async () => {
  const root = join(temp('term-create-'), 'books');
  await createWorkspace({
    root, preset: 'freelancer', name: 'Muster Beratung', uid: 'CHE-153.004.184', owner: 'Max Muster',
    answers: { legalForm: 'Einzelfirma', vatRegistered: 'no', fiscalYear: 'calendar', start: 'new', sells: ['services'], foreignCustomers: 'no', imports: 'no', employees: 'none', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no' },
    banks: [{ bank: 'UBS', currency: 'CHF' }],
  });
  assert.equal(readFileSync(join(root, 'vanilla-accounting/AGENTS.md'), 'utf8'), TERMINAL_SECTION);
  assert.equal(readFileSync(join(root, 'vanilla-accounting/CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.equal(readFileSync(join(root, 'vanilla-accounting/output/.gitignore'), 'utf8'), '*\n');
  assert.doesNotMatch(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /vanilla-accounting:start/, 'the repository\'s file is its own');
  assert.deepEqual(ensureTerminalAgents(workspaceAt(root).paths), [], 'an update finds them in place');
});

test('the sidebar\'s offer: a vanilla-terminal block is the request, never shown as text, beside the changes block', () => {
  const said = 'Das kann ich hier nicht.\n\n```vanilla-terminal\nFüge die Belege von Q3 zu einem PDF zusammen, Ergebnis nach output/.\n```\n\n```vanilla-changes\n[]\n```';
  assert.equal(terminalRequest(said), 'Füge die Belege von Q3 zu einem PDF zusammen, Ergebnis nach output/.');
  assert.equal(withoutChanges(said), 'Das kann ich hier nicht.');
  assert.deepEqual(changesIn(said), []);
  assert.equal(terminalRequest('```vanilla-terminal\n\n```'), undefined);
  assert.equal(withoutChanges('Moment.\n\n```vanilla-terminal\nFüge die Bel'), 'Moment.', 'an unfinished block is not shown while it streams');
});

test('end to end: the sidebar offers the terminal, the button starts the CLI in the books folder on the request; a proposal from the terminal waits for «Übernehmen»', async (t) => {
  const demo = loadBooks(workspaceAt(DEMO_ROOT));
  const closed = demo.config.closedThrough!;
  const open = demo.journalEntries.find((e) => e.date > closed && e.transactionRef && !e.origin)!;
  const filed = demo.journalEntries.find((e) => e.date <= closed)!;
  const log = temp('term-api-');
  const out = join(log, 'run');
  const said = join(log, 'said.txt');
  writeFileSync(said, 'Ein PDF zusammenführen kann ich hier nicht: der Knopf unten öffnet das Terminal.\n\n```vanilla-terminal\nFasse alle Belege von Q3 in output/q3.pdf zusammen. $(touch pwned)\n```');
  const api = await startApi('demo/vanilla-accounting', {
    PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_BIN: '', CLAUDE_STUB_TEXT: said,
    SHELL: join(BIN, 'shell'), TERMINAL_STUB_PATH: `${BIN}:/usr/bin:/bin`, VANILLA_TERMINAL_OPENER: join(BIN, 'opener'), TERMINAL_STUB_OUT: out,
    CODEX_STUB_STATUS: '1', VANILLA_AI_SETTINGS: join(log, 'ai.json'),
  });
  cpSync(DEMO_ROOT, api.root, { recursive: true, filter: (src) => !src.endsWith('belege.workspace.yaml') });
  t.after(async () => { await api.stop(); rmSync(log, { recursive: true, force: true }); });

  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Mach mir ein PDF aller Belege von Q3', language: 'de', context: [] }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  const request = 'Fasse alle Belege von Q3 in output/q3.pdf zusammen. $(touch pwned)';
  assert.deepEqual(events.filter((e) => e.type === 'terminal'), [{ type: 'terminal', request }]);
  const id = (events[0] as { id: string }).id;
  const turn = (await (await api.fetch(`/api/assistant/${id}`)).json() as Conversation).turns[1];
  assert.equal(turn.role === 'ai' && turn.terminal, request, 'the offer is kept with the answer');
  assert.ok(turn.role === 'ai' && !turn.text.includes('vanilla-terminal'));

  const view = (await api.send('GET', '/api/terminal')).json;
  assert.deepEqual(view.clis, [{ cli: 'claude', installed: true, signedIn: true }, { cli: 'codex', installed: true, signedIn: false }], 'Claude answered the sidebar just now; Codex said it is signed out');
  assert.equal(realpathSync(String(view.folder)), realpathSync(api.root));

  rmSync(join(api.root, 'AGENTS.md'), { force: true });
  const opened = await api.send('POST', '/api/terminal/open', { request });
  assert.deepEqual([opened.status, opened.json], [200, { cli: 'claude' }]);
  assert.deepEqual([readFileSync(`${out}.cli`, 'utf8'), readFileSync(`${out}.arg`, 'utf8'), readFileSync(`${out}.argc`, 'utf8')], ['claude', request, '1']);
  assert.equal(realpathSync(readFileSync(`${out}.cwd`, 'utf8')), realpathSync(api.root), 'in the books folder');
  assert.equal(existsSync(join(api.root, 'pwned')), false);
  assert.ok(readFileSync(join(api.root, 'AGENTS.md'), 'utf8').includes(SECTION_START), 'the instructions are written before the CLI starts');

  assert.equal((await api.send('PUT', '/api/terminal', { preferred: 'codex' })).json.preferred, 'codex');
  assert.deepEqual((await api.send('POST', '/api/terminal/open', { request: 'Hallo' })).json, { cli: 'codex' }, 'chosen in Firma › KI');
  assert.deepEqual((await api.send('POST', '/api/terminal/open', { request: 'Hallo', cli: 'claude' })).json, { cli: 'claude' }, '«oder mit Claude Code»');
  assert.equal((await api.send('POST', '/api/terminal/open', {})).status, 400, 'no request, no terminal');

  // A proposal the terminal AI wrote: held, booking by booking, until «Übernehmen».
  const books = () => api.send('GET', '/books.json').then((r) => r.json as unknown as Index);
  const proposals = join(api.root, 'data/terminal');
  mkdirSync(proposals, { recursive: true });
  const text = JSON.stringify({ title: 'Auf Material umbuchen', summary: 'Eine Buchung kommt auf 4000.', changes: [{ kind: 'entry', id: open.id, set: { accountDebit: '4000', vatCode: 'M0' } }] });
  writeFileSync(join(proposals, 'material.json'), text);
  writeFileSync(join(proposals, 'filed.json'), JSON.stringify({ title: 'Gefiltes ändern', summary: 'x', changes: [{ kind: 'deleteEntry', id: filed.id }] }));
  writeFileSync(join(proposals, 'broken.json'), '{ "title": "kaputt", ');
  const before = await books();
  const list = (await (await api.fetch('/api/assistant')).json()) as ConversationSummary[];
  assert.deepEqual(readdirSync(proposals), [], 'each file taken in');
  assert.ok(list.some((c) => c.id === proposalId('material.json', text) && c.title === 'Auf Material umbuchen'));
  assert.deepEqual(await books(), before, 'taken in, nothing changed yet');
  const material = (await (await api.fetch(`/api/assistant/${proposalId('material.json', text)}`)).json()) as Conversation;
  const ai = material.turns[1];
  assert.ok(ai.role === 'ai' && ai.held);
  assert.deepEqual([ai.held!.why, ai.held!.status, ai.held!.rows.map((r) => [r.entry, r.after?.accountDebit])], [['terminal'], 'held', [[open.id, '4000']]]);
  const others = list.filter((c) => c.title === 'Gefiltes ändern' || c.title === 'broken');
  for (const c of others) {
    const turn = ((await (await api.fetch(`/api/assistant/${c.id}`)).json()) as Conversation).turns[1];
    assert.ok(turn?.role === 'ai' && turn.refused && !turn.held, `${c.title}: refused, nothing to take`);
  }
  assert.equal(others.length, 2);

  const took = await api.send('POST', `/api/assistant/${material.id}/held/1`, { take: true, language: 'de' });
  assert.equal(took.status, 200);
  const changed = (await books()).journalEntries!.find((e) => e.id === open.id)!;
  assert.deepEqual([changed.accountDebit, changed.vatCode, changed.origin], ['4000', 'M0', 'manual'], 'made by the person\'s click, as the person\'s');
});

test('the sidebar is told to offer the terminal at a limit, never to refuse', async () => {
  const { assistantArgs } = await import('../src/assistant/claude.js');
  const system = assistantArgs({ language: 'de' }, undefined, '/repo', '2850 Privat').join('\n');
  assert.match(system, /vanilla-terminal/);
  assert.match(system, /never refuse and never call impossible/);
  assert.doesNotMatch(system, /say plainly that you cannot do it/);
});
