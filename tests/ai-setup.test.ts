/**
 * The AI setup on a fresh Mac (docs/0.4.0/ai-setup.md): the card's state machine, detection with
 * fake CLIs in a temporary home and PATH (nothing, installed only in ~/.local/bin, signed out,
 * signed in, not answering), the Terminal scripts (nothing runs before Enter), that the app keeps
 * no email or organization and opens no CLI's credentials, and #175: a Mac with only an API key.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIRST_RUN_CLIS, POLL_MS, WAIT_MS, cardOf, nextCard, stepCards, waits, type CardState, type Cards, type CliProbe } from '../src/platform/ai-setup.js';
import { installScript, loginScript, parseClaudeStatus, parseCodexStatus, probeCli } from '../src/platform/ai-cli.js';
import { alreadyHere, legOf, otherOf, type Said } from '../src/app/ai/first-run.js';
import { probationOf, scriptTexts } from '../src/server/ai-setup.js';
import { desktopServer, listen, portOf } from '../src/desktop/server.js';
import { forgetCli, forgetKey } from '../src/llm/providers/index.js';
import { modelReady, resolveStep } from '../src/llm/ask.js';
import { writeCli } from '../src/llm/settings.js';
import { providerStub, type ProviderStub } from './support/provider-stub.js';
import { DEMO_ROOT } from './support/workspace.js';

const REPO = process.cwd();
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const script = (dir: string, name: string, body: string) => { const f = join(dir, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };

const OUT: CliProbe = { found: 'signedOut', bin: '/u/.local/bin/claude', version: '2.1.211' };
const IN: CliProbe = { found: 'signedIn', bin: '/u/.local/bin/claude', version: '2.1.211', plan: 'pro' };
const NONE: CliProbe = { found: 'none', looked: ['/usr/bin', '/u/.local/bin'] };

test('the card: nothing → installing → installed, signed out → signing in → signed in → tested → ready, looking every 2 s meanwhile', () => {
  let s: CardState = cardOf(NONE);
  assert.equal(s.kind, 'missing');
  assert.equal(waits(s), false, 'nothing polls before the person starts something');
  s = nextCard(s, { kind: 'install', at: 0 });
  assert.equal(s.kind, 'installing');
  assert.equal(waits(s), true);
  assert.ok(POLL_MS === 2000);
  s = nextCard(s, { kind: 'probed', probe: NONE, at: 2000 });
  assert.equal(s.kind, 'installing', 'still nothing: still waiting');
  s = nextCard(s, { kind: 'probed', probe: OUT, at: 4000 });
  assert.deepEqual(s, { kind: 'signedOut', bin: OUT.bin, version: '2.1.211' }, 'found without a restart');
  assert.equal(waits(s), false);
  s = nextCard(s, { kind: 'signIn', at: 5000 });
  assert.equal(s.kind, 'signingIn');
  s = nextCard(s, { kind: 'probed', probe: OUT, at: 7000 });
  assert.equal(s.kind, 'signingIn', 'not signed in yet: still waiting');
  s = nextCard(s, { kind: 'probed', probe: IN, at: 9000 });
  assert.deepEqual(s, { kind: 'testing', bin: IN.bin, version: '2.1.211', plan: 'pro' }, 'a fresh sign-in is tested once');
  assert.equal(nextCard(s, { kind: 'probed', probe: IN, at: 11_000 }).kind, 'testing', 'another look does not start a second test');
  s = nextCard(s, { kind: 'tested', result: { ok: true, ms: 1400 } });
  assert.deepEqual(s, { kind: 'ready', bin: IN.bin, version: '2.1.211', plan: 'pro', ms: 1400 });
  assert.deepEqual(nextCard(s, { kind: 'probed', probe: IN, at: 13_000 }), s, 'ready stays ready while signed in');
  assert.equal(nextCard(s, { kind: 'probed', probe: NONE, at: 15_000 }).kind, 'missing', 'uninstalled: says so');
  assert.equal(nextCard(s, { kind: 'again', at: 16_000 }).kind, 'testing', '«Nochmals prüfen» tests again');
});

test('the card: a refused test call shows the plan or the limit as a fact, from Claude Code and Codex alike', () => {
  const testing = cardOf(IN);
  const refused = nextCard(testing, { kind: 'tested', result: probationOf('claude exited 1: Claude Code is not available on your current plan. Upgrade to Pro.') });
  assert.deepEqual(refused, { kind: 'refused', bin: IN.bin, version: '2.1.211', plan: 'pro', why: 'plan', said: 'Claude Code is not available on your current plan. Upgrade to Pro.' });
  assert.deepEqual(probationOf("claude exited 1: Claude AI usage limit reached|1761404400"), { ok: false, why: 'limit', said: 'Claude AI usage limit reached|1761404400' });
  assert.deepEqual(probationOf('claude exited 1: something else broke'), { ok: false, why: 'other', said: 'something else broke' });
  assert.equal(nextCard(refused, { kind: 'signIn', at: 1 }).kind, 'signingIn', '«Mit anderem Konto anmelden»');
  assert.deepEqual(probationOf("codex exited 1: You've hit your usage limit. Try again at 6:00 PM."), { ok: false, why: 'limit', said: "You've hit your usage limit. Try again at 6:00 PM." });
  assert.deepEqual(cardOf({ found: 'signedIn', bin: '/u/codex', version: '0.163.0', plan: 'ChatGPT' }), { kind: 'testing', bin: '/u/codex', version: '0.163.0', plan: 'ChatGPT' }, 'Codex is tested too');
});

test('the card: after 15 minutes of waiting «nicht gefunden», with where the app looked; found later, it says so', () => {
  let s = nextCard(cardOf(NONE), { kind: 'install', at: 1000 });
  s = nextCard(s, { kind: 'probed', probe: NONE, at: 1000 + WAIT_MS - 1 });
  assert.equal(s.kind, 'installing');
  s = nextCard(s, { kind: 'probed', probe: NONE, at: 1000 + WAIT_MS });
  assert.deepEqual(s, { kind: 'notFound', waited: 'install', looked: NONE.looked });
  assert.equal(waits(s), false, 'the app stops looking');
  assert.equal(nextCard(s, { kind: 'probed', probe: NONE, at: 2 * WAIT_MS }), s, 'a look on focus that finds nothing keeps the fact');
  assert.equal(nextCard(s, { kind: 'again', at: 5 }).kind, 'installing', '«Nochmals prüfen» waits again');
  assert.equal(nextCard(s, { kind: 'probed', probe: OUT, at: 3 * WAIT_MS }).kind, 'signedOut');

  let t = nextCard(cardOf(OUT), { kind: 'signIn', at: 0 });
  t = nextCard(t, { kind: 'probed', probe: OUT, at: WAIT_MS });
  assert.deepEqual(t, { kind: 'notFound', waited: 'signIn', looked: [OUT.bin], bin: OUT.bin, version: '2.1.211' });
  assert.equal(nextCard(t, { kind: 'again', at: 1 }).kind, 'signingIn');
});

test('detection: nothing; installed only in ~/.local/bin (the native installer, before a new shell has it); signed out; signed in; not answering', async () => {
  const pinned = process.env.CLAUDE_BIN;
  delete process.env.CLAUDE_BIN;
  try {
    const home = temp('ai-home-');
    const path = temp('ai-path-');
    const none = await probeCli('claude', { home, path });
    assert.deepEqual(none, { found: 'none', looked: [path, join(home, '.local', 'bin')] });

    const local = join(home, '.local', 'bin');
    mkdirSync(local, { recursive: true });
    cpSync(join(REPO, 'tests/support/terminal-bin/claude'), join(local, 'claude'));
    process.env.CLAUDE_STUB_SIGNED_OUT = '1';
    assert.deepEqual(await probeCli('claude', { home, path }), { found: 'signedOut', bin: join(local, 'claude'), version: '2.1.211' });
    delete process.env.CLAUDE_STUB_SIGNED_OUT;
    assert.deepEqual(await probeCli('claude', { home, path }), { found: 'signedIn', bin: join(local, 'claude'), version: '2.1.211', method: 'claude.ai', plan: 'pro' },
      'the plan and the method; no email, no organization');

    script(path, 'claude', 'sleep 30');
    assert.deepEqual(await probeCli('claude', { home, path }, 500), { found: 'silent', bin: join(path, 'claude') }, 'the PATH first; a program that does not answer is said so');

    cpSync(join(REPO, 'tests/support/terminal-bin/codex'), join(path, 'codex'));
    process.env.CODEX_STUB_STATUS = '1';
    assert.deepEqual(await probeCli('codex', { home, path }), { found: 'signedOut', bin: join(path, 'codex'), version: '0.163.0' });
    process.env.CODEX_STUB_STATUS = '0';
    assert.deepEqual(await probeCli('codex', { home, path }), { found: 'signedIn', bin: join(path, 'codex'), version: '0.163.0' });
  } finally {
    delete process.env.CODEX_STUB_STATUS;
    if (pinned !== undefined) process.env.CLAUDE_BIN = pinned;
  }
});

const CODEX_NONE: CliProbe = { found: 'none', looked: ['/usr/bin', '/u/.local/bin'] };
const CODEX_OUT: CliProbe = { found: 'signedOut', bin: '/u/.local/bin/codex', version: '0.164.0' };
const CODEX_IN: CliProbe = { found: 'signedIn', bin: '/u/.local/bin/codex', version: '0.164.0', method: 'chatgpt', plan: 'ChatGPT' };
/** The first look at both CLIs, as useAiSetup makes it. */
const looked = (claude: CliProbe, codex: CliProbe, at = 0): Cards =>
  stepCards(stepCards({}, 'claude', { kind: 'probed', probe: claude, at }), 'codex', { kind: 'probed', probe: codex, at });

