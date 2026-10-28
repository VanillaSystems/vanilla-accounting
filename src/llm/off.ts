/**
 * «KI ganz ausschalten» (Firma › KI, issue #212): the one gate every model call passes. Each way the
 * app reaches a model goes through it right before it starts one: the `claude` CLI (spawnClaude),
 * the `codex` CLI (runCodex), an HTTP provider's request (requestJson), and Terminal's AI
 * (openInTerminal, src/platform/terminal-open.ts). ask() and judge() pass it before they choose a provider, so a stopped call
 * leaves no row in the ledger. Callers that can do without the model ask aiOff() first (modelReady
 * says no) and take their way by hand; the gate stops anything that still tries.
 * tests/ai-off.test.ts drives the app's paths with the switch on and fails on any call that gets through,
 * and on a new file that starts a program or sends a request without being named there.
 */
import { AiRefused } from './provider.js';
import { readSettings } from './settings.js';

export const aiOff = (): boolean => readSettings().off === true;

export const AI_OFF_MESSAGE = 'Die KI ist auf diesem Mac ausgeschaltet (Firma › KI): kein Modell wird gefragt.';

/** Throws the refusal `off` when the switch is on; returns otherwise. */
export function gate(): void {
  if (aiOff()) throw new AiRefused({ reason: 'off' }, AI_OFF_MESSAGE);
}
