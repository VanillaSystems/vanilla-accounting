import type { StatementProblem } from '../../types/api-error.js';
import type { BankTransaction, InboxFile, Index, StatementImport, JournalEntry, Receipt, ReceiptPatch, TransactionPatch } from '../../types/index.js';
import type { StatementRemoved } from '../../server/routes/statements.js';
import type { PaymentReleased } from '../../invoices/payments.js';
export type { StatementRemoved };
import type { BookingLine } from '../../accounting/manual-booking.js';
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
import { fmt, formatDate } from './utils.js';
import { vatSetup } from '../../engines/index.js';
import { normalRate } from '../../accounting/sales-without-vat.js';
import { API_SOURCES, EXPORT_SOURCES } from '../../audit/sources.js';
import type { Comment, Customer, CustomerFields, Draft, Invoice, Issued, Reminder, SentDocument } from '../../invoices/model.js';
import type { PaymentProposal } from '../../invoices/payments.js';
import type { DraftPatch } from '../../invoices/service.js';
import type { InvoiceRefusal, Missing } from '../../invoices/rules.js';
import type { DesktopInfo, KnownBooks, PhoneInfo } from '../../types/desktop.js';
import type { SetupRefusal, SetupRequest } from '../../workspace/create.js';
import type { ReturnFigures } from '../../engines/return.js';
import type { JournalEntryInput } from '../../books/entry-input.js';
import type { Answer, Choice, Question, QuestionsView, QuestionTarget } from '../../questions/model.js';

