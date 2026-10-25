/**
 * The ChatGPT subscription (issue #121): the `codex` CLI the person installed and signed into with
 * «Sign in with ChatGPT». The app runs the program, which uses whatever account it is signed into;
 * it never opens ~/.codex or reads a token.
 *
 * A call only answers. `codex exec` runs from an empty directory with the step's own instructions
 * in place of Codex's (`model_instructions_file`), without the person's config, rules, AGENTS.md,
 * apps, web search or shell tool, in the read-only sandbox, never asking for approval, and keeps no
 * session, and without its plugins, whose marketplace it would otherwise clone with git. Should
 * the model still start a command, an edit, a tool or a search, the call is ended and fails. Codex takes images (`--image`) but no PDF, so it serves no step that reads a receipt.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join } from 'node:path';
import { programOn } from '../../platform/login-path.js';
import { knownPath, locate, probeCli } from '../../platform/ai-cli.js';
import { AiRefused, CallFailed, isPlanLimit, NO_USAGE, type Call, type Provider, type Usage } from '../provider.js';

/**
 * The CLI: CODEX_BIN when set, else as a look finds it now (src/platform/ai-cli.ts: the PATH, the
 * login shell's, ~/.local/bin); its folder joins the PATH, so an npm-installed codex finds its node.
 * A test run finds only CODEX_BIN, never the developer's own codex, which would spend their subscription.
 */
export function codexCommand(): { bin: string; env: NodeJS.ProcessEnv } | undefined {
  const named = process.env.CODEX_BIN;
  const bin = named ? programOn(dirname(named), basename(named)) : process.env.NODE_TEST_CONTEXT ? undefined : locate('codex', { path: knownPath() });
  if (!bin) return undefined;
  return { bin, env: { ...process.env, PATH: [dirname(bin), process.env.PATH].filter(Boolean).join(delimiter) } };
}

const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** What an answer may not do: run a command, change a file, call a tool, search the web. */
const ACTS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

let emptyCwd: string | undefined;
const cwd = (): string => (emptyCwd ??= mkdtempSync(join(tmpdir(), 'vanilla-codex-')));

export function codexArgs(call: Call, instructionsFile: string): string[] {
  return [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--sandbox', 'read-only', '--cd', cwd(), '--model', call.model,
    '-c', 'approval_policy="never"',
    '-c', 'features.shell_tool=false',
    '-c', 'features.apps=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.shell_snapshot=false',
    // Codex otherwise clones its plugin marketplace with git when it starts: on a Mac without the
    // Command Line Tools, /usr/bin/git asks the person to install them.
    '-c', 'features.plugins=false',
    '-c', 'features.remote_plugin=false',
    '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'history.persistence="none"',
    '-c', `model_instructions_file=${JSON.stringify(instructionsFile)}`,
    ...call.attachments.flatMap((p) => ['--image', p]),
  ];
}

interface Event {
  type?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

const refusalOf = (said: string, message: string, usage: Usage): CallFailed =>
  isPlanLimit(said) ? new AiRefused({ reason: 'limit', cli: 'codex', said }, message, usage)
  : /not logged in|not signed in|please (log|sign) ?in|codex login|unauthori[sz]ed|\b401\b/i.test(said) ? new AiRefused({ reason: 'signedOut', cli: 'codex' }, message, usage)
  : new CallFailed(message, usage);

export const codexCli: Provider = {
  id: 'codex-cli',
  billing: 'subscription',
  models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].map((id) => ({ id, can: ['text', 'json', 'typed', 'image'] as const })),
  defaults: { fast: 'gpt-6-luna', standard: 'gpt-6.1-sol', strong: 'gpt-6-astra' },

  /** The prompt goes on stdin; the answer is the last agent message of the JSONL events, the usage that of the finished turn. */
  ask(call) {
    const command = codexCommand();
    if (!command) return Promise.reject(new AiRefused({ reason: 'missing', cli: 'codex' }, 'Codex ist auf diesem Mac nicht installiert.'));
    const unread = call.attachments.find((p) => !IMAGES.has(extname(p).toLowerCase()));
    if (unread) return Promise.reject(new CallFailed(`Codex liest keine ${extname(unread) || 'Datei'}, nur Bilder: ${basename(unread)}`, NO_USAGE));
    const dir = mkdtempSync(join(tmpdir(), 'vanilla-codex-call-'));
    const instructions = join(dir, 'instructions.md');
    writeFileSync(instructions, call.system, { mode: 0o600 });
    return new Promise((done, fail) => {
      const child = spawn(command.bin, codexArgs(call, instructions), { cwd: cwd(), env: command.env });
      let usage: Usage = NO_USAGE;
      let answer: string | undefined;
      // A turn that failed says why; an `error` event alone may be a notice the run recovers from («Reconnecting…»).
      let failed: string | undefined;
      let notice: string | undefined;
      let acted: string | undefined;
      let pending = '';
      let err = '';
      const settle = (f: () => void) => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); f(); };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(() => fail(new CallFailed(`codex timed out after ${call.timeoutMs} ms`, usage)));
      }, call.timeoutMs);
      const read = (line: string) => {
        let e: Event;
        try { e = JSON.parse(line) as Event; } catch { return; }
        if (e.item?.type && ACTS.has(e.item.type)) {
          acted ??= e.item.type;
          child.kill('SIGKILL');
        } else if (e.type === 'item.completed' && e.item?.type === 'agent_message') answer = e.item.text ?? '';
        else if (e.type === 'turn.completed') {
          const u = e.usage ?? {};
          const cached = u.cached_input_tokens ?? 0;
          usage = { input: (u.input_tokens ?? 0) - cached, cacheCreate: 0, cacheRead: cached, output: u.output_tokens ?? 0, turns: 1 };
        } else if (e.type === 'turn.failed') failed = e.error?.message ?? 'turn failed';
        else if (e.type === 'error') notice = e.message ?? notice;
      };
      child.stdout.on('data', (d) => {
        const lines = (pending + d).split('\n');
        pending = lines.pop() ?? '';
        lines.forEach(read);
      });
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e: NodeJS.ErrnoException) => settle(() => fail(e.code === 'ENOENT' ? new AiRefused({ reason: 'missing', cli: 'codex' }, 'Codex ist auf diesem Mac nicht installiert.') : e)));
      child.on('close', (code) => {
        read(pending);
        if (acted) return settle(() => fail(new CallFailed(`codex wanted to act (${acted}); the app's steps only answer`, usage)));
        if (code === 0 && answer !== undefined && !failed) return settle(() => done({ text: answer!.trim(), usage }));
        const said = (failed ?? notice ?? (err.trim() || 'no answer')).slice(0, 300);
        settle(() => fail(refusalOf(said, `codex exited ${code}: ${said}`, usage)));
      });
      child.stdin.on('error', () => { /* the child's 'error' or 'close' settles the call, with the reason */ });
      child.stdin.write(call.prompt);
      child.stdin.end();
    });
  },

  /** Codex answers here: installed, and `codex login status` says signed in. */
  async ready(timeoutMs) {
    return (await codexStatus(timeoutMs)) === true;
  },
};

/** `codex login status`: true signed in, false signed out, undefined not installed or no answer. */
export function codexStatus(timeoutMs = 15_000): Promise<boolean | undefined> {
  const command = codexCommand();
  if (!command) return Promise.resolve(undefined);
  return probeCli('codex', { path: dirname(command.bin) }, timeoutMs).then((p) => (p.found === 'signedIn' ? true : p.found === 'signedOut' ? false : undefined));
}
