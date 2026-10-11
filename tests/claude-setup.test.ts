/**
 * "Claude einrichten" (src/desktop/claude-setup.ts, src/desktop/claude.ts, src/llm/ask.ts
 * claudeStatus): the scripts the app opens in a visible window, run here against a fake installer
 * and a fake `claude`; the state Firma › Claude shows; the CLI found again without a restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchSetup, openCommand, setupScript, type SetupTexts } from '../src/desktop/claude-setup.js';
import { resolveClaude } from '../src/desktop/claude.js';
import { claudeStatus } from '../src/llm/ask.js';
import { APP_ROOT } from '../src/workspace/workspace.js';

const DE: SetupTexts = {
  title: 'Claude einrichten', install: 'Installieren.', signIn: 'Anmelden.', back: 'Zurück zur App.',
  failed: 'Hat nicht geklappt.', done: 'Fertig.', notSignedIn: 'Nicht angemeldet.',
};
const FR: SetupTexts = { ...DE, title: 'Configurer Claude', done: 'Terminé, c’est l’app qu\'il faut rouvrir.' };

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
function program(path: string, text: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}

/** A `claude` that logs its arguments; signed in once `auth login` ran. */
const fakeClaude = (log: string) => `#!/bin/sh
echo "$*" >> ${log}
case "$*" in
  "auth status"*) [ -f ${log}.in ] && exit 0; exit 1 ;;
  "auth login") touch ${log}.in ;;
esac
`;

/** The .command as Terminal runs it, with only /usr/bin:/bin and `extra` on the PATH. */
function runMac(text: string, home: string, extra: string) {
  const file = program(join(home, 'setup.command'), text);
  return spawnSync('/bin/bash', [file], { env: { HOME: home, PATH: `${extra}:/usr/bin:/bin`, TERM: 'dumb' }, encoding: 'utf8' });
}

test('Mac: no claude yet: the official installer runs, then the sign-in, then the way back; every text shows', () => {
  const home = tmp('setup-home-');
  const log = join(home, 'claude.log');
  const bin = tmp('setup-bin-');
  // curl hands out an "installer" that puts claude into ~/.local/bin, as the real one does.
  program(join(bin, 'curl'), `#!/bin/sh
echo "$*" > ${home}/curl.args
cat <<'EOF'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/claude" <<'C'
${fakeClaude(log)}C
chmod +x "$HOME/.local/bin/claude"
EOF
`);
  const { text, file } = setupScript('darwin', [DE, FR]);
  assert.equal(file, 'claude-einrichten.command');
  const r = runMac(text, home, bin);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(home, 'curl.args'), 'utf8').trim(), '-fsSL https://claude.ai/install.sh');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['auth status', 'auth login', 'auth status'], 'signs in with the claude it just installed, then checks it worked');
  for (const line of ['Claude einrichten', '1. Installieren.', '2. Anmelden.', '3. Zurück zur App.', 'Configurer Claude']) assert.ok(r.stdout.includes(line), line);
  assert.ok(r.stdout.trimEnd().endsWith('Fertig. / Terminé, c’est l’app qu\'il faut rouvrir.'), r.stdout);
  assert.equal(readFileSync(join(home, '.zprofile'), 'utf8'), '\nexport PATH="$HOME/.local/bin:$PATH"\n', 'a new Terminal window finds claude');
});

test('Mac: run twice, the PATH line is added once; a sign-in that did not complete never says done', () => {
  const home = tmp('setup-home-');
  const log = join(home, 'claude.log');
  program(join(home, '.local/bin/claude'), `#!/bin/sh\necho "$*" >> ${log}\n[ "$1 $2" = "auth status" ] && exit 1\nexit 0\n`);
  writeFileSync(join(home, '.zprofile'), 'export EDITOR=vi\n');
  const text = setupScript('darwin', [DE]).text;
  for (let i = 0; i < 2; i++) {
    const r = runMac(text, home, tmp('setup-bin-'));
    assert.equal(r.status, 1);
    assert.ok(r.stdout.trimEnd().endsWith('Nicht angemeldet.'), r.stdout);
    assert.ok(!r.stdout.includes('Fertig.'), r.stdout);
  }
  assert.equal(readFileSync(join(home, '.zprofile'), 'utf8'), 'export EDITOR=vi\n\nexport PATH="$HOME/.local/bin:$PATH"\n', 'kept what was there, added the line once');
});

test('Mac: claude installed and signed in: nothing is installed and nobody is asked to sign in again', () => {
  const home = tmp('setup-home-');
  const log = join(home, 'claude.log');
  writeFileSync(`${log}.in`, '');
  program(join(home, '.local/bin/claude'), fakeClaude(log));
  const bin = tmp('setup-bin-');
  program(join(bin, 'curl'), `#!/bin/sh\ntouch ${home}/curl.ran\n`);
  const r = runMac(setupScript('darwin', [DE]).text, home, bin);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(home, 'curl.ran')), false);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['auth status', 'auth status']);
});

test('Mac: the installer fails: the script says so and stops before any sign-in', () => {
  const home = tmp('setup-home-');
  const bin = tmp('setup-bin-');
  program(join(bin, 'curl'), '#!/bin/sh\necho "curl: (6) Could not resolve host" >&2\nexit 6\n');
  const r = runMac(setupScript('darwin', [DE]).text, home, bin);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.trimEnd().endsWith('Hat nicht geklappt.'), r.stdout);
});

