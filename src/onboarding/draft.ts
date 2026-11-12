/**
 * The setup before the books exist (#139): «Neue Buchhaltung anlegen» asks the folder and the
 * language, then the setup conversation asks what `createWorkspace` (src/workspace/create.ts) needs,
 * one step at a time, and keeps each answer in a draft in that folder (DRAFT_FILE, in its
 * vanilla-accounting/). The manifest is written once, when the draft is complete, by the same
 * `createWorkspace` the form calls: a folder holds a draft or books, never half a manifest.
 *
 * The draft is the state; `draftSteps` draws the conversation from it, up to the first step not
 * answered, so a setup broken off stands where it stood when the folder is opened again. Pure,
 * shared by the desktop server (src/onboarding/draft-store.ts) and the start screen.
 */
import { PRESETS, QUESTIONS, QUESTION_ORDER, VAT_QUESTIONS, asked, usualPeriod, type Answers, type Preset, type QuestionKey } from '../workspace/setup.js';
import type { NetRate } from '../workspace/vat-setup.js';
import type { BankSpec, SetupRequest } from '../workspace/create.js';
import type { KnownBooks } from '../types/desktop.js';

export const DRAFT_FILE = 'setup-draft.json';

/** Who the firm is: what the manifest's `company` needs before anything else. */
export interface Firm { name: string; uid: string; owner: string }

export interface SetupDraft {
  started: string;
  /** The books' language, chosen with the folder. */
  language: string;
  firm?: Firm;
  /**
   * What the person's words said of the firm while it is not whole (#345): a firm is saved only with
   * its UID, so a name and an owner given before it wait here, and the UID alone completes them.
   * Absent once `firm` is saved.
   */
  said?: Partial<Firm>;
  preset?: Preset;
  /** The answers of src/workspace/setup.ts: those of the preset, and those the person gave. */
  answers: Partial<Answers>;
  netRates?: NetRate[];
  banks?: BankSpec[];
  /** The answers the AI took from the person's own words (#145), shown «aus deiner Nachricht» until the person changes them. */
  fromText?: StepMark[];
}

/** One answer of the draft, as the setup conversation marks it: a step, or a question by its key. */
export type StepMark = 'firm' | 'preset' | QuestionKey | 'netRates' | 'banks';

export type QuestionValue = string | readonly string[];

/** A step of the conversation before the books exist; `answer` absent: the step waits for it. */
export type DraftStep =
  | { id: 'firm'; answer?: Firm }
  | { id: 'preset'; answer?: Preset }
  | { id: 'question'; key: QuestionKey; answer?: QuestionValue; suggested?: QuestionValue }
  | { id: 'netRates'; answer?: NetRate[] }
  | { id: 'banks'; answer?: BankSpec[] }
  /** Everything is answered: what «Buchhaltung anlegen» sends to createWorkspace. */
  | { id: 'review'; request: Omit<SetupRequest, 'root'> };

/** One answer given or taken back (`null`), as the start screen sends it; the server checks it (draft-store.ts checkPatch). */
export type DraftPatch =
  | { step: 'firm'; value: Firm | null }
  | { step: 'preset'; value: Preset | null }
  | { step: 'question'; key: QuestionKey; value: QuestionValue | null }
  | { step: 'netRates'; value: NetRate[] | null }
  | { step: 'banks'; value: BankSpec[] | null };

export const isStepMark = (m: unknown): m is StepMark =>
  typeof m === 'string' && (['firm', 'preset', 'netRates', 'banks'].includes(m) || Object.hasOwn(QUESTIONS, m));

export const markOf = (p: DraftPatch): StepMark => (p.step === 'question' ? p.key : p.step);

/** A setup in progress before its books exist, as /api/desktop/setup returns it; `baseCurrency`: the jurisdiction's, a bank account's first proposal. */
export interface SetupDraftView { root: string; draft: SetupDraft; baseCurrency: string }

/** POST /api/desktop/setup: the setup in that folder, or the books already there, opened. */
export type SetupBegun = { kind: 'draft'; view: SetupDraftView } | { kind: 'books'; books: KnownBooks };

export const newDraft = (language: string, now: string): SetupDraft => ({ started: now, language, answers: {} });

const isVat = (k: QuestionKey) => (VAT_QUESTIONS as readonly string[]).includes(k);
const presetAnswers = (p: Preset): Partial<Answers> => PRESETS[p].answers as Partial<Answers>;

/** Whether `key` holds an answer: a multiple choice that needs one needs it non-empty. */
function answered(key: QuestionKey, a: Partial<Answers>): boolean {
  const q = QUESTIONS[key] as { multi?: boolean; required?: boolean };
  const v = a[key];
  return q.multi && q.required ? ([] as string[]).concat(v ?? []).length > 0 : v !== undefined;
}

/**
 * The questions the conversation asks one by one: the VAT questions always (they decide the books'
 * whole setup, so a preset only suggests them), the others only without a preset that answers them.
 */
export function askedQuestions(d: SetupDraft): QuestionKey[] {
  const given = d.preset ? presetAnswers(d.preset) : {};
  return QUESTION_ORDER.filter((k) => asked(k, d.answers) && (isVat(k) || d.preset === 'custom' || given[k] === undefined));
}

const netRateMethod = (a: Partial<Answers>) => a.vatRegistered === 'yes' && a.vatMethod === 'net-rate';

/** What the conversation proposes for a VAT question: the preset's answer; the period follows the method (r5f-14). */
function suggestion(d: SetupDraft, key: QuestionKey): QuestionValue | undefined {
  if (key === 'period' && d.answers.vatMethod) return usualPeriod(d.answers.vatMethod);
  return d.preset ? presetAnswers(d.preset)[key] : undefined;
}