test('the first run offers Claude Code and Codex, and nothing is picked while neither is here', () => {
  assert.deepEqual(FIRST_RUN_CLIS, ['claude', 'codex']);
  const cards = looked(NONE, CODEX_NONE);
  assert.deepEqual([cards.claude?.kind, cards.codex?.kind], ['missing', 'missing'], 'both cards');
  assert.equal(alreadyHere(cards), undefined);
  assert.equal(legOf([], alreadyHere(cards)), undefined, 'no CLI followed: the answers «Claude Code installieren», «Codex installieren», «Ohne KI weiter»');
  assert.equal(otherOf('claude'), 'codex');
  assert.equal(otherOf('codex'), 'claude');
});

test('first run, pick Claude Code: the conversation follows Claude through install, sign-in, test call and ready; the Codex card stays as it was', () => {
  let cards = looked(NONE, CODEX_NONE);
  const said: Said[] = [{ kind: 'install', cli: 'claude' }];
  cards = stepCards(cards, 'claude', { kind: 'install', at: 0 });
  assert.deepEqual(legOf(said, alreadyHere(cards)), { cli: 'claude', by: 'install', at: 0, signIn: false });
  assert.equal(cards.codex?.kind, 'missing', 'Claude\'s install does not move the Codex card');
  cards = stepCards(cards, 'claude', { kind: 'probed', probe: OUT, at: 2000 });
  cards = stepCards(cards, 'codex', { kind: 'probed', probe: CODEX_NONE, at: 2000 });
  assert.deepEqual([cards.claude?.kind, cards.codex?.kind], ['signedOut', 'missing']);
  said.push({ kind: 'signIn', cli: 'claude' });
  cards = stepCards(cards, 'claude', { kind: 'signIn', at: 3000 });
  assert.equal(legOf(said, alreadyHere(cards))?.signIn, true);
  cards = stepCards(cards, 'claude', { kind: 'probed', probe: IN, at: 5000 });
  assert.equal(cards.claude?.kind, 'testing');
  cards = stepCards(cards, 'claude', { kind: 'tested', result: { ok: true, ms: 900 } });
  cards = stepCards(cards, 'codex', { kind: 'tested', result: { ok: true, ms: 1 } });
  assert.deepEqual(cards.claude, { kind: 'ready', bin: IN.bin, version: '2.1.211', plan: 'pro', ms: 900 });
  assert.equal(cards.codex?.kind, 'missing', 'a test result for a card that is not testing changes nothing');
});

