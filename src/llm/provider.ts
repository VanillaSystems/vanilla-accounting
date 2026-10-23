/**
 * What a provider of models offers the app (issue #48): its catalog, its model per tier, and one
 * call. Each provider delivers the step's attachments its own way (the CLI: the folder and its
 * Read tool; an API: the file inline).
 */
import type { Capability, Tier } from './steps.js';

export type ProviderId = 'claude-cli';

export interface ModelEntry {
  /** The id the provider takes (`sonnet` for the CLI). */
  id: string;
  can: readonly Capability[];
}

export interface Call {
  prompt: string;
  system: string;
  model: string;
  /** Absolute paths of the files the model reads. */
  attachments: readonly string[];
  timeoutMs: number;
}

export interface Usage {
  input: number;
  cacheCreate: number;
  cacheRead: number;
  output: number;
  turns: number;
}

export const NO_USAGE: Usage = { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, turns: 0 };

/** A failed call, with what it used before it failed (the ledger counts it). */
export class CallFailed extends Error {
  constructor(message: string, readonly usage: Usage) {
    super(message);
  }
}

export interface Provider {
  id: ProviderId;
  /** A subscription counts against the person's quota; a key costs money per call. */
  billing: 'subscription' | 'key';
  models: readonly ModelEntry[];
  defaults: Record<Tier, string>;
  ask(call: Call): Promise<{ text: string; usage: Usage }>;
  /** Whether the provider answers here at all. */
  ready(timeoutMs?: number): Promise<boolean>;
}
