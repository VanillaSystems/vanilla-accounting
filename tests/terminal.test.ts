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
import { TERMINAL_APPS, TERMINAL_APP_FACTS, chooseCli, chooseTerminalApp, copyCommand, launchScript, openArgs, shellQuote, type CliState, type TerminalApp } from '../src/platform/terminal.js';
import { detectTerminalApps, openInTerminal } from '../src/platform/terminal-open.js';
import { parseSettings, readSettings, writeCli, writeTerminalApp } from '../src/llm/settings.js';
import { REPOSITORY_SECTION, SECTION_END, SECTION_START, TERMINAL_SECTION, ensureTerminalAgents, renewTerminalAgents, repositoryAgents, withAgentsImport, withRepositorySection, withSection } from '../src/workspace/terminal-agents.js';
import { createWorkspace } from '../src/workspace/create.js';
import { committedAsIs, initRepository } from '../src/workspace/git.js';
import { changesIn, terminalRequest, withoutChanges } from '../src/assistant/changes.js';
import { proposalId } from '../src/assistant/terminal-drafts.js';
import { CONTEXT_MAX, QUESTION_MAX, handover } from '../src/assistant/handover.js';
import { loadBooks } from '../src/books/store.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import type { AssistantEvent, Conversation, ConversationSummary, Turn } from '../src/types/assistant.js';
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
    const script = await openInTerminal({ folder, bin: join(BIN, 'claude'), request }, (command, args, done) => {
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

/** Runs `open`'s arguments as tests/support/terminal-bin/opener does, never a real terminal app. */
const stubOpen = (opened: string[][], env: Record<string, string>) => (command: string, args: string[], done: (err: Error | null) => void) => {
  opened.push([command, ...args]);
  execFile(join(BIN, 'opener'), args, { env: { PATH: '/usr/bin:/bin', ...env } }, (err) => done(err));
};

test('an empty chat starts the CLI with no prompt: no request file, no argument, in the books folder (issue #210)', async () => {
  const folder = join(temp('term-empty-'), `Firma's "Bücher"`);
  mkdirSync(folder);
  const out = join(temp('term-out-'), 'run');
  for (const request of [undefined, '', '  \n ']) {
    const opened: string[][] = [];
    const script = await openInTerminal({ folder, bin: join(BIN, 'claude'), ...(request !== undefined ? { request } : {}) }, stubOpen(opened, { TERMINAL_STUB_OUT: out }));
    assert.deepEqual(opened, [['open', '-a', 'Terminal', script]]);
    assert.equal(readFileSync(`${out}.argc`, 'utf8'), '0', 'the CLI gets no prompt');
    assert.equal(realpathSync(readFileSync(`${out}.cwd`, 'utf8')), realpathSync(folder));
    assert.equal(existsSync(script), false);
  }
  const dir = temp('term-script-');
  const bare = launchScript(folder, '/bin/claude', dir);
  assert.doesNotMatch(bare, /request/, 'nothing read, nothing handed on');
  assert.match(bare, /^exec '\/bin\/claude'$/m);
  assert.match(launchScript(folder, '/bin/claude', dir, join(dir, 'request.txt')), /exec '\/bin\/claude' "\$request"/, 'with a request: as before');
});

test('each terminal app runs the script its own way, never by AppleScript; the CLI arrives with the request in the books folder', async () => {
  assert.deepEqual(openArgs('terminal', '/s.command'), ['-a', 'Terminal', '/s.command']);
  assert.deepEqual(openArgs('iterm', '/s.command'), ['-a', 'iTerm', '/s.command']);
  assert.deepEqual(openArgs('warp', '/s.command'), ['-a', 'Warp', '/s.command']);
  assert.deepEqual(openArgs('ghostty', '/s.command'), ['-na', 'Ghostty', '--args', '-e', '/s.command']);
  const folder = join(temp('term-apps-'), 'Bücher & Co');
  mkdirSync(folder);
  const out = join(temp('term-out-'), 'run');
  for (const app of TERMINAL_APPS) {
    const opened: string[][] = [];
    const script = await openInTerminal({ folder, bin: join(BIN, 'codex'), request: NASTY[0], app }, stubOpen(opened, { TERMINAL_STUB_OUT: out }));
    assert.deepEqual(opened, [['open', ...openArgs(app, script)]], app);
    assert.equal(readFileSync(`${out}.app`, 'utf8'), TERMINAL_APP_FACTS[app].bundle);
    assert.deepEqual([readFileSync(`${out}.cli`, 'utf8'), readFileSync(`${out}.arg`, 'utf8'), readFileSync(`${out}.argc`, 'utf8')], ['codex', NASTY[0], '1'], app);
    assert.equal(realpathSync(readFileSync(`${out}.cwd`, 'utf8')), realpathSync(folder));
    assert.equal(existsSync(join(folder, 'pwned')), false);
  }
});

test('which terminal app: one installed opens it without a question; several ask until one is chosen; a chosen one gone asks again', () => {
  assert.deepEqual(chooseTerminalApp(['terminal'], undefined), { kind: 'open', app: 'terminal' }, 'Terminal alone: no question');
  assert.deepEqual(chooseTerminalApp(['terminal'], 'iterm'), { kind: 'open', app: 'terminal' }, 'iTerm2 removed since: Terminal, no question');
  assert.deepEqual(chooseTerminalApp(['terminal', 'iterm'], undefined), { kind: 'ask', apps: ['terminal', 'iterm'] });
  assert.deepEqual(chooseTerminalApp(['terminal', 'iterm'], 'iterm'), { kind: 'open', app: 'iterm' });
  assert.deepEqual(chooseTerminalApp(['terminal', 'iterm', 'ghostty'], 'warp'), { kind: 'ask', apps: ['terminal', 'iterm', 'ghostty'] });

  const system = temp('term-apps-sys-');
  const own = temp('term-apps-own-');
  assert.deepEqual(detectTerminalApps([system, own]), ['terminal'], 'Terminal is part of macOS');
  mkdirSync(join(own, 'Ghostty.app'));
  mkdirSync(join(system, 'iTerm.app'));
  mkdirSync(join(system, 'Warp')); // not an app bundle
  assert.deepEqual(detectTerminalApps([system, own]), ['terminal', 'iterm', 'ghostty'], 'in the table\'s order, from any of the folders');
});

test('the terminal app is kept per machine beside the CLI choice, never in the workspace', () => {
  assert.deepEqual(parseSettings({ steps: {}, cli: 'codex', terminalApp: 'iterm' }), { steps: {}, cli: 'codex', terminalApp: 'iterm' });
  assert.deepEqual(parseSettings({ steps: {}, terminalApp: 'xterm' }), { steps: {} }, 'an app the table does not know is left out');
  const file = join(temp('term-settings-'), 'ai.json');
  const before = process.env.VANILLA_AI_SETTINGS;
  process.env.VANILLA_AI_SETTINGS = file;
  try {
    writeCli({ cli: 'codex' });
    assert.equal(writeTerminalApp('ghostty').terminalApp, 'ghostty');
    writeCli({ askOther: true });
    assert.deepEqual(readSettings(), { steps: {}, cli: 'codex', askOther: true, terminalApp: 'ghostty' }, 'the CLI choice and the app\'s live side by side');
    assert.deepEqual(writeTerminalApp(null), { steps: {}, cli: 'codex', askOther: true });
  } finally {
    if (before === undefined) delete process.env.VANILLA_AI_SETTINGS; else process.env.VANILLA_AI_SETTINGS = before;
  }
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
  assert.deepEqual(ensureTerminalAgents({ root, repository: root }), ['AGENTS.md', 'CLAUDE.md', 'output/.gitignore']);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), 'Our Claude notes.\n\n@AGENTS.md\n');
  assert.equal(readFileSync(join(root, 'output/.gitignore'), 'utf8'), '*\n', 'what the terminal AI makes is not committed');
  assert.deepEqual(ensureTerminalAgents({ root, repository: root }), [], 'a second run writes nothing');
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
  const repository = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(repository, repositoryAgents('Muster Beratung'));
  assert.doesNotMatch(repository, /cd .*npm|app\.asar|\.app\//, 'no command into the app\'s folder: in the Mac app it is inside the bundle (issue #149)');
  assert.match(repository, /read `vanilla-accounting\/AGENTS\.md`/, 'the books\' rules are in the app\'s section there');
  assert.deepEqual(ensureTerminalAgents(workspaceAt(root).paths), [], 'an update finds them in place');
});

/** The repository's AGENTS.md as setup wrote it until issue #149, `app` the app's path from the repository. */
const legacyRepository = (app: string, notes = '- (add what an agent should know about this company)\n') => `# Muster GmbH: the company's repository (private)

This repository holds the company's data, not the code. Each app has its own folder; the books of
Vanilla Accounting are in \`vanilla-accounting/\`: \`belege.workspace.yaml\` (who the company is, how
it works, which ledger account each bank books on), \`knowledge/\` (suppliers, customers,
authorities, rules), \`mail.yaml\`, \`master-data/accounts.json\` (chart of accounts), \`ledger.json\`,
and per fiscal year \`transactional-data/<year>/\` (\`books/\`, \`receipts/\`, \`bank-statements/\`,
\`filings/\`). Files no app reads (notes, scripts, reference documents) go to \`own/\`;
\`npm run doctor\` names every other file.

The app is at \`${app}\`. Its \`.env\` sets \`VANILLA_WORKSPACE\` to this folder, so every
command run there works on these books:

    cd ${app} && npm start          # UI on http://localhost:5173
    cd ${app} && npm run doctor     # is everything set up?

Read the app's rules first: ${app}/AGENTS.md (golden rule 1: a filed quarter never changes;
corrections are booked in the open quarter with \`corrects:\` and declared on a form 0535).

What goes where:
- Code, generic process rules, public vendor facts: the app.
- Anything naming this company's accounts, amounts, customers, suppliers or the owner's
  decisions: here (knowledge/, this file).

Company notes:
${notes}`;

test('the repository\'s AGENTS.md of an existing workspace: the app\'s old text corrected with the company\'s notes kept, a file the company wrote left alone (issue #149)', () => {
  const bundle = '../../../Applications/Vanilla Accounting.app/Contents/Resources/app.asar';
  const notes = '- Owner answers in English.\n- Fiscal year = calendar year.\n\nMore of our own lines.\n';
  const corrected = withRepositorySection(legacyRepository(bundle, notes));
  assert.ok(corrected, 'the app\'s own text is recognised');
  assert.equal(corrected, `# Muster GmbH: the company's repository (private)\n\n${REPOSITORY_SECTION}\nCompany notes:\n${notes}`);
  assert.doesNotMatch(corrected, /npm start\b.*#|app\.asar/);
  assert.equal(withRepositorySection(corrected), corrected, 'renewed between its markers, idempotent');
  assert.equal(withRepositorySection(legacyRepository('../vanilla-accounting-app')), repositoryAgents('Muster GmbH'), 'a developer checkout\'s path too');

  const old03 = `# Muster GmbH: books (private workspace)

This folder holds the books, not the code. It is a Vanilla Accounting workspace: \`belege.workspace.yaml\`
(who the company is, how it works, which ledger account each bank books on), \`accounts.json\`
(chart of accounts), \`books.json\`, \`receipts/\`, \`bank-statements/\`, \`filings/\`, plus the
company's own knowledge: \`knowledge/\` (suppliers, customers, authorities, rules), \`mail.yaml\`.
${legacyRepository(bundle).slice(legacyRepository(bundle).indexOf('\nThe app is at'))}`;
  assert.equal(withRepositorySection(old03), repositoryAgents('Muster GmbH'), 'the text of 0.3, moved to the repository by the layout migration');

  const edited = legacyRepository(bundle).replace('decisions: here (knowledge/, this file).', 'decisions: here, and in our wiki.');
  assert.equal(withRepositorySection(edited), undefined, 'a person\'s edit of the app\'s part: the file is theirs now');
  assert.equal(withRepositorySection('# Muster GmbH\n\nOur own rules: cd ../app && npm start\n'), undefined, 'a file the company wrote');
  const stale = `# Muster GmbH\n\n${SECTION_START}\nold words\n${SECTION_END}\n\nOur notes.\n`;
  assert.equal(withRepositorySection(stale), `# Muster GmbH\n\n${REPOSITORY_SECTION.trimEnd()}\n\nOur notes.\n`);

  const repo = temp('term-repo-');
  const root = join(repo, 'vanilla-accounting');
  mkdirSync(root);
  assert.deepEqual(ensureTerminalAgents({ root, repository: repo }), ['vanilla-accounting/AGENTS.md', 'vanilla-accounting/CLAUDE.md', 'vanilla-accounting/output/.gitignore']);
  assert.equal(existsSync(join(repo, 'AGENTS.md')), false, 'a repository without its own AGENTS.md gets none');
  writeFileSync(join(repo, 'AGENTS.md'), legacyRepository(bundle, notes));
  assert.deepEqual(ensureTerminalAgents({ root, repository: repo }), ['AGENTS.md'], 'opening the app or npm run update corrects it');
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), corrected);
  writeFileSync(join(repo, 'AGENTS.md'), edited);
  assert.deepEqual(ensureTerminalAgents({ root, repository: repo }), []);
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), edited, 'never overwritten');
});

