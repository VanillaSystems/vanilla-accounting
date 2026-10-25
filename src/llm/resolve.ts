/**
 * Which provider and model serve a step (issue #48): the person's setting for this machine when
 * its provider is there and its model meets the step's needs, else the first subscription whose
 * model for the step's tier meets them. A key is never the default: it costs money per call.
 */
import { AiRefused, type Provider } from './provider.js';
import type { AiSettings } from './settings.js';
import { meets, STEPS, type StepId } from './steps.js';

export interface Resolved {
  provider: Provider;
  model: string;
  /** `unserved`: no subscription here can do what the step needs (Codex alone, a step that reads a PDF); the call says so. */
  source: 'setting' | 'default' | 'unserved';
}

const fits = (step: StepId, p: Provider, model: string) => meets(p.models.find((m) => m.id === model)?.can ?? [], step);

/** `providers` are those usable on this machine, the subscriptions first. */
export function resolve(step: StepId, settings: AiSettings, providers: readonly [Provider, ...Provider[]]): Resolved {
  const { tier } = STEPS[step];
  const chosen = settings.steps[step];
  const provider = chosen && providers.find((p) => p.id === chosen.provider);
  if (provider) {
    const model = chosen.model ?? provider.defaults[tier];
    if (fits(step, provider, model)) return { provider, model, source: 'setting' };
  }
  const fallback = providers.find((p) => p.billing === 'subscription' && fits(step, p, p.defaults[tier]));
  if (fallback) return { provider: fallback, model: fallback.defaults[tier], source: 'default' };
  const [first] = providers;
  return { provider: first, model: first.defaults[tier], source: 'unserved' };
}

/** The step's provider when nothing is set for it. */
export const defaultFor = (step: StepId, providers: readonly [Provider, ...Provider[]]): Resolved => resolve(step, { steps: {} }, providers);

export const unserved = (step: StepId): AiRefused =>
  new AiRefused({ reason: 'unserved', step }, `Kein KI-Programm auf diesem Mac kann den Schritt ${step}: er braucht ${STEPS[step].needs.join(', ')}.`);

/**
 * The other subscription to ask when `asked` could not answer: only with «das andere fragen» on
 * (Firma › KI, off unless set), only for a CLI's refusal (a limit, signed out, not installed), and
 * only one that serves the step. Never a key.
 */
export function otherSubscription(e: unknown, step: StepId, asked: Provider, settings: AiSettings, providers: readonly Provider[]): Resolved | undefined {
  if (!settings.askOther || !(e instanceof AiRefused) || e.refusal.reason === 'unserved') return undefined;
  const { tier } = STEPS[step];
  const other = providers.find((p) => p.billing === 'subscription' && p !== asked && fits(step, p, p.defaults[tier]));
  return other && { provider: other, model: other.defaults[tier], source: 'default' };
}
