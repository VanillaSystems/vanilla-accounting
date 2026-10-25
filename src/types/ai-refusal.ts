/**
 * Why a subscription CLI did not answer (src/llm/provider.ts AiRefused), as the API tells the UI
 * (code `aiRefused`): the program is not on this Mac, it is signed out, the plan's limit is reached
 * (`said`: the CLI's own words), the account does not offer the model asked (Codex on a ChatGPT plan
 * without it, issue #180), or no program here can do what the step needs.
 */
export type AiRefusal =
  | { reason: 'missing' | 'signedOut'; cli: 'claude' | 'codex' }
  | { reason: 'limit'; cli: 'claude' | 'codex'; said: string }
  | { reason: 'modelRefused'; cli: 'codex'; model: string }
  | { reason: 'unserved'; step: string };
