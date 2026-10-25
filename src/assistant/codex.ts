/**
 * The KI column on Codex (issue #121 step 5): the same conversation, prompt and change block as on
 * Claude Code (src/assistant/claude.ts), with the same write boundary, enforced three times:
 *
 *  1. Codex has no tool of its own that reaches the disk, a shell or the web: the same CLOSED run
 *     as the app's single answers (read-only sandbox, approval never asked, shell, exec, web,
 *     apps, plugins, image and browser tools off, no user config, rules, AGENTS.md or skills).
 *  2. Its only tools are the app's, served for this message (src/assistant/codex-tools.ts): read
 *     the books' folder, write only the draft. A change to the books is named in the answer's
 *     ```vanilla-changes block, which conversations.ts applies through the books' write door.
 *  3. The app reads every event and ends the run at the first item that is neither an answer nor a
 *     call of its own tools: a command, an edit, a web search, a sub-agent, another server's tool.
 *     An answer whose run was ended applies nothing.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record } from '../llm/ask.js';
import { CLOSED, codexCommand, codexEnv, missing, runCodex, usageOf, type CodexEvent } from '../llm/providers/codex-cli.js';
import { STEPS } from '../llm/steps.js';
import { ownerAccount } from '../accounting/bank-accounts.js';
import { APP_FILES, assistantSystem, draftPatterns, NEVER_DRAFTED, type AssistantCall } from './claude.js';
import { serveTools } from './codex-tools.js';

/** The server's name in Codex: its tools are mcp__vanilla__Read and so on. */
export const SERVER = 'vanilla';

/** What the instructions add for Codex: where its tools are, and that it has no other. */
export const CODEX_TOOLS_NOTE = [
  `Your tools are the app's, and only these: ${['Read', 'Glob', 'Grep'].map((t) => `mcp__${SERVER}__${t}`).join(', ')} read the books folder (the current directory; relative paths start there), the app's files and the company's repository, and mcp__${SERVER}__Write and mcp__${SERVER}__Edit write only the draft (data/draft/…).`,
  `Call them from exec, for example \`const r = await tools.mcp__${SERVER}__Read({ file_path: 'ledger.json' }); text(r);\`.`,
  'You have no shell, no web and no other file tool: apply_patch, a command, a web search or a sub-agent is refused and ends your answer without anything of it being done. Read with these tools, write the draft with them, and name every change to the books in your vanilla-changes block.',
].join(' ');

export function codexSidebarArgs(model: string, instructionsFile: string, toolsUrl: string, root: string, session: string | undefined): string[] {
  const own = [
    '--json', '--model', model,
    '-c', `model_instructions_file=${JSON.stringify(instructionsFile)}`,
    '-c', `mcp_servers.${SERVER}.url=${JSON.stringify(toolsUrl)}`,
    '-c', `mcp_servers.${SERVER}.required=true`,
    // Its tools run without asking: approval is never asked of anyone in this run, so they would be refused.
    '-c', `mcp_servers.${SERVER}.default_tools_approval_mode="approve"`,
    // Listed in exec's description, not left for the model to search for.
    '-c', `mcp_servers.${SERVER}.omit_tools_from=["deferred"]`,
    '-c', `mcp_servers.${SERVER}.tool_timeout_sec=120`,
  ];
  // `exec resume` takes no --sandbox and no --cd: the same sandbox as a setting, the folder as the run's cwd.
  return session
    ? ['exec', 'resume', ...CLOSED.flatMap((a, i, all) => (a === '--sandbox' ? ['-c', `sandbox_mode="${all[i + 1]}"`] : all[i - 1] === '--sandbox' ? [] : [a])), ...own, session, '-']
    : ['exec', ...CLOSED, '--cd', root, ...own];
}

/** The workspace's path as the person knows it, cut from a tool's file. */
const relativeTo = (roots: string[]) => (p: string) => {
  const root = roots.find((r) => p.startsWith(r + '/'));
  return root ? p.slice(root.length + 1) : p;
};

