/**
 * The setup checklist (docs/0.4.0/onboarding.md): the topics a new workspace is set up by, each
 * open, done or skipped. The AI runs the setup conversation, but this list is the code's: the
 * conversation reads it, advances it with a `setupTopic` change, and a person can mark a topic by
 * hand. Kept in the workspace (onboarding.json, src/onboarding/store.ts), so progress survives a
 * restart. Pure, shared by the server, the prompt and the UI.
 */

import { parseVatSetup, type VatSetup } from '../workspace/vat-setup.js';
import { salesKinds, type SalesKind } from '../workspace/setup.js';

/**
 * In the order the conversation takes them. Only what the app can do something with (#345): when the
 * books begin the first statement says, and the old program's data has no import, so neither is a topic.
 */
export const SETUP_TOPICS = ['firm', 'opening', 'bank', 'receipts', 'knowledge'] as const;
export type SetupTopic = typeof SETUP_TOPICS[number];

export const TOPIC_STATES = ['open', 'done', 'skipped'] as const;
export type TopicState = typeof TOPIC_STATES[number];

export interface TopicProgress {
  state: TopicState;
  /** When it was last marked done or skipped. */
  at?: string;
}

export interface SetupProgress {
  /** When the setup was first opened; absent while it never was. */
  started?: string;
  /** The setup conversation (data/assistant/<id>.json), so reopening continues it. */
  conversation?: string;
  /**
   * When the setup conversation created these books (#139, src/onboarding/draft.ts); absent for books
   * set up by the form or `npm run init`. Until `ready`, opening the books continues the setup.
   */
  created?: string;
  /** When the person ended the setup with «Los geht's»: from then on only «Einrichtung fortsetzen» opens it. */
  ready?: string;
  topics: Record<SetupTopic, TopicProgress>;
  /** The person's answers to the conversation's questions (src/onboarding/conversation.ts), by question. */
  answers: Answers;
}

/**
 * The conversation's questions and the answers each takes, in the order it asks them. A question
 * whose answer only acknowledges a card («Weiter», «Später») is one too: its answer is the step
 * passed, so the conversation knows where it stands after a restart.
 */
export const QUESTIONS = {
  /** The firm as the app has it is shown, not asked: `fix` («Etwas ändern») opens the VAT and the sales question; `ok` is what older books answered. */
  company: ['ok', 'fix'],
  vat: ['none', 'effective', 'net-rate', 'unknown'],
  /** «Was verkauft ihr?» (#46): the kinds chosen, in SALES_KINDS order, joined by «+» (sellsAnswer). */
  sells: ['made', 'traded', 'services', 'made+traded', 'made+services', 'traded+services', 'made+traded+services'],
  opening: ['next', 'later'],
  bank: ['next', 'later'],
  receipts: ['next', 'later'],
  partners: ['next'],
} as const satisfies Record<string, readonly string[]>;
export type QuestionId = keyof typeof QUESTIONS;
export type AnswerValue<Q extends QuestionId = QuestionId> = (typeof QUESTIONS)[Q][number];
export const QUESTION_IDS = Object.keys(QUESTIONS) as QuestionId[];

export interface Answer<Q extends QuestionId = QuestionId> {
  value: AnswerValue<Q>;
  at: string;
  /** The VAT setup before the person kept the answer's change («Übernehmen»), for its «Rückgängig»; absent while not kept. */
  kept?: { before: VatSetup; at: string };
}
export type Answers = { [Q in QuestionId]?: Answer<Q> };

/** The kinds an answer to `sells` names, and the answer of the kinds. */
export const kindsOfAnswer = (value: string): SalesKind[] => salesKinds(value.split('+'));
export const sellsAnswer = (kinds: readonly SalesKind[]): AnswerValue<'sells'> => salesKinds(kinds).join('+') as AnswerValue<'sells'>;

