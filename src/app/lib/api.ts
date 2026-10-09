import type { BankTransaction, Index, JournalEntry, Receipt, ReceiptPatch, TransactionPatch } from '../../types/index.js';
import type { ReturnFigures } from '../../accounting/return-figures.js';
import type { Account } from './accounts.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { ApiErrorBody, ApiStatus } from '../../types/api-error.js';
import { t } from '../i18n/index.js';
import { formatDate } from './utils.js';
import { API_SOURCES, EXPORT_SOURCES } from '../../audit/sources.js';
import type { LogCommit } from '../../books/history.js';
import type { ReviewView, ImportResult, DecideInput, DecideResult } from '../../review/git.js';
import type { DecidedReview } from '../../review/package.js';
import type { Intent } from '../../review/corrections.js';
import { ClosedPeriodError, IntentError, reviewSession } from './review.js';

/** Built by `npm run build:audit` (vite --mode audit): reads the export's files, never an API. */
export const STATIC_EXPORT = import.meta.env.MODE === 'audit';

/** Where each read goes: every URL the UI fetches or links to comes from here. */
export const sources = STATIC_EXPORT ? EXPORT_SOURCES : API_SOURCES;

/** A refused request: the API's body, whose code errorText says in the user's language. */
export class ApiError extends Error {
  constructor(readonly body: ApiErrorBody) { super(body.error); }
}

/** Every call throws an ApiError when the response is not ok. The static export refuses every write unsent. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (STATIC_EXPORT && method !== 'GET') throw new ApiError({ error: 'read-only snapshot', code: 'readonly' });
  const res = await fetch(path, body === undefined ? { method } : {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(err?.error ? err : { error: `HTTP ${res.status}` });
  }
  return res.json() as Promise<T>;
}

/**
 * In a review package every write is a correction of the Treuhänder's copy (lib/review.ts): a
 * refusal comes back as the API's would, so errorText says it the same way.
 */
async function correct(intent: Intent): Promise<Ok> {
  try {
    await reviewSession()!.write(intent);
    return { ok: true };
  } catch (e) {
    if (e instanceof ClosedPeriodError) {
      throw new ApiError({ error: e.message, code: 'periodClosed', params: { closedThrough: e.closedThrough ?? '', ...(e.reason ? { reason: e.reason } : {}) } });
    }
    if (e instanceof IntentError) throw new ApiError({ error: e.message });
    throw e;
  }
}

/** A write the review package makes as a correction, else the API's request. */
const write = <T>(intent: () => Intent, call: () => Promise<T>): Promise<T | Ok> => (reviewSession() ? correct(intent()) : call());

/** What to tell the user about a failed call: a coded refusal in their language, else the API's own text. */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  const b = e.body;
  switch (b.code) {
    case 'readonly': return t('error.readonly');
    case 'localOnly': return t('error.localOnly');
    case 'manualOnly': return t('error.manualOnly');
    case 'fileExists': return t('error.fileExists', b.params);
    case 'periodClosed': {
      const closed = t('error.periodClosed', { date: formatDate(b.params.closedThrough) });
      return b.params.reason ? `${closed} ${t(`error.closed.${b.params.reason}`)}` : closed;
    }
    case undefined: return b.error;
  }
}

/** Awaits an API call and shows its refusal in an alert instead of throwing. True when it succeeded. */
export async function orAlert(call: Promise<unknown>): Promise<boolean> {
  try {
    await call;
    return true;
  } catch (e) {
    alert(errorText(e));
    return false;
  }
}

type Ok = { ok: true };
type Link = { receiptId: string; transactionRef: string };
export type JournalEntryPatch = Partial<Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'vatCode' | 'description'>>;
export type ManualTransactionInput ={ date: string; description: string; amount: number; currency: string };

export const api = {
  patchReceipt: (id: string, patch: ReceiptPatch) =>
    request<{ receipt: Receipt }>('PATCH', `/api/receipts/${id}`, patch).then((r) => r.receipt),
  deleteReceipt: (id: string) => request<Ok>('DELETE', `/api/receipts/${id}`),
  suggestFilename: (receiptId: string) =>
    request<{ suggestedFilename: string }>('POST', '/api/rename/suggest', { receiptId }).then((r) => r.suggestedFilename),
  suggestDate: (id: string) => request<{ date: string }>('POST', `/api/receipts/${id}/suggest-date`).then((r) => r.date),
  visionExtract: (receiptId: string) => request<Ok>('POST', '/api/vision/extract', { receiptId }),
  batchRename: () => request<{ renamed: number; skipped: number; failed: number }>('POST', '/api/rename/batch'),

  patchTransaction: (ref: string, patch: TransactionPatch) =>
    write(() => ({ kind: 'editTransaction', ref, patch }), () => request<{ transaction: BankTransaction }>('PATCH', `/api/transactions/${encodeURIComponent(ref)}`, patch)),
  deleteTransaction: (ref: string) => request<Ok>('DELETE', `/api/transactions/${encodeURIComponent(ref)}`),
  createManualTransaction: (input: ManualTransactionInput) =>
    request<{ ref: string }>('POST', '/api/transactions/manual', input).then((r) => r.ref),
  suggestManualTransaction: (receiptId: string) =>
    request<{ date: string; description: string; amount: number | null; currency: string }>('POST', '/api/transactions/manual/suggest', { receiptId }),

  addMapping: (link: Link) => write(() => ({ kind: 'linkReceipt', ref: link.transactionRef, receiptId: link.receiptId }), () => request<Ok>('POST', '/api/mapping/add', link)),
  removeMapping: (link: Link) => write(() => ({ kind: 'unlinkReceipt', ref: link.transactionRef, receiptId: link.receiptId }), () => request<Ok>('POST', '/api/mapping/remove', link)),
  approveDuplicate: (receiptId: string) => request<Ok>('POST', '/api/mapping/approve-duplicate', { receiptId }),

  patchJournalEntry: (id: string, patch: JournalEntryPatch) =>
    write(() => ({ kind: 'editEntry', id, patch }), () => request<Ok>('PATCH', `/api/journal-entries/${encodeURIComponent(id)}`, patch)),
  deleteJournalEntry: (id: string) => write(() => ({ kind: 'reverseEntry', id }), () => request<Ok>('DELETE', `/api/journal-entries/${encodeURIComponent(id)}`)),
  classifyTransaction: (txRef: string) => request<unknown>('POST', `/api/journal-entries/classify/${encodeURIComponent(txRef)}`),

  books: () => {
    const review = reviewSession();
    return review ? Promise.resolve(review.books as Index) : request<Index>('GET', `${sources.books()}?t=${Date.now()}`);
  },
  log: () => request<LogCommit[]>('GET', sources.log()),
  chart: () => request<Account[]>('GET', sources.chart()),
  reviewDecisions: () => request<DecidedReview[]>('GET', sources.reviewDecisions()),
  reviews: () => request<ReviewView[]>('GET', '/api/reviews'),
  importReview: (file: unknown) => request<ImportResult>('POST', '/api/reviews/import', file),
  decideReview: (branch: string, input: DecideInput) => request<DecideResult>('POST', '/api/reviews/decide', { branch, ...input }),
  status: () => request<ApiStatus>('GET', sources.status()),
  accounts: () => request<Account[]>('GET', sources.accounts()),
  workspace: () => request<Pick<Workspace, 'company' | 'bankAccounts'>>('GET', sources.workspace()),
  filedReturns: (year: string) => request<ReturnFigures[]>('GET', sources.filedReturns(year)),
};
