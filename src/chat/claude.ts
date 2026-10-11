/**
 * The chat composer's messages to the `claude` CLI: an agent in the workspace, with Claude Code's
 * own tools, that follows the app's rules and process guides. Unlike src/llm/ask.ts (one lean
 * call from an empty folder) it runs in the workspace, keeps its session for follow-ups
 * (--resume) and streams its answer (stream-json).
 *
 * What it may change is set by its permissions, not by the prompt alone: it reads everywhere,
 * edits only knowledge/, and runs only the app's own commands (when the app runs from its source),
 * which write the books through src/books/store.ts and refuse closed periods. An edit of books.json
 * or filings/ is denied and shows in the answer as refused.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from '../workspace/workspace.js';
import { claudeCommand, NoClaudeError, record, type Model } from '../llm/ask.js';
import type { ChatEvent, ChatSend, ChatSkill } from '../types/chat.js';
import { PROCESSES_DIR } from './skills.js';

/** The packaged app's files Claude reads (AGENTS.md, processes/) lie beside its archive, unpacked (electron-builder asarUnpack). */
const APP_FILES = APP_ROOT.replace(/app\.asar(?=$|\/)/, 'app.asar.unpacked');
const PROCESS_FILES = PROCESSES_DIR.replace(/app\.asar(?=$|\/)/, 'app.asar.unpacked');
/** From its source (npm start, npm run desktop) the app's commands are there to run; the packaged app has no npm. */
const FROM_SOURCE = APP_FILES === APP_ROOT;

const LANGUAGES: Record<string, string> = { de: 'German', fr: 'French', it: 'Italian', en: 'English' };

export function chatSystem(language: string): string {
  return [
    'You work on the books of one company in Vanilla Accounting, a Swiss bookkeeping app, for the person who keeps them.',
    'The current directory is the company\'s workspace: belege.workspace.yaml, books.json, receipts/, bank-statements/, filings/, knowledge/.',
    `Before you act, read the app's rules in ${join(APP_FILES, 'AGENTS.md')} and the workspace's docs/company/AGENTS.md when it exists.`,
    `For a job, follow its flow ${PROCESS_FILES}/<job>.flow.yaml step by step, and for each step the rules in ${PROCESS_FILES}/<process>.guide.yaml and knowledge/rules/<process>.guide.yaml.`,
    'A filed quarter never changes (config.closedThrough in books.json). Never edit books.json, filings/ or a seal yourself.',
    FROM_SOURCE
      ? `Change the books only through the app's commands, \`npm --prefix ${APP_ROOT} run <script>\` (VANILLA_WORKSPACE already points here); they refuse closed periods.`
      : 'The app\'s commands cannot run here: say which change the person should make in the app.',
    'You may edit knowledge/ (rules, precedents, businesses) as the process guides say.',
    'Files the person attached lie under data/chat/; read them with the Read tool.',
    `Answer in ${LANGUAGES[language] ?? 'German'}, short and plain.`,
  ].join('\n');
}

/** The message: the job's flow when one was chosen, the text, and the attached files by their path in the workspace. */
export function chatPrompt(send: Pick<ChatSend, 'text' | 'skill' | 'files'>, skills: ChatSkill[]): string {
  const skill = skills.find((s) => s.id === send.skill);
  return [
    skill && `Job: ${skill.name}. Follow ${PROCESS_FILES}/${skill.id}.flow.yaml.`,
    send.text.trim(),
    send.files.length > 0 && ['Attached files (read them with the Read tool):', ...send.files.map((f) => `- ${f}`)].join('\n'),
  ].filter(Boolean).join('\n\n');
}

export function chatArgs(send: Pick<ChatSend, 'session' | 'language'>): string[] {
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt', chatSystem(send.language),
    // The workspace's own settings, not the person's (their hooks and plugins are for their own sessions).
    '--setting-sources', 'project,local',
    '--strict-mcp-config',
    '--permission-mode', 'default',
    '--add-dir', APP_FILES,
    '--allowedTools', 'Read', 'Glob', 'Grep', 'Edit(knowledge/**)', 'Write(knowledge/**)',
    ...(FROM_SOURCE ? [`Bash(npm --prefix ${APP_ROOT} run *)`] : []),
    ...(send.session ? ['--resume', send.session] : []),
  ];
}

type Block = { type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> };
type Line = {
  type?: string; subtype?: string; session_id?: string; is_error?: boolean; result?: string;
  tool_name?: string; tool_use_id?: string;
  event?: { type?: string; content_block?: Block; delta?: { type?: string; text?: string } };
  message?: { content?: Block[] };
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
  num_turns?: number; modelUsage?: Record<string, unknown>;
};

/**
 * Turns stream-json lines into ChatEvents. The answer's text comes from the partial messages'
 * text deltas; a message that came without them (an older CLI) gives its text whole. Text blocks
 * apart (before and after a tool) are kept apart by a blank line. `roots` are the workspace's
 * paths, cut from a tool's file so it reads as the person knows it.
 */
