/**
 * The AI sidebar's conversations, kept on this computer (data/assistant/<id>.json, outside git):
 * one session each (Claude Code's or Codex's), continued by every message. Sending appends the person's turn and the
 * AI's, which fills as the answer streams and is stored when it ends.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { ApiRefusal } from '../types/api-error.js';
import type { AssistantEvent, AssistantSend, Change, Conversation, ConversationSummary, HeldChanges, MadeChange, Turn } from '../types/assistant.js';
import { ChangesError, changesIn, terminalRequest, withoutChanges } from './changes.js';
import { assistantPrompt, callClaude, type AssistantCall } from './claude.js';
import { callCodex } from './codex.js';
import { isPlanLimit, isSignedOut, type AiRefusal } from '../llm/provider.js';
import { AI_OFF_MESSAGE } from '../llm/off.js';
import { NoClaudeError } from '../llm/providers/claude-cli.js';
import { missing as codexMissing } from '../llm/providers/codex-cli.js';
import { sidebarAgent } from '../llm/ask.js';
import { contextText } from './context.js';
import { draftedBy, proposalsNote } from './proposals.js';
import { attachmentsNote, keepAttachments } from './attachments.js';
import type { Attachment } from '../types/attachment.js';
import { wordsIn } from '../export/texts.js';
import { strayFigures } from '../reports/figures.js';
import { accountsOf as chartOf } from '../workspace/reads.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dir = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.data, 'assistant');

export const isConversationId = (id: unknown): id is string => typeof id === 'string' && ID.test(id);

export function readConversation(ws: Pick<Workspace, 'paths'>, id: string): Conversation | undefined {
  if (!isConversationId(id)) return undefined;
  try { return JSON.parse(readFileSync(join(dir(ws), `${id}.json`), 'utf8')) as Conversation; } catch { return undefined; }
}

export function storeConversation(ws: Pick<Workspace, 'paths'>, c: Conversation): void {
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
 * back on its own; `language`: the person's, for what an action writes (an export's files);
 * `conversation`: whose changes they are. With `hold`, changes that rebook the books rather than
 * fix one booking are not made: their rows come back for the card (src/assistant/held.ts).
 */
export type ApplyChanges = (changes: Change[], earlier: MadeChange[], language: string, how: { conversation: string; hold: Hold }) => Promise<Applied>;
/** The app's facts a conversation's answer is held to (src/onboarding/opening-claim.ts): its words as shown, and what the model said when they were replaced. */
export type KeepToFacts = (text: string) => { text: string; withdrawn?: string };
/** `always`: held whatever they change (a proposal from the terminal); true: held when they rebook rather than fix; false: made. */
export type Hold = boolean | 'always';
export type Applied = { made: MadeChange[] } | { held: Pick<HeldChanges, 'why' | 'rows'> };

/** The changes the conversation's answers made and that stand, but those of `except`. */
const standing = (c: Conversation, except?: Turn): MadeChange[] =>
  c.turns.flatMap((t) => (t.role === 'ai' && t !== except ? (t.changes ?? []).filter((m) => !m.undone) : []));

/** Why the books refused an answer's changes: the API's words, and its code for the UI's. */
export class RefusedChanges extends Error {
  constructor(message: string, readonly refusal?: ApiRefusal) { super(message); }
}

/**
 * One message: stored, sent with its context read now, the app's places (`map`) and what waits for
 * the person now (`waiting`, src/server/open-work.ts), its answer streamed to `onEvent` and stored
 * at the end. The changes to the books the answer asks for are applied before its `done`.
 */
