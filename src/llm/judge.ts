/**
 * A typed question to the model a step resolves to (issue #48 step 3): yes or no, or one of a few
 * choices, with how sure the model is. A model made for it (Jev) answers itself; any model that
 * writes JSON answers through a prompt. An answer less sure than the step's `confident` is asked
 * again of the default provider, as is a question a key could not answer; the default is never
 * asked to hand over to a key.
 */
import { CallFailed, NO_USAGE, type JudgeCall, type Provider, type Question, type Usage, type Verdict } from './provider.js';
import { usableProviders } from './providers/index.js';
import { record } from './ask.js';
import { defaultFor, otherSubscription, resolve, unserved } from './resolve.js';
import { readSettings } from './settings.js';
import { confidentOf, STEPS, type StepId } from './steps.js';

export interface JudgeOptions {
  step: StepId;
  /** Absolute paths of PNG or JPEG images the question is about. */
  images?: string[];
  timeoutMs?: number;
}

export type Judged = Verdict & { provider: Provider['id']; model: string };

const SYSTEM = 'You answer one typed question about the given state. Answer only with the JSON the message asks for.';

/** The prompt a text model answers a typed question by. */
export function judgePrompt(state: JudgeCall['state'], q: Question): string {
  const asked = q.type === 'noul'
    ? `Question (yes or no): ${q.instructions}\nAnswer: {"yes": <probability of yes, 0 to 1>}`
    : `Question: ${q.instructions}\nChoices:\n${Object.entries(q.options).map(([k, v]) => `- ${k}${v ? `: ${v}` : ''}`).join('\n')}\nAnswer: {"choice": "<one of the choices>", "confidence": <0 to 1>}`;
  return `State:\n${typeof state === 'string' ? state : JSON.stringify(state, null, 2)}\n\n${asked}`;
}

/** The verdict in a text model's answer; undefined when it answers something else. */
export function parseJudgement(raw: string, q: Question): Verdict | undefined {
  let j: { yes?: unknown; choice?: unknown; confidence?: unknown };
  try { j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return undefined; }
  const p = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : undefined);
  if (q.type === 'noul') {
    const yes = p(j.yes);
    return yes === undefined ? undefined : { type: 'noul', yes, confidence: Math.max(yes, 1 - yes) };
  }
  const confidence = p(j.confidence);
  return typeof j.choice === 'string' && j.choice in q.options && confidence !== undefined ? { type: 'choice', choice: j.choice, confidence } : undefined;
}

async function judgeOne(step: StepId, provider: Provider, model: string, call: Omit<JudgeCall, 'model'>): Promise<Verdict> {
  const started = Date.now();
  const row = (ok: boolean, usage: Usage) => record({ at: new Date().toISOString(), step: STEPS[step].ledger, provider: provider.id, model, ok, ms: Date.now() - started, ...usage });
  try {
    const { verdict, usage } = provider.judge
      ? await provider.judge({ ...call, model })
      : await (async () => {
        if (call.images.length) throw new CallFailed('a text model reads no image in a typed question', NO_USAGE);
        const { text, usage } = await provider.ask({ prompt: judgePrompt(call.state, call.question), system: SYSTEM, model, attachments: [], timeoutMs: call.timeoutMs });
        const verdict = parseJudgement(text, call.question);
        if (!verdict) throw new CallFailed(`no answer to the question in: ${text.slice(0, 120)}`, usage);
        return { verdict, usage };
      })();
    row(true, usage);
    return verdict;
  } catch (e) {
    row(false, e instanceof CallFailed ? e.usage : NO_USAGE);
    throw e;
  }
}

export async function judge(state: JudgeCall['state'], question: Question, opts: JudgeOptions): Promise<Judged> {
  const providers = await usableProviders();
  const settings = readSettings();
  const standard = defaultFor(opts.step, providers);
  const chosen = resolve(opts.step, settings, providers);
  if (chosen.source === 'unserved') throw unserved(opts.step);
  const call = { state, question, images: opts.images ?? [], timeoutMs: opts.timeoutMs ?? 120_000 };
  const fallback = standard.provider;
  const byDefault = async () => {
    if (standard.source === 'unserved') throw unserved(opts.step);
    return { ...(await judgeOne(opts.step, fallback, standard.model, call)), provider: fallback.id, model: standard.model };
  };
  if (chosen.provider === fallback) {
    try {
      return { ...(await judgeOne(opts.step, fallback, chosen.model, call)), provider: fallback.id, model: chosen.model };
    } catch (e) {
      const other = otherSubscription(e, opts.step, fallback, settings, providers);
      if (!other) throw e;
      return { ...(await judgeOne(opts.step, other.provider, other.model, call).catch(() => { throw e; })), provider: other.provider.id, model: other.model };
    }
  }
  let verdict: Verdict;
  try {
    verdict = await judgeOne(opts.step, chosen.provider, chosen.model, call);
  } catch (e) {
    return byDefault().catch(() => { throw e; });
  }
  const sure = confidentOf(opts.step);
  if (sure !== undefined && verdict.confidence < sure) return byDefault().catch(() => ({ ...verdict, provider: chosen.provider.id, model: chosen.model }));
  return { ...verdict, provider: chosen.provider.id, model: chosen.model };
}
