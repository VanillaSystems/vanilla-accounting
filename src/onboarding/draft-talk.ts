/**
 * What the person types in the setup conversation before the books exist (#145). The AI reads the
 * words with the draft, the step waiting and every value code accepts, and answers one JSON object:
 * its words (`say`: an answer to a question, or one short question back) and the answers the words
 * state. Code stays the authority: each proposed answer goes through checkPatch and withPatch, the
 * click's own path, before it is saved; a UID or an IBAN must stand in the person's own words; an
 * answer code refuses is explained back and never saved. `talkDraft` is the one call: the text goes
 * to the provider the person configured for the step (src/llm), and to no one else.
 */
import { join } from 'node:path';
import type { AskOptions } from '../llm/ask.js';
import { SetupError, type BankSpec, type SetupRefusal } from '../workspace/create.js';
import { BANKS } from '../workspace/banks.js';
import { PRESETS, PRESET_NAMES, QUESTIONS, QUESTION_ORDER, VAT_QUESTIONS, optionOf, type QuestionKey } from '../workspace/setup.js';
import { APP_FOLDER } from '../workspace/workspace.js';
import { checkPatch, draftView, readDraft, writeDraft } from './draft-store.js';
import { draftSteps, markOf, withPatch, type DraftPatch, type Firm, type SetupDraft, type SetupDraftView, type StepMark } from './draft.js';

/** A turn of the conversation typed so far, as the start screen keeps it; it is not saved. */
export interface TalkTurn { who: 'me' | 'ai'; text: string }

/** Why code did not take an answer the AI read from the words. */
export type TalkRefusal =
  | SetupRefusal
  /** A UID or an IBAN that is not in the person's words: the AI never fills one in. */
  | { reason: 'notStated'; field: 'uid' | 'iban'; detail: string }
  /** A value the question does not offer. */
  | { reason: 'notAnOption'; question: QuestionKey; value: string };

export type SetupReply =
  /** `filled`: the answers saved from the words; `firm`: what the words said of the firm, short of a whole one, for its card. */
  | { kind: 'read'; say: string; filled: StepMark[]; refused: Array<{ step: StepMark; refusal: TalkRefusal }>; firm?: Partial<Firm> }
  /** The model answered something other than the JSON asked for: nothing is saved. */
  | { kind: 'unreadable' }
  /** The model did not answer (no provider, a timeout): nothing is saved. */
  | { kind: 'failed'; detail: string };

/** POST /api/desktop/setup/talk: the draft after the message, and what the AI says to it. */
export interface SetupTalked { view: SetupDraftView; reply: SetupReply }

