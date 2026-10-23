/**
 * Which provider and model serve a step (issue #48): the person's setting for this machine when
 * its provider is there and its model meets the step's needs, else the default provider's model
 * for the step's tier.
 */
import type { Provider } from './provider.js';
import type { AiSettings } from './settings.js';
import { meets, STEPS, type StepId } from './steps.js';

export interface Resolved {
  provider: Provider;
  model: string;
  source: 'setting' | 'default';
}

/** `providers` are those usable on this machine, the default first. */
export function resolve(step: StepId, settings: AiSettings, providers: readonly [Provider, ...Provider[]]): Resolved {
  const { tier } = STEPS[step];
  const fits = (p: Provider, model: string) => meets(p.models.find((m) => m.id === model)?.can ?? [], step);
  const chosen = settings.steps[step];
  const provider = chosen && providers.find((p) => p.id === chosen.provider);
  if (provider) {
    const model = chosen.model ?? provider.defaults[tier];
    if (fits(provider, model)) return { provider, model, source: 'setting' };
  }
  const [fallback] = providers;
  return { provider: fallback, model: fallback.defaults[tier], source: 'default' };
}
