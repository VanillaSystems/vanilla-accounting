/**
 * What the person types in the setup conversation before the books exist (#145). The AI reads the
 * words with the draft, the step waiting and every value code accepts, and answers one JSON object:
 * its words (`say`: an answer to a question, or one short question back) and the answers the words
 * state. Code stays the authority: each proposed answer goes through checkPatch and withPatch, the
 * click's own path, before it is saved; a UID or an IBAN must stand in the person's own words; an
 * answer code refuses is explained back and never saved. `talkDraft` is the one call: the text goes
 * to the provider the person configured for the step (src/llm), and to no one else.
 */
import { join, resolve } from 'node:path';
import type { AskOptions } from '../llm/ask.js';
import { SetupError, type BankSpec, type SetupRefusal } from '../workspace/create.js';
import { BANKS } from '../workspace/banks.js';
import { PRESETS, PRESET_NAMES, QUESTIONS, QUESTION_ORDER, VAT_QUESTIONS, optionOf, unusualPeriod, type QuestionKey } from '../workspace/setup.js';
import { APP_FOLDER } from '../workspace/workspace.js';
import { checkPatch, draftView, readDraft, saidFirm, writeDraft } from './draft-store.js';
import { draftMarks, draftSteps, markOf, withPatch, type DraftPatch, type Firm, type SetupDraft, type SetupDraftView, type StepMark } from './draft.js';

/** A turn of the conversation typed so far, as the server keeps it in memory; it is not saved. */
export interface TalkTurn { who: 'me' | 'ai'; text: string }

/** Why code did not take an answer the AI read from the words. */
export type TalkRefusal =
  | SetupRefusal
  /** A UID or an IBAN that is not in the person's words: the AI never fills one in. */
  | { reason: 'notStated'; field: 'uid' | 'iban'; detail: string }
  /** A value the question does not offer. */
  | { reason: 'notAnOption'; question: QuestionKey; value: string }
  /**
   * A filing period the tax authority grants only on request (half-yearly on the effective method,
   * quarterly on the net tax rate), read from loose words: not taken; the reply says what is usual,
   * and the person picks it with the question's own button when it was granted (#345).
   */
  | { reason: 'unusualPeriod'; method: 'effective' | 'net-rate'; value: string; usual: string };

export type SetupReply =
  /** `filled`: the answers saved from the words; `firm`: what the words said of the firm so far, short of a whole one (kept in the draft's `said`). */
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
  if (open.id === 'firm' && d.said && Object.keys(d.said).length) return `firm: only ${(['name', 'uid', 'owner'] as const).filter((k) => !d.said![k]).join(' and ')} is missing`;
  return open.id === 'review' ? 'nothing: every answer is given, the person can create the books' : open.id;
}

const key = (m: StepMark) => (['firm', 'preset', 'netRates', 'banks'].includes(m) ? m : `answers.${m}`);

