/**
 * Why a subscription CLI did not answer (src/llm/provider.ts AiRefused), as the API tells the UI
 * (code `aiRefused`): the program is not on this Mac, it is signed out, the plan's limit is reached
 * (`said`: the CLI's own words), or no program here can do what the step needs (Codex reads no PDF).
 */
export type AiRefusal =
  | { reason: 'missing' | 'signedOut'; cli: 'claude' | 'codex' }
  | { reason: 'limit'; cli: 'claude' | 'codex'; said: string }
  | { reason: 'unserved'; step: string };