export async function sendMessage(ws: Workspace, send: AssistantSend, apply: ApplyChanges, { map, waiting, attachments = [], keep }: { map: string; waiting: string; attachments?: Attachment[]; keep?: KeepToFacts }, onEvent: (e: AssistantEvent) => void, signal: AbortSignal, now = () => new Date()): Promise<void> {
  const at = now().toISOString();
  const c: Conversation = (send.conversation && readConversation(ws, send.conversation))
    || { id: randomUUID(), title: send.text.trim().replace(/\s+/g, ' ').slice(0, 60), at, ...(send.purpose ? { purpose: send.purpose } : {}), turns: [] };
  const last = c.turns.at(-1);
  const paths = keepAttachments(ws, c.id, attachments);
  const me: Turn = { role: 'me', text: send.text, at, context: send.context, ...(attachments.length ? { attachments } : {}) };
  const ai: Extract<Turn, { role: 'ai' }> = { role: 'ai', text: '', at, tools: [], done: false };
  c.turns.push(me, ai);
  c.at = at;
  storeConversation(ws, c);
  onEvent({ type: 'conversation', id: c.id });
  // What became of every earlier proposal is the app's to say (#362): read now, before the turns of this message.
  const proposals = proposalsNote(ws, { turns: c.turns.slice(0, -2) }, send.language);
  const prompt = assistantPrompt(send.text, contextText(ws, send.context), [...(last?.role === 'ai' && last.refused ? [refusedNote(last.refused)] : []), ...(proposals ? [proposals] : []), waiting, ...(attachments.length ? [attachmentsNote(attachments, paths)] : [])]);
  let done: AssistantEvent | undefined;
  await callAgent(c, {
    ws, send, map, prompt, signal,
    onEvent: (e) => {
      if (e.type === 'session') c.session = e.session;
      if (e.type === 'text') ai.text += e.text;
      if (e.type === 'tool') ai.tools.push({ name: e.name, detail: e.detail, ...(e.denied ? { denied: true } : {}) });
      if (e.type === 'error') {
        ai.error = e.message;
        const why = noAnswerWhy(e.message, c.agent === 'codex-cli' ? 'codex' : 'claude');
        // The CLI prints its refusal as the answer's text too («Not logged in · Please run /login»): an answer that is that refusal
        // itself goes, so the app's sentence stands alone; an answer with words of its own stays.
        if (why && ai.text.trim() && noAnswerWhy(ai.text.trim(), c.agent === 'codex-cli' ? 'codex' : 'claude')?.reason === why.reason) { ai.text = ''; onEvent({ type: 'replace', text: '' }); }
        if (why) { ai.errorWhy = why; onEvent({ ...e, why }); return; }
      }
      if (e.type === 'done' && e.session) c.session = e.session;
      if (e.type === 'done') done = e;
      else onEvent(e);
    },
  });
  const said = ai.text;
  ai.text = withoutChanges(said);
  // Words that state what the app does otherwise are not shown as said (#496): the app's sentence stands in their place.
  const kept = keep?.(ai.text);
  if (kept?.withdrawn !== undefined) { ai.withdrawn = kept.withdrawn; ai.text = kept.text; onEvent({ type: 'replace', text: ai.text }); }
  // Which rules its drafts add, change or remove, now that they are written: later messages tell each one's state (#362).
  const drafted = draftedBy(ws, ai);
  if (drafted.length) ai.drafted = drafted;
  const terminal = terminalRequest(said);
  if (terminal) { ai.terminal = terminal; onEvent({ type: 'terminal', request: terminal }); }
  if (done?.type === 'done' && !done.isError) {
    try {
      const asked = changesIn(said);
      if (asked.length) {
        const applied = await apply(asked, standing(c, ai), send.language, { conversation: c.id, hold: true });
        if ('held' in applied) {
          ai.held = { changes: asked, ...applied.held, status: 'held' };
          onEvent({ type: 'held', held: ai.held });
        } else {
          ai.changes = applied.made;
          onEvent({ type: 'changes', changes: ai.changes });
          const { t } = wordsIn(send.language);
          // A report's figures are the code's (src/reports/figures.ts): words that state another are withdrawn.
          const reports = applied.made.flatMap((m) => (m.change.kind === 'report' && m.note?.report ? [m.note.report] : []));
          if (reports.length && strayFigures(ai.text, reports, (chartOf(ws) as Array<{ number: unknown }>).map((a) => String(a.number))).length) {
            ai.withdrawn = ai.text;
            ai.text = t('assistant.reportFigures');
          }
          // What was made is the app's to say, not the model's to guess (r8f-47): its line closes the answer, and says so where the model still named «Übernehmen» (r10f-11).
          const take = ai.text.includes(t('assistant.held.take'));
          // The card of the open period (#342) changes nothing: it is not counted, and alone it takes no line.
          const made = applied.made.filter((m) => m.change.kind !== 'openPeriod').length;
          const line = reports.length === made ? t('assistant.reportMade', { n: reports.length }) : t('assistant.applied', { n: made });
          if (made) ai.text = `${ai.text.trimEnd()}\n\n${line}${take ? ` ${t('assistant.appliedNoTake', { take: t('assistant.held.take') })}` : ''}`;
          onEvent({ type: 'replace', text: ai.text });
        }
      }
    } catch (e) {
      ai.refused = (e as Error).message;
      if ((e instanceof RefusedChanges || e instanceof ChangesError) && e.refusal) ai.refusal = e.refusal;
      onEvent({ type: 'refused', message: ai.refused, ...(ai.refusal ? { refusal: ai.refusal } : {}) });
      ai.withdrawn = ai.text;
      ai.text = await saidAgain(ws, send, map, c, ai.withdrawn, ai.refused, signal);
      onEvent({ type: 'replace', text: ai.text });
    }
  }
  if (done) onEvent(done);
  ai.done = true;
  storeConversation(ws, c);
}