/** Sends one message to Codex and streams the answer to `onEvent`, ending with `done` or `error`. */
export async function callCodex(call: AssistantCall, model: string): Promise<void> {
  const started = Date.now();
  const root = call.ws.paths.root;
  const command = codexCommand();
  if (!command) {
    call.onEvent({ type: 'error', message: missing().message });
    return;
  }
  let real = root;
  try { real = realpathSync(root); } catch { /* the path as given */ }
  const relative = relativeTo([...new Set([root, real])]);
  const tools = await serveTools({
    root, readable: [root, APP_FILES, call.ws.paths.repository], writable: draftPatterns(), never: NEVER_DRAFTED,
    pagesCache: join(call.ws.paths.data, 'pdf-pages'),
  });
  const dir = mkdtempSync(join(tmpdir(), 'vanilla-codex-sidebar-'));
  const instructions = join(dir, 'instructions.md');
  writeFileSync(instructions, `${assistantSystem(call.send.language, ownerAccount(call.ws), call.map, call.ws.invoicing?.paymentTermsDays)}\n\n${CODEX_TOOLS_NOTE}`, { mode: 0o600 });
  let texted = false;
  let ended = false;
  let failed: string | undefined;
  let usage = usageOf({});
  const emit: AssistantCall['onEvent'] = (e) => {
    if (e.type === 'done' || e.type === 'error') ended = true;
    call.onEvent(e);
  };
  const onEvent = (e: CodexEvent) => {
    if (e.type === 'thread.started' && e.thread_id) emit({ type: 'session', session: e.thread_id });
    else if (e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text) {
      emit({ type: 'text', text: (texted ? '\n\n' : '') + e.item.text });
      texted = true;
    } else if (e.type === 'item.completed' && e.item?.type === 'mcp_tool_call') {
      const a = (e.item.arguments ?? {}) as Record<string, unknown>;
      const what = [a.file_path, a.path, a.pattern].find((v) => typeof v === 'string') as string | undefined;
      const result = e.item.result as { content?: unknown; isError?: boolean } | undefined;
      emit({ type: 'tool', name: e.item.tool ?? '', detail: relative(what ?? '').slice(0, 160), ...(e.item.status === 'failed' || e.item.error || result?.isError ? { denied: true } : {}) });
    } else if (e.type === 'turn.completed') usage = usageOf(e.usage ?? {});
    else if (e.type === 'turn.failed') failed = e.error?.message ?? 'turn failed';
  };
  try {
    const exit = await runCodex({
      bin: command.bin, args: codexSidebarArgs(model, instructions, tools.url, root, call.session), env: { ...codexEnv(command), VANILLA_WORKSPACE: root },
      cwd: root, prompt: call.prompt, timeoutMs: 15 * 60_000, signal: call.signal,
      allowed: (item) => item.type === 'mcp_tool_call' && item.server === SERVER,
      onEvent,
    });
    const ok = exit.code === 0 && !exit.acted && !exit.timedOut && !failed && !call.signal.aborted;
    record({ at: new Date().toISOString(), step: STEPS.sidebar.ledger, provider: 'codex-cli', model, ok, ms: Date.now() - started, ...usage });
    if (exit.acted) emit({ type: 'error', message: `Codex wollte etwas tun, das die Seitenleiste nicht darf (${exit.acted}): die App hat die Antwort beendet, nichts davon ist gemacht.` });
    else if (exit.timedOut) emit({ type: 'error', message: 'Codex hat zu lange gebraucht: die App hat die Antwort beendet.' });
    else if (!ok && !call.signal.aborted) emit({ type: 'error', message: `codex: ${(failed ?? (exit.stderr.trim() || `exited ${exit.code}`)).slice(0, 500)}` });
    if (!call.signal.aborted) emit({ type: 'done', isError: !ok });
  } catch (e) {
    if (!ended) emit({ type: 'error', message: (e as NodeJS.ErrnoException).code === 'ENOENT' ? missing().message : (e as Error).message });
  } finally {
    await tools.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
