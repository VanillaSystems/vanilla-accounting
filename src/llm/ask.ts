/**
 * The one way the app asks a model for a single answer. A call names its step (steps.ts); the
 * resolver picks the provider and the model, and the provider delivers the prompt and the
 * attachments its own way. A call on an API key that fails is asked again of the step's default
 * subscription; a failing subscription is never asked again of a key that costs money, and asks
 * the other subscription only when Firma › KI says so (`askOther`).
 *
 * Every call appends its real usage to data/llm-ledger.jsonl, tagged with the step it served and
 * the provider, so `npm run llm-usage` reports measured cost, not estimates.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openWorkspace } from '../workspace/workspace.js';
import { AiRefused, CallFailed, NO_USAGE, type Provider, type ProviderId, type Usage } from './provider.js';
import { claudeCli, NoClaudeError } from './providers/claude-cli.js';
import { subscriptions, usableProviders } from './providers/index.js';
import { defaultFor, otherSubscription, resolve, unserved, type Resolved } from './resolve.js';
import { readSettings } from './settings.js';
import { aiOff, gate } from './off.js';
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
  /** Where the call is ledgered, when no books are open yet (the setup before they exist): their own data/llm-ledger.jsonl to be. */
  ledger?: string;
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

export function record(row: LedgerRow, file?: string): void {
  try {
    const path = file ?? ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + '\n');
  } catch {
    // The ledger is a measurement aid; a failed write must not fail the call.
  }
}

/** The provider and model that serve `step` on this machine now. */
export const resolveStep = async (step: StepId): Promise<Resolved> => resolve(step, readSettings(), await usableProviders());

/** The AI sidebar's model on Claude Code. */
export const sidebarModel = (): string => resolve('sidebar', readSettings(), [claudeCli]).model;

/** Who runs the KI column here: an agent with a session and tools is a subscription's CLI, Claude Code or Codex, never a key. */
export function sidebarAgent(): Resolved {
  const settings = readSettings();
  return resolve('sidebar', settings, subscriptions(settings.cli));
}

/** Resolves with the model's text answer; rejects with the provider's reason (NoClaudeError names the step). */
export async function ask(prompt: string, opts: AskOptions): Promise<string> {
  try {
    return await askResolved(prompt, opts);
  } catch (e) {
    throw e instanceof NoClaudeError ? new NoClaudeError(opts.step) : e;
  }
}

async function askResolved(prompt: string, opts: AskOptions): Promise<string> {
  // Refused before a provider is chosen, so a call the switch stopped leaves no row in the ledger.
  gate();
  const providers = await usableProviders();
  const settings = readSettings();
  const chosen = resolve(opts.step, settings, providers);
  if (chosen.source === 'unserved') throw unserved(opts.step);
  try {
    return await askOne(prompt, opts, chosen.provider, chosen.model);
  } catch (e) {
    // Claude Code there but not signed in fails like any call: said as «no AI here», which the error line offers to set up.
    if (chosen.provider === claudeCli && !(e instanceof NoClaudeError) && !(e instanceof AiRefused) && !(await claudeCli.ready(8000))) throw new NoClaudeError(opts.step);
    // The person chose the key: when the default cannot answer either, its reason is the one to see.
    // A key that fails asks a subscription, never another key: where a key is the default (#175), the subscriptions alone decide.
    const subs = providers.filter((p) => p.billing === 'subscription');
    const next = chosen.provider.billing === 'key'
      ? (subs.length ? defaultFor(opts.step, [subs[0], ...subs.slice(1)]) : undefined)
      : otherSubscription(e, opts.step, chosen.provider, settings, providers);
    if (!next || next.source === 'unserved') throw e;
    return askOne(prompt, opts, next.provider, next.model).catch(() => { throw e; });
  }
}

async function askOne(prompt: string, opts: AskOptions, provider: Provider, model: string): Promise<string> {
  const step = opts.detail ? `${STEPS[opts.step].ledger}#${opts.detail}` : STEPS[opts.step].ledger;
  const started = Date.now();
  const row = (ok: boolean, usage: Usage) => record({ at: new Date().toISOString(), step, provider: provider.id, model, ok, ms: Date.now() - started, ...usage }, opts.ledger);
  try {
    const answer = await provider.ask({
      prompt, model, system: opts.system ?? DEFAULT_SYSTEM, attachments: opts.attachments ?? [], timeoutMs: opts.timeoutMs ?? 360_000,
    });
    const { text, usage } = answer;
    model = answer.model ?? model;
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
 * «KI ganz ausschalten» (src/llm/off.ts) answers no without asking anyone.
 */
export async function modelReady(timeoutMs?: number): Promise<boolean> {
  if (aiOff()) return false;
  const providers = await usableProviders();
  const settings = readSettings();
  const used = new Set(STEP_IDS.filter((s) => s !== 'sidebar').map((s) => resolve(s, settings, providers).provider));
  for (const p of used) if (await p.ready(timeoutMs)) return true;
  return false;
}
