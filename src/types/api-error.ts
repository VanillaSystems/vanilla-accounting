import type { AuditSnapshot } from '../audit/sources.js';

/**
 * The JSON body of every refused API request. `error` is the German text the CLI, the tests and
 * the logs read; `code` and `params` let the UI say the same in the user's language
 * (src/app/lib/api.ts errorText). A body without a code is shown as its `error` text.
 */
export const CLOSED_REASONS = [
  'editTransaction', 'deleteTransaction', 'newTransaction', 'mapping',
  'editReceipt', 'deleteReceipt', 'editEntry', 'deleteEntry', 'newEntry',
] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export type ApiRefusal =
  | { code: 'readonly' }
  | { code: 'localOnly' }
  | { code: 'periodClosed'; params: { closedThrough: string; reason?: ClosedReason } }
  | { code: 'manualOnly' }
  | { code: 'yearClose' }
  | { code: 'fileExists'; params: { filename: string } };

export type ApiErrorBody = { error: string } & (ApiRefusal | { code?: undefined });

/**
 * GET /api/status: the API runs, and whether it refuses every write (READONLY=1, `npm run start:audit`).
 * The static audit export's status always is readonly and names its snapshot.
 */
export interface ApiStatus { ok: true; readonly: boolean; snapshot?: AuditSnapshot }
