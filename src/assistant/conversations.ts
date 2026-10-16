/**
 * The AI sidebar's conversations, kept on this computer (data/assistant/<id>.json, outside git):
 * one Claude session each, continued by every message. Sending appends the person's turn and the
 * AI's, which fills as the answer streams and is stored when it ends.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { ApiRefusal } from '../types/api-error.js';
import type { AssistantEvent, AssistantSend, Change, Conversation, ConversationSummary, MadeChange, Turn } from '../types/assistant.js';
import { changesIn, withoutChanges } from './changes.js';
import { assistantPrompt, callClaude } from './claude.js';
import { contextText } from './context.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dir = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.data, 'assistant');

export const isConversationId = (id: unknown): id is string => typeof id === 'string' && ID.test(id);

export function readConversation(ws: Pick<Workspace, 'paths'>, id: string): Conversation | undefined {
  if (!isConversationId(id)) return undefined;
  try { return JSON.parse(readFileSync(join(dir(ws), `${id}.json`), 'utf8')) as Conversation; } catch { return undefined; }
}

function store(ws: Pick<Workspace, 'paths'>, c: Conversation): void {
  mkdirSync(dir(ws), { recursive: true });
  writeFileSync(join(dir(ws), `${c.id}.json`), JSON.stringify(c, null, 2) + '\n');
}

/** Newest first. */
export function listConversations(ws: Pick<Workspace, 'paths'>): ConversationSummary[] {
  if (!existsSync(dir(ws))) return [];
  return readdirSync(dir(ws)).filter((f) => f.endsWith('.json')).flatMap((f) => {
    const c = readConversation(ws, f.slice(0, -5));
    if (!c) return [];
    const context = [...new Set(c.turns.flatMap((t) => (t.role === 'me' ? t.context.map((r) => r.label) : [])))];
    return [{ id: c.id, title: c.title, at: c.at, context }];
  }).sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Applies all the changes, or none and throws why (a RefusedChanges, or a ChangesError). `earlier`:
 * the changes the conversation's answers made before and that stand, which an answer never takes
 * back on its own; `language`: the person's, for what an action writes (an export's files).
 */
export type ApplyChanges = (changes: Change[], earlier: MadeChange[], language: string) => Promise<MadeChange[]>;

/** Why the books refused an answer's changes: the API's words, and its code for the UI's. */
export class RefusedChanges extends Error {
  constructor(message: string, readonly refusal?: ApiRefusal) { super(message); }
}

/**
 * One message: stored, sent with its context read now and the app's places (`map`), its answer streamed to `onEvent` and stored
 * at the end. The changes to the books the answer asks for are applied before its `done`.
 */
export async function sendMessage(ws: Workspace, send: AssistantSend, apply: ApplyChanges, map: string, onEvent: (e: AssistantEvent) => void, signal: AbortSignal, now = () => new Date()): Promise<void> {
  const at = now().toISOString();
  const c: Conversation = (send.conversation && readConversation(ws, send.conversation))
    || { id: randomUUID(), title: send.text.trim().replace(/\s+/g, ' ').slice(0, 60), at, turns: [] };
  const last = c.turns.at(-1);
  const me: Turn = { role: 'me', text: send.text, at, context: send.context };
  const ai: Extract<Turn, { role: 'ai' }> = { role: 'ai', text: '', at, tools: [], done: false };
  c.turns.push(me, ai);
  c.at = at;
  store(ws, c);
  onEvent({ type: 'conversation', id: c.id });
  const prompt = assistantPrompt(send.text, contextText(ws, send.context), last?.role === 'ai' && last.refused ? [refusedNote(last.refused)] : []);
  let done: AssistantEvent | undefined;
  await callClaude({
    ws, send, map, session: c.session, prompt, signal,
    onEvent: (e) => {
      if (e.type === 'session') c.session = e.session;
      if (e.type === 'text') ai.text += e.text;
      if (e.type === 'tool') ai.tools.push({ name: e.name, detail: e.detail, ...(e.denied ? { denied: true } : {}) });
      if (e.type === 'error') ai.error = e.message;
      if (e.type === 'done' && e.session) c.session = e.session;
      if (e.type === 'done') done = e;
      else onEvent(e);
    },
  });
  const said = ai.text;
  ai.text = withoutChanges(said);
  if (done?.type === 'done' && !done.isError) {
    try {
      const asked = changesIn(said);
      if (asked.length) {
        const earlier = c.turns.flatMap((t) => (t.role === 'ai' && t !== ai ? (t.changes ?? []).filter((m) => !m.undone) : []));
        ai.changes = await apply(asked, earlier, send.language);
        onEvent({ type: 'changes', changes: ai.changes });
      }
    } catch (e) {
      ai.refused = (e as Error).message;
      if (e instanceof RefusedChanges && e.refusal) ai.refusal = e.refusal;
      onEvent({ type: 'refused', message: ai.refused, ...(ai.refusal ? { refusal: ai.refusal } : {}) });
      ai.withdrawn = ai.text;
      ai.text = await saidAgain(ws, send, map, c, ai.refused, signal);
      onEvent({ type: 'replace', text: ai.text });
    }
  }
  if (done) onEvent(done);
  ai.done = true;
  store(ws, c);
}