/** The model's answer as parsed at the boundary; each value is still unchecked. */
export interface TalkOutput {
  say: string;
  firm?: Partial<Record<keyof Firm, string>>;
  preset?: string;
  answers: Record<string, unknown>;
  netRates?: unknown;
  banks?: unknown;
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The JSON object in the model's text; undefined when there is none, or nothing in it. */
export function parseTalk(raw: string): TalkOutput | undefined {
  let j: unknown;
  try { j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return undefined; }
  if (!isMap(j)) return undefined;
  const given = isMap(j.firm) ? j.firm : {};
  const firm = Object.fromEntries((['name', 'uid', 'owner'] as const).flatMap((k) => { const v = str(given[k]); return v ? [[k, v]] : []; }));
  const out: TalkOutput = {
    say: typeof j.say === 'string' ? j.say.trim() : '',
    ...(Object.keys(firm).length ? { firm } : {}),
    ...(str(j.preset) ? { preset: str(j.preset) } : {}),
    answers: isMap(j.answers) ? j.answers : {},
    ...(j.netRates !== undefined && j.netRates !== null ? { netRates: j.netRates } : {}),
    ...(j.banks !== undefined && j.banks !== null ? { banks: j.banks } : {}),
  };
  const empty = !out.say && !out.firm && !out.preset && !Object.keys(out.answers).length && out.netRates === undefined && out.banks === undefined;
  return empty ? undefined : out;
}

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Whether `value` stands in the person's words: an IBAN whole, a UID by its nine digits. */
function stated(field: 'uid' | 'iban', value: string, words: readonly string[]): boolean {
  const said = words.map(alnum);
  const wanted = field === 'uid' ? value.replace(/\D/g, '') : alnum(value);
  return wanted.length > 0 && said.some((w) => w.includes(wanted));
}

const LANGUAGE = { de: 'German', fr: 'French', it: 'Italian', en: 'English' } as const;

const describe = (key: QuestionKey): string => {
  const q = QUESTIONS[key] as { ask: string; why: string; multi?: boolean; options: ReadonlyArray<{ value: string; label: string; unsupported?: string }> };
  const values = q.options.map((o) => `"${o.value}" (${o.label}${o.unsupported ? `; not supported: ${o.unsupported}` : ''})`).join(', ');
  const when = (VAT_QUESTIONS as readonly string[]).includes(key) && key !== 'vatRegistered' ? ' Only when vatRegistered is "yes".' : '';
  return `  - ${key}: ${q.ask}. ${q.why}${when} ${q.multi ? 'A list of any of' : 'One of'}: ${values}.`;
};

/** What the step waiting asks, in the model's words. */
function waiting(d: SetupDraft): string {
  const open = draftSteps(d).at(-1)!;
  if (open.id === 'question') return `answers.${open.key}`;
  return open.id === 'review' ? 'nothing: every answer is given, the person can create the books' : open.id;
}

/** The prompt for one typed message: the draft, the step waiting, every value code accepts, the turns so far. */
export function talkPrompt(d: SetupDraft, text: string, history: readonly TalkTurn[], baseCurrency: string): string {
  const { started: _started, language, fromText: _marks, ...draft } = d;
  const presets = PRESET_NAMES.map((p) => `  - ${p}: ${PRESETS[p].label}. Gives: ${JSON.stringify(PRESETS[p].answers)}`).join('\n');
  const turns = history.length ? history.map((t) => `${t.who === 'me' ? 'person' : 'you'}: ${t.text}`).join('\n') : '(none)';
  return `You help a person set up the bookkeeping of their Swiss company in Vanilla Accounting, before the books exist. They may give several answers at once, ask about the setup, or both.

The setup so far (JSON; a key that is missing is not answered yet):
${JSON.stringify(draft, null, 2)}

The step waiting now: ${waiting(d)}

What the setup asks, with the only values the app accepts:
- firm: {"name": company name, "uid": Swiss company number CHE-###.###.###, "owner": the owner's or managing director's name}
- preset: the kind of firm, one of:
${presets}
- answers:
${QUESTION_ORDER.map(describe).join('\n')}
- netRates: only with vatMethod "net-rate": the one or two net tax rates (Saldosteuersatz) the tax authority approved, in percent: [{"rate": 4.5, "label": "<activity>"}]
- banks: the company's bank accounts, the whole list (those already given too): [{"bank": "<name>", "currency": "${baseCurrency}", "iban": "<only when written>"}]. Known names: ${Object.keys(BANKS).join(', ')}; another bank by its own name.

The conversation so far:
${turns}

The person's message:
"""
${text}
"""

Rules:
- Take only what the message or the conversation so far states or plainly implies («zwei Angestellte»: employees "staff"; «registered for VAT»: vatRegistered "yes"; «Schreinerei»: they make products and sell services). Leave out what it does not say. Never guess.
- Never invent, complete or correct a UID or an IBAN: copy one only when the person wrote it.
- firm: every field the person stated, in this message or the conversation so far: when they now give the UID, repeat the name and the owner they gave before.
- preset: only when none is chosen yet and one plainly fits; "custom" when none fits.
- Use the listed values only; an answer the app does not support yet you still give with its listed value, the app explains it.
- say: in the language of the person's message (when unclear: ${LANGUAGE[language as keyof typeof LANGUAGE] ?? 'German'}), addressing them informally, plain words, no markdown. When the person asks something, answer it in two or three sentences. Then, or otherwise, ask back once, briefly, for what is still missing or unclear: the step waiting now first, unless your answers fill it. Never say that you took over, saved, noted or corrected anything, and never call a UID or an IBAN valid: the app checks every answer, saves it or refuses it, and shows which.

Answer with only this JSON object and nothing else; leave out every key you have nothing for:
{"say": "...", "firm": {"name": "...", "uid": "...", "owner": "..."}, "preset": "...", "answers": {"<key>": "<value>" or ["<value>"]}, "netRates": [{"rate": 0, "label": "..."}], "banks": [{"bank": "...", "currency": "...", "iban": "..."}]}`;
}

const current = (d: SetupDraft, p: DraftPatch): unknown =>
  p.step === 'question' ? d.answers[p.key] : p.step === 'firm' ? d.firm : p.step === 'preset' ? d.preset : p.step === 'netRates' ? d.netRates : d.banks;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isVat = (k: QuestionKey) => (VAT_QUESTIONS as readonly string[]).includes(k);

/**
 * The draft after the model's answer: each answer it read checked as a click is (checkPatch), the
 * firm's UID and the banks' IBANs only when they stand in `words` (the person's own), then saved in
 * the click's order through withPatch and marked as taken from the words. A non-VAT answer without
 * a preset makes the preset «custom», which keeps answers given (another preset would replace them).
 */
export function applyTalk(d: SetupDraft, out: TalkOutput, words: readonly string[], baseCurrency: string): { draft: SetupDraft; reply: SetupReply } {
  const refused: Array<{ step: StepMark; refusal: TalkRefusal }> = [];
  const patches: DraftPatch[] = [];
  const take = (step: StepMark, raw: unknown) => {
    try { patches.push(checkPatch(raw)); } catch (e) {
      if (!(e instanceof SetupError)) throw e;
      refused.push({ step, refusal: e.refusal });
    }
  };

  let hint: Partial<Firm> | undefined;
  if (out.firm) {
    const firm = { ...out.firm };
    if (firm.uid && !stated('uid', firm.uid, words)) {
      refused.push({ step: 'firm', refusal: { reason: 'notStated', field: 'uid', detail: firm.uid } });
      delete firm.uid;
    }
    if (firm.name && firm.uid && firm.owner) take('firm', { step: 'firm', value: firm });
    if (!patches.some((p) => p.step === 'firm') && !d.firm) hint = firm;
  }
  if (out.preset) take('preset', { step: 'preset', value: out.preset });
  for (const key of QUESTION_ORDER) {
    const value = out.answers[key];
    if (value === undefined || value === null) continue;
    const odd = ([] as unknown[]).concat(value).find((v) => typeof v !== 'string' || !optionOf(key, v));
    if (odd !== undefined) refused.push({ step: key, refusal: { reason: 'notAnOption', question: key, value: String(odd) } });
    else take(key, { step: 'question', key, value });
  }
  if (out.netRates !== undefined) take('netRates', { step: 'netRates', value: out.netRates });
  if (Array.isArray(out.banks)) {
    const banks = out.banks.filter(isMap).map((b): BankSpec => {
      const iban = str(b.iban);
      if (iban && !stated('iban', iban, words)) refused.push({ step: 'banks', refusal: { reason: 'notStated', field: 'iban', detail: iban } });
      return { bank: str(b.bank) ?? '', currency: str(b.currency) ?? baseCurrency, ...(iban && stated('iban', iban, words) ? { iban } : {}) };
    });
    take('banks', { step: 'banks', value: banks });
  }

  const presetGiven = d.preset ?? patches.find((p) => p.step === 'preset')?.value;
  if (!presetGiven && patches.some((p) => p.step === 'question' && !isVat(p.key))) patches.push({ step: 'preset', value: 'custom' });
  const order: StepMark[] = ['firm', 'preset', ...QUESTION_ORDER, 'netRates', 'banks'];
  patches.sort((a, b) => order.indexOf(markOf(a)) - order.indexOf(markOf(b)));

  let draft = d;
  const filled: StepMark[] = [];
  for (const p of patches) {
    if (same(current(d, p), p.value)) continue;
    draft = withPatch(draft, p);
    draft = { ...draft, fromText: [...(draft.fromText ?? []), markOf(p)] };
    filled.push(markOf(p));
  }
  // The model writes its words before code checks: beside a refusal they may claim what was not saved, so code's reasons stand alone.
  return { draft, reply: { kind: 'read', say: refused.length ? '' : out.say, filled, refused, ...(hint && Object.keys(hint).length ? { firm: hint } : {}) } };
}

export type Ask = (prompt: string, opts: AskOptions) => Promise<string>;

const SYSTEM = 'You help set up Swiss bookkeeping. Answer only with the JSON object the message asks for.';
const MAX_TEXT = 4000;
const MAX_TURNS = 12;

/** A typed message as the start screen sent it: its text, and the turns before it (the last ones, each cut short); undefined without text. */
export function parseTalkRequest(body: unknown): { text: string; history: TalkTurn[] } | undefined {
  const r = isMap(body) ? body : {};
  const text = typeof r.text === 'string' ? r.text.trim().slice(0, MAX_TEXT) : '';
  if (!text) return undefined;
  const turns = Array.isArray(r.history) ? r.history.filter(isMap) : [];
  const history = turns
    .filter((t) => (t.who === 'me' || t.who === 'ai') && typeof t.text === 'string' && t.text.trim())
    .map((t): TalkTurn => ({ who: t.who as TalkTurn['who'], text: (t.text as string).trim().slice(0, MAX_TEXT) }))
    .slice(-MAX_TURNS);
  return { text, history };
}

/**
 * One typed message: the model reads it with the draft, code checks and saves what it read. The
 * call is ledgered in the folder's data/, which becomes the books' own. A model that fails or
 * answers no JSON leaves the draft as it was.
 */
export async function talkDraft(root: string, text: string, history: readonly TalkTurn[], ask: Ask): Promise<{ draft: SetupDraft; reply: SetupReply }> {
  const draft = readDraft(root);
  if (!draft) throw new SetupError('No setup in this folder.', { reason: 'required', field: 'root' });
  const { baseCurrency } = draftView(root, draft);
  let raw: string;
  try {
    raw = await ask(talkPrompt(draft, text, history, baseCurrency), {
      step: 'setup-conversation', system: SYSTEM, timeoutMs: 120_000, ledger: join(root, APP_FOLDER, 'data', 'llm-ledger.jsonl'),
    });
  } catch (e) {
    return { draft, reply: { kind: 'failed', detail: e instanceof Error ? e.message : String(e) } };
  }
  const out = parseTalk(raw);
  if (!out) return { draft, reply: { kind: 'unreadable' } };
  const words = [text, ...history.filter((t) => t.who === 'me').map((t) => t.text)];
  const next = applyTalk(draft, out, words, baseCurrency);
  return next.reply.kind === 'read' && next.reply.filled.length ? { ...next, draft: writeDraft(root, next.draft) } : next;
}
