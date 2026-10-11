import type { AuditSnapshot } from '../audit/sources.js';
import type { MailRefusal } from '../invoices/mail.js';
import type { InvoiceRefusal, Missing } from '../invoices/rules.js';

/**
 * The JSON body of every refused API request. `error` is the German text the CLI, the tests and
 * the logs read; `code` and `params` let the UI say the same in the user's language
 * (src/app/lib/api.ts errorText). A body without a code is shown as its `error` text.
 */
export const CLOSED_REASONS = [
  'editTransaction', 'deleteTransaction', 'newTransaction', 'mapping',
  'editReceipt', 'deleteReceipt', 'editEntry', 'deleteEntry', 'newStatement', 'newEntry',
] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export type ApiRefusal =
  | { code: 'readonly' }
  | { code: 'localOnly' }
  | { code: 'periodClosed'; params: { closedThrough: string; reason?: ClosedReason } }
  | { code: 'manualOnly' }
  | { code: 'hasEntries' }
  | { code: 'yearClose' }
  | { code: 'fileExists'; params: { filename: string } }
  | { code: 'statement'; params: { reason: StatementRefusal; detail?: string } }
  | { code: 'noBrowser' };

/**
 * Why a statement upload (POST /api/statements) was refused: not XML or PDF, an XML that is no
 * camt.053, no bank account takes it (detail: the manifest's problem), a PDF whose name gives no
 * month, or a camt.053 already read (detail: that file).
 */
export type StatementRefusal = 'format' | 'notCamt' | 'account' | 'name' | 'duplicate';

/** An invoicing refusal: which rule of src/invoices/rules.ts refused, and for an incomplete invoice what Art. 26 MWSTG still asks for. */
export type InvoiceErrorBody = { error: string; code?: undefined; invoiceRefusal: InvoiceRefusal | 'noBrowser'; missing?: Missing[] };

/** An e-mail the company's mailbox did not send (src/invoices/mail.ts); nothing was recorded. */
export type MailErrorBody = { error: string; code?: undefined; mailRefusal: MailRefusal; detail?: string };

export type ApiErrorBody = ({ error: string } & (ApiRefusal | { code?: undefined })) | InvoiceErrorBody | MailErrorBody;

/**
 * GET /api/status: the API runs, and whether it refuses every write (READONLY=1, `npm run start:audit`).
 * The static audit export's status always is readonly and names its snapshot.
 */
export interface ApiStatus { ok: true; readonly: boolean; snapshot?: AuditSnapshot }

/** GET /api/mail: whether the company's mailbox can send (Firma › E-Mail-Versand). */
export interface MailStatus {
  configured: boolean;
  /** The mailbox logs in and its password is there, or is missing; or it needs none. */
  password: 'set' | 'missing' | 'none';
  /** Where the password goes (`VANILLA_SMTP_PASSWORD in .env`, the keychain). */
  where: string;
}
