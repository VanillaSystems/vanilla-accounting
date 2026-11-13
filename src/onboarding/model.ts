/**
 * The setup checklist (docs/0.4.0/onboarding.md): the topics a new workspace is set up by, each
 * open, done or skipped. The AI runs the setup conversation, but this list is the code's: the
 * conversation reads it, advances it with a `setupTopic` change, and a person can mark a topic by
 * hand. Kept in the workspace (onboarding.json, src/onboarding/store.ts), so progress survives a
 * restart. Pure, shared by the server, the prompt and the UI.
 */

import { parseVatSetup, type VatSetup } from '../workspace/vat-setup.js';
import { PRESET_NAMES, QUESTIONS as SETUP_QUESTIONS, QUESTION_ORDER, optionOf, salesKinds, type Preset, type QuestionKey, type SalesKind } from '../workspace/setup.js';

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
  /**
   * The setup's answers the kind of firm gave and the person never touched (#385), by the form or the
   * setup conversation that created the books: shown «angenommen» in the books, as before them. `by`:
   * the kind of firm, absent when «Etwas anderes» assumed them.
   */
  assumed?: Assumed;
  /** The private shares the person named in the setup (#402), kept until a rule of the business can take them (src/saving/share-rule.ts). */
  shares?: PrivateShares;
}

/** What may be used privately (the setup's privateUse), and the share of it the person named in her words: the percent, and her words as she said them. */
export type PrivateShares = Partial<Record<'car' | 'phone', PrivateShare>>;

/** One share: the percent, the words of hers that named it (empty when they could not be told apart), and the businesses she said «Nicht jetzt» to. */
export interface PrivateShare { percent: number; said: string; dismissed?: string[] }

/** Shares as read from disk or from the model: a whole percent between 1 and 99 for car or phone; her words cut to 300 characters. Undefined when none is left. */
export function parseShares(raw: unknown): PrivateShares | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: PrivateShares = {};
  for (const item of ['car', 'phone'] as const) {
    const v = (raw as Record<string, unknown>)[item] as { percent?: unknown; said?: unknown; dismissed?: unknown } | undefined;
    const percent = typeof v?.percent === 'number' ? Math.round(v.percent) : NaN;
    const dismissed = Array.isArray(v?.dismissed) ? v.dismissed.filter((d): d is string => typeof d === 'string') : [];
    if (percent >= 1 && percent <= 99) out[item] = { percent, said: typeof v?.said === 'string' ? v.said.slice(0, 300) : '', ...(dismissed.length && { dismissed }) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Each assumed answer as it was given (a list for a question of several answers), so one changed since is no longer marked. */
export interface Assumed { answers: Partial<Record<QuestionKey, string | string[]>>; by?: Exclude<Preset, 'custom'> }

/** An `assumed` as read from disk or a request: unknown questions, answers and kinds left out; undefined when none is left. */
export function parseAssumed(raw: unknown): Assumed | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const given = r.answers && typeof r.answers === 'object' ? r.answers as Record<string, unknown> : {};
  const answers: Assumed['answers'] = {};
  for (const k of QUESTION_ORDER) {
    const v = given[k];
    const multi = 'multi' in SETUP_QUESTIONS[k];
    if (multi ? Array.isArray(v) && v.every((x) => typeof x === 'string' && optionOf(k, x)) : typeof v === 'string' && optionOf(k, v)) answers[k] = v as string | string[];
  }
  const by = typeof r.by === 'string' && r.by !== 'custom' && PRESET_NAMES.includes(r.by as Preset) ? r.by as Assumed['by'] : undefined;
  return Object.keys(answers).length ? { answers, ...(by ? { by } : {}) } : undefined;
}

/** The answers of `keys` as `answers` gives them, kept as assumed; undefined when none has an answer. */
export const assumedOf = (keys: readonly QuestionKey[], answers: Partial<Record<QuestionKey, unknown>>, by?: Preset): Assumed | undefined =>
  parseAssumed({ answers: Object.fromEntries(keys.map((k) => [k, answers[k]])), by });

/** The assumed answers the firm still has: those equal to what is set up now (`now`, the manifest's answers), in question order. */
export function stillAssumed(a: Assumed | undefined, now: Partial<Record<QuestionKey, unknown>>): Array<{ key: QuestionKey; value: string | string[] }> {
  if (!a) return [];
  const same = (x: unknown, y: unknown) => JSON.stringify(Array.isArray(x) ? [...x].sort() : x) === JSON.stringify(Array.isArray(y) ? [...y].sort() : y);
  return QUESTION_ORDER.flatMap((key) => (a.answers[key] !== undefined && same(a.answers[key], now[key]) ? [{ key, value: a.answers[key]! }] : []));
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

/**
 * The words of a topic or a question as a stored turn names it. A conversation kept by an earlier
 * version names topics and questions this one no longer has (`periods`, `history`, `start`, `filed`, …):
 * those get one generic sentence, never a key the dictionary lacks, which would throw while the
 * setup opens by itself (review of #352).
 */
export const topicWordsKey = (topic: unknown): string => (isSetupTopic(topic) ? `onboarding.topic.${topic}` : 'onboarding.topic.gone');
export const questionWordsKey = (question: unknown): string => (isQuestion(question) ? `onboarding.question.${question}` : 'onboarding.question.gone');
export const stateWordsKey = (state: unknown): string => `onboarding.state.${isTopicState(state) ? state : 'open'}`;

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
  const assumed = parseAssumed(r.assumed);
  if (assumed) out.assumed = assumed;
  const shares = parseShares(r.shares);
  if (shares) out.shares = shares;
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
