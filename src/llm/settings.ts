/**
 * The person's choice of provider and model per step, kept per machine (owner 21.10., issue #48):
 * what is installed and signed in differs per computer, so it never lies in the workspace, which is
 * a git repository others share. VANILLA_AI_SETTINGS names another file; a test run reads none
 * unless it names one, so a developer's own choice never changes a test.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProviderId } from './provider.js';
import { isStepId, type StepId } from './steps.js';

export interface StepChoice {
  provider: ProviderId;
  /** Absent: the provider's model for the step's tier. */
  model?: string;
}

export interface AiSettings {
  steps: Partial<Record<StepId, StepChoice>>;
}

export const PROVIDERS: readonly ProviderId[] = ['claude-cli', 'anthropic', 'openai'];
const isProvider = (p: unknown): p is ProviderId => PROVIDERS.includes(p as ProviderId);

export const settingsPath = (): string | undefined =>
  process.env.VANILLA_AI_SETTINGS ?? (process.env.NODE_TEST_CONTEXT ? undefined : join(homedir(), '.vanilla-accounting', 'ai.json'));

/** The file as the app understands it: a step or provider it does not know is left out, never an error. */
export function parseSettings(raw: unknown): AiSettings {
  const steps: AiSettings['steps'] = {};
  const given = (raw as { steps?: unknown } | null)?.steps;
  if (given && typeof given === 'object') {
    for (const [step, c] of Object.entries(given as Record<string, unknown>)) {
      const choice = c as { provider?: unknown; model?: unknown } | null;
      if (!isStepId(step) || !isProvider(choice?.provider)) continue;
      steps[step] = { provider: choice.provider, ...(typeof choice.model === 'string' && choice.model ? { model: choice.model } : {}) };
    }
  }
  return { steps };
}

export function readSettings(): AiSettings {
  const path = settingsPath();
  if (!path || !existsSync(path)) return { steps: {} };
  try {
    return parseSettings(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return { steps: {} };
  }
}

/** Sets or clears (null) the choice for one step; the other steps keep theirs. */
export function writeChoice(step: StepId, choice: StepChoice | null): AiSettings {
  const path = settingsPath();
  if (!path) throw new Error('No settings file in a test run: set VANILLA_AI_SETTINGS.');
  const next = readSettings();
  if (choice) next.steps[step] = choice; else delete next.steps[step];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
  return next;
}