/**
 * Why the agent's CLI gave no answer, read off its own words: not signed in, its plan's limit, not
 * on this Mac, or switched off. Undefined: a failure of another kind, shown as the CLI said it.
 */
export function noAnswerWhy(said: string, cli: 'claude' | 'codex'): AiRefusal | undefined {
  if (said === AI_OFF_MESSAGE) return { reason: 'off' };
  if (isPlanLimit(said)) return { reason: 'limit', cli, said: said.replace(/^(claude|codex)[^:]*:\s*/i, '').trim() };
  if (isSignedOut(said)) return { reason: 'signedOut', cli };
  if (said === new NoClaudeError('sidebar').message || said === codexMissing().message) return { reason: 'missing', cli };
  return undefined;
}

/**
 * The KI column's agent on this computer sends the message: Claude Code or Codex (Firma › KI). A
 * session continues only with the agent it was started with; after a switch the next message starts a new one.
 */
function callAgent(c: Conversation, call: Omit<AssistantCall, 'session'>): Promise<void> {
  const { provider, model } = sidebarAgent();
  const agent = provider.id === 'codex-cli' ? 'codex-cli' : 'claude-cli';
  if ((c.agent ?? 'claude-cli') !== agent) c.session = undefined;
  c.agent = agent;
  return agent === 'codex-cli' ? callCodex({ ...call, session: c.session }, model) : callClaude({ ...call, session: c.session });
}

/**
 * «Übernehmen» (`take`) or «Verwerfen» on the changes the app held for an answer (`turn`: its
 * index): taken, they are made as one answer's changes, all or none, refused as any answer is;
 * discarded, nothing changes. Once settled, the card stays as it was settled. Returns the turn.
 */
export async function settleHeld(ws: Pick<Workspace, 'paths'>, id: string, turn: number, take: boolean, language: string, apply: ApplyChanges): Promise<Extract<Turn, { role: 'ai' }> | undefined> {
  const c = readConversation(ws, id);
  const ai = c?.turns[turn];
  if (!c || ai?.role !== 'ai' || !ai.held) return undefined;
  if (ai.held.status !== 'held') return ai;
  if (take) {
    const applied = await apply(ai.held.changes, standing(c, ai), language, { conversation: c.id, hold: false });
    if ('made' in applied) ai.changes = applied.made;
  }
  ai.held.status = take ? 'taken' : 'dropped';
  storeConversation(ws, c);
  return ai;
}

/** Around the answer the app refused, in the call that says it again. */
export const ANSWER_START = 'Your answer as it was:\n<<<';
const ANSWER_END = '>>>';

/** What the next message tells the model when the app refused the changes of its last answer, so it never builds on them. */
export const refusedNote = (why: string): string =>
  `The app did not apply the changes of your previous answer: it refused them all, nothing of them was changed. Why: ${why}`;

/**
 * An answer whose changes the app refused said they were made. The model, in its session, writes
 * it again with only what it said about those changes corrected (not done, why, what the person
 * can do), and everything else kept as it was: a readiness check, an explanation, an answer to a
 * question never depended on them (w08). One short call, so the person never reads «done» for what
 * was not done, and the session knows it too. Without a model answer (an error, a stop) the text
 * stays empty and the app's own line under it says why.
 */
async function saidAgain(ws: Workspace, send: AssistantSend, map: string, c: Conversation, said: string, why: string, signal: AbortSignal): Promise<string> {
  let text = '';
  let ok = false;
  await callAgent(c, {
    ws, send, map, signal,
    prompt: [
      refusedNote(why),
      'The person will not see your answer as it was: it said things were done that were not. Write the answer they read in its place: the same answer, with only what it said about those changes corrected, plainly: that they are not done and why, in their words (no field names, no codes), and what they can do (give what is missing, or where in the app they do it). Keep every other part as it was, word for word: what you checked, found, explained or answered does not depend on them. No vanilla-changes block, no tools.',
      ANSWER_START, said, ANSWER_END,
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
  storeConversation(ws, c);
  return together;
}
