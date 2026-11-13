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
import { PRESETS, QUESTIONS, QUESTION_ORDER, VAT_QUESTIONS, asked, inSetup, notRegistered, unsteered, usualPeriod, type Answers, type Preset, type QuestionKey } from '../workspace/setup.js';
import type { NetRate } from '../workspace/vat-setup.js';
import type { BankSpec, SetupRequest } from '../workspace/create.js';
import type { KnownBooks } from '../types/desktop.js';
import type { PrivateShares } from './model.js';

export const DRAFT_FILE = 'setup-draft.json';

/** Who the firm is: what the manifest's `company` needs before anything else. The UID only when her words gave it: the setup does not ask it (#452). */
export interface Firm { name: string; uid?: string; owner: string }

export interface SetupDraft {
  started: string;
  /** The books' language, chosen with the folder. */
  language: string;
  firm?: Firm;
  /**
   * What the person's words said of the firm while it is not whole (#345): a firm is saved with its
   * name and its owner, so one given before the other waits here, and the other completes it.
   * Absent once `firm` is saved.
   */
  said?: Partial<Firm>;
  preset?: Preset;
  /** The answers of src/workspace/setup.ts: those of the preset, and those the person gave. */
  answers: Partial<Answers>;
  netRates?: NetRate[];
  banks?: BankSpec[];
  /**
   * The unusual filing period the words named and code did not take (src/onboarding/draft-talk.ts): said
   * once; the model repeating it from the same earlier words raises nothing again. Gone once the period is answered.
   */
  refusedPeriod?: string;
  /** The answers the AI took from the person's own words (#145), shown «aus deiner Nachricht» until the person changes them. */
  fromText?: StepMark[];
  /**
   * The answers the kind of firm gave and the person never said (#364): shown «angenommen» on the review
   * until she answers them herself, so she knows which to check. Absent: none.
   */
  assumed?: QuestionKey[];
  /** The kind of firm that gave `assumed`: named on the review although the preset is «Etwas anderes» since (#364). */
  assumedBy?: Exclude<Preset, 'custom'>;
  /**
   * The kind of firm she picked, when a changed answer made the preset «Etwas anderes» since (#402): the
   * review still names her kind, «mit einer Änderung». Absent while the preset is her pick, or she picked «Etwas anderes».
   */
  chosen?: Exclude<Preset, 'custom'>;
  /** The private share of the phone or the car her words named (#402): kept with the books in onboarding.json, never in the settings. */
  shares?: PrivateShares;
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
 * whole setup, so a preset only suggests them), the others only without a preset that answers them,
 * and none the setup does not ask (#452): those take their `later` answer.
 */
export function askedQuestions(d: SetupDraft): QuestionKey[] {
  const given = d.preset ? presetAnswers(d.preset) : {};
  return QUESTION_ORDER.filter((k) => inSetup(k) && asked(k, d.answers) && (isVat(k) || d.preset === 'custom' || given[k] === undefined));
}

const netRateMethod = (a: Partial<Answers>) => a.vatRegistered === 'yes' && a.vatMethod === 'net-rate';

/** What the conversation proposes for a VAT question: the preset's answer; the period follows the method (r5f-14). */
function suggestion(d: SetupDraft, key: QuestionKey): QuestionValue | undefined {
  if (unsteered(key)) return undefined;
  if (key === 'period' && d.answers.vatMethod) return usualPeriod(d.answers.vatMethod);
  return d.preset ? presetAnswers(d.preset)[key] : undefined;
}

/** The answers createWorkspace takes: only those of questions asked, so a VAT method left from «yes» is gone after «no». */
const askedAnswers = (a: Partial<Answers>): Answers =>
  Object.fromEntries(QUESTION_ORDER.filter((k) => a[k] !== undefined && asked(k, a)).map((k) => [k, a[k]])) as Answers;

/** The request the draft makes once every step is answered; undefined while one waits. */
export function requestOf(d: SetupDraft): Omit<SetupRequest, 'root'> | undefined {
  if (!d.firm || !d.preset || !d.banks?.length) return undefined;
  if (QUESTION_ORDER.some((k) => inSetup(k) && asked(k, d.answers) && !answered(k, d.answers))) return undefined;
  if (netRateMethod(d.answers) && !d.netRates?.length) return undefined;
  return {
    preset: d.preset, name: d.firm.name, ...(d.firm.uid ? { uid: d.firm.uid } : {}), owner: d.firm.owner, language: d.language,
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
 * The parts of the setup before the books (#364), the same for every firm: who the firm is, what kind of
 * firm (the preset and, for «Etwas anderes», its questions), the VAT, the bank. How many questions a part
 * holds depends on the answers (registered or not, the method), so the count is of parts, never of
 * questions: it never jumps and never shrinks unless she takes an answer back.
 */
export const DRAFT_PHASES = ['firm', 'kind', 'vat', 'banks'] as const;
export type DraftPhase = (typeof DRAFT_PHASES)[number];

const phaseOf = (s: DraftStep): DraftPhase =>
  s.id === 'firm' || s.id === 'banks' ? s.id : s.id === 'netRates' || (s.id === 'question' && isVat(s.key)) ? 'vat' : 'kind';

/** How far the person is: each part done (every step of it answered) or not, and the part the open step belongs to. */
export function draftProgress(d: SetupDraft): { done: number; of: number; phases: Record<DraftPhase, boolean>; next?: DraftPhase } {
  const all = allSteps(d);
  const phases = Object.fromEntries(DRAFT_PHASES.map((p) => [p, all.filter((s) => phaseOf(s) === p).every((s) => 'answer' in s)])) as Record<DraftPhase, boolean>;
  const open = all.find((s) => !('answer' in s));
  return { done: DRAFT_PHASES.filter((p) => phases[p]).length, of: DRAFT_PHASES.length, phases, ...(open ? { next: phaseOf(open) } : {}) };
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
  // A person's answer is theirs, no longer one taken from their words, nor one the kind of firm assumed.
  const marks = (d.fromText ?? []).filter((m) => m !== markOf(patch));
  const assumed = (next.assumed ?? []).filter((k) => k !== markOf(patch));
  const by = next.assumedBy;
  delete next.fromText;
  delete next.assumed;
  delete next.assumedBy;
  return { ...next, ...(marks.length ? { fromText: marks } : {}), ...(assumed.length ? { assumed, ...(by ? { assumedBy: by } : {}) } : {}) };
}

/**
 * The kind of firm the review names (#402): her pick, also after a changed answer made the preset
 * «custom» (`chosen`), with how many of its answers differ now; undefined before a kind is picked.
 */
export function kindOf(d: Pick<SetupDraft, 'preset' | 'chosen' | 'answers'>): { kind: Preset; changes: number } | undefined {
  if (!d.preset) return undefined;
  if (d.preset !== 'custom' || !d.chosen) return { kind: d.preset, changes: 0 };
  const given = presetAnswers(d.chosen);
  const changes = QUESTION_ORDER.filter((k) => !isVat(k) && given[k] !== undefined && JSON.stringify(given[k]) !== JSON.stringify(d.answers[k])).length;
  return { kind: d.chosen, changes };
}

/** The answers the kind of firm gave that the person did not say herself (#364). */
export const assumedOf = (d: SetupDraft): QuestionKey[] => (d.assumed ?? []).filter((k) => d.answers[k] !== undefined && asked(k, d.answers));

function answer(d: SetupDraft, patch: DraftPatch): SetupDraft {
  const without = <K extends keyof SetupDraft>(k: K): SetupDraft => { const next = { ...d }; delete next[k]; return next; };
  switch (patch.step) {
    case 'firm': { const { said: _said, ...rest } = d; return patch.value ? { ...rest, firm: patch.value } : without('firm'); }
    case 'netRates': return patch.value ? { ...d, netRates: patch.value } : without('netRates');
    case 'banks': return patch.value ? { ...d, banks: patch.value } : without('banks');
    case 'preset': {
      if (!patch.value) { const { chosen: _c, preset: _p, ...rest } = d; return rest; }
      if (patch.value === 'custom') { const { chosen: _c, ...rest } = d; return { ...rest, preset: 'custom' }; }
      const kept = Object.fromEntries(QUESTION_ORDER.filter((k) => d.answers[k] !== undefined && (isVat(k) || d.fromText?.includes(k))).map((k) => [k, d.answers[k]]));
      const given = Object.fromEntries(Object.entries(presetAnswers(patch.value)).filter(([k]) => !isVat(k as QuestionKey)));
      const assumed = QUESTION_ORDER.filter((k) => k in given && !(k in kept));
      const { chosen: _c, ...rest } = d;
      return { ...rest, preset: patch.value, answers: { ...given, ...kept } as Partial<Answers>, assumed, assumedBy: patch.value };
    }
    case 'question': {
      const answers = { ...d.answers } as Record<string, QuestionValue>;
      if (patch.value === null) delete answers[patch.key]; else answers[patch.key] = patch.value;
      if (patch.key === 'period' && patch.value !== null && d.refusedPeriod) { const { refusedPeriod: _r, ...rest } = d; d = rest; }
      const hidden = patch.value === null && !!d.preset && d.preset !== 'custom' && !isVat(patch.key);
      // Her kind stays named on the review (#402): the preset becomes «custom» only so the question is asked again.
      const chosen = hidden ? { chosen: d.preset as Exclude<Preset, 'custom'> } : {};
      // Not registered, by «nein» or by the answer «we file no VAT returns» (#347): the questions of a registered firm and its rates go.
      if (patch.key === 'vatRegistered' && patch.value === 'no') {
        const { netRates: _rates, ...rest } = d;
        return { ...rest, answers: notRegistered(answers as Partial<Answers>), ...(hidden ? { preset: 'custom' as const, ...chosen } : {}) };
      }
      return { ...d, answers: answers as Partial<Answers>, ...(hidden ? { preset: 'custom' as const, ...chosen } : {}) };
    }
  }
}
