/**
 * The one way the app asks a model for a single answer. A call names its step (steps.ts); the
 * resolver picks the provider and the model, and the provider delivers the prompt and the
 * attachments its own way. A call on an API key that fails is asked again of the default (the
 * Claude subscription); a failing subscription is never asked again of a key that costs money.
 *
 * Every call appends its real usage to data/llm-ledger.jsonl, tagged with the step it served and
 * the provider, so `npm run llm-usage` reports measured cost, not estimates.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openWorkspace } from '../workspace/workspace.js';
import { CallFailed, NO_USAGE, type Provider, type ProviderId, type Usage } from './provider.js';
import { claudeCli } from './providers/claude-cli.js';
import { usableProviders } from './providers/index.js';
import { resolve, type Resolved } from './resolve.js';
import { readSettings } from './settings.js';
import { STEP_IDS, STEPS, type StepId } from './steps.js';

export interface AskOptions {
  step: StepId;
  /** Which part of the step, for the ledger only: `saving` with `talk` is ledgered as `saving#talk`. */
  detail?: string;
  /** Replaces the default system prompt. */
  system?: string;
  /** Absolute paths of the files the model reads. Absent: the model reads no file. */
  attachments?: string[];
  timeoutMs?: number;
  /** Told which provider and model gave the answer (an entry names the model that booked it). */
  answered?: (by: { provider: ProviderId; model: string }) => void;
}

export interface LedgerRow extends Usage {
  at: string;
  step: string;
  provider: ProviderId;
  model: string;
  ok: boolean;
  ms: number;
}

const DEFAULT_SYSTEM =
  'You are a careful assistant for a Swiss GmbH\'s bookkeeping. Follow the instructions in the message exactly and answer only in the format they ask for.';

/** Every model call's cost, appended to the workspace's data/ (gitignored). */
export const ledgerPath = (): string => join(openWorkspace().paths.data, 'llm-ledger.jsonl');

export function record(row: LedgerRow): void {
  try {
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + '\n');
  } catch {
    // The ledger is a measurement aid; a failed write must not fail the call.
  }
}

/** The provider and model that serve `step` on this machine now. */
export const resolveStep = async (step: StepId): Promise<Resolved> => resolve(step, readSettings(), await usableProviders());

/** The AI sidebar's model: only the Claude CLI runs it (it is an agent with a session and tools). */
export const sidebarModel = (): string => resolve('sidebar', readSettings(), [claudeCli]).model;

/** Resolves with the model's text answer; rejects with the provider's reason. */
export async function ask(prompt: string, opts: AskOptions): Promise<string> {
  const providers = await usableProviders();
  const chosen = resolve(opts.step, readSettings(), providers);
  try {
    return await askOne(prompt, opts, chosen.provider, chosen.model);
  } catch (e) {
    if (chosen.provider.billing !== 'key') throw e;
    const [fallback] = providers;
    // The person chose the key: when the default cannot answer either, its reason is the one to see.
    return askOne(prompt, opts, fallback, fallback.defaults[STEPS[opts.step].tier]).catch(() => { throw e; });
  }
}

async function askOne(prompt: string, opts: AskOptions, provider: Provider, model: string): Promise<string> {
  const step = opts.detail ? `${STEPS[opts.step].ledger}#${opts.detail}` : STEPS[opts.step].ledger;
  const started = Date.now();
  const row = (ok: boolean, usage: Usage) => record({ at: new Date().toISOString(), step, provider: provider.id, model, ok, ms: Date.now() - started, ...usage });
  try {
    const { text, usage } = await provider.ask({
      prompt, model, system: opts.system ?? DEFAULT_SYSTEM, attachments: opts.attachments ?? [], timeoutMs: opts.timeoutMs ?? 360_000,
    });
    row(true, usage);
    opts.answered?.({ provider: provider.id, model });
    return text;
  } catch (e) {
    row(false, e instanceof CallFailed ? e.usage : NO_USAGE);
    throw e;
  }
}

/**
 * Whether a provider some step uses answers here: the `claude` CLI, or a key a step was set to.
 * Steps that need the model skip their model part without it and say so, instead of failing each call.
 */
export async function modelReady(timeoutMs?: number): Promise<boolean> {
  const providers = await usableProviders();
  const settings = readSettings();
  const used = new Set(STEP_IDS.filter((s) => s !== 'sidebar').map((s) => resolve(s, settings, providers).provider));
  for (const p of used) if (await p.ready(timeoutMs)) return true;
  return false;
}
