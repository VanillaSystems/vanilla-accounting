/**
 * "Claude einrichten": a script in a visible terminal window that runs the official installer and
 * then `claude auth login`. The person reads every step and signs in themselves; the app neither
 * installs anything out of sight nor touches the login. Nothing here needs Electron.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupPlatform } from '../types/claude.js';

/** The script's words, in one language. */
export interface SetupTexts {
  title: string;
  install: string;
  signIn: string;
  back: string;
  failed: string;
  done: string;
  notSignedIn: string;
}

/** The script for `platform`, its header in each of `texts` (the app's language, then English). */
export function setupScript(platform: SetupPlatform, texts: SetupTexts[]): { file: string; text: string } {
  const header = texts.flatMap((x) => [x.title, '', `1. ${x.install}`, `2. ${x.signIn}`, `3. ${x.back}`, '']);
  const say = (pick: (x: SetupTexts) => string) => texts.map(pick).join(' / ');
  if (platform === 'win32') {
    const q = (s: string) => `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
    return {
      file: 'claude-einrichten.ps1',
      // A BOM, or Windows PowerShell 5 reads the umlauts as ANSI.
      text: '\ufeff' + [
        ...header.map((l) => `Write-Host ${q(l)}`),
        `$env:Path = "$env:USERPROFILE\\.local\\bin;$env:Path"`,
        `if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { irm https://claude.ai/install.ps1 | iex }`,
        `if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host ${q(say((x) => x.failed))}; return }`,
        `claude auth status *> $null`,
        `if ($LASTEXITCODE -ne 0) { claude auth login }`,
        `Write-Host ''`,
        `claude auth status *> $null`,
        `if ($LASTEXITCODE -ne 0) { Write-Host ${q(say((x) => x.notSignedIn))}; return }`,
        `Write-Host ${q(say((x) => x.done))}`,
        '',
      ].join('\r\n'),
    };
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return {
    file: 'claude-einrichten.command',
    text: [
      '#!/bin/bash',
      'set -o pipefail',
      'clear',
      "cat <<'VANILLA'",
      ...header,
      'VANILLA',
      'export PATH="$HOME/.local/bin:$PATH"',
      `command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash || { printf '%s\\n' ${q(say((x) => x.failed))}; exit 1; }`,
      // The installer leaves ~/.local/bin off the PATH of new Terminal windows; add it once.
      'grep -qs \'.local/bin\' "$HOME/.zprofile" || printf \'\\nexport PATH="$HOME/.local/bin:$PATH"\\n\' >> "$HOME/.zprofile"',
      'claude auth status >/dev/null 2>&1 || claude auth login',
      'echo',
      `claude auth status >/dev/null 2>&1 || { printf '%s\\n' ${q(say((x) => x.notSignedIn))}; exit 1; }`,
      `printf '%s\\n' ${q(say((x) => x.done))}`,
      '',
    ].join('\n'),
  };
}

/** The program and arguments that show `file` in a window the person sees. */
export function openCommand(platform: SetupPlatform, file: string): [string, string[]] {
  return platform === 'win32'
    ? ['powershell.exe', ['-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file]]
    // `open` hands a .command file to Terminal: no AppleScript, no automation permission.
    : ['open', [file]];
}

/**
 * Writes the script into `dir` and opens it. VANILLA_OPEN_COMMAND replaces the opener (for a test
 * run: a program that records the file instead of opening a window).
 */
export function launchSetup(platform: SetupPlatform, dir: string, texts: SetupTexts[]): string {
  const { file, text } = setupScript(platform, texts);
  const path = join(dir, file);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  const [cmd, args] = process.env.VANILLA_OPEN_COMMAND ? [process.env.VANILLA_OPEN_COMMAND, [path]] : openCommand(platform, path);
  // detached: on Windows the console window of its own; on the Mac `open` returns at once anyway.
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }).on('error', (e) => console.error('claude setup:', e)).unref();
  return path;
}