test('opening the books commits the terminal AI\'s files: no untracked AGENTS.md or CLAUDE.md left in the company\'s repository, a file the person is editing left to them (F25)', async () => {
  const files = ['vanilla-accounting/AGENTS.md', 'vanilla-accounting/CLAUDE.md', 'AGENTS.md'];
  const uncommitted = async (repo: string) => { const ok = await committedAsIs(repo, files); return files.filter((f) => !ok.has(f)); };

  // A repository of a version before #146: the books, no terminal files.
  const repo = temp('term-commit-');
  const root = join(repo, 'vanilla-accounting');
  mkdirSync(root);
  writeFileSync(join(root, 'ledger.json'), '{}\n');
  writeFileSync(join(repo, 'AGENTS.md'), repositoryAgents('Muster GmbH').replace(REPOSITORY_SECTION.trimEnd(), `${SECTION_START}\nold words\n${SECTION_END}`));
  await initRepository(repo, 'Books');
  const opened = await renewTerminalAgents({ root, repository: repo });
  assert.deepEqual(opened.written, ['vanilla-accounting/AGENTS.md', 'vanilla-accounting/CLAUDE.md', 'vanilla-accounting/output/.gitignore', 'AGENTS.md']);
  assert.equal(opened.committed, true);
  assert.deepEqual(await uncommitted(repo), [], 'git status stays clean');
  assert.deepEqual(await renewTerminalAgents({ root, repository: repo }), { written: [], committed: false }, 'a second opening changes nothing');

  // Files an earlier version left untracked, already as this version writes them.
  const stray = temp('term-stray-');
  const strayRoot = join(stray, 'vanilla-accounting');
  mkdirSync(strayRoot);
  writeFileSync(join(strayRoot, 'ledger.json'), '{}\n');
  await initRepository(stray, 'Books');
  ensureTerminalAgents({ root: strayRoot, repository: stray });
  assert.deepEqual(await uncommitted(stray), ['vanilla-accounting/AGENTS.md', 'vanilla-accounting/CLAUDE.md'], 'the finding: two untracked files');
  assert.deepEqual(await renewTerminalAgents({ root: strayRoot, repository: stray }), { written: [], committed: true });
  assert.deepEqual(await uncommitted(stray), []);

  // The person writes their own CLAUDE.md and has not saved it: the app adds its line, the save stays theirs.
  writeFileSync(join(strayRoot, 'CLAUDE.md'), 'Our Claude notes.\n');
  const editing = await renewTerminalAgents({ root: strayRoot, repository: stray });
  assert.deepEqual(editing, { written: ['vanilla-accounting/CLAUDE.md'], committed: false });
  assert.equal(readFileSync(join(strayRoot, 'CLAUDE.md'), 'utf8'), 'Our Claude notes.\n\n@AGENTS.md\n');
  assert.deepEqual(await uncommitted(stray), ['vanilla-accounting/CLAUDE.md']);

  const plain = temp('term-nogit-');
  assert.deepEqual(await renewTerminalAgents({ root: plain, repository: plain }), { written: ['AGENTS.md', 'CLAUDE.md', 'output/.gitignore'], committed: false }, 'no repository: written, nothing committed');
});