test('first run, pick Codex: the conversation follows Codex; «Doch lieber Claude Code» switches, «Ändern» goes back', () => {
  let cards = looked(NONE, CODEX_NONE);
  const said: Said[] = [{ kind: 'install', cli: 'codex' }];
  cards = stepCards(cards, 'codex', { kind: 'install', at: 0 });
  assert.deepEqual([cards.claude?.kind, cards.codex?.kind], ['missing', 'installing']);
  assert.deepEqual(legOf(said, alreadyHere(cards)), { cli: 'codex', by: 'install', at: 0, signIn: false });
  cards = stepCards(cards, 'codex', { kind: 'probed', probe: CODEX_OUT, at: 2000 });
  assert.equal(cards.codex?.kind, 'signedOut', 'installed, not signed in');
  assert.equal(alreadyHere(cards), 'codex');

  const switched: Said[] = [...said, { kind: 'switch', cli: 'claude' }];
  assert.deepEqual(legOf(switched, alreadyHere(cards)), { cli: 'claude', by: 'switch', at: 1, signIn: false }, 'the other one, offered quietly, picked');
  assert.deepEqual(legOf(switched.slice(0, 1), alreadyHere(cards))?.cli, 'codex', '«Ändern» on the switch: back to Codex');
  assert.equal(legOf([...switched, { kind: 'signIn', cli: 'codex' }], 'codex')?.signIn, false, 'a sign-in of the other CLI is not this leg\'s');

  cards = stepCards(cards, 'codex', { kind: 'signIn', at: 3000 });
  cards = stepCards(cards, 'codex', { kind: 'probed', probe: CODEX_IN, at: 5000 });
  assert.deepEqual(cards.codex, { kind: 'testing', bin: CODEX_IN.bin, version: '0.164.0', plan: 'ChatGPT' }, 'Codex makes its test call too');
  cards = stepCards(cards, 'codex', { kind: 'tested', result: { ok: true, ms: 2100 } });
  assert.equal(cards.codex?.kind, 'ready');
  assert.equal(cards.claude?.kind, 'missing');
});

