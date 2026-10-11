/**
 * The one way the app calls a model through the `claude` CLI (subscription).
 *
 * A plain `claude -p` from the repo loads Claude Code's system prompt, tool
 * schemas, CLAUDE.md, AGENTS.md, auto-memory, hooks and skills: ~36,000 tokens
 * before the prompt (measured 2026-10-07). This caller runs from an empty
 * directory with its own short system prompt, no tools unless a step needs to
 * read a file, no MCP servers, no settings and no session: ~630 tokens.
 * `--bare` would also do it, but it requires an API key, and the app runs on
 * the subscription. See docs/adr/0002-counterparty-knowledge-and-lean-calls.md.
 *
 * Every call appends its real usage to data/llm-ledger.jsonl, tagged with the
 * step it served, so `npm run llm-usage` reports measured cost, not estimates.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openWorkspace } from '../workspace/workspace.js';

export type Model = 'haiku' | 'sonnet' | 'opus';

export interface AskOptions {
  /** Which process step this call serves, e.g. "booking.guide.yaml#classify". Tags the ledger. */
  step: string;
  model?: Model;
  /** Replaces the default system prompt. */
  system?: string;
  /** Directories the Read tool may open. Absent: the model gets no tools at all. */
  read?: string[];
  timeoutMs?: number;
}

export interface LedgerRow {
  at: string;
  step: string;
  model: Model;
  ok: boolean;
  ms: number;
  input: number;
  cacheCreate: number;
  cacheRead: number;
  output: number;
  turns: number;
}

const DEFAULT_SYSTEM =
  'You are a careful assistant for a Swiss GmbH\'s bookkeeping. Follow the instructions in the message exactly and answer only in the format they ask for.';

/** Every model call's cost, appended to the workspace's data/ (gitignored). */
export const ledgerPath = (): string => join(openWorkspace().paths.data, 'llm-ledger.jsonl');

let emptyCwd: string | undefined;
function cwd(): string {
  // An empty directory: no CLAUDE.md, no project settings, nothing to discover.
  emptyCwd ??= mkdtempSync(join(tmpdir(), 'belege-llm-'));
  return emptyCwd;
}

function args(opts: AskOptions): string[] {
  const a = [
    '-p',
    '--model', opts.model ?? 'sonnet',
    '--output-format', 'json',
    '--system-prompt', opts.system ?? DEFAULT_SYSTEM,
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--no-session-persistence',
  ];
  if (opts.read?.length) a.push('--tools', 'Read', '--permission-mode', 'dontAsk', '--add-dir', ...opts.read);
  else a.push('--tools', '');
  return a;
}

function record(row: LedgerRow): void {
  try {
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + '\n');
  } catch {
    // The ledger is a measurement aid; a failed write must not fail the call.
  }
}

/**
 * Ask the model. The prompt goes on stdin (no argument-length limit). Resolves
 * with the model's text answer. Rejects with an error whose message carries the
 * CLI's own output, so isRateLimitSignal() in adaptive-pool still sees it.
 */
export function ask(prompt: string, opts: AskOptions): Promise<string> {
  const model = opts.model ?? 'sonnet';
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args(opts), { cwd: cwd() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${opts.timeoutMs ?? 360_000} ms`));
    }, opts.timeoutMs ?? 360_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed: {
        result?: string; is_error?: boolean; num_turns?: number;
        usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
      } | undefined;
      try { parsed = JSON.parse(out); } catch { /* not JSON: the CLI failed before answering */ }
      const u = parsed?.usage ?? {};
      const ok = code === 0 && !!parsed && !parsed.is_error;
      record({
        at: new Date().toISOString(), step: opts.step, model, ok, ms: Date.now() - started,
        input: u.input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, turns: parsed?.num_turns ?? 0,
      });
      if (ok) resolve((parsed!.result ?? '').trim());
      else reject(new Error(`claude exited ${code}: ${(parsed?.result ?? (err || out)).slice(0, 300)}`));
    });
    child.stdin.on('error', reject);
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Whether a working `claude` CLI answers here: found on PATH and exits 0 for `--version`. Steps
 * that need the model skip their model part without it and say so, instead of failing each call.
 */
export function modelReady(timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('claude', ['--version'], { cwd: cwd(), stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
