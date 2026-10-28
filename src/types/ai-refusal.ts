/**
 * Why a subscription CLI did not answer (src/llm/provider.ts AiRefused), as the API tells the UI
 * (code `aiRefused`): the program is not on this Mac, it is signed out, the plan's limit is reached
 * (`said`: the CLI's own words), the account does not offer the model asked (Codex on a ChatGPT plan
 * without it, issue #180), no program here can do what the step needs,
 * or the person switched the AI off on this Mac.
 */
export type AiRefusal =
  | { reason: 'missing' | 'signedOut'; cli: 'claude' | 'codex' }
  | { reason: 'limit'; cli: 'claude' | 'codex'; said: string }
  | { reason: 'modelRefused'; cli: 'codex'; model: string }
  | { reason: 'unserved'; step: string }
  /** «KI ganz ausschalten» is on in Firma › KI (issue #212): no model is asked on this Mac. */
  | { reason: 'off' };
