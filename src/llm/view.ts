/** Firma › KI (GET /api/ai, issue #48): the providers this computer can use and the model per step. */
import type { ProviderId } from './provider.js';
import type { Capability, StepId, Tier } from './steps.js';
import type { StepChoice } from './settings.js';

export interface AiProviderView {
  id: ProviderId;
  /** A subscription counts against the person's quota; a key costs money per call. */
  billing: 'subscription' | 'key';
  /** The CLI answers here or not; a key is kept or not. */
  state: 'ready' | 'missing' | 'set' | 'unset';
  /** Only a provider the app can use now has models to choose. */
  models: Array<{ id: string; can: readonly Capability[] }>;
  /** The provider's model list could not be read; its shipped models are offered. */
  listError?: string;
}

export interface AiStepView {
  id: StepId;
  tier: Tier;
  needs: readonly Capability[];
  /** A typed step: below this confidence the default answers. */
  confident?: number;
  choice?: StepChoice;
  /** What serves the step now: the choice, or the default when the choice cannot serve it. */
  resolved: { provider: ProviderId; model: string; source: 'setting' | 'default' };
  /** What serves the step without a choice. */
  standard: { provider: ProviderId; model: string };
}

export interface AiView {
  providers: AiProviderView[];
  steps: AiStepView[];
  /** The app keeps keys itself (the keychain); elsewhere they go into .env, named by `keysWhere`. */
  keysInApp: boolean;
  keysWhere: Partial<Record<ProviderId, string>>;
}