/** The answers createWorkspace takes: only those of questions asked, so a VAT method left from «yes» is gone after «no». */
const askedAnswers = (a: Partial<Answers>): Answers =>
  Object.fromEntries(QUESTION_ORDER.filter((k) => a[k] !== undefined && asked(k, a)).map((k) => [k, a[k]])) as Answers;

/** The request the draft makes once every step is answered; undefined while one waits. */
export function requestOf(d: SetupDraft): Omit<SetupRequest, 'root'> | undefined {
  if (!d.firm || !d.preset || !d.banks?.length) return undefined;
  if (QUESTION_ORDER.some((k) => asked(k, d.answers) && !answered(k, d.answers))) return undefined;
  if (netRateMethod(d.answers) && !d.netRates?.length) return undefined;
  return {
    preset: d.preset, name: d.firm.name, uid: d.firm.uid, owner: d.firm.owner, language: d.language,
    answers: askedAnswers(d.answers), ...(netRateMethod(d.answers) ? { netRates: d.netRates } : {}), banks: d.banks,
  };
}

/** Every step this draft is asked, answered or not, in order. */
function allSteps(d: SetupDraft): DraftStep[] {
  return [
    { id: 'firm', ...(d.firm ? { answer: d.firm } : {}) },
    { id: 'preset', ...(d.preset ? { answer: d.preset } : {}) },
    ...askedQuestions(d).map((key): DraftStep => {
      const suggested = suggestion(d, key);
      return { id: 'question', key, ...(answered(key, d.answers) ? { answer: d.answers[key] } : {}), ...(suggested !== undefined ? { suggested } : {}) };
    }),
    ...(netRateMethod(d.answers) ? [{ id: 'netRates', ...(d.netRates?.length ? { answer: d.netRates } : {}) } as DraftStep] : []),
    { id: 'banks', ...(d.banks?.length ? { answer: d.banks } : {}) },
  ];
}

/**
 * How far the person is (#345): the steps answered, of those this draft is asked. `of` can still grow
 * (a preset not chosen yet, «registered» opening the VAT questions): it is the count as the answers stand.
 */
export function draftProgress(d: SetupDraft): { done: number; of: number } {
  const all = allSteps(d);
  return { done: all.filter((s) => 'answer' in s).length, of: all.length };
}

/** The questions answered and those still open, by key, in the order asked: what the AI is told, so it asks nothing a click answered. */
export function draftMarks(d: SetupDraft): { answered: StepMark[]; open: StepMark[] } {
  const mark = (s: DraftStep): StepMark => (s.id === 'question' ? s.key : (s.id as StepMark));
  const all = allSteps(d);
  return { answered: all.filter((s) => 'answer' in s).map(mark), open: all.filter((s) => !('answer' in s)).map(mark) };
}

/** The conversation so far: every step in order, up to and with the first one not answered (the review once all are). */
export function draftSteps(d: SetupDraft): DraftStep[] {
  const all = allSteps(d);
  const open = all.findIndex((s) => !('answer' in s));
  if (open >= 0) return all.slice(0, open + 1);
  const request = requestOf(d);
  return request ? [...all, { id: 'review', request }] : all;
}

/**
 * The draft after an answer. A preset fills the answers it has, but never the VAT ones and never one
 * the person's own words gave (`fromText`: «wir verrechnen das Material mit» holds whichever kind of
 * firm is picked after it, #345); «custom» keeps what is there. Taking back an answer the preset gave
 * turns the preset into «custom», so that question is asked in the conversation, with the others the
 * preset answered shown as given.
 */
export function withPatch(d: SetupDraft, patch: DraftPatch): SetupDraft {
  const next = answer(d, patch);
  // A person's answer is theirs, no longer one taken from their words.
  const marks = (d.fromText ?? []).filter((m) => m !== markOf(patch));
  delete next.fromText;
  return marks.length ? { ...next, fromText: marks } : next;
}

function answer(d: SetupDraft, patch: DraftPatch): SetupDraft {
  const without = <K extends keyof SetupDraft>(k: K): SetupDraft => { const next = { ...d }; delete next[k]; return next; };
  switch (patch.step) {
    case 'firm': { const { said: _said, ...rest } = d; return patch.value ? { ...rest, firm: patch.value } : without('firm'); }
    case 'netRates': return patch.value ? { ...d, netRates: patch.value } : without('netRates');
    case 'banks': return patch.value ? { ...d, banks: patch.value } : without('banks');
    case 'preset': {
      if (!patch.value) return without('preset');
      if (patch.value === 'custom') return { ...d, preset: 'custom' };
      const kept = Object.fromEntries(QUESTION_ORDER.filter((k) => d.answers[k] !== undefined && (isVat(k) || d.fromText?.includes(k))).map((k) => [k, d.answers[k]]));
      const given = Object.fromEntries(Object.entries(presetAnswers(patch.value)).filter(([k]) => !isVat(k as QuestionKey)));
      return { ...d, preset: patch.value, answers: { ...given, ...kept } as Partial<Answers> };
    }
    case 'question': {
      const answers = { ...d.answers } as Record<string, QuestionValue>;
      if (patch.value === null) delete answers[patch.key]; else answers[patch.key] = patch.value;
      const hidden = patch.value === null && !!d.preset && d.preset !== 'custom' && !isVat(patch.key);
      return { ...d, answers: answers as Partial<Answers>, ...(hidden ? { preset: 'custom' as const } : {}) };
    }
  }
}