/** Built by `npm run build:audit` (vite --mode audit): reads the export's files, never an API. */
import type { AutomationCommand, AutomationView, CommandResult, RunDetail } from '../../workflows/model.js';
import type { Conversation, ConversationSummary, MadeChange, Turn } from '../../types/assistant.js';
import type { DropAction, DropSession, QuarantinedFile } from '../../types/drop.js';
import type { MailCheck, SourcesView } from '../../platform/sources/model.js';
import type { DraftCommand, DraftView, KeepResult, RuleCommand, RuleCommandResult, RulesView } from '../../saving/rules.js';
import type { ShareOffer } from '../../saving/share-rule.js';
import type { CorrectionOffer } from '../../saving/correction-rule.js';
import type { HandRule, HandStart } from '../../saving/hand-rule.js';
import { refusalKey } from '../areas/company/rules-model.js';
import { refusalText } from '../../reports/words.js';
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
const dayAfter = (iso: string) => new Date(Date.parse(`${iso}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
const groupedIban = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

/** Why a statement lands on no bank account, in the person's words (never the manifest file). */
function statementProblemText(p: StatementProblem): string {
  switch (p.kind) {
    case 'noAccount': return p.iban ? t('error.statement.unknownAccount', { iban: groupedIban(p.iban), currency: p.currency }) : t('error.statement.noAccount', { currency: p.currency });
    case 'otherIban': return t('error.statement.otherIban', { iban: groupedIban(p.iban), bank: p.account.bank, currency: p.currency, known: groupedIban(p.account.iban) });
    case 'twoAccounts': return t('error.statement.twoAccounts', { bank: p.bank, currency: p.currency, first: groupedIban(p.ibans[0]), second: groupedIban(p.ibans[1]) });
  }
}

export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  const b = e.body;
  if ('invoiceRefusal' in b) return invoiceRefusalText(b.invoiceRefusal, b.missing);
  if ('mailRefusal' in b) return t(`mail.refusal.${b.mailRefusal}`, { detail: b.detail ?? '' });
  switch (b.code) {
    case 'readonly': return t('error.readonly');
    case 'localOnly': return t('error.localOnly');
    case 'phoneToken': return t('error.phoneToken');
    case 'manualOnly': return t('error.manualOnly');
    case 'hasEntries': return t('error.hasEntries');
    case 'bookedSince': return t('error.bookedSince', { payment: b.params.payment, n: b.params.entries, by: t(`error.bookedSince.${b.params.by}`) });
    case 'receiptPaid': return t('error.receiptPaid', { payment: b.params.payment });
    case 'secondPayment': return t('error.secondPayment', { payment: b.params.payment });
    case 'yearClose': return t('error.yearClose');
    case 'paymentDate': return t('error.paymentDate', { date: formatDate(b.params.date) });
    case 'paymentBalance': {
      const { date, currency, paid, booked } = b.params;
      return t('error.paymentBalance', { date: formatDate(date), paid: `${currency} ${fmt(paid)}`, booked: `${currency} ${fmt(booked)}` });
    }
    case 'classifyAccount': return t('error.classifyAccount', b.params);
    case 'classifyBalance': {
      const { date, currency, paid, booked } = b.params;
      return t('error.classifyBalance', { date: formatDate(date), paid: `${currency} ${fmt(paid)}`, booked: `${currency} ${fmt(booked)}` });
    }
    case 'personsBooking': return t('error.personsBooking', { n: b.params.entries });
    case 'fileExists': return t('error.fileExists', b.params);
    case 'notInTrash': return t('error.notInTrash');
    case 'deletedAgain': return t('error.deletedAgain');
    case 'alreadyBack': return t('error.alreadyBack');
    case 'statement': {
      const { reason, detail = '', unknown, problem, closed } = b.params;
      if (reason === 'duplicate') return t('error.statement.duplicate', { detail: detail.split('/').pop() ?? detail });
      // A firm that files no return has closed periods, not filed ones (r9k-9).
      if (reason === 'filedPayments') return closed ? t(vatSetup().registered ? 'error.statement.filedPayments' : 'error.statement.closedPayments', { n: closed.n, through: formatDate(closed.through), from: formatDate(dayAfter(closed.through)), refs: closed.refs.slice(0, 5).join(', ') }) : b.error;
      if (reason === 'account') return problem ? statementProblemText(problem) : unknown ? t('error.statement.unknownAccount', unknown) : t('error.statement.account');
      return t(`error.statement.${reason}`);
    }
    case 'iban': return t('error.iban', b.params);
    case 'uid': return t('error.uid', b.params);
    case 'payToNeedsIban': return t('error.payToNeedsIban', b.params);
    case 'questionAnswered': return t('error.questionAnswered');
    case 'questionGone': return t(`questions.gone.${b.params.why}`);
    case 'takesBack': return t('error.takesBack');
    case 'setAside': return t('error.setAside', b.params);
    case 'unknownAccount': return t('error.unknownAccount', b.params);
    case 'oneSided': return t('error.oneSided', b.params);
    case 'codeSign': return t(b.params.expected.startsWith('-') ? 'error.codeSign.back' : 'error.codeSign.out', b.params);
    case 'accountInUse': return t('error.accountInUse', { account: b.params.account, n: b.params.entries });
    case 'bankInUse': return t('error.bankInUse', { label: b.params.label, account: b.params.account, uses: [
      b.params.statements && t('error.bankInUse.statements', { n: b.params.statements }),
      b.params.entries && t('error.bankInUse.entries', { n: b.params.entries }),
      b.params.invoices && t('error.bankInUse.invoices', { n: b.params.invoices }),
    ].filter(Boolean).join(', ') });
    case 'ledgerAccountTaken': return t('error.ledgerAccountTaken', b.params);
    case 'noBrowser': return t('error.noBrowser');
    case 'noClaude': return t('error.noClaude');
    case 'gone': return t(`error.gone.${b.params.what}`);
    case 'secretStore': return t('error.secretStore');
    case 'invoice': return invoiceRefusalText(b.params.refusal, b.params.missing);
    case 'invoicingNotSetUp': return t('error.invoicingNotSetUp');
    case 'payToAccount': return t('error.payToAccount', b.params);
    case 'iban': return t('error.iban', b.params);
    case 'ibanOnInvoices': return t('error.ibanOnInvoices', b.params);
    case 'unknownCustomer': return t('error.unknownCustomer');
    case 'amountZero': return t('error.amountZero');
    case 'noAccount': return t('error.noAccount');
    case 'sameAccount': return t('error.sameAccount', b.params);
    case 'unknownVatCode': return t('error.unknownVatCode', b.params);
    case 'codeNotTaken': return t(b.params.method === 'none' ? 'error.codeNotTaken.none' : 'error.codeNotTaken.netRate', { code: b.params.code });
    case 'rule': { const k = refusalKey(b.params.refusal); return t(k.key, k.vars as never); }
    case 'report': return t('error.report', { why: refusalText(b.params.refusal, (k, v) => t(k, v as never)) });
    case 'noDescription': return t('error.noDescription');
    case 'accountNumber': return t('error.accountNumber', b.params);
    case 'accountName': return t('error.accountName', b.params);
    case 'questionChoices': return t('error.questionChoices', {
      private: t('questions.choice.private'), business: t('questions.choice.business'), saleDomestic: t('questions.choice.saleDomestic', { rate: String(normalRate()) }),
      saleAbroad: t('questions.choice.saleAbroad'), notSale: t('questions.choice.notSale'),
    });
    case 'accountOutsideStatements': return t('error.accountOutsideStatements', b.params);
    case 'noWorkspace': return t('desktop.noWorkspace');
    case 'notWorkspace': return t('desktop.notWorkspace');
    case 'setup': return setupText(b.params);
    case 'openingAccount': return t(`error.openingAccount.${b.params.reason}`, { account: b.params.account });
    case 'openingNotFirstYear': return t('error.openingNotFirstYear', { year: b.params.year });
    case 'openingYearClosed': return t('company.openingClosed', { year: b.params.year });
    case 'mailSourceField': return t(`sources.field.${b.params.field}.invalid` as 'sources.field.address.invalid');
    case 'vatMethodHeld': return t('error.vatMethodHeld', { year: b.params.year, n: b.params.entries, next: String(Number(b.params.year) + 1) });
    case 'vatSetup': return t(`error.vatSetup.${b.params.reason}`, { rate: String(b.params.rate) });
    case 'periodClosed': {
      if (b.params.filed) return t('error.periodFiledDrift', { period: b.params.filed });
      const closed = b.params.approved ? t('error.periodApproved', { period: b.params.approved }) : t('error.periodClosed', { date: formatDate(b.params.closedThrough) });
      return b.params.reason ? `${closed} ${t(`error.closed.${b.params.reason}`)}` : closed;
    }
    case undefined: return b.error;
  }
}

/** Why a new workspace was refused, as the start screen says it (src/workspace/create.ts). */
export function setupText(r: SetupRefusal): string {
  switch (r.reason) {
    case 'unsupported': return r.question === 'preset' ? tData(`desktop.q.preset.${r.value}`) : tData(`desktop.q.${r.question}.${r.value}.unsupported`);
    case 'missing': return t('desktop.setup.missing', { question: tData(`desktop.q.${r.question}.ask`) });
    case 'netRates': return t('desktop.setup.netRates', { detail: r.detail });
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
  // A customer's field is filled in where the customer is kept: the line says so.
  if (code === 'incomplete' && missing?.length) return t('invoice.refusal.incompleteList', { list: missing.map(missingText).join(', ') }) + (missing.some((m) => m.field.startsWith('customer.')) ? ` ${t('invoice.refusal.customerWhere')}` : '');
  return t(`invoice.refusal.${code}`);
}

type Ok = { ok: true };
/** `confirm`: a second bank payment of another payee for a receipt that has one, confirmed (r8h-21). */
type Link = { receiptId: string; transactionRef: string; confirm?: true };
type Linked = Ok & { again: string[]; kept?: string[] };
/** A change by hand; `origin`, `reason` and `by` only from its undo (null: the booking had none). */
export type JournalEntryPatch = Partial<Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'vatCode' | 'description' | 'amount' | 'receipts'>>
  & { origin?: JournalEntry['origin'] | null; reason?: string | null; by?: JournalEntry['by'] | null };
/** A new entry by hand; `id`, `transactionRef` and the provenance put a deleted one back (undo): src/books/entry-input.ts. */
export type { JournalEntryInput };
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
  deleteReceipt: (id: string) => request<{ ok: true; deletion: string }>('DELETE', `/api/receipts/${id}`).then((r) => r.deletion),
  restoreReceipt: (id: string, deletion: string) => request<Ok>('POST', `/api/receipts/${id}/restore`, { deletion }),
  answerTwin: (id: string, answer: 'same' | 'distinct', of: string) => request<Ok>('POST', `/api/receipts/${id}/twin`, { answer, of }),
  visionExtract: (receiptId: string) => request<Ok>('POST', '/api/vision/extract', { receiptId }),

  patchTransaction: (ref: string, patch: TransactionPatch) =>
    request<{ transaction: BankTransaction }>('PATCH', `/api/transactions/${encodeURIComponent(ref)}`, patch),
  deleteTransaction: (ref: string) => request<Ok>('DELETE', `/api/transactions/${encodeURIComponent(ref)}`),
  createManualTransaction: (input: ManualTransactionInput) =>
    request<{ ref: string }>('POST', '/api/transactions/manual', input).then((r) => r.ref),
  /** «Privat oder bar bezahlt»: the owner's payment of the receipt, linked; refused when a payment pays it already. */
  /** The owner's payment made for the receipt: its ref and date, and the filed period it corrects when the receipt lies in one (r8k-10). */
  privatePayment: (receiptId: string) => request<{ ref: string; date: string; corrects?: string }>('POST', `/api/receipts/${receiptId}/private-payment`),

  bookPayment: (ref: string, lines: BookingLine[]) =>
    request<{ entries: JournalEntry[] }>('POST', `/api/transactions/${encodeURIComponent(ref)}/entries`, { lines }).then((r) => r.entries),

  attachEntries: (ref: string, own: string) =>
    request<{ before: JournalEntry[] }>('POST', `/api/transactions/${encodeURIComponent(ref)}/attach`, { ref: own }).then((r) => r.before),

  /** `again`: the payments booked again by a run; `kept`: a booked payment whose booking stays because no model is there to rebook it (r8f-41). */
  addMapping: (link: Link) => request<Linked>('POST', '/api/mapping/add', link),
  removeMapping: (link: Link) => request<Linked>('POST', '/api/mapping/remove', link),

  patchJournalEntry: (id: string, patch: JournalEntryPatch) =>
    request<Ok>('PATCH', `/api/journal-entries/${encodeURIComponent(id)}`, patch),
  createJournalEntry: (input: JournalEntryInput) =>
    request<{ entry: JournalEntry }>('POST', '/api/journal-entries', input).then((r) => r.entry),
  deleteJournalEntry: (id: string) => request<Ok>('DELETE', `/api/journal-entries/${encodeURIComponent(id)}`),
  /** Änderungen › «Rückgängig» of a change by hand: the booking as the last save holds it, or gone when booked since. */
  restoreSavedEntry: (id: string) => request<Ok>('POST', `/api/journal-entries/${encodeURIComponent(id)}/as-saved`),
  classifyTransaction: (txRef: string, overwrite = false) =>
    request<{ entries: JournalEntry[] }>('POST', `/api/journal-entries/classify/${encodeURIComponent(txRef)}`, { overwrite }).then((r) => r.entries),

  yearClose: (year: string) => request<YearCloseView>('GET', `/api/year-close/${year}`),
  automation: (since?: string) => request<AutomationView | { unchanged: true }>('GET', `/api/automation${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  automationRun: (id: string) => request<RunDetail>('GET', `/api/automation/runs/${encodeURIComponent(id)}`),
  questions: () => request<QuestionsView>('GET', '/api/questions'),
  ask: (q: { on: QuestionTarget; by: string; text: string; choices: Choice[]; to?: string }) => request<Question>('POST', '/api/questions', q),
  answerQuestion: (id: string, by: string, answer: Answer) => request<Question>('POST', `/api/questions/${id}/answer`, { by, ...answer }),
  undoAnswer: (id: string, by: string) => request<Question>('POST', `/api/questions/${id}/undo`, { by }),
  closeQuestion: (id: string, by: string, how: 'done' | 'withdrawn') => request<Question>('POST', `/api/questions/${id}/close`, { by, how }),
  automationCommand: (cmd: AutomationCommand) => request<CommandResult>('POST', '/api/automation', cmd),
  automationSchedule: (workflow: string, schedule: string | null) => request<{ ok: true }>('PATCH', `/api/automation/workflows/${encodeURIComponent(workflow)}`, { schedule }),
  changes: (since?: string) => request<ChangesView | { unchanged: true }>('GET', `/api/changes${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  changesSave: (oid: string) => request<SaveDetail>('GET', `/api/changes/saves/${encodeURIComponent(oid)}`),
  assistantList: () => request<ConversationSummary[]>('GET', '/api/assistant'),
  assistantConversation: (id: string) => request<Conversation>('GET', `/api/assistant/${encodeURIComponent(id)}`),
  assistantUndo: (id: string, change: string) => request<MadeChange[]>('POST', `/api/assistant/${encodeURIComponent(id)}/changes/${encodeURIComponent(change)}/undo`),
  assistantHeld: (id: string, turn: number, take: boolean, language: string) => request<Extract<Turn, { role: 'ai' }>>('POST', `/api/assistant/${encodeURIComponent(id)}/held/${turn}`, { take, language }),
  sources: () => request<SourcesView>('GET', '/api/sources'),
  addMailSource: (input: { address: string; host: string; account?: string; password?: string }) => request<{ ok: true; id: string; updated?: true }>('POST', '/api/sources/mail', input),
  saveSourcePassword: (id: string, password: string | null) => request<{ ok: true }>('PUT', `/api/sources/${encodeURIComponent(id)}/secret`, { password }),
  checkSource: (id: string) => request<MailCheck>('POST', `/api/sources/${encodeURIComponent(id)}/check`),
  quarantine: () => request<QuarantinedFile[]>('GET', '/api/quarantine'),
  takeFromQuarantine: (file: string) => request<{ ok: true; file: string; run?: string }>('POST', `/api/quarantine/${encodeURIComponent(file)}/take`),
  skipSender: (id: string, sender: string, version: string) => request<{ ok: true }>('POST', `/api/sources/${encodeURIComponent(id)}/skip`, { sender, version }),
  approveSource: (id: string, version: string) => request<{ ok: true }>('POST', `/api/sources/${encodeURIComponent(id)}/approve`, { version }),
  rules: () => request<RulesView>('GET', '/api/rules'),
  ruleCommand: (c: RuleCommand) => request<RuleCommandResult>('POST', '/api/rules', c),
  draftRules: (path: string) => request<DraftView>('GET', `/api/rules/draft?path=${encodeURIComponent(path)}`),
  draftCommand: (c: DraftCommand) => request<KeepResult | { ok: boolean }>('POST', '/api/rules/draft', c),
  shareOffer: (ref: string) => request<{ offer: ShareOffer | null }>('GET', `/api/rules/share?ref=${encodeURIComponent(ref)}`),
  draftShare: (ref: string) => request<{ path: string }>('POST', '/api/rules/share', { ref }),
  /** «Regel anpassen?» after a person corrected a rule's booking (r9k-5): the rule's change the correction teaches, and its draft for the card. */
  correctionOffer: (ref: string) => request<{ offer: CorrectionOffer | null }>('GET', `/api/rules/correction?ref=${encodeURIComponent(ref)}`),
  draftCorrection: (ref: string) => request<{ path: string }>('POST', '/api/rules/correction', { ref }),
  handStart: (payment: string) => request<{ start: HandStart | null }>('GET', `/api/rules/hand?payment=${encodeURIComponent(payment)}`),
  draftHand: (rule: HandRule) => request<{ path: string }>('POST', '/api/rules/hand', rule),
  dropOpen: () => request<DropSession>('POST', '/api/drop'),
  dropAdd: async (session: string, file: File): Promise<DropSession> => {
    const res = await fetch(`/api/drop/${session}/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as ApiErrorBody | null) ?? { error: `HTTP ${res.status}` });
    return res.json() as Promise<DropSession>;
  },
  dropRow: (session: string, key: string, action: DropAction) => request<DropSession>('POST', `/api/drop/${session}/rows/${key}`, action),
  dropClose: (session: string) => request<{ ok: true }>('DELETE', `/api/drop/${session}`),
  changesCommand: (cmd: SavingCommand) => request<SavingResult>('POST', '/api/changes', cmd),
  changesDiff: (source: string, path: string) => request<FileDiff>('GET', `/api/changes/diff?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`),
  bookRevaluation: (year: string) => request<{ entries: JournalEntry[] }>('POST', `/api/year-close/${year}/revaluation`),
  /** `state: null` opens the step again and removes the booking it made; `removed` lists it for the undo (r9c-16). */
  markYearEndEntry: (year: string, id: string, state: TemplateState | null) => request<{ removed?: JournalEntry[] }>('PUT', `/api/year-close/${year}/templates/${id}`, { state }),
  bookYearEndEntry: (year: string, input: YearEndEntryInput) => request<{ entry: JournalEntry }>('POST', `/api/year-close/${year}/entries`, input),
  rebookYearEndEntry: (year: string, id: string, description: string) => request<{ removed: JournalEntry[]; entry?: JournalEntry }>('POST', `/api/year-close/${year}/templates/${id}/rebook`, { description }),
  closeYear: (year: string) => request<unknown>('POST', `/api/year-close/${year}/close`),
  openYear: (year: string) => request<unknown>('POST', `/api/year-close/${year}/open`),

  /** A PDF or photo into the workspace's inbox (beleg-import/), as the phone app sends it. */
  upload: async (file: Blob, type: ReceiptType, capturedAt: Date) => {
    if (STATIC_EXPORT) throw new ApiError({ error: 'read-only snapshot', code: 'readonly' });
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': type, 'X-Captured-At': capturedAt.toISOString() }, body: file });
    if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as ApiErrorBody | null) ?? { error: `HTTP ${res.status}` });
    return (await res.json()) as { filename: string };
  },

  /** A bank account's opening balance of `year`; null takes it back (src/accounting/opening-balance.ts). */
  setOpeningBalance: (year: string, account: string, amount: number | null) =>
    request<Ok>('PUT', `/api/opening-balances/${year}/${encodeURIComponent(account)}`, { amount }),

  /** A statement taken back out of the books (`file`: `<bank>/<filename>` as the import named it): the drop dialog's undo, from the page (r9k-3). */
  deleteStatement: (file: string) => request<StatementRemoved>('DELETE', `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}`),
  /** The undo of a removal, after the file is read again: its bookings and links back as they were (r10h-3). */
  restoreStatementBookings: (removed: StatementRemoved['removed']) => request<Ok>('POST', '/api/statements/bookings', removed),

  /** A camt.053 or statement PDF into bank-statements/, read into the books; `into` names the missing month it is for. */
  importStatement: async (file: Blob, name: string, into?: { account: string; month: string }) => {
    if (STATIC_EXPORT) throw new ApiError({ error: 'read-only snapshot', code: 'readonly' });
    const qs = new URLSearchParams({ name, ...into });
    const res = await fetch(`/api/statements?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as ApiErrorBody | null) ?? { error: `HTTP ${res.status}` });
    return (await res.json()) as StatementImport;
  },

  /** Starts the inbox processing; while a job runs, one more run after it. */

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
    phone: () => request<PhoneInfo>('GET', '/api/desktop/phone'),
    setPhone: (on: boolean) => request<PhoneInfo>('POST', '/api/desktop/phone', { on }),
    renewPhone: () => request<PhoneInfo>('POST', '/api/desktop/phone', { renew: true }),
  },
  patchWorkspace: (patch: ManifestPatch) => request<CompanyInfo>('PATCH', '/api/workspace', patch),
  removeAccount: (number: string) => request<Ok>('DELETE', `/api/accounts/${number}`),
  setAccountName: (number: string, name: string) => request<{ number: string; name: string; added: boolean }>('PUT', `/api/accounts/${number}`, { name }),
  uploadLogo: (file: Blob, type: string) => upload<CompanyInfo>('/api/workspace/logo', file, type),
  assistantExportUrl: (file: string) => `/api/assistant/exports/${encodeURIComponent(file)}`,
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
  /** Links a payment to an invoice; `booked` false when a person's booking of the payment stays as the revenue (r9c-3). */
  confirmPayment: (id: string, transactionRef: string) => request<{ paid: Array<{ transactionRef: string; number: string; amount: number; fee: number; booked: boolean }> }>('POST', `/api/invoices/${id}/payments`, { transactionRef }),
  /** «Lösen» (r10c-3): the payment leaves the invoice, the link's bookings go, what the link replaced is back. */
  releasePayment: (id: string, transactionRef: string) => request<PaymentReleased>('DELETE', `/api/invoices/${id}/payments/${encodeURIComponent(transactionRef)}`),
  /** The PDF as issued, or a sent reminder or notice as sent: the file's path under the workspace is its URL. */
  documentUrl: (file: string) => `/${file.split('/').map(encodeURIComponent).join('/')}`,
  filingXmlUrl: (period: string) => `/api/filing/${encodeURIComponent(period)}`,

  filedReturns: (year: string) => request<ReturnFigures[]>('GET', sources.filedReturns(year)),
  fxRates: () => request<EstvRateTable>('GET', sources.fxRates()),
};
