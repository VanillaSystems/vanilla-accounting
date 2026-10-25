/**
 * The ChatGPT subscription (issue #121): the `codex` CLI the person installed and signed into with
 * «Sign in with ChatGPT». The app runs the program in its own CODEX_HOME (codex-home.ts), which is
 * signed in through a link to the person's sign-in and holds nothing else of theirs: no AGENTS.md,
 * config, rules or skills reach a prompt. The app never reads a token.
 *
 * A call only answers. `codex exec` runs from an empty directory with the step's own instructions
 * in place of Codex's (`model_instructions_file`), in the read-only sandbox, never asking for
 * approval, keeping no session, with every tool Codex can switch off switched off (`CLOSED`). Should
 * the model still start anything but an answer (a command, an edit, a search, a sub-agent), the
 * run is ended and fails (`runCodex`). Codex takes images (`--image`) but no PDF, so it serves no step that reads a receipt.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join } from 'node:path';
import { programOn } from '../../platform/login-path.js';
import { codexSignedIn } from '../../platform/terminal-open.js';
import { AiRefused, CallFailed, isPlanLimit, NO_USAGE, type Call, type Provider, type Usage } from '../provider.js';
import { codexHome } from './codex-home.js';

/**
 * The CLI: CODEX_BIN when set (the desktop app finds it through the login shell), else `codex` on
 * the PATH; its folder joins the PATH, so an npm-installed codex finds its node. A test run finds
 * only CODEX_BIN, never the developer's own codex, which would spend their subscription.
 */
export function codexCommand(): { bin: string; env: NodeJS.ProcessEnv } | undefined {
  const named = process.env.CODEX_BIN;
  const bin = named ? programOn(dirname(named), basename(named)) : process.env.NODE_TEST_CONTEXT ? undefined : programOn(process.env.PATH ?? '', 'codex');
  if (!bin) return undefined;
  return { bin, env: { ...process.env, PATH: [dirname(bin), process.env.PATH].filter(Boolean).join(delimiter) } };
}

/** The environment a run of the app's gets: the app's own CODEX_HOME. */
export const codexEnv = (command: { env: NodeJS.ProcessEnv }): NodeJS.ProcessEnv => ({ ...command.env, CODEX_HOME: codexHome() });

const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** Codex's tools that act or reach out, each off (codex-cli 0.163 feature names). */
const TOOLS_OFF = [
  'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'goals', 'view_image',
  'image_generation', 'browser_use', 'computer_use', 'hooks', 'tool_suggest', 'skill_search', 'sleep_tool',
];

/**
 * What closes every run of the app's, an answer or the KI column alike: no user config, rules,
 * project docs or skills, the read-only sandbox, no approval asked (so whatever needs one is
 * refused), no web, no history file. Plugins off also keeps Codex from cloning its plugin
 * marketplace with git, which on a Mac without the Command Line Tools asks to install them.
 */
export const CLOSED: readonly string[] = [
  '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only',
  '-c', 'approval_policy="never"',
  ...TOOLS_OFF.flatMap((f) => ['-c', `features.${f}=false`]),
  '-c', 'web_search="disabled"',
  '-c', 'project_doc_max_bytes=0',
  '-c', 'history.persistence="none"',
  '-c', 'skills.include_instructions=false',
  '-c', 'skills.bundled.enabled=false',
  '-c', 'include_collaboration_mode_instructions=false',
];

let emptyCwd: string | undefined;
const cwd = (): string => (emptyCwd ??= mkdtempSync(join(tmpdir(), 'vanilla-codex-')));

export function codexArgs(call: Pick<Call, 'model'>, instructionsFile: string, images: readonly string[]): string[] {
  return [
    'exec', '--json', '--ephemeral', ...CLOSED, '--cd', cwd(), '--model', call.model,
    '-c', `model_instructions_file=${JSON.stringify(instructionsFile)}`,
    ...images.flatMap((p) => ['--image', p]),
  ];
}

/** One JSONL event of `codex exec --json`. */
export interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: { id?: string; type?: string; text?: string; server?: string; tool?: string; arguments?: unknown; status?: string; error?: { message?: string } | null; result?: unknown };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

/** What a run of the app's may show: an answer, its reasoning, its plan, a notice. Anything else is an act. */
const ANSWERS = new Set(['agent_message', 'reasoning', 'todo_list', 'error']);

export interface CodexRun {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Besides an answer, what an item may be: the KI column's calls of the app's own tools. */
  allowed?: (item: NonNullable<CodexEvent['item']>) => boolean;
  onEvent(e: CodexEvent): void;
}

export interface CodexExit {
  code: number | null;
  /** The item that broke the rules; the run was killed for it. */
  acted?: string;
  timedOut?: boolean;
  stderr: string;
}