test('first run, one already signed in: the conversation starts from it and skips the install', () => {
  const cards = looked(NONE, CODEX_IN);
  assert.equal(alreadyHere(cards), 'codex', 'Codex signed in, Claude Code missing');
  assert.deepEqual(legOf([], alreadyHere(cards)), { cli: 'codex', by: 'already', at: -1, signIn: false });
  assert.equal(cards.codex?.kind, 'testing', 'signed in: the test call, no install, no sign-in');
  assert.equal(alreadyHere(looked(IN, CODEX_NONE)), 'claude');
  assert.equal(alreadyHere(looked(NONE, CODEX_OUT)), 'codex', 'installed, not signed in: starts from the sign-in');
});

test('first run, both installed: the one signed in first, else Claude Code; the other is offered quietly', () => {
  assert.equal(alreadyHere(looked(OUT, CODEX_OUT)), 'claude', 'both signed out: the first of the first run');
  assert.equal(alreadyHere(looked(OUT, CODEX_IN)), 'codex', 'Codex signed in wins over Claude Code signed out');
  assert.equal(alreadyHere(looked(IN, CODEX_IN)), 'claude', 'both signed in: Claude Code');
  const both = looked(OUT, CODEX_OUT);
  assert.equal(legOf([{ kind: 'switch', cli: 'codex' }], alreadyHere(both))?.cli, 'codex', '«Doch lieber Codex»');
  const silent = looked({ found: 'silent', bin: '/u/claude' }, CODEX_NONE);
  assert.equal(alreadyHere(silent), undefined, 'a program that does not answer is not «schon da»');
});

test('codex login status: whether, and ChatGPT or an API key; the key\'s digits are dropped', () => {
  assert.deepEqual(parseCodexStatus('Logged in using ChatGPT\n', 0), { loggedIn: true, method: 'chatgpt', plan: 'ChatGPT' });
  assert.deepEqual(parseCodexStatus('Logged in using an API key - sk-proj-***ABCD\n', 0), { loggedIn: true, method: 'api-key' });
  assert.deepEqual(parseCodexStatus('Not logged in\n', 1), { loggedIn: false });
});

test('claude auth status: only whether, the method and the plan are kept', () => {
  const full = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'anna@example.test', orgId: 'o1', orgName: 'Anna GmbH', subscriptionType: 'max' });
  assert.deepEqual(parseClaudeStatus(full, 0), { loggedIn: true, method: 'claude.ai', plan: 'max' });
  assert.deepEqual(parseClaudeStatus(JSON.stringify({ loggedIn: false, email: 'x' }), 1), { loggedIn: false });
  assert.deepEqual(parseClaudeStatus('not json', 0), { loggedIn: true }, 'no JSON: the exit code');
});