/** The prompt for one typed message: the draft, the step waiting, every value code accepts, the turns so far. */
export function talkPrompt(d: SetupDraft, text: string, history: readonly TalkTurn[], baseCurrency: string): string {
  const { started: _started, language, fromText: _marks, said, ...draft } = d;
  const presets = PRESET_NAMES.map((p) => `  - ${p}: ${PRESETS[p].label} (${PRESETS[p].fits}). Gives: ${JSON.stringify(PRESETS[p].answers)}`).join('\n');
  const marks = draftMarks(d);
  const turns = history.length ? history.map((t) => `${t.who === 'me' ? 'person' : 'you'}: ${t.text}`).join('\n') : '(none)';
  return `You help a person set up the bookkeeping of their Swiss company in Vanilla Accounting, before the books exist. They may give several answers at once, ask about the setup, or both.

The setup so far (JSON; a key that is missing is not answered yet):
${JSON.stringify(draft, null, 2)}
${said && Object.keys(said).length ? `\nOf the firm the person already said, and the app keeps it: ${JSON.stringify(said)}. Do not ask for these again.\n` : ''}
Answered, by a button or by the person's words (never ask about these again, also when the conversation below asked them: a button answered since): ${marks.answered.map(key).join(', ') || 'nothing yet'}
Still open, in the order the app asks them: ${marks.open.map(key).join(', ') || 'nothing'}
The step waiting now, which the app shows with its buttons right below your words: ${waiting(d)}

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
- Take only what the message or the conversation so far states or plainly implies («zwei Angestellte»: employees "staff"; «registered for VAT»: vatRegistered "yes"). Leave out what it does not say. Never guess.
- sells: a trade (a painter, a carpenter, an electrician, a builder …), and any firm that charges material with its work («d Farb verrechned mer mit», «Material kommt auf die Rechnung»), sells "made" and "services": "made" covers the material. "services" alone is work without material.
- period: give it only when the person names how often they file. Quarterly is usual on the effective method, half-yearly on the net tax rate; the app does not take the other from loose words and says so itself.
- Never invent, complete or correct a UID or an IBAN: copy one only when the person wrote it.
- firm: every field the person stated in this message; the app joins it to what they said of the firm before.
- preset: only when none is chosen yet. Name the one whose kind of firm the words plainly say: a trade is "trades". Leave it out when the words do not say what the firm does: the app then asks with buttons. "custom" only when the person describes a firm none of the others fits.
- Use the listed values only; an answer the app does not support yet you still give with its listed value, the app explains it.
- say: in the language of the person's message (when unclear: ${LANGUAGE[language as keyof typeof LANGUAGE] ?? 'German'}), addressing them informally, plain words, no markdown. When the person asks something, answer it in two or three sentences. Do not ask the next question and do not list what is still missing: the app asks the step waiting itself, with buttons, right below your words. Ask back only when the message tried to say something you could not read («welche Bank meinst du?»), once and briefly; otherwise end without a question. Do not greet the person by a name: who types need not be the owner. Never say that you took over, saved, noted or corrected anything, and never call a UID or an IBAN valid: the app checks every answer, saves it or refuses it, and shows which.

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
 * the click's order through withPatch and marked as taken from the words. An answer without a
 * preset leaves the kind of firm open: the app asks it with buttons, and whichever is picked keeps
 * what the words said (withPatch).
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

  // The firm: what the words say now, joined to what they said before (`said`) or to the firm saved.
  // A name and an owner given before the UID are kept, so the UID alone completes them (#345).
  let said: Partial<Firm> | undefined;
  if (out.firm) {
    const now = { ...out.firm };
    if (now.uid && !stated('uid', now.uid, words)) {
      refused.push({ step: 'firm', refusal: { reason: 'notStated', field: 'uid', detail: now.uid } });
      delete now.uid;
    }
    const firm = { ...(d.firm ?? d.said), ...now };
    const whole = !!(firm.name && firm.uid && firm.owner);
    const before = patches.length;
    if (whole) take('firm', { step: 'firm', value: firm });
    // Not whole yet, or refused whole (a UID that is none): what was said of it is kept all the same.
    if (patches.length === before && !d.firm) {
      said = saidFirm(firm);
      if (!whole && firm.uid && !said.uid) refused.push({ step: 'firm', refusal: { reason: 'uid', detail: firm.uid } });
    }
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
  if (said && Object.keys(said).length && !draft.firm && !same(d.said, said)) draft = { ...draft, said };
  // A period the tax authority grants only on request is not taken from loose words: the question keeps its buttons, the usual one proposed.
  const odd = unusualPeriod(draft.answers);
  if (odd && draft.fromText?.includes('period') && (filled.includes('period') || filled.includes('vatMethod'))) {
    draft = withPatch(draft, { step: 'question', key: 'period', value: null });
    if (filled.includes('period')) filled.splice(filled.indexOf('period'), 1);
    refused.push({ step: 'period', refusal: { reason: 'unusualPeriod', method: odd.method, value: odd.period, usual: odd.usual } });
  }
  // The model writes its words before code checks: beside a refusal they may claim what was not saved, so code's reasons stand alone.
  return { draft, reply: { kind: 'read', say: refused.length ? '' : out.say, filled, refused, ...(draft.said ? { firm: draft.said } : {}) } };
}

export type Ask = (prompt: string, opts: AskOptions) => Promise<string>;

/**
 * The turns typed per folder, as this server received and answered them: the model's context, and
 * the person's words the evidence a UID or an IBAN must stand in. Nothing the screen sends counts
 * but the message itself; a restart forgets the turns, the draft keeps the answers.
 */
const turnsOf = new Map<string, TalkTurn[]>();

const SYSTEM = 'You help set up Swiss bookkeeping. Answer only with the JSON object the message asks for.';
export const MAX_TEXT = 4000;
const MAX_TURNS = 12;

/** A typed message as the start screen sent it; undefined without text. */
export function parseTalkRequest(body: unknown): { text: string } | { tooLong: true } | undefined {
  const r = isMap(body) ? body : {};
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  if (!text) return undefined;
  return text.length > MAX_TEXT ? { tooLong: true } : { text };
}

/**
 * One typed message: the model reads it with the draft and the turns before it, code checks and
 * saves what it read. The call is ledgered in the folder's data/, which becomes the books' own. A
 * model that fails or answers no JSON leaves the draft as it was.
 */
export async function talkDraft(root: string, text: string, ask: Ask): Promise<{ draft: SetupDraft; reply: SetupReply }> {
  const draft = readDraft(root);
  if (!draft) throw new SetupError('No setup in this folder.', { reason: 'required', field: 'root' });
  const { baseCurrency } = draftView(root, draft);
  const key = resolve(root);
  const before = turnsOf.get(key) ?? [];
  const keep = (turns: TalkTurn[]) => turnsOf.set(key, turns.slice(-MAX_TURNS));
  keep([...before, { who: 'me', text }]);
  let raw: string;
  try {
    raw = await ask(talkPrompt(draft, text, before, baseCurrency), {
      step: 'setup-conversation', system: SYSTEM, timeoutMs: 120_000, ledger: join(root, APP_FOLDER, 'data', 'llm-ledger.jsonl'),
    });
  } catch (e) {
    return { draft, reply: { kind: 'failed', detail: e instanceof Error ? e.message : String(e) } };
  }
  const out = parseTalk(raw);
  if (!out) return { draft, reply: { kind: 'unreadable' } };
  const words = [...before, { who: 'me', text }].filter((t) => t.who === 'me').map((t) => t.text);
  const next = applyTalk(draft, out, words, baseCurrency);
  if (next.reply.kind === 'read' && next.reply.say) keep([...(turnsOf.get(key) ?? []), { who: 'ai', text: next.reply.say }]);
  return next.draft !== draft ? { ...next, draft: writeDraft(root, next.draft) } : next;
}
