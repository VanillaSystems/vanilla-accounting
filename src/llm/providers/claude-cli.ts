/**
 * The Claude subscription: the `claude` CLI the person installed and signed into.
 *
 * A plain `claude -p` from the repo loads Claude Code's system prompt, tool schemas, CLAUDE.md,
 * AGENTS.md, auto-memory, hooks and skills: ~36,000 tokens before the prompt (measured
 * 2026-10-07). This caller runs from an empty directory with its own short system prompt, no tools
 * unless a step reads a file, no MCP servers, no settings and no session: ~630 tokens. `--bare`
 * would also do it, but it requires an API key, and the app runs on the subscription. See
 * docs/adr/0002-counterparty-knowledge-and-lean-calls.md.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { AiRefused, CallFailed, isPlanLimit, NO_USAGE, type Call, type Provider } from '../provider.js';

/** No `claude` CLI to run: model features say what to install, everything else works without them. */
export class NoClaudeError extends Error {
  constructor() {
    super('Für Belege lesen und Buchungsvorschläge braucht die App Claude Code: von claude.com/claude-code installieren und einmal im Terminal mit "claude" anmelden.');
  }
}

/**
 * The CLI: CLAUDE_BIN when set (the desktop app finds it through the login shell, src/platform/login-path.ts),
 * else `claude` on the PATH. Its own folder joins the PATH, so an npm-installed claude finds its node.
 */
export function claudeCommand(): { bin: string; env: NodeJS.ProcessEnv } {
  const bin = process.env.CLAUDE_BIN;
  if (!bin) return { bin: 'claude', env: process.env };
  return { bin, env: { ...process.env, PATH: [dirname(bin), process.env.PATH].filter(Boolean).join(delimiter) } };
}

let emptyCwd: string | undefined;
function cwd(): string {
  // An empty directory: no CLAUDE.md, no project settings, nothing to discover.
  emptyCwd ??= mkdtempSync(join(tmpdir(), 'belege-llm-'));
  return emptyCwd;
}

function args(call: Call): string[] {
  const a = [
    '-p',
    '--model', call.model,
    '--output-format', 'json',
    '--system-prompt', call.system,
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--no-session-persistence',
  ];
  // The lean call runs from an empty directory: the Read tool may open the attachments' folders, nothing else.
  const dirs = [...new Set(call.attachments.map((p) => dirname(resolve(p))))];
  if (dirs.length) a.push('--tools', 'Read', '--permission-mode', 'dontAsk', '--add-dir', ...dirs);
  else a.push('--tools', '');
  return a;
}

const EVERY = ['text', 'json', 'typed', 'pdf', 'image', 'agent'] as const;

export const claudeCli: Provider = {
  id: 'claude-cli',
  billing: 'subscription',
  models: [{ id: 'haiku', can: EVERY }, { id: 'sonnet', can: EVERY }, { id: 'opus', can: EVERY }],
  defaults: { fast: 'haiku', standard: 'sonnet', strong: 'opus' },

  /**
   * The prompt goes on stdin (no argument-length limit). Rejects with an error whose message carries
   * the CLI's own output, so isRateLimitSignal() in adaptive-pool still sees it.
   */
  ask(call) {
    return new Promise((done, fail) => {
      const { bin, env } = claudeCommand();
      const child = spawn(bin, args(call), { cwd: cwd(), env });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        fail(new CallFailed(`claude timed out after ${call.timeoutMs} ms`, NO_USAGE));
      }, call.timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); fail(e.code === 'ENOENT' ? new NoClaudeError() : e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        let parsed: {
          result?: string; is_error?: boolean; num_turns?: number;
          usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
        } | undefined;
        try { parsed = JSON.parse(out); } catch { /* not JSON: the CLI failed before answering */ }
        const u = parsed?.usage ?? {};
        const usage = {
          input: u.input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, turns: parsed?.num_turns ?? 0,
        };
        if (code === 0 && parsed && !parsed.is_error) return done({ text: (parsed.result ?? '').trim(), usage });
        const said = (parsed?.result ?? (err || out)).slice(0, 300);
        const message = `claude exited ${code}: ${said}`;
        fail(isPlanLimit(said) ? new AiRefused({ reason: 'limit', cli: 'claude', said: said.trim() }, message, usage) : new CallFailed(message, usage));
      });
      child.stdin.on('error', () => { /* the child's 'error' or 'close' settles the call, with the reason */ });
      child.stdin.write(call.prompt);
      child.stdin.end();
    });
  },

  /** A working `claude` CLI answers here (CLAUDE_BIN, else on PATH) and exits 0 for `--version`. */
  ready(timeoutMs = 15_000) {
    return new Promise((done) => {
      const { bin, env } = claudeCommand();
      const child = spawn(bin, ['--version'], { cwd: cwd(), env, stdio: ['ignore', 'ignore', 'ignore'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(false); }, timeoutMs);
      child.on('error', () => { clearTimeout(timer); done(false); });
      child.on('close', (code) => { clearTimeout(timer); done(code === 0); });
    });
  },
};
