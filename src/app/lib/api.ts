import type { BankTransaction, InboxFile, Index, StatementImport, JournalEntry, Receipt, ReceiptPatch, TransactionPatch } from '../../types/index.js';
import type { IntakeStatus } from '../../intake/pipeline.js';
import type { EstvRateTable } from '../../accounting/fx-conversion.js';
import type { WorkspaceModules } from '../../core/modules/load.js';
import type { Account } from './accounts.js';
import type { CompanyInfo } from '../../books/company.js';
import type { ManifestPatch } from '../../workspace/manifest-write.js';
import type { ApiErrorBody, ApiStatus, MailStatus } from '../../types/api-error.js';
import type { MailMessage } from '../../invoices/mail.js';
import type { ReceiptType } from '../../types/upload.js';
import type { Opening, TemplateState, YearClose } from '../../accounting/year-close.js';
import { t, tData } from '../i18n/index.js';
import { formatDate } from './utils.js';
import { API_SOURCES, EXPORT_SOURCES } from '../../audit/sources.js';
import type { Comment, Customer, CustomerFields, Draft, Invoice, Issued, Reminder, SentDocument } from '../../invoices/model.js';
import type { PaymentProposal } from '../../invoices/payments.js';
import type { DraftPatch } from '../../invoices/service.js';
import type { InvoiceRefusal, Missing } from '../../invoices/rules.js';
import type { DesktopInfo, KnownBooks } from '../../types/desktop.js';
import type { SetupRefusal, SetupRequest } from '../../workspace/create.js';
import type { ReturnFigures } from '../../engines/return.js';

/** Built by `npm run build:audit` (vite --mode audit): reads the export's files, never an API. */
import type { AutomationCommand, AutomationView, CommandResult, RunDetail } from '../../workflows/model.js';
import type { Conversation, ConversationSummary } from '../../types/assistant.js';
import type { ChangesView, FileDiff, SaveDetail, SavingCommand, SavingResult } from '../../saving/model.js';

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
  if ('invoiceRefusal' in b) return invoiceRefusalText(b.invoiceRefusal, b.missing);
  if ('mailRefusal' in b) return t(`mail.refusal.${b.mailRefusal}`, { detail: b.detail ?? '' });
  switch (b.code) {
    case 'readonly': return t('error.readonly');
    case 'localOnly': return t('error.localOnly');
    case 'manualOnly': return t('error.manualOnly');
    case 'hasEntries': return t('error.hasEntries');
    case 'yearClose': return t('error.yearClose');
    case 'fileExists': return t('error.fileExists', b.params);
    case 'statement': {
      const { reason, detail = '' } = b.params;
      if (reason === 'duplicate') return t('error.statement.duplicate', { detail });
      if (reason === 'account') return detail ? b.error : t('error.statement.account');
      return t(`error.statement.${reason}`);
    }
    case 'noBrowser': return t('error.noBrowser');
    case 'noClaude': return t('error.noClaude');
    case 'noWorkspace': return t('desktop.noWorkspace');
    case 'notWorkspace': return t('desktop.notWorkspace');
    case 'setup': return setupText(b.params);
    case 'periodClosed': {
      const closed = t('error.periodClosed', { date: formatDate(b.params.closedThrough) });
      return b.params.reason ? `${closed} ${t(`error.closed.${b.params.reason}`)}` : closed;
    }
    case undefined: return b.error;
  }
}

/** Why a new workspace was refused, as the start screen says it (src/workspace/create.ts). */
export function setupText(r: SetupRefusal): string {
  switch (r.reason) {
    case 'unsupported': return r.question === 'preset' ? t('desktop.q.preset.freelancer.unsupported') : tData(`desktop.q.${r.question}.${r.value}.unsupported`);
    case 'required': return t(`desktop.setup.required.${r.field}`);
    case 'uid': case 'language': case 'preset': return t(`desktop.setup.${r.reason}`, { detail: r.detail });
    case 'noBank': return t('desktop.setup.noBank');
    default: return t(`desktop.setup.${r.reason}`, { bank: r.bank, detail: r.detail });
  }
}

/** What an invoice still needs before it is issued (Art. 26 MWSTG), one phrase per gap; `line` counts from 0. */
export const missingText = (m: Missing): string =>
  m.line === undefined ? t(`invoice.missing.${m.field}`) : t('invoice.missingLine', { line: m.line + 1, what: t(`invoice.missing.${m.field}`) });

function invoiceRefusalText(code: InvoiceRefusal | 'noBrowser', missing?: Missing[]): string {
  if (code === 'incomplete' && missing?.length) return t('invoice.refusal.incompleteList', { list: missing.map(missingText).join(', ') });
  return t(`invoice.refusal.${code}`);
}

