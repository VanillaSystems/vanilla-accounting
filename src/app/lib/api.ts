import type { BankTransaction, JournalEntry, Receipt, ReceiptPatch, TransactionPatch } from '../../types/index.js';
import type { ReturnFigures } from '../../accounting/return-figures.js';
import type { Account } from './accounts.js';
import type { Workspace } from '../../workspace/workspace.js';

/** Every call throws an Error carrying the API's own message when the response is not ok. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { method } : {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Awaits an API call and shows its refusal in an alert instead of throwing. True when it succeeded. */
export async function orAlert(call: Promise<unknown>): Promise<boolean> {
  try {
    await call;
    return true;
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
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
    request<{ transaction: BankTransaction }>('PATCH', `/api/transactions/${encodeURIComponent(ref)}`, patch),
  deleteTransaction: (ref: string) => request<Ok>('DELETE', `/api/transactions/${encodeURIComponent(ref)}`),
  createManualTransaction: (input: ManualTransactionInput) =>
    request<{ ref: string }>('POST', '/api/transactions/manual', input).then((r) => r.ref),
  suggestManualTransaction: (receiptId: string) =>
    request<{ date: string; description: string; amount: number | null; currency: string }>('POST', '/api/transactions/manual/suggest', { receiptId }),

  addMapping: (link: Link) => request<Ok>('POST', '/api/mapping/add', link),
  removeMapping: (link: Link) => request<Ok>('POST', '/api/mapping/remove', link),
  approveDuplicate: (receiptId: string) => request<Ok>('POST', '/api/mapping/approve-duplicate', { receiptId }),

  patchJournalEntry: (id: string, patch: JournalEntryPatch) =>
    request<Ok>('PATCH', `/api/journal-entries/${encodeURIComponent(id)}`, patch),
  deleteJournalEntry: (id: string) => request<Ok>('DELETE', `/api/journal-entries/${encodeURIComponent(id)}`),
  classifyTransaction: (txRef: string) => request<unknown>('POST', `/api/journal-entries/classify/${encodeURIComponent(txRef)}`),

  status: () => request<Ok>('GET', '/api/status'),
  accounts: () => request<Account[]>('GET', '/api/accounts'),
  workspace: () => request<Pick<Workspace, 'company' | 'bankAccounts'>>('GET', '/api/workspace'),
  filedReturns: (year: string) => request<ReturnFigures[]>('GET', `/api/vat/filed?year=${year}`),
};