test('Windows: the PowerShell script runs the official installer and the sign-in; quotes in a text stay text', () => {
  const { text, file } = setupScript('win32', [FR, DE]);
  assert.equal(file, 'claude-einrichten.ps1');
  assert.ok(text.startsWith('\ufeff'), 'a BOM, so Windows PowerShell 5 reads it as UTF-8');
  const lines = text.slice(1).split('\r\n');
  assert.ok(!text.slice(1).replace(/\r\n/g, '').includes('\n'), 'CRLF only');
  assert.deepEqual(lines.filter((l) => !l.startsWith('Write-Host')), [
    '$env:Path = "$env:USERPROFILE\\.local\\bin;$env:Path"',
    'if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { irm https://claude.ai/install.ps1 | iex }',
    "if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host 'Hat nicht geklappt. / Hat nicht geklappt.'; return }",
    'claude auth status *> $null',
    'if ($LASTEXITCODE -ne 0) { claude auth login }',
    'claude auth status *> $null',
    "if ($LASTEXITCODE -ne 0) { Write-Host 'Nicht angemeldet. / Nicht angemeldet.'; return }",
    '',
  ]);
  assert.ok(lines.includes("Write-Host '3. Zurück zur App.'"));
  // PowerShell ends a single-quoted string at ' and at the typographic ’ alike: both are doubled.
  assert.equal(lines.at(-2), "Write-Host 'Terminé, c’’est l’’app qu''il faut rouvrir. / Fertig.'");
  assert.deepEqual(openCommand('win32', 'C:\\x\\claude-einrichten.ps1'),
    ['powershell.exe', ['-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\x\\claude-einrichten.ps1']]);
  assert.deepEqual(openCommand('darwin', '/x/claude-einrichten.command'), ['open', ['/x/claude-einrichten.command']]);
});

test('the button: the script is written, executable, and handed to the opener', async () => {
  const dir = tmp('setup-data-');
  const record = join(dir, 'opened.txt');
  const opener = program(join(tmp('setup-open-'), 'open'), `#!/bin/sh\necho "$1" > ${record}\n`);
  process.env.VANILLA_OPEN_COMMAND = opener;
  try {
    const path = launchSetup('darwin', join(dir, 'userData'), [DE]);
    assert.equal(path, join(dir, 'userData', 'claude-einrichten.command'));
    assert.equal(readFileSync(path, 'utf8'), setupScript('darwin', [DE]).text);
    assert.equal(statSync(path).mode & 0o111, 0o111);
    for (let i = 0; i < 100 && !existsSync(record); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(readFileSync(record, 'utf8').trim(), path);
  } finally {
    delete process.env.VANILLA_OPEN_COMMAND;
  }
});

test('the state: not installed (and whether Claude Desktop is), signed out, ready; a CLI without auth status counts as ready', async () => {
  const before = process.env.CLAUDE_BIN;
  const dir = tmp('status-');
  const stub = join(dir, 'claude');
  copyFileSync(join(APP_ROOT, 'tests/support/stub-bin/claude'), stub);
  symlinkSync(process.execPath, join(dir, 'node'));
  const desktopApp = join(dir, 'Claude.app');
  try {
    process.env.CLAUDE_BIN = join(dir, 'none');
    assert.deepEqual(await claudeStatus([desktopApp]), { state: 'missing', desktopApp: false });
    mkdirSync(desktopApp);
    assert.deepEqual(await claudeStatus([desktopApp]), { state: 'missing', desktopApp: true });
    process.env.CLAUDE_BIN = stub;
    assert.deepEqual(await claudeStatus(), { state: 'ready', version: '0.0.0' });
    process.env.CLAUDE_STUB_SIGNED_OUT = '1';
    assert.deepEqual(await claudeStatus(), { state: 'signedOut', version: '0.0.0' });
    process.env.CLAUDE_BIN = program(join(dir, 'old', 'claude'), '#!/bin/sh\n[ "$1" = --version ] && { echo "1.0.3 (Claude Code)"; exit 0; }\necho "error: unknown command auth" >&2\nexit 1\n');
    assert.deepEqual(await claudeStatus(), { state: 'ready', version: '1.0.3' });
  } finally {
    delete process.env.CLAUDE_STUB_SIGNED_OUT;
    if (before === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = before;
  }
});

test('found again without a restart: a claude installed after the start is picked up, also only in ~/.local/bin', async () => {
  const before = { bin: process.env.CLAUDE_BIN, home: process.env.HOME, path: process.env.PATH };
  const home = tmp('resolve-home-');
  const loginBin = tmp('resolve-login-');
  // A login shell whose PATH is /usr/bin:/bin and loginBin, whatever this machine's profile says.
  const shell = program(join(tmp('resolve-shell-'), 'sh'), `#!/bin/sh\nPATH=${loginBin}:/usr/bin:/bin exec /bin/sh -c "$2"\n`);
  process.env.HOME = home;
  // As the app runs from the Finder: no claude on its own PATH.
  process.env.PATH = '/usr/bin:/bin';
  try {
    assert.equal(await resolveClaude(shell), undefined);
    assert.equal(process.env.CLAUDE_BIN, undefined);
    assert.equal((await claudeStatus([])).state, 'missing');

    const installed = join(home, '.local/bin/claude');
    copyFileSync(join(APP_ROOT, 'tests/support/stub-bin/claude'), program(installed, ''));
    symlinkSync(process.execPath, join(home, '.local/bin/node'));
    assert.equal(await resolveClaude(shell), installed, 'the installer folder, though the login PATH does not name it yet');
    assert.deepEqual(await claudeStatus(), { state: 'ready', version: '0.0.0' });

    const onPath = join(loginBin, 'claude');
    copyFileSync(installed, onPath);
    assert.equal(await resolveClaude(shell), onPath, 'the login PATH comes first');
  } finally {
    process.env.HOME = before.home;
    process.env.PATH = before.path;
    if (before.bin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = before.bin;
  }
});
