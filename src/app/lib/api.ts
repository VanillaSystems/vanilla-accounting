import type { BankTransaction, InboxFile, Index, JournalEntry, Receipt, ReceiptPatch, TransactionPatch } from '../../types/index.js';
import type { ReturnFigures } from '../../accounting/return-figures.js';
import type { EstvRateTable } from '../../accounting/fx-conversion.js';
import type { Account } from './accounts.js';
import type { Workspace } from '../../workspace/workspace.js';
import type { ApiErrorBody, ApiStatus } from '../../types/api-error.js';
import type { Opening, TemplateState, YearClose } from '../../accounting/year-close.js';
import { t } from '../i18n/index.js';
import { formatDate } from './utils.js';
import { API_SOURCES, EXPORT_SOURCES } from '../../audit/sources.js';

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

/** What to tell the user about a failed call: a coded refusal in their language, else the API's own text. */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  const b = e.body;
  switch (b.code) {
    case 'readonly': return t('error.readonly');
    case 'localOnly': return t('error.localOnly');
    case 'manualOnly': return t('error.manualOnly');
    case 'yearClose': return t('error.yearClose');
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
export type YearEndEntryInput = Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'amount' | 'description'> & { vatCode?: string; template?: string };
export type YearCloseView = YearClose & { opening?: Opening };

export const api = {
  patchReceipt: (id: string, patch: ReceiptPatch) =>
    request<{ receipt: Receipt }>('PATCH', `/api/receipts/${id}`, patch).then((r) => r.receipt),
  deleteReceipt: (id: string) => request<Ok>('DELETE', `/api/receipts/${id}`),
  visionExtract: (receiptId: string) => request<Ok>('POST', '/api/vision/extract', { receiptId }),

  patchTransaction: (ref: string, patch: TransactionPatch) =>
    request<{ transaction: BankTransaction }>('PATCH', `/api/transactions/${encodeURIComponent(ref)}`, patch),
  deleteTransaction: (ref: string) => request<Ok>('DELETE', `/api/transactions/${encodeURIComponent(ref)}`),
  createManualTransaction: (input: ManualTransactionInput) =>
    request<{ ref: string }>('POST', '/api/transactions/manual', input).then((r) => r.ref),
  suggestManualTransaction: (receiptId: string) =>
    request<{ date: string; description: string; amount: number | null; currency: string }>('POST', '/api/transactions/manual/suggest', { receiptId }),

  addMapping: (link: Link) => request<Ok>('POST', '/api/mapping/add', link),
  removeMapping: (link: Link) => request<Ok>('POST', '/api/mapping/remove', link),

  patchJournalEntry: (id: string, patch: JournalEntryPatch) =>
    request<Ok>('PATCH', `/api/journal-entries/${encodeURIComponent(id)}`, patch),
  deleteJournalEntry: (id: string) => request<Ok>('DELETE', `/api/journal-entries/${encodeURIComponent(id)}`),
  classifyTransaction: (txRef: string) => request<unknown>('POST', `/api/journal-entries/classify/${encodeURIComponent(txRef)}`),

  yearClose: (year: string) => request<YearCloseView>('GET', `/api/year-close/${year}`),
  bookRevaluation: (year: string) => request<{ entries: JournalEntry[] }>('POST', `/api/year-close/${year}/revaluation`),
  markYearEndEntry: (year: string, id: string, state: TemplateState | null) => request<unknown>('PUT', `/api/year-close/${year}/templates/${id}`, { state }),
  bookYearEndEntry: (year: string, input: YearEndEntryInput) => request<{ entry: JournalEntry }>('POST', `/api/year-close/${year}/entries`, input),
  closeYear: (year: string) => request<unknown>('POST', `/api/year-close/${year}/close`),
  openYear: (year: string) => request<unknown>('POST', `/api/year-close/${year}/open`),

  /** A PDF into the workspace's inbox (beleg-import/), as the phone app sends it. */
  upload: async (pdf: Blob, capturedAt: Date) => {
    if (STATIC_EXPORT) throw new ApiError({ error: 'read-only snapshot', code: 'readonly' });
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Captured-At': capturedAt.toISOString() }, body: pdf });
    if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as ApiErrorBody | null) ?? { error: `HTTP ${res.status}` });
    return (await res.json()) as { filename: string };
  },

  /** The PDFs waiting in the inbox to be read; none in the static export. */
  inbox: () => (STATIC_EXPORT ? Promise.resolve([]) : request<InboxFile[]>('GET', '/api/inbox')),
  inboxFile: (id: string) => `/api/inbox/${id}`,

  books: () => request<Index>('GET', `${sources.books()}?t=${Date.now()}`),
  status: () => request<ApiStatus>('GET', sources.status()),
  accounts: () => request<Account[]>('GET', sources.accounts()),
  workspace: () => request<Pick<Workspace, 'company' | 'bankAccounts'>>('GET', sources.workspace()),
  filedReturns: (year: string) => request<ReturnFigures[]>('GET', sources.filedReturns(year)),
  fxRates: () => request<EstvRateTable>('GET', sources.fxRates()),
};
