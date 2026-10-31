/** Firma › KI (GET /api/ai, issue #48): the providers this computer can use and the model per step. */
import type { ProviderId } from './provider.js';
import type { Capability, StepId, Tier } from './steps.js';
import type { StepChoice } from './settings.js';
import type { TierChoice } from './providers/codex-models.js';
import type { TerminalCli } from '../platform/terminal.js';

export interface AiProviderView {
  id: ProviderId;
  /** A subscription counts against the person's quota; a key costs money per call. */
  billing: 'subscription' | 'key';
  /** A CLI: answers here, installed but signed out (Codex says so), or not found; a key: kept or not. */
  state: 'ready' | 'signedOut' | 'missing' | 'set' | 'unset';
  /** Only a provider the app can use now has models to choose. */
  models: Array<{ id: string; can: readonly Capability[] }>;
  /** The provider's model list could not be read; its shipped models are offered. */
  listError?: string;
  /**
   * Codex (issue #180): the model each tier takes from the models the signed-in account offers,
   * and when that list was read (absent: not yet, the tiers take the app's first choices).
   */
  tiers?: Record<Tier, TierChoice>;
  checkedAt?: string;
}

export interface AiStepView {
  id: StepId;
  tier: Tier;
  needs: readonly Capability[];
  /** A typed step: below this confidence the default answers. */
  confident?: number;
  choice?: StepChoice;
  /** What serves the step now: the choice, or the default when the choice cannot serve it; `unserved`: nothing here can. */
  resolved: { provider: ProviderId; model: string; source: 'setting' | 'default' | 'unserved' };
  /** What serves the step without a choice; `unserved`: no subscription here can (the sidebar or a PDF with Codex alone). */
  standard: { provider: ProviderId; model: string; unserved?: true };
}

export interface AiView {
  providers: AiProviderView[];
  steps: AiStepView[];
  /** The app keeps keys itself (the keychain); elsewhere they go into .env, named by `keysWhere`. */
  keysInApp: boolean;
  keysWhere: Partial<Record<ProviderId, string>>;
  /** «Die App fragt» (issue #121): the CLI chosen; absent: Claude Code. */
  cli?: TerminalCli;
  /** Whether the app asks the other CLI by itself when the one asked cannot answer. */
  askOther: boolean;
  /** «KI ganz ausschalten» (issue #212): no model is asked on this Mac. */
  off: boolean;
}