/** Runs codex, hands each JSONL event to `onEvent`, and kills the run at the first item that is neither an answer nor `allowed`. */
export function runCodex(run: CodexRun): Promise<CodexExit> {
  return new Promise((done, fail) => {
    const child = spawn(run.bin, run.args, { cwd: run.cwd, env: run.env });
    const exit: CodexExit = { code: null, stderr: '' };
    let pending = '';
    const timer = setTimeout(() => { exit.timedOut = true; child.kill('SIGKILL'); }, run.timeoutMs);
    const abort = () => child.kill('SIGTERM');
    run.signal?.addEventListener('abort', abort, { once: true });
    const read = (line: string) => {
      if (exit.acted || !line.trim()) return;
      let e: CodexEvent;
      try { e = JSON.parse(line) as CodexEvent; } catch { return; }
      const item = e.item;
      if (item?.type && !ANSWERS.has(item.type) && !run.allowed?.(item)) {
        exit.acted = item.type === 'mcp_tool_call' ? `${item.type} ${item.server ?? ''}.${item.tool ?? ''}` : item.type;
        child.kill('SIGKILL');
        return;
      }
      run.onEvent(e);
    };
    child.stdout.on('data', (d) => {
      const lines = (pending + d).split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(read);
    });
    child.stderr.on('data', (d) => (exit.stderr += d));
    child.on('error', (e) => { clearTimeout(timer); run.signal?.removeEventListener('abort', abort); fail(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', abort);
      read(pending);
      exit.code = code;
      done(exit);
    });
    child.stdin.on('error', () => { /* 'error' or 'close' settles the run, with the reason */ });
    child.stdin.end(run.prompt);
  });
}

export const usageOf = (u: NonNullable<CodexEvent['usage']>): Usage => {
  const cached = u.cached_input_tokens ?? 0;
  return { input: (u.input_tokens ?? 0) - cached, cacheCreate: 0, cacheRead: cached, output: u.output_tokens ?? 0, turns: 1 };
};

export const refusalOf = (said: string, message: string, usage: Usage): CallFailed =>
  isPlanLimit(said) ? new AiRefused({ reason: 'limit', cli: 'codex', said }, message, usage)
  : /not logged in|not signed in|please (log|sign) ?in|codex login|unauthori[sz]ed|\b401\b/i.test(said) ? new AiRefused({ reason: 'signedOut', cli: 'codex' }, message, usage)
  : new CallFailed(message, usage);

export const missing = (): AiRefused => new AiRefused({ reason: 'missing', cli: 'codex' }, 'Codex ist auf diesem Mac nicht installiert.');

export const codexCli: Provider = {
  id: 'codex-cli',
  billing: 'subscription',
  models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].map((id) => ({ id, can: ['text', 'json', 'typed', 'image'] as const })),
  defaults: { fast: 'gpt-6-luna', standard: 'gpt-6.1-sol', strong: 'gpt-6-astra' },

  /** The prompt goes on stdin; the answer is the last agent message of the JSONL events, the usage that of the finished turn. */
  async ask(call) {
    const command = codexCommand();
    if (!command) throw missing();
    const unread = call.attachments.find((p) => !IMAGES.has(extname(p).toLowerCase()));
    if (unread) throw new CallFailed(`Codex liest keine ${extname(unread) || 'Datei'}, nur Bilder: ${basename(unread)}`, NO_USAGE);
    const dir = mkdtempSync(join(tmpdir(), 'vanilla-codex-call-'));
    const instructions = join(dir, 'instructions.md');
    writeFileSync(instructions, call.system, { mode: 0o600 });
    let usage: Usage = NO_USAGE;
    let answer: string | undefined;
    // A turn that failed says why; an `error` event alone may be a notice the run recovers from («Reconnecting…»).
    let failed: string | undefined;
    let notice: string | undefined;
    try {
      const exit = await runCodex({
        bin: command.bin, args: codexArgs(call, instructions, call.attachments), env: codexEnv(command), cwd: cwd(),
        prompt: call.prompt, timeoutMs: call.timeoutMs,
        onEvent(e) {
          if (e.type === 'item.completed' && e.item?.type === 'agent_message') answer = e.item.text ?? '';
          else if (e.type === 'turn.completed') usage = usageOf(e.usage ?? {});
          else if (e.type === 'turn.failed') failed = e.error?.message ?? 'turn failed';
          else if (e.type === 'error') notice = e.message ?? notice;
        },
      }).catch((e: NodeJS.ErrnoException) => { throw e.code === 'ENOENT' ? missing() : e; });
      if (exit.acted) throw new CallFailed(`codex wanted to act (${exit.acted}); the app's steps only answer`, usage);
      if (exit.timedOut) throw new CallFailed(`codex timed out after ${call.timeoutMs} ms`, usage);
      if (exit.code === 0 && answer !== undefined && !failed) return { text: answer.trim(), usage };
      const said = (failed ?? notice ?? (exit.stderr.trim() || 'no answer')).slice(0, 300);
      throw refusalOf(said, `codex exited ${exit.code}: ${said}`, usage);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  /** Codex answers here: installed, and `codex login status` says signed in. */
  async ready(timeoutMs) {
    return (await codexStatus(timeoutMs)) === true;
  },
};

/** `codex login status` in the app's CODEX_HOME: true signed in, false signed out, undefined not installed or no answer. */
export function codexStatus(timeoutMs = 15_000): Promise<boolean | undefined> {
  const command = codexCommand();
  return command ? codexSignedIn(command.bin, codexEnv(command), timeoutMs) : Promise.resolve(undefined);
}
