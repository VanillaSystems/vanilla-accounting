/**
 * The AI sidebar's messages to the `claude` CLI (docs/0.4.0/views.md, "The AI, as a sidebar"):
 * an agent in the workspace with Claude Code's own tools, its session continued by every message
 * of a conversation (--resume), its answer streamed (stream-json). Unlike src/llm/ask.ts (one lean
 * call from an empty folder) it runs in the workspace.
 *
 * What it may change is set by its permissions, not by the prompt: no settings of the workspace or
 * the person are loaded (they could allow more), Fragen has only Read, Glob and Grep, and Ändern
 * adds Edit and Write under data/draft/ for the customizing folders only. So the AI never writes
 * the books (ledger.json, transactional-data/), never the approvals (outside the workspace), and
 * never a file in place: a person saves the draft in Änderungen (docs/0.4.0/saving.md).
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { claudeCommand, NoClaudeError, record, type Model } from '../llm/ask.js';
import { customizingNames } from '../saving/changes.js';
import type { AssistantEvent, AssistantMode, AssistantSend } from '../types/assistant.js';

/** The packaged app's files Claude reads (AGENTS.md, workflows/) lie beside its archive, unpacked (electron-builder asarUnpack). */
const APP_FILES = APP_ROOT.replace(/app\.asar(?=$|\/)/, 'app.asar.unpacked');

const LANGUAGES: Record<string, string> = { de: 'German', fr: 'French', it: 'Italian', en: 'English' };

/** Where Ändern may write: the draft's copy of each customizing folder or file. */
export function draftPatterns(): string[] {
  return customizingNames().map((n) => (/\.[a-z]+$/i.test(n) ? `data/draft/${n}` : `data/draft/${n}/**`));
}

export function assistantSystem(mode: AssistantMode, language: string): string {
  return [
    'You work on the books of one company in Vanilla Accounting, a Swiss bookkeeping app, for the person who keeps them.',
    'The current directory is the company\'s app folder: ledger.json, master-data/, transactional-data/<year>/ (the books, receipts, statements, filings, the run log), knowledge/ (rules, precedents, counterparties), workflows/ (the company\'s changes to the app\'s workflows), modules/, belege.workspace.yaml.',
    `The app's own rules: ${join(APP_FILES, 'AGENTS.md')}. Its workflows: ${join(APP_FILES, 'workflows')}/<id>/workflow.yaml and <step>/step.yaml. The company's notes: ../docs/company/AGENTS.md when it exists.`,
    'A filed quarter never changes. You never change the books: bookings are made by the app\'s workflows, which the person starts.',
    mode === 'ask'
      ? 'You only read and answer. If the person wants something changed, say what you would change, and that they can switch to «Ändern».'
      : [
        'You change how the app works (rules, workflows, knowledge, settings) in the draft, never in place:',
        'to change a file X of this folder, write data/draft/X. If data/draft/X does not exist yet, Read X first and Write its whole new content to data/draft/X; a new file is written to data/draft/ directly.',
        'The person sees the draft under Änderungen and saves it there. Say which files you changed and why, in one or two sentences.',
      ].join(' '),
    `Answer in ${LANGUAGES[language] ?? 'German'}, short and plain.`,
  ].join('\n');
}

export function assistantArgs(send: Pick<AssistantSend, 'mode' | 'language'>, session: string | undefined, repository: string): string[] {
  const writes = send.mode === 'change' ? draftPatterns().flatMap((p) => [`Edit(${p})`, `Write(${p})`]) : [];
  return [
    '-p',
    '--model', 'sonnet',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt', assistantSystem(send.mode, send.language),
    '--setting-sources', '',
    '--strict-mcp-config',
    '--permission-mode', 'default',
    '--add-dir', APP_FILES, repository,
    '--allowedTools', 'Read', 'Glob', 'Grep', ...writes,
    '--disallowedTools', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch', ...(send.mode === 'ask' ? ['Edit', 'Write'] : []),
    ...(session ? ['--resume', session] : []),
  ];
}

/** The message: what the person refers to, as the server read it now, then their words. */
export function assistantPrompt(text: string, context: string[]): string {
  return [
    context.length ? ['The person refers to:', ...context.map((c) => `- ${c}`)].join('\n') : '',
    text.trim(),
  ].filter(Boolean).join('\n\n');
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
 * Turns stream-json lines into events. The answer's text comes from the partial messages' text
 * deltas; a message that came without them (an older CLI) gives its text whole. Text blocks apart
 * (before and after a tool) are kept apart by a blank line. `roots` are the workspace's paths, cut
 * from a tool's file so it reads as the person knows it.
 */
export function streamParser(roots: string[]): (line: string) => AssistantEvent[] {
  let texted = false;
  let streamed = false;
  const details = new Map<string, string>();
  const relative = (p: string) => {
    const root = roots.find((r) => p.startsWith(r + '/'));
    return root ? p.slice(root.length + 1) : p;
  };
  const text = (s: string): AssistantEvent[] => {
    const out: AssistantEvent[] = [{ type: 'text', text: (texted ? '\n\n' : '') + s }];
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
      return (m.message?.content ?? []).flatMap((b): AssistantEvent[] => {
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
        ...(isError ? [{ type: 'error', message: (m.result || m.subtype || 'claude').slice(0, 500) } as AssistantEvent] : []),
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

export interface AssistantCall {
  ws: Pick<Workspace, 'paths'>;
  send: AssistantSend;
  session: string | undefined;
  prompt: string;
  onEvent(e: AssistantEvent): void;
  signal: AbortSignal;
}

/** Sends one message and streams the answer to `onEvent`, ending with `done` or `error`. Resolves when the CLI exits. */
export function callClaude(call: AssistantCall): Promise<void> {
  const started = Date.now();
  const root = call.ws.paths.root;
  return new Promise((resolve) => {
    const { bin, env } = claudeCommand();
    const child = spawn(bin, assistantArgs(call.send, call.session, call.ws.paths.repository), { cwd: root, env: { ...env, VANILLA_WORKSPACE: root } });
    let real = root;
    try { real = realpathSync(root); } catch { /* the path as given */ }
    const parse = streamParser([...new Set([root, real])]);
    let ended = false;
    let pending = '';
    let err = '';
    const emit = (e: AssistantEvent) => {
      if (e.type === 'done' || e.type === 'error') ended = true;
      call.onEvent(e);
    };
    const kill = () => child.kill('SIGTERM');
    call.signal.addEventListener('abort', kill, { once: true });
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
      call.signal.removeEventListener('abort', kill);
      if (pending) parse(pending).forEach(emit);
      if (!ended && !call.signal.aborted) emit({ type: 'error', message: `claude exited ${code}: ${err.trim().slice(0, 300)}` });
      resolve();
    });
    child.stdin.on('error', () => { /* 'error' or 'close' says why */ });
    child.stdin.end(call.prompt);
  });

  function ledger(line: string): void {
    let m: Line;
    try { m = JSON.parse(line) as Line; } catch { return; }
    const u = m.usage ?? {};
    record({
      at: new Date().toISOString(), step: `assistant#${call.send.mode}`, model: modelOf(m.modelUsage), ok: !m.is_error, ms: Date.now() - started,
      input: u.input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0, turns: m.num_turns ?? 0,
    });
  }
}
