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
import { isTerminalCli, type TerminalCli } from '../platform/terminal.js';

export interface StepChoice {
  provider: ProviderId;
  /** Absent: the provider's model for the step's tier. */
  model?: string;
}

export interface AiSettings {
  steps: Partial<Record<StepId, StepChoice>>;
  /**
   * «Die App fragt» with both CLIs installed (issue #121): the app's steps ask this one first, and
   * «Im Terminal öffnen» starts it, the other offered (issue #146). Absent: Claude Code.
   */
  cli?: TerminalCli;
  /** When the CLI asked cannot answer (its limit, signed out, gone), ask the other one by itself; off unless set. */
  askOther?: true;
  /** «Ohne KI weitermachen»: the first run does not ask again on this Mac (docs/0.4.0/ai-setup.md, decision 6). */
  noAi?: true;
}

export const PROVIDERS: readonly ProviderId[] = ['claude-cli', 'codex-cli', 'anthropic', 'openai', 'jev'];
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
  // Before #121 the choice was the terminal's alone, kept as `terminal`.
  const top = raw as { cli?: unknown; terminal?: unknown; askOther?: unknown; noAi?: unknown } | null;
  const cli = top?.cli ?? top?.terminal;
  return { steps, ...(isTerminalCli(cli) ? { cli } : {}), ...(top?.askOther === true ? { askOther: true as const } : {}), ...(top?.noAi === true ? { noAi: true as const } : {}) };
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
  const next = readSettings();
  if (choice) next.steps[step] = choice; else delete next.steps[step];
  return write(next);
}

/** «Die App fragt»: the CLI chosen, or none (null: Claude Code then), and whether to ask the other when it cannot answer. */
export function writeCli(change: { cli?: TerminalCli | null; askOther?: boolean }): AiSettings {
  const { cli, askOther, ...rest } = readSettings();
  const nextCli = change.cli === undefined ? cli : change.cli ?? undefined;
  const nextOther = change.askOther === undefined ? askOther : change.askOther || undefined;
  return write({ ...rest, ...(nextCli ? { cli: nextCli } : {}), ...(nextOther ? { askOther: true } : {}) });
}

/** «Ohne KI weitermachen» kept on this Mac (true) or taken back (false). */
export function writeNoAi(on: boolean): AiSettings {
  const { noAi: _was, ...rest } = readSettings();
  return write(on ? { ...rest, noAi: true } : rest);
}

function write(next: AiSettings): AiSettings {
  const path = settingsPath();
  if (!path) throw new Error('No settings file in a test run: set VANILLA_AI_SETTINGS.');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
  return next;
}