/** What the next message tells the model when the app refused the changes of its last answer, so it never builds on them. */
export const refusedNote = (why: string): string =>
  `The app did not apply the changes of your previous answer: it refused them all, nothing of them was changed. Why: ${why}`;

/**
 * An answer whose changes the app refused said they were made. Its text goes, and the model, in
 * its session, says in its place what was not done and why: one short call, so the person never
 * reads «done» for what was not done, and the session knows it too. Without a model answer
 * (an error, a stop) the text stays empty and the app's own line under it says why.
 */
async function saidAgain(ws: Workspace, send: AssistantSend, map: string, c: Conversation, why: string, signal: AbortSignal): Promise<string> {
  let text = '';
  let ok = false;
  await callClaude({
    ws, send, map, session: c.session, signal,
    prompt: [
      refusedNote(why),
      'The person will not see your answer: it said things were done that were not. Write what they read in its place: one or two short sentences, saying plainly what is not done and why, in their words (no field names, no codes), and what they can do (give what is missing, or where in the app they do it). No vanilla-changes block, no tools.',
    ].join('\n\n'),
    onEvent: (e) => {
      if (e.type === 'text') text += e.text;
      if (e.type === 'session') c.session = e.session;
      if (e.type === 'done') { ok = !e.isError; if (e.session) c.session = e.session; }
    },
  });
  return ok ? withoutChanges(text).trim() : '';
}

/** The accounts a change books on. */
const accountsOf = (c: Change): string[] => {
  const set = c.kind === 'newEntry' ? c.entry : c.kind === 'entry' ? c.set : undefined;
  return [set?.accountDebit, set?.accountCredit].filter((a): a is string => !!a);
};

/**
 * Takes back one change an answer made, once, and with it the others of that answer that cannot
 * stand without it, newest first: those on the same payment, so its bookings add up again, and
 * for an account the answer added, the bookings it put on that account. The books refuse it as
 * they refuse any edit of a filed quarter. Returns the changes now undone.
 */
export function undoChange(ws: Pick<Workspace, 'paths'>, id: string, change: string, revert: (undos: Change[]) => void): MadeChange[] | undefined {
  const c = readConversation(ws, id);
  const turn = c?.turns.find((t): t is Extract<Turn, { role: 'ai' }> => t.role === 'ai' && !!t.changes?.some((x) => x.id === change));
  const made = turn?.changes?.find((x) => x.id === change);
  if (!c || !turn || !made) return undefined;
  if (made.undone || !made.undo) return [made];
  const open = turn.changes!.filter((x) => !x.undone && x.undo);
  const added = made.change.kind === 'account' && made.undo.kind === 'account' && made.undo.name === null ? made.change.number : undefined;
  const on = new Set(open.filter((x) => x === made || (added && accountsOf(x.change).includes(added))));
  for (const x of [...on]) for (const y of open) if (x.payment && y.payment === x.payment) on.add(y);
  const together = open.filter((x) => on.has(x));
  revert(together.map((x) => x.undo!).reverse());
  for (const x of together) x.undone = true;
  store(ws, c);
  return together;
}