test('the sidebar\'s offer: a vanilla-terminal block is the request, never shown as text, beside the changes block', () => {
  const said = 'Das kann ich hier nicht.\n\n```vanilla-terminal\nFüge die Belege von Q3 zu einem PDF zusammen, Ergebnis nach output/.\n```\n\n```vanilla-changes\n[]\n```';
  assert.equal(terminalRequest(said), 'Füge die Belege von Q3 zu einem PDF zusammen, Ergebnis nach output/.');
  assert.equal(withoutChanges(said), 'Das kann ich hier nicht.');
  assert.deepEqual(changesIn(said), []);
  assert.equal(terminalRequest('```vanilla-terminal\n\n```'), undefined);
  assert.equal(withoutChanges('Moment.\n\n```vanilla-terminal\nFüge die Bel'), 'Moment.', 'an unfinished block is not shown while it streams');
});

test('the composer\'s terminal button hands over the typed words; with none, the last question and one line of the answer, capped', () => {
  const at = '2026-10-24T10:00:00Z';
  const me = (text: string): Turn => ({ role: 'me', text, at, context: [{ kind: 'entry', id: 'e-1', label: 'Buchung 1' }] });
  const ai = (text: string): Turn => ({ role: 'ai', text, at, tools: [{ name: 'Read', detail: 'secret/path.json' }], done: true });
  const turns = [
    me('Wie viel Umsatz im Q2?'), ai('Im Q2 waren es 12 000.'),
    me('Fasse die **Belege** von Q3 zu\neinem PDF zusammen.'),
    ai('## Das geht hier nicht\nIch habe keine Shell.\n\n```vanilla-changes\n[]\n```'),
  ];

  assert.equal(handover('  Exportiere alles nach output/  ', turns, 'Bisher im Chat'), 'Exportiere alles nach output/', 'typed words win, trimmed');
  assert.equal(handover('', turns, 'Bisher im Chat'), 'Fasse die Belege von Q3 zu einem PDF zusammen.\n\nBisher im Chat: Das geht hier nicht',
    'the last question on one line without Markdown, and the first line of its answer: no earlier turns, no references, no tool details');
  assert.equal(handover(' \n ', turns.slice(0, 3), 'Bisher im Chat'), 'Fasse die Belege von Q3 zu einem PDF zusammen.', 'no answer yet: the question alone');
  assert.equal(handover('', [], 'Bisher im Chat'), '', 'nothing asked: nothing to hand over (the button says a request of its own)');

  const long = handover('', [me('x'.repeat(5000)), ai(`${'y'.repeat(5000)}\nmehr`)], 'K');
  const [question, context] = long.split('\n\nK: ');
  assert.equal(question.length, QUESTION_MAX, 'the question is cut');
  assert.ok(question.endsWith('…'));
  assert.equal(context.length, CONTEXT_MAX, 'the context line is cut');
  assert.ok(!context.includes('mehr'), 'one line only');
  const typed = 'z'.repeat(5000);
  assert.equal(handover(typed, turns, 'K'), typed, 'typed words are not cut here: the open path caps them at REQUEST_MAX');
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
    CODEX_STUB_STATUS: '1', VANILLA_AI_SETTINGS: join(log, 'ai.json'), VANILLA_APPLICATIONS: join(log, 'Applications'),
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
  assert.deepEqual([view.apps, view.app], [['terminal'], undefined], 'Terminal alone: nothing to ask');

  rmSync(join(api.root, 'AGENTS.md'), { force: true });
  const opened = await api.send('POST', '/api/terminal/open', { request });
  assert.deepEqual([opened.status, opened.json], [200, { cli: 'claude', app: 'terminal' }]);
  assert.equal(readFileSync(`${out}.app`, 'utf8'), 'Terminal');
  assert.deepEqual([readFileSync(`${out}.cli`, 'utf8'), readFileSync(`${out}.arg`, 'utf8'), readFileSync(`${out}.argc`, 'utf8')], ['claude', request, '1']);
  assert.equal(realpathSync(readFileSync(`${out}.cwd`, 'utf8')), realpathSync(api.root), 'in the books folder');
  assert.equal(existsSync(join(api.root, 'pwned')), false);
  assert.ok(readFileSync(join(api.root, 'AGENTS.md'), 'utf8').includes(SECTION_START), 'the instructions are written before the CLI starts');

  assert.equal((await api.send('PUT', '/api/ai/cli', { cli: 'codex' })).json.cli, 'codex');
  assert.equal((await api.send('GET', '/api/terminal')).json.preferred, 'codex');
  assert.deepEqual((await api.send('POST', '/api/terminal/open', { request: 'Hallo' })).json, { cli: 'codex', app: 'terminal' }, 'chosen in Firma › KI');
  assert.deepEqual((await api.send('POST', '/api/terminal/open', { request: 'Hallo', cli: 'claude' })).json, { cli: 'claude', app: 'terminal' }, '«oder mit Claude Code»');

  // An empty chat (issue #210): the CLI starts with no prompt, nothing the person did not write is sent.
  assert.deepEqual((await api.send('POST', '/api/terminal/open', { cli: 'claude' })).json, { cli: 'claude', app: 'terminal' });
  assert.deepEqual([readFileSync(`${out}.cli`, 'utf8'), readFileSync(`${out}.argc`, 'utf8')], ['claude', '0'], 'no request: no prompt');
  assert.equal((await api.send('POST', '/api/terminal/open', { request: 42 })).status, 400);

  // A second terminal app: the UI asks; the choice is kept on this Mac and used.
  mkdirSync(join(log, 'Applications/iTerm.app'), { recursive: true });
  const two = (await api.send('GET', '/api/terminal')).json;
  assert.deepEqual([two.apps, two.app], [['terminal', 'iterm'], undefined]);
  assert.deepEqual(chooseTerminalApp(two.apps as TerminalApp[], undefined), { kind: 'ask', apps: ['terminal', 'iterm'] }, 'the button asks');
  assert.deepEqual((await api.send('POST', '/api/terminal/open', { request: 'Hallo', app: 'iterm' })).json, { cli: 'codex', app: 'iterm' }, 'picked without «merken»');
  assert.equal(readFileSync(`${out}.app`, 'utf8'), 'iTerm');
  assert.equal((await api.send('GET', '/api/terminal')).json.app, undefined, 'not kept');
  assert.equal((await api.send('PUT', '/api/terminal/app', { app: 'iterm' })).json.app, 'iterm', '«merken»');
  assert.equal(JSON.parse(readFileSync(join(log, 'ai.json'), 'utf8')).terminalApp, 'iterm', 'in the machine\'s settings, beside the CLI');
  assert.deepEqual((await api.send('POST', '/api/terminal/open', { request: 'Hallo' })).json, { cli: 'codex', app: 'iterm' }, 'the kept one opens');
  assert.equal(readFileSync(`${out}.app`, 'utf8'), 'iTerm');
  const missing = await api.send('PUT', '/api/terminal/app', { app: 'ghostty' });
  assert.deepEqual([missing.status, missing.json.code], [409, 'terminalAppMissing']);
  assert.equal((await api.send('POST', '/api/terminal/open', { request: 'Hallo', app: 'warp' })).status, 409);
  assert.equal((await api.send('PUT', '/api/terminal/app', { app: 'xterm' })).status, 400);
  assert.equal((await api.send('PUT', '/api/terminal/app', { app: null })).json.app, undefined, '«Beim nächsten Mal fragen»');

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