export function streamParser(roots: string[]): (line: string) => ChatEvent[] {
  let texted = false;
  let streamed = false;
  const details = new Map<string, string>();
  const relative = (p: string) => {
    const root = roots.find((r) => p.startsWith(r + '/'));
    return root ? p.slice(root.length + 1) : p;
  };
  const text = (s: string): ChatEvent[] => {
    const out: ChatEvent[] = [{ type: 'text', text: (texted ? '\n\n' : '') + s }];
    texted = true;
    return out;
  };
  return (raw) => {
    let m: Line;
    try { m = JSON.parse(raw) as Line; } catch { return []; }
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) return [{ type: 'session', session: m.session_id }];
    if (m.type === 'system' && m.subtype === 'permission_denied' && m.tool_name) {
      return [{ type: 'tool', name: m.tool_name, detail: details.get(m.tool_use_id ?? '') ?? '', denied: true }];
    }
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e?.type === 'message_start') streamed = false;
      if (e?.type === 'content_block_start' && e.content_block?.type === 'text' && texted) { streamed = true; return [{ type: 'text', text: '\n\n' }]; }
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        streamed = true;
        texted = true;
        return [{ type: 'text', text: e.delta.text }];
      }
      return [];
    }
    if (m.type === 'assistant') {
      return (m.message?.content ?? []).flatMap((b): ChatEvent[] => {
        if (b.type === 'tool_use' && b.name) {
          const i = b.input ?? {};
          const what = [i.file_path, i.path, i.command, i.pattern, i.url, i.description].find((v) => typeof v === 'string') as string | undefined;
          const detail = relative(what ?? '').slice(0, 160);
          if (b.id) details.set(b.id, detail);
          return [{ type: 'tool', name: b.name, detail }];
        }
        if (b.type === 'text' && b.text && !streamed) return text(b.text);
        return [];
      });
    }
    if (m.type === 'result') {
      const isError = !!m.is_error || m.subtype !== 'success';
      return [
        ...(isError ? [{ type: 'error', message: (m.result || m.subtype || 'claude').slice(0, 500) } as ChatEvent] : []),
        { type: 'done', isError, ...(m.session_id ? { session: m.session_id } : {}) },
      ];
    }
    return [];
  };
}

/** The ledger's model name of a model id such as claude-opus-4-x; sonnet when it names none of the three. */
function modelOf(usage: Record<string, unknown> | undefined): Model {
  const id = Object.keys(usage ?? {})[0] ?? '';
  return (['opus', 'haiku', 'sonnet'] as const).find((m) => id.includes(m)) ?? 'sonnet';
}

export interface ChatRun {
  /** The workspace: Claude's cwd, and VANILLA_WORKSPACE of the commands it runs. */
  root: string;
  skills: ChatSkill[];
  onEvent(e: ChatEvent): void;
  signal: AbortSignal;
}

/** Sends one message and streams the answer to `onEvent`, ending with `done` or `error`. Resolves when the CLI exits. */
export function runChat(send: ChatSend, run: ChatRun): Promise<void> {
  const started = Date.now();
  return new Promise((resolve) => {
    const { bin, env } = claudeCommand();
    const child = spawn(bin, chatArgs(send), { cwd: run.root, env: { ...env, VANILLA_WORKSPACE: run.root } });
    let real = run.root;
    try { real = realpathSync(run.root); } catch { /* the path as given */ }
    const parse = streamParser([...new Set([run.root, real])]);
    let ended = false;
    let pending = '';
    let err = '';
    const emit = (e: ChatEvent) => {
      if (e.type === 'done' || e.type === 'error') ended = true;
      run.onEvent(e);
    };
    const kill = () => child.kill('SIGTERM');
    run.signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      pending += d.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.includes('"type":"result"')) ledger(line);
        parse(line).forEach(emit);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (!ended) emit({ type: 'error', message: e.code === 'ENOENT' ? new NoClaudeError().message : e.message });
    });
    child.on('close', (code) => {
      run.signal.removeEventListener('abort', kill);
      if (pending) parse(pending).forEach(emit);
      if (!ended && !run.signal.aborted) emit({ type: 'error', message: `claude exited ${code}: ${err.trim().slice(0, 300)}` });
      resolve();
    });
    child.stdin.on('error', () => { /* 'error' or 'close' says why */ });
    child.stdin.end(chatPrompt(send, run.skills));
  });

  function ledger(line: string): void {
    let m: Line;
    try { m = JSON.parse(line) as Line; } catch { return; }
    const u = m.usage ?? {};
    record({
      at: new Date().toISOString(), step: 'chat', model: modelOf(m.modelUsage), ok: !m.is_error, ms: Date.now() - started,
      input: u.input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0, turns: m.num_turns ?? 0,
    });
  }
}