export const isQuestion = (s: unknown): s is QuestionId => typeof s === 'string' && Object.hasOwn(QUESTIONS, s);
export const isAnswerOf = <Q extends QuestionId>(q: Q, v: unknown): v is AnswerValue<Q> => (QUESTIONS[q] as readonly unknown[]).includes(v);

export const isSetupTopic = (s: unknown): s is SetupTopic => (SETUP_TOPICS as readonly unknown[]).includes(s);
export const isTopicState = (s: unknown): s is TopicState => (TOPIC_STATES as readonly unknown[]).includes(s);

export const emptyProgress = (): SetupProgress => ({
  topics: Object.fromEntries(SETUP_TOPICS.map((t) => [t, { state: 'open' }])) as Record<SetupTopic, TopicProgress>,
  answers: {},
});

/** onboarding.json as read from disk: what it does not know (a topic of a later version, a bad state) is left out, never thrown. */
export function parseProgress(raw: unknown): SetupProgress {
  const out = emptyProgress();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.started === 'string') out.started = r.started;
  if (typeof r.conversation === 'string' && r.conversation) out.conversation = r.conversation;
  if (typeof r.created === 'string') out.created = r.created;
  if (typeof r.ready === 'string') out.ready = r.ready;
  const topics = r.topics && typeof r.topics === 'object' ? (r.topics as Record<string, unknown>) : {};
  for (const topic of SETUP_TOPICS) {
    const p = topics[topic] as Record<string, unknown> | undefined;
    if (!p || !isTopicState(p.state)) continue;
    out.topics[topic] = { state: p.state, ...(p.state !== 'open' && typeof p.at === 'string' ? { at: p.at } : {}) };
  }
  const answers = r.answers && typeof r.answers === 'object' ? (r.answers as Record<string, unknown>) : {};
  for (const q of QUESTION_IDS) {
    const a = answers[q] as Record<string, unknown> | undefined;
    if (!a || !isAnswerOf(q, a.value) || typeof a.at !== 'string') continue;
    const kept = a.kept as { before?: unknown; at?: unknown } | undefined;
    const before = kept && typeof kept.at === 'string' ? keptVat(kept.before) : undefined;
    (out.answers as Record<string, Answer>)[q] = { value: a.value, at: a.at, ...(before && kept ? { kept: { before, at: kept.at as string } } : {}) };
  }
  return out;
}

/** A VAT setup kept for an undo, checked as the manifest checks it; undefined when it does not parse. */
function keptVat(raw: unknown): VatSetup | undefined {
  try { return parseVatSetup(raw, (msg) => { throw new Error(msg); }); } catch { return undefined; }
}

export function withAnswer<Q extends QuestionId>(p: SetupProgress, q: Q, answer: Answer<Q> | undefined): SetupProgress {
  const answers = { ...p.answers } as Record<string, Answer>;
  if (answer) answers[q] = answer; else delete answers[q];
  return { ...p, answers: answers as Answers };
}

export function withTopic(p: SetupProgress, topic: SetupTopic, state: TopicState, at: string): SetupProgress {
  return { ...p, topics: { ...p.topics, [topic]: state === 'open' ? { state } : { state, at } } };
}

/** Each topic's state, as `topicStates` (src/onboarding/conversation.ts) sees it or as marked. */
export type TopicStates = Record<SetupTopic, TopicState>;

/** The states as marked, by the AI or by hand: what `topicStates` starts from. */
export const markedStates = (p: SetupProgress): TopicStates => Object.fromEntries(SETUP_TOPICS.map((t) => [t, p.topics[t].state])) as TopicStates;

/** The topic the conversation takes up next: the first still open. */
export const nextTopic = (s: TopicStates): SetupTopic | undefined => SETUP_TOPICS.find((t) => s[t] === 'open');

/** How many topics are done or skipped. */
export const settledCount = (s: TopicStates): number => SETUP_TOPICS.filter((t) => s[t] !== 'open').length;