type Ok = { ok: true };
type Link = { receiptId: string; transactionRef: string };
export type JournalEntryPatch = Partial<Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'vatCode' | 'description' | 'amount'>>;
/** A new entry by hand; `id` and `transactionRef` put a deleted one back (undo). */
export type JournalEntryInput = Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'amount'> & { description: string }
  & Partial<Pick<JournalEntry, 'id' | 'transactionRef' | 'vatCode' | 'exchangeCurrency' | 'exchangeRate' | 'corrects' | 'origin'>>;
export type ManualTransactionInput ={ date: string; description: string; amount: number; currency: string };
export type YearEndEntryInput = Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'amount' | 'description'> & { vatCode?: string; template?: string };
export type YearCloseView = YearClose & { opening?: Opening };
export interface InvoiceList { today: string; invoices: Invoice[]; customers: Customer[]; sent: SentDocument[] }
export type DraftChange = { [K in keyof DraftPatch]?: DraftPatch[K] | null };
export interface CreditInput { reason: string; amount?: number; settlement?: 'refund' | 'offset' }
export interface ReminderInput { date?: string; fee?: number; intro?: string; closing?: string; to?: string; email?: MailMessage }

/** Raw bytes to a route that takes a file; the static export refuses unsent. */
async function upload<T>(path: string, body: Blob, type: string): Promise<T> {
  if (STATIC_EXPORT) throw new ApiError({ error: 'read-only snapshot', code: 'readonly' });
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': type }, body });
  if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as ApiErrorBody | null) ?? { error: `HTTP ${res.status}` });
  return res.json() as Promise<T>;
}

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

  addMapping: (link: Link) => request<Ok>('POST', '/api/mapping/add', link),
  removeMapping: (link: Link) => request<Ok>('POST', '/api/mapping/remove', link),

  patchJournalEntry: (id: string, patch: JournalEntryPatch) =>
    request<Ok>('PATCH', `/api/journal-entries/${encodeURIComponent(id)}`, patch),
  createJournalEntry: (input: JournalEntryInput) =>
    request<{ entry: JournalEntry }>('POST', '/api/journal-entries', input).then((r) => r.entry),
  deleteJournalEntry: (id: string) => request<Ok>('DELETE', `/api/journal-entries/${encodeURIComponent(id)}`),
  classifyTransaction: (txRef: string) =>
    request<{ entries: JournalEntry[] }>('POST', `/api/journal-entries/classify/${encodeURIComponent(txRef)}`).then((r) => r.entries),

  yearClose: (year: string) => request<YearCloseView>('GET', `/api/year-close/${year}`),
  automation: (since?: string) => request<AutomationView | { unchanged: true }>('GET', `/api/automation${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  automationRun: (id: string) => request<RunDetail>('GET', `/api/automation/runs/${encodeURIComponent(id)}`),
  automationCommand: (cmd: AutomationCommand) => request<CommandResult>('POST', '/api/automation', cmd),
  changes: (since?: string) => request<ChangesView | { unchanged: true }>('GET', `/api/changes${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  changesSave: (oid: string) => request<SaveDetail>('GET', `/api/changes/saves/${encodeURIComponent(oid)}`),
  assistantList: () => request<ConversationSummary[]>('GET', '/api/assistant'),
  assistantConversation: (id: string) => request<Conversation>('GET', `/api/assistant/${encodeURIComponent(id)}`),
  changesCommand: (cmd: SavingCommand) => request<SavingResult>('POST', '/api/changes', cmd),
  changesDiff: (source: string, path: string) => request<FileDiff>('GET', `/api/changes/diff?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`),
  bookRevaluation: (year: string) => request<{ entries: JournalEntry[] }>('POST', `/api/year-close/${year}/revaluation`),
  markYearEndEntry: (year: string, id: string, state: TemplateState | null) => request<unknown>('PUT', `/api/year-close/${year}/templates/${id}`, { state }),
  bookYearEndEntry: (year: string, input: YearEndEntryInput) => request<{ entry: JournalEntry }>('POST', `/api/year-close/${year}/entries`, input),
  closeYear: (year: string) => request<unknown>('POST', `/api/year-close/${year}/close`),
  openYear: (year: string) => request<unknown>('POST', `/api/year-close/${year}/open`),

  /** A PDF or photo into the workspace's inbox (beleg-import/), as the phone app sends it. */
  upload: async (file: Blob, type: ReceiptType, capturedAt: Date) => {
    if (STATIC_EXPORT) throw new ApiError({ error: 'read-only snapshot', code: 'readonly' });
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': type, 'X-Captured-At': capturedAt.toISOString() }, body: file });
    if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as ApiErrorBody | null) ?? { error: `HTTP ${res.status}` });
    return (await res.json()) as { filename: string };
  },

  /** A camt.053 or statement PDF into bank-statements/, read into the books; `into` names the missing month it is for. */
  importStatement: async (file: Blob, name: string, into?: { account: string; month: string }) => {
    if (STATIC_EXPORT) throw new ApiError({ error: 'read-only snapshot', code: 'readonly' });
    const qs = new URLSearchParams({ name, ...into });
    const res = await fetch(`/api/statements?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as ApiErrorBody | null) ?? { error: `HTTP ${res.status}` });
    return (await res.json()) as StatementImport;
  },

  /** How far the inbox processing is (src/intake/); the static export has none. */
  intake: () => (STATIC_EXPORT ? Promise.resolve<IntakeStatus>({ running: false, inbox: [] }) : request<IntakeStatus>('GET', '/api/intake')),
  /** Starts the inbox processing; while a job runs, one more run after it. */
  startIntake: () => request<IntakeStatus>('POST', '/api/intake'),

  /** The PDFs waiting in the inbox to be read; none in the static export. */
  inbox: () => (STATIC_EXPORT ? Promise.resolve([]) : request<InboxFile[]>('GET', '/api/inbox')),
  inboxFile: (id: string) => `/api/inbox/${id}`,

  books: () => request<Index>('GET', `${sources.books()}?t=${Date.now()}`),
  modules: () => request<WorkspaceModules>('GET', `${sources.modules()}?t=${Date.now()}`),
  status: () => request<ApiStatus>('GET', sources.status()),
  accounts: () => request<Account[]>('GET', sources.accounts()),
  workspace: () => request<CompanyInfo>('GET', sources.workspace()),
  /** The desktop app's start screen (src/desktop/server.ts). */
  desktop: {
    info: () => request<DesktopInfo>('GET', '/api/desktop'),
    open: (root: string) => request<KnownBooks>('POST', '/api/desktop/open', { root }),
    create: (setup: SetupRequest) => request<KnownBooks>('POST', '/api/desktop/create', setup),
    demo: () => request<KnownBooks>('POST', '/api/desktop/demo'),
  },
  patchWorkspace: (patch: ManifestPatch) => request<CompanyInfo>('PATCH', '/api/workspace', patch),
  setAccountName: (number: string, name: string) => request<{ number: string; name: string; added: boolean }>('PUT', `/api/accounts/${number}`, { name }),
  uploadLogo: (file: Blob, type: string) => upload<CompanyInfo>('/api/workspace/logo', file, type),
  logoUrl: (path: string) => `/api/invoice-logo?path=${encodeURIComponent(path)}`,

  invoices: () => request<InvoiceList>('GET', '/api/invoices'),
  paymentProposals: () => request<{ proposals: PaymentProposal[] }>('GET', '/api/invoices/payments').then((r) => r.proposals),
  createCustomer: (fields: CustomerFields) => request<Customer>('POST', '/api/customers', fields),
  patchCustomer: (id: string, fields: Partial<CustomerFields>) => request<Customer>('PATCH', `/api/customers/${id}`, fields),
  createDraft: (input: DraftChange & { customerId: string }) => request<Draft>('POST', '/api/invoices', input),
  patchDraft: (id: string, patch: DraftChange) => request<Draft>('PATCH', `/api/invoices/${id}`, patch),
  deleteDraft: (id: string) => request<{ ok: true }>('DELETE', `/api/invoices/${id}`),
  issue: (id: string) => request<Issued>('POST', `/api/invoices/${id}/issue`),
  /** With `email` the PDF goes out through the company's mailbox; without, the send is recorded as a download to `to`. */
  recordSend: (id: string, send: { to?: string; email?: MailMessage }) => request<SentDocument>('POST', `/api/invoices/${id}/send`, send),
  mailStatus: () => request<MailStatus>('GET', '/api/mail'),
  saveMailPassword: (password: string) => request<{ ok: true }>('PUT', '/api/mail/password', { password }),
  verifyMail: () => request<{ ok: true }>('POST', '/api/mail/verify'),
  cancelInvoice: (id: string, input: { date: string; reason: string; notify: boolean; to?: string; email?: MailMessage }) =>
    request<{ invoice: Issued; sent?: SentDocument }>('POST', `/api/invoices/${id}/cancel`, input),
  creditNote: (id: string, input: CreditInput) => request<Draft>('POST', `/api/invoices/${id}/credit-note`, input),
  sendReminder: (id: string, input: ReminderInput) => request<{ reminder: Reminder; sent: SentDocument }>('POST', `/api/invoices/${id}/reminders`, input),
  addComment: (id: string, text: string) => request<Comment>('POST', `/api/invoices/${id}/comments`, { text }),
  confirmPayment: (id: string, transactionRef: string) => request<{ paid: unknown }>('POST', `/api/invoices/${id}/payments`, { transactionRef }),
  /** The PDF as issued, or a sent reminder or notice as sent: the file's path under the workspace is its URL. */
  documentUrl: (file: string) => `/${file.split('/').map(encodeURIComponent).join('/')}`,

  filedReturns: (year: string) => request<ReturnFigures[]>('GET', sources.filedReturns(year)),
  fxRates: () => request<EstvRateTable>('GET', sources.fxRates()),
};
