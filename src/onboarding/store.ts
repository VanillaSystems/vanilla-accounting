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
import { emptyProgress, parseProgress, withAnswer, withTopic, type Answer, type Assumed, type PrivateShares, type QuestionId, type SetupProgress, type SetupTopic, type TopicState } from './model.js';
import type { SetupView } from './facts.js';
import type { QuestionKey } from '../workspace/setup.js';

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
  // Not opened yet: no file, or one the form wrote with what it assumed (seedAssumed), which opens nothing.
  const first = (!existsSync(fileOf(ws)) || !progress.started) && emptyBooks(books);
  return { progress, opensItself: first || (!!progress.created && !progress.ready) };
}

/**
 * Books the setup conversation just created (src/onboarding/draft-store.ts). What it asked before the
 * books existed is in the settings now, and the conversation in the books shows it from there without
 * asking (#345), so no answer is recorded: only that these books open into the setup until «Los geht's».
 */
export function seedCreated(ws: Ws, seed: { started: string; assumed?: Assumed; shares?: PrivateShares }, now: string): SetupProgress {
  return write(ws, { ...emptyProgress(), started: seed.started, created: now, ...(seed.assumed ? { assumed: seed.assumed } : {}), ...(seed.shares ? { shares: seed.shares } : {}) });
}

/**
 * Books the form just created (#385): what the kind of firm answered and the person never touched, so
 * the conversation in the books marks it «angenommen». Not `started`: the setup still opens by itself.
 */
export function seedAssumed(ws: Ws, assumed: Assumed | undefined): void {
  if (!assumed) return;
  write(ws, { ...readProgress(ws), assumed });
}

/** «stimmt» beside an assumed answer (#387 review): it is hers now, so it is no longer marked. */
export function confirmAssumed(ws: Ws, key: QuestionKey): SetupProgress {
  const p = readProgress(ws);
  if (!p.assumed || p.assumed.answers[key] === undefined) return p;
  const { [key]: _gone, ...answers } = p.assumed.answers;
  const { assumed: _a, ...rest } = p;
  return write(ws, Object.keys(answers).length ? { ...rest, assumed: { ...p.assumed, answers } } : rest);
}

/** The private shares of the setup as they stand now (#402): a share goes once a rule took it or she said «Nie». */
export function setShares(ws: Ws, shares: PrivateShares | undefined): SetupProgress {
  const { shares: _old, ...rest } = readProgress(ws);
  return write(ws, shares && Object.keys(shares).length ? { ...rest, shares } : rest);
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
