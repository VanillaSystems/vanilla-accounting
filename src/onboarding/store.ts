/**
 * The setup checklist on disk: onboarding.json at the top of the workspace (LAYOUT in
 * src/workspace/workspace.ts), written whole and atomically. Every write converges: marking a topic
 * twice, or starting twice, leaves the same file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '../workspace/workspace.js';
import type { Index } from '../types/index.js';
import { writeAtomic } from '../invoices/store.js';
import { emptyProgress, parseProgress, withAnswer, withTopic, type Answer, type AnswerValue, type QuestionId, type SetupProgress, type SetupTopic, type TopicState } from './model.js';
import type { SetupView } from './facts.js';

export const ONBOARDING_FILE = 'onboarding.json';
const SCHEMA = 1;

type Ws = Pick<Workspace, 'paths'>;
const fileOf = (ws: Ws) => join(ws.paths.root, ONBOARDING_FILE);

export function readProgress(ws: Ws): SetupProgress {
  const file = fileOf(ws);
  if (!existsSync(file)) return emptyProgress();
  try { return parseProgress(JSON.parse(readFileSync(file, 'utf8'))); } catch { return emptyProgress(); }
}

function write(ws: Ws, p: SetupProgress): SetupProgress {
  writeAtomic(fileOf(ws), JSON.stringify({ schema: SCHEMA, ...p }, null, 2) + '\n');
  return p;
}

/** Whether the books hold anything yet: a workspace with payments, bookings or receipts was in use before the setup existed. */
const emptyBooks = (books: Pick<Index, 'transactions' | 'receipts'> & { journalEntries?: unknown[] }) =>
  !books.transactions.length && !books.receipts.length && !(books.journalEntries ?? []).length;

/**
 * Whether opening the books opens the setup by itself: the first start of an empty workspace never
 * set up, and books the setup conversation created until the person said «Los geht's» (#139).
 */
export function setupView(ws: Ws, books: Parameters<typeof emptyBooks>[0]): Pick<SetupView, 'progress' | 'opensItself'> {
  const progress = readProgress(ws);
  const first = !existsSync(fileOf(ws)) && emptyBooks(books);
  return { progress, opensItself: first || (!!progress.created && !progress.ready) };
}

/**
 * Books the setup conversation just created (src/onboarding/draft-store.ts): what it asked before
 * the books existed stands answered, so the conversation goes on at the next question.
 */
export function seedCreated(ws: Ws, seed: { started: string; vat: AnswerValue<'vat'>; sells: AnswerValue<'sells'> }, now: string): SetupProgress {
  let p: SetupProgress = { ...emptyProgress(), started: seed.started, created: now };
  p = withAnswer(p, 'company', { value: 'ok', at: now });
  p = withAnswer(p, 'vat', { value: seed.vat, at: now });
  p = withAnswer(p, 'sells', { value: seed.sells, at: now });
  return write(ws, p);
}

/** «Los geht's»: the setup ends; the books open as books from now on. */
export function finishSetup(ws: Ws, now: string): SetupProgress {
  const p = readProgress(ws);
  if (p.ready) return p;
  return write(ws, { ...p, started: p.started ?? now, ready: now });
}

/** The setup opened: the file exists from now on, so the first start does not open it again by itself. */
export function startSetup(ws: Ws, now: string): SetupProgress {
  const p = readProgress(ws);
  if (p.started && existsSync(fileOf(ws))) return p;
  return write(ws, { ...p, started: p.started ?? now });
}

export function markTopic(ws: Ws, topic: SetupTopic, state: TopicState, now: string): { progress: SetupProgress; was: TopicState } {
  const p = readProgress(ws);
  const was = p.topics[topic].state;
  if (was === state) return { progress: p, was };
  return { progress: write(ws, withTopic({ ...p, started: p.started ?? now }, topic, state, now)), was };
}

/** The conversation the setup runs in; a later one replaces it (the person started the setup conversation anew). */
export function rememberConversation(ws: Ws, id: string, now: string): void {
  const p = readProgress(ws);
  if (p.conversation === id) return;
  write(ws, { ...p, started: p.started ?? now, conversation: id });
}

/** An answer to one of the conversation's questions, or none (`undefined`: taken back); the previous answer, for an undo. */
export function answerQuestion<Q extends QuestionId>(ws: Ws, q: Q, answer: Answer<Q> | undefined, now: string): { progress: SetupProgress; was: Answer<Q> | undefined } {
  const p = readProgress(ws);
  const was = p.answers[q] as Answer<Q> | undefined;
  if (JSON.stringify(was) === JSON.stringify(answer)) return { progress: p, was };
  return { progress: write(ws, withAnswer({ ...p, started: p.started ?? now }, q, answer)), was };
}