/** Runs a .command script as Terminal would, with `input` typed; resolves with what it printed. */
function runScript(file: string, input: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile('/bin/sh', [file], { env, timeout: 10_000 }, (err, stdout) => (stdout || !err ? done(stdout) : fail(err)));
    child.stdin!.end(input);
  });
}

test('the installer\'s screen: a title, three steps, the vendor\'s command shown; nothing runs before Enter, then the install, then the sign-in on a second Enter', async () => {
  const fake = temp('ai-fake-');
  const home = temp('ai-home-');
  const mark = join(temp('ai-mark-'), 'ran');
  const out = join(temp('ai-out-'), 'run');
  // A stand-in for curl whose script, piped into bash as the vendor's command does, «installs» the CLI into ~/.local/bin.
  script(fake, 'curl', `echo "mkdir -p \\$HOME/.local/bin; cp ${join(REPO, 'tests/support/terminal-bin/claude')} \\$HOME/.local/bin/claude; echo installed > ${mark}"`);
  const texts = scriptTexts('de', 'claude');
  const env = { PATH: `${fake}:/usr/bin:/bin`, HOME: home, TERMINAL_STUB_OUT: out, NO_COLOR: '1' };
  const run = async (input: string, extra: NodeJS.ProcessEnv = {}) => {
    const dir = temp('ai-script-');
    writeFileSync(join(dir, 'i.command'), installScript('claude', dir, texts));
    const said = await runScript(join(dir, 'i.command'), input, { ...env, ...extra });
    assert.equal(existsSync(dir), false, 'the script removes its folder');
    return said;
  };

  const unrun = await run('');
  assert.ok(unrun.includes('\x1b]0;Vanilla Accounting · Claude Code einrichten\x07'), 'the window\'s title');
  for (const line of ['Vanilla Accounting · Claude Code einrichten', '1. Drück die Eingabetaste (⏎ Enter), um Claude Code zu installieren.', '2. ', '3. ', 'Was ausgeführt wird:', 'curl -fsSL https://claude.ai/install.sh | bash', '➜ Eingabetaste drücken zum Starten']) {
    assert.ok(unrun.includes(line), line);
  }
  assert.equal(/\x1b\[/.test(unrun), false, 'NO_COLOR: no colours');
  assert.equal(existsSync(mark), false, 'no Enter: nothing ran');

  const installed = await run('\n');
  assert.equal(existsSync(mark), true, 'Enter: the vendor\'s command ran');
  assert.ok(installed.includes('Wird installiert … das dauert etwa eine Minute.'));
  assert.ok(installed.includes('✓ Claude Code ist installiert.'));
  assert.ok(installed.includes('Jetzt anmelden: Eingabetaste drücken'));
  assert.equal(existsSync(`${out}.arg`), false, 'no second Enter: no sign-in');

  const signedIn = await run('\n\n', { NO_COLOR: '' });
  assert.equal(readFileSync(`${out}.arg`, 'utf8'), 'auth', 'the second Enter starts the CLI\'s own login, found in ~/.local/bin');
  assert.ok(signedIn.includes('✓ Fertig. Du kannst dieses Fenster schliessen.'));
  assert.ok(/\x1b\[1m/.test(signedIn), 'colours where Terminal has them');

  script(fake, 'curl', 'echo "echo curl: \\(6\\) Could not resolve host: claude.ai >&2; exit 6"');
  const failed = await run('\n');
  assert.ok(failed.includes('✗ Die Installation hat nicht geklappt.'));
  assert.ok(failed.includes('Could not resolve host'), 'the reason, as the installer said it');
  assert.ok(failed.includes('Zurück in der App kannst du es nochmals versuchen.'));
});

test('the Codex installer\'s screen, in the person\'s language: OpenAI\'s command piped into sh, then `codex login` from ~/.local/bin', async () => {
  const fake = temp('ai-fake-');
  const home = temp('ai-home-');
  const out = join(temp('ai-out-'), 'run');
  script(fake, 'curl', `echo "mkdir -p \\$HOME/.local/bin; cp ${join(REPO, 'tests/support/terminal-bin/codex')} \\$HOME/.local/bin/codex"`);
  const dir = temp('ai-script-');
  writeFileSync(join(dir, 'i.command'), installScript('codex', dir, scriptTexts('fr', 'codex')));
  const said = await runScript(join(dir, 'i.command'), '\n\n', { PATH: `${fake}:/usr/bin:/bin`, HOME: home, TERMINAL_STUB_OUT: out, NO_COLOR: '1' });
  for (const line of ['Vanilla Accounting · Installer Codex', '1. Appuie sur la touche Entrée (⏎) pour installer Codex.', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', '✓ Codex est installé.', '✓ Terminé.']) {
    assert.ok(said.includes(line), line);
  }
  assert.equal(existsSync(join(home, '.local', 'bin', 'codex')), true, 'installed where OpenAI\'s installer writes');
  assert.equal(readFileSync(`${out}.arg`, 'utf8'), 'login', 'the second Enter runs `codex login`');
});

test('the sign-in screen runs the CLI\'s own login; the words are printed as words', async () => {
  const out = join(temp('ai-out-'), 'run');
  const dir = temp('ai-script-');
  const texts = { ...scriptTexts('de', 'claude'), title: `Melde dich an: 'x' $(touch pwned)` };
  writeFileSync(join(dir, 'l.command'), loginScript('claude', join(REPO, 'tests/support/terminal-bin/claude'), dir, texts));
  const said = await runScript(join(dir, 'l.command'), '', { PATH: '/usr/bin:/bin', TERMINAL_STUB_OUT: out, NO_COLOR: '1' });
  assert.equal(readFileSync(`${out}.argc`, 'utf8'), '2');
  assert.equal(readFileSync(`${out}.arg`, 'utf8'), 'auth');
  assert.ok(said.includes(`Melde dich an: 'x' $(touch pwned)`));
  assert.ok(said.includes('✓ Fertig.'));
  assert.equal(existsSync(join(dir, 'pwned')) || existsSync('pwned'), false);
});

test('no code path opens a CLI\'s login: no credential file, no Keychain entry of the CLIs', () => {
  const files = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((f) => /\.(ts|tsx|mjs|swift)$/.test(f));
  const found = files.flatMap((f) => {
    const text = readFileSync(join('src', f), 'utf8');
    return [/\.credentials\.json/, /\.codex\/auth/, /Claude Code-credentials/, /homedir\(\),\s*['"`]\.(claude|codex)['"`]/, /['"`]~?\/?\.(claude|codex)\//]
      .filter((re) => re.test(text)).map((re) => `${f} ${re}`);
  });
  // The app's CODEX_HOME links the person's ~/.codex/auth.json and never opens it (#181).
  const linksOnly = 'llm/providers/codex-home.ts /homedir\\(\\),\\s*[\'"`]\\.(claude|codex)[\'"`]/';
  assert.deepEqual(found.filter((f) => f !== linksOnly), []);
});

// #175: a Mac with only an API key, through the desktop server as the app runs it.
let stub: ProviderStub;
let dir: string;
let base: string;
let close: () => void;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

before(async () => {
  stub = await providerStub();
  dir = temp('ai-175-');
  process.env.VANILLA_WORKSPACE = join(dir, 'ws');
  cpSync(DEMO_ROOT, process.env.VANILLA_WORKSPACE, { recursive: true });
  process.env.VANILLA_SECRETS_FILE = join(dir, 'secrets.json');
  process.env.VANILLA_AI_SETTINGS = join(dir, 'ai.json');
  process.env.VANILLA_ANTHROPIC_URL = stub.url;
  process.env.VANILLA_OPENAI_URL = stub.url;
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html>');
  const server = desktopServer({ stateFile: join(dir, 'desktop.json'), demoRoot: join(dir, 'Demo'), booksHome: dir, dist: join(dir, 'dist') });
  const s = await listen(server.app, '127.0.0.1', undefined);
  base = `http://127.0.0.1:${portOf(s)}`;
  close = () => s.close();
});
after(() => { stub.stop(); close(); });
beforeEach(() => {
  process.env.CLAUDE_BIN = join(dir, 'no-such-claude');
  writeFileSync(join(dir, 'secrets.json'), '{}');
  forgetKey('anthropic');
  forgetKey('openai');
  forgetCli();
});

test('#175: no CLI and no key: no AI, and GET /api/desktop/ai and the setup say the same', async () => {
  assert.equal(await modelReady(), false);
  assert.equal((await call('GET', '/api/desktop/ai')).json.available, false);
  const view = (await call('GET', '/api/ai/setup')).json;
  assert.equal(view.available, false);
  assert.deepEqual(view.keys, [{ id: 'anthropic', set: false }, { id: 'openai', set: false }]);
});

test('#175: a key refused by the provider is not kept; a key accepted is kept, tested once, and then serves every step but the KI column', async () => {
  stub.reply.set('GET /v1/models', { status: 401, body: { error: { message: 'invalid x-api-key' } } });
  const refused = await call('PUT', '/api/ai/setup/keys/anthropic', { key: 'sk-ant-obviously-invalid' });
  assert.deepEqual([refused.status, refused.json.code], [400, 'aiKeyRefused']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')), {}, 'nothing kept');
  stub.reply.clear();

  const kept = await call('PUT', '/api/ai/setup/keys/anthropic', { key: 'test-key-anthropic-0001' });
  assert.equal(kept.status, 200);
  assert.equal(kept.json.test.ok, true, 'one test call answered');
  assert.equal(stub.seen.filter((s) => s.path === '/v1/messages').at(-1)!.body.model, 'claude-haiku-5-5', 'with the cheapest model');
  assert.equal(kept.json.view.available, true);
  assert.equal((await call('GET', '/api/desktop/ai')).json.available, true, 'the start screen agrees with the steps');
  assert.equal((await resolveStep('classify')).provider.id, 'anthropic');
  assert.equal((await resolveStep('setup-conversation')).provider.id, 'anthropic', 'the setup conversation runs on the key');
  assert.equal((await resolveStep('sidebar')).provider.id, 'claude-cli', 'the KI column needs Claude Code');
});

test('the view names the CLI the KI column runs on, as the column\'s agent is chosen (#181): the column shows that one\'s card', async () => {
  const stubBin = join(REPO, 'tests/support/stub-bin');
  try {
    assert.equal((await call('GET', '/api/ai/setup')).json.sidebar, 'claude', 'nothing found: Claude Code, whose card says what to install');
    process.env.CODEX_BIN = join(stubBin, 'codex');
    assert.equal((await call('GET', '/api/ai/setup')).json.sidebar, 'codex', 'only Codex here');
    process.env.CLAUDE_BIN = join(stubBin, 'claude');
    assert.equal((await call('GET', '/api/ai/setup')).json.sidebar, 'claude', 'both, nothing chosen: Claude Code');
    writeCli({ cli: 'codex' });
    assert.equal((await call('GET', '/api/ai/setup')).json.sidebar, 'codex', 'both, Codex chosen');
  } finally {
    delete process.env.CODEX_BIN;
    writeCli({ cli: null });
  }
});

test('the test call runs through the CLI\'s own provider: Codex answers with its cheapest model', async () => {
  const args = join(temp('ai-codex-args-'), 'args');
  process.env.CODEX_BIN = join(REPO, 'tests/support/stub-bin/codex');
  process.env.CODEX_STUB_ARGS = args;
  try {
    const tested = await call('POST', '/api/ai/setup/codex/test');
    assert.equal(tested.status, 200);
    assert.equal(tested.json.ok, true, JSON.stringify(tested.json));
    const run = JSON.parse(readFileSync(args, 'utf8').trim().split('\n').at(-1)!);
    assert.equal(run.args[run.args.indexOf('--model') + 1], 'gpt-6-luna');
    assert.equal((await call('POST', '/api/ai/setup/gemini/test')).status, 404);
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.CODEX_STUB_ARGS;
  }
});

test('«Ohne KI weitermachen» is kept on this Mac, and taken back', async () => {
  assert.equal((await call('PUT', '/api/ai/setup/choice', { noAi: true })).json.noAi, true);
  assert.equal((await call('GET', '/api/ai/setup')).json.noAi, true, 'the next start does not ask again');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'ai.json'), 'utf8')), { steps: {}, noAi: true });
  const back = (await call('PUT', '/api/ai/setup/choice', { noAi: false, askOther: true })).json;
  assert.deepEqual([back.noAi, back.askOther], [false, true]);
  assert.equal((await call('PUT', '/api/ai/setup/choice', { noAi: 'yes' })).status, 400);
});
