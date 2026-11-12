import type { Found } from '../../intake/pairing.js';
import type { TerminalApp, TerminalCli, TerminalView } from '../../platform/terminal.js';
import type { AiSetupView, KeySaved, Probation, SetupKey } from '../../platform/ai-setup.js';
import type { StatementProblem } from '../../types/api-error.js';
import type { MoneyRole } from '../../workspace/banks.js';
import type { AiView } from '../../llm/view.js';
import type { AiRefusal, ProviderId } from '../../llm/provider.js';
import { isStepId, type StepId } from '../../llm/steps.js';
import type { BankTransaction, InboxFile, Index, VatAdjustment, StatementAsk, StatementImport, JournalEntry, Receipt, ReceiptPatch, ReconcilePair, TransactionPatch } from '../../types/index.js';
import type { PdfFactsView, PdfTable, ReadStatement, StatementReadsView } from '../../types/statement-read.js';
import type { StatementRemoved } from '../../server/routes/statements.js';
import type { PaymentReleased } from '../../invoices/payments.js';
export type { StatementRemoved };
import type { BookingLine } from '../../accounting/manual-booking.js';
import type { EstvRateTable } from '../../accounting/fx-conversion.js';
import type { WorkspaceModules } from '../../core/modules/load.js';
import type { Account } from './accounts.js';
import type { CompanyInfo } from '../../books/company.js';
import type { ManifestPatch } from '../../workspace/manifest-write.js';
import type { QuestionId } from '../../onboarding/model.js';
import type { SetupView } from '../../onboarding/facts.js';
import type { VatSetup } from '../../workspace/vat-setup.js';
import type { ApiErrorBody, ApiStatus, MailStatus } from '../../types/api-error.js';
import type { MailMessage } from '../../invoices/mail.js';
import type { ReceiptType } from '../../types/upload.js';
import type { Opening, TemplateState, YearClose } from '../../accounting/year-close.js';
import { t, tData } from '../i18n/index.js';
import { fmt, formatDate } from './utils.js';
import { agreedBasis, vatSetup } from '../../engines/index.js';
import { normalRate } from '../../accounting/sales-without-vat.js';
import { API_SOURCES, EXPORT_SOURCES } from '../../audit/sources.js';
import type { Comment, Customer, CustomerFields, Draft, Invoice, Issued, Reminder, SentDocument } from '../../invoices/model.js';
import type { PaymentProposal } from '../../invoices/payments.js';
import type { DraftPatch } from '../../invoices/service.js';
import type { InvoiceRefusal, Missing } from '../../invoices/rules.js';
import type { AiAvailability, DesktopInfo, FolderLook, KnownBooks, PhoneInfo } from '../../types/desktop.js';
import { DesktopCallError } from '../desktop/bridge.js';
import { setAiOff } from '../ai/ai-off.js';
import type { DraftPatch as SetupPatch, SetupBegun, SetupDraftView } from '../../onboarding/draft.js';
import type { SetupTalked } from '../../onboarding/draft-talk.js';
import type { SetupRefusal, SetupRequest } from '../../workspace/create.js';
import type { ReturnFigures } from '../../engines/return.js';
import type { JournalEntryInput } from '../../books/entry-input.js';
import type { Answer, Choice, Question, QuestionsView, QuestionTarget } from '../../questions/model.js';

/** Built by `npm run build:audit` (vite --mode audit): reads the export's files, never an API. */
import type { AutomationCommand, AutomationView, CommandResult, RunDetail } from '../../workflows/model.js';
import type { RunLogLine } from '../../workflows/runlog.js';
import type { HistoryObject, ObjectHistory } from '../../workflows/history.js';
import type { Conversation, ConversationSummary, MadeChange, PrivatePart, Turn } from '../../types/assistant.js';
import { ATTACHMENT_MAX_MB, type Attachment } from '../../types/attachment.js';
import type { DropAction, DropSession, PayoutWaitView, QuarantinedFile, StatementDetails } from '../../types/drop.js';
import type { MailCheck, ReceiptSkipOffer, SourcePreview, SourcesView } from '../../platform/sources/model.js';
import type { MailHost } from '../../platform/sources/mail-host.js';
import type { DraftCommand, DraftView, KeepResult, RuleCommand, RuleCommandResult, RulesView } from '../../saving/rules.js';
import type { ShareOffer } from '../../saving/share-rule.js';
import type { GroupedOffer } from '../../saving/grouped-flag.js';
import type { ReceiptSet, SetCut } from '../../intake/receipt-sets.js';
import type { UnreadOffer } from '../../saving/unread-rule.js';
import type { SaleRuleOffer } from '../../saving/sale-rule.js';
import type { CorrectionOffer } from '../../saving/correction-rule.js';
import type { LearnOffer, LearnProposal } from '../../saving/learn-rule.js';
import type { HandRule, HandStart } from '../../saving/hand-rule.js';
import type { BatchAnswer, BatchRequest } from '../../types/batch.js';
import type { NoteRuleCommand } from '../../saving/note-rule.js';
import { refusalKey } from '../areas/company/rules-model.js';
import { refusalText } from '../../reports/words.js';
import type { ReportResult } from '../../reports/result.js';
import type { SavedReport, SavedWrite } from '../../reports/saved.js';
import type { ChangesView, FileDiff, SaveDetail, SavingCommand, SavingResult } from '../../saving/model.js';
import type { PartnerDetail, PartnersView } from '../../knowledge/partners.js';
import type { Note, NoteCommand, NoteResult, TopicRow } from '../../knowledge/notes.js';
import type { AppLayerView, GapsView } from '../../knowledge/wissen.js';
import type { OrderPage } from '../../booking/order-pages.js';
import type { VatCorrection } from '../../booking/vat-corrections.js';

export const STATIC_EXPORT = import.meta.env.MODE === 'audit';

/** Where each read goes: every URL the UI fetches or links to comes from here. */
export const sources = STATIC_EXPORT ? EXPORT_SOURCES : API_SOURCES;

/** A refused request: the API's body, whose code errorText says in the user's language. */
export class ApiError extends Error {
  constructor(readonly body: ApiErrorBody) { super(body.error); }
}

/**
 * The one door to the server. The static export has no server: a call to /api/ is refused there
 * unsent, read or write, so no area can make the snapshot ask a host for what it cannot serve.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (STATIC_EXPORT && path.startsWith('/api/')) throw new ApiError({ error: 'read-only snapshot', code: 'readonly' });
  return fetch(path, init);
}

/** Every call throws an ApiError when the response is not ok. */
/** The window event of a refusal for want of an AI; its detail is the error line's text. */
export const NO_AI_EVENT = 'vanilla:no-ai';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, body === undefined ? { method } : {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiErrorBody | null;
    // A step that needed an AI where none answers: the shell shows the error line with «KI einrichten» (src/app/shell/Toast.tsx).
    if (err?.code === 'aiRefused' && err.params.reason === 'off') setAiOff(true);
    if (err && (err.code === 'noClaude' || (err.code === 'aiRefused' && err.params.reason !== 'limit')) && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(NO_AI_EVENT, { detail: errorText(new ApiError(err)) }));
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
    case 'whichAccount': return t('error.statement.whichAccount', { currency: p.currency, accounts: p.accounts.map((a) => a.label).join(', ') });
  }
}

export function aiRefusedText(r: AiRefusal): string {
  if (r.reason === 'off') return t('error.ai.off');
  if (r.reason === 'unserved') return t('error.ai.unserved', { step: isStepId(r.step) ? t(`ai.step.${r.step}`) : r.step });
  if (r.reason === 'modelRefused') return t('error.ai.modelRefused', { model: r.model });
  const cli = t(`terminal.cli.${r.cli}`);
  return r.reason === 'limit' ? t('error.ai.limit', { cli, said: r.said }) : t(`error.ai.${r.reason}`, { cli });
}

export function errorText(e: unknown): string {
  if (e instanceof DesktopCallError) return t(e.text);
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e);
  const b = e.body;
  if ('invoiceRefusal' in b) return invoiceRefusalText(b.invoiceRefusal, b.missing);
  if ('mailRefusal' in b) return t(`mail.refusal.${b.mailRefusal}`, { detail: b.detail ?? '' });
  switch (b.code) {
    case 'readonly': return t('error.readonly');
    case 'localOnly': return t('error.localOnly');
    case 'foreignHost': return t('error.foreignHost');
    case 'phoneToken': return t('error.phoneToken');
    case 'manualOnly': return t('error.manualOnly');
    case 'booksChanged': return t('error.booksChanged');
    case 'hasEntries': return t('error.hasEntries');
    case 'bookedSince': return t('error.bookedSince', { payment: b.params.payment, n: b.params.entries, by: t(`error.bookedSince.${b.params.by}`) });
    case 'receiptPaid': return t('error.receiptPaid', { payment: b.params.payment });
    case 'pointerLinked': return t('error.pointerLinked', { payment: b.params.payment });
    case 'correctionBooked': return t('error.correctionBooked', { entry: b.params.entry });
    case 'reportCorrection': return t(`error.reportCorrection.${b.params.why}`);
    case 'statementUndo': return t(`error.statementUndo.${b.params.why}`);
    case 'secondPayment': return t('error.secondPayment', { payment: b.params.payment });
    case 'paidPrivately': return t('error.paidPrivately', { payment: b.params.payment });
    case 'partAmount': return t('error.partAmount', { total: `${b.params.currency} ${fmt(b.params.total)}` });
    case 'partRate': return t('error.partRate', { rates: b.params.rates.map((r) => `${r} %`).join(', ') });
    case 'reconcilePending': return t('error.reconcilePending', { from: formatDate(b.params.from), to: formatDate(b.params.to) });
    case 'reconcileUndecided': return t('error.reconcileUndecided', { n: b.params.n });
    case 'reconcileTwice': return t('error.reconcileTwice', { ref: b.params.ref });
    case 'reconcileDifference': return t('error.reconcileDifference', { amount: `${b.params.currency} ${fmt(b.params.amount)}` });
    case 'reconcileMismatch': return t('error.reconcileMismatch');
    case 'reconcileNotCovered': return t('error.reconcileNotCovered', { date: formatDate(b.params.date) });
    case 'reconcileFiledUnbooked': return t('error.reconcileFiledUnbooked', { date: formatDate(b.params.date) });
    case 'reconciledTwins': return t('error.reconciledTwins', { n: b.params.refs.length, refs: b.params.refs.slice(0, 3).join(', ') });
    case 'bookedInFiled': return b.params.date ? t('error.bookedInFiled', { date: formatDate(b.params.date) }) : t('error.bookedInFiledUnnamed');
    case 'twinBookedByHand': return t('error.twinBookedByHand', { entry: b.params.entry, read: `${b.params.currency} ${fmt(b.params.read)}`, bank: `${b.params.currency} ${fmt(b.params.bank)}` });
    case 'bookedByHand': return t('error.bookedByHand', { entry: b.params.entry, date: formatDate(b.params.date), amount: `${b.params.currency} ${fmt(b.params.amount)}` });
    case 'yearClose': return t('error.yearClose');
    case 'batchUnchanged': return t('error.batchUnchanged');
    case 'batchNotOn': return t('error.batchNotOn', { account: b.params.account });
    case 'batchBooked': return t('error.batchBooked');
    case 'batchNoReceipt': return t('error.batchNoReceipt');
    case 'batchChangedSince': return t('error.batchChangedSince', { n: b.params.n, ids: b.params.ids });
    case 'batchUndoGone': return t('error.batchUndoGone');
    case 'notEmployee': return t('error.notEmployee', { account: b.params.account });
    case 'employeeCurrency': return t('error.employeeCurrency', { label: b.params.label, currency: b.params.currency, receipt: b.params.receipt });
    case 'batchLimit': return t('selection.limit', { max: b.params.max, n: b.params.n - b.params.max });
    case 'noBatchPayer': return t('error.noBatchPayer');
    case 'tagShape': return t('error.tagShape');
    case 'tagDimension': return t('error.tagDimension', b.params);
    case 'tagValue': return t('error.tagValue', b.params);
    case 'vatAdjustment': return t(`error.vatAdjustment.${b.params.why}`, { value: b.params.value ?? '' });
    case 'dimensionInUse': return t('error.dimensionInUse', { dimension: b.params.dimension, n: b.params.entries });
    case 'paymentDate': return t(agreedBasis() ? 'error.paymentDateAgreed' : 'error.paymentDate', { date: formatDate(b.params.date) });
    case 'paymentBalance': {
      const { date, currency, paid, booked } = b.params;
      return t('error.paymentBalance', { date: formatDate(date), paid: `${currency} ${fmt(paid)}`, booked: `${currency} ${fmt(booked)}` });
    }
    case 'classifyAccount': return t('error.classifyAccount', b.params);
    case 'classifyUnknownAccount': return t('error.classifyUnknownAccount', b.params);
    case 'classifyUnknownVatCode': return t('error.classifyUnknownVatCode', b.params);
    case 'classifyBalance': {
      const { date, currency, paid, booked } = b.params;
      return t('error.classifyBalance', { date: formatDate(date), paid: `${currency} ${fmt(paid)}`, booked: `${currency} ${fmt(booked)}` });
    }
    case 'classifySeparateFee': return t('error.classifySeparateFee', { fee: b.params.fee, amount: `${b.params.currency} ${fmt(b.params.amount)}` });
    case 'classifyOpenInvoice': return t('error.classifyOpenInvoice', b.params);
    case 'classifyInputTaxShared': return t('error.classifyInputTaxShared', { payments: b.params.payments, booked: `${b.params.currency} ${fmt(b.params.booked)}`, shown: `${b.params.currency} ${fmt(b.params.shown)}` });
    case 'personsBooking': return t('error.personsBooking', { n: b.params.entries });
    case 'fileExists': return t('error.fileExists', b.params);
    case 'statementRead': {
      const p = b.params;
      if (p.why === 'gap') return t('error.statementRead.gap', { gap: `${p.currency ?? ''} ${fmt(p.gap ?? 0)}`.trim(), page: p.page ? t('error.statementRead.onPage', { page: p.page }) : '' });
      if (p.why === 'covered') return t('error.statementRead.covered', { file: (p.file ?? '').split('/').pop() ?? '' });
      return t(`error.statementRead.${p.why}`, { row: p.row ?? '', rows: p.rows ?? '', limit: p.limit ?? '' });
    }
    case 'readsRunning': return t('error.readsRunning');
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
    case 'foreignTaxInvalid': return t('error.foreignTaxInvalid');
    case 'foreignTaxSplit': return t('error.foreignTaxSplit');
    case 'questionGone': return t(`questions.gone.${b.params.why}`);
    case 'takesBack': return t('error.takesBack');
    case 'setAside': return t('error.setAside', b.params);
    case 'unknownAccount': return t('error.unknownAccount', b.params);
    case 'oneSided': return t('error.oneSided', b.params);
    case 'codeSign': return t(b.params.expected.startsWith('-') ? 'error.codeSign.back' : 'error.codeSign.out', b.params);
    case 'taxAmountTwoSided': return t('error.taxAmountTwoSided', b.params);
    case 'importVatUnproven': return t('error.importVatUnproven', { account: b.params.account, amount: b.params.amount.toFixed(2) });
    case 'accountInUse': return t('error.accountInUse', { account: b.params.account, n: b.params.entries });
    case 'bankInUse': return t('error.bankInUse', { label: b.params.label, account: b.params.account, uses: [
      b.params.statements && t('error.bankInUse.statements', { n: b.params.statements }),
      b.params.entries && t('error.bankInUse.entries', { n: b.params.entries }),
      b.params.invoices && t('error.bankInUse.invoices', { n: b.params.invoices }),
    ].filter(Boolean).join(', ') });
    case 'ledgerAccountTaken': return t('error.ledgerAccountTaken', b.params);
    case 'bankNameManual': return t('error.bankNameManual', b.params);
    case 'bankTwice': return t('error.bankTwice', b.params);
    case 'moneyAccountSide': return t('error.moneyAccountSide', b.params);
    case 'unknownCurrency': return t('error.unknownCurrency', b.params);
    case 'attachment': return t(`error.attachment.${b.params.reason}`, { name: b.params.name, mb: 'mb' in b.params ? b.params.mb : 0, limit: ATTACHMENT_MAX_MB });
    case 'noBrowser': return t('error.noBrowser');
    case 'noClaude': return b.params?.step && isStepId(b.params.step) ? t('error.noAi', { what: t(`ai.step.${b.params.step}`) }) : t('error.noAi.any');
    case 'aiRefused': return aiRefusedText(b.params);
    case 'terminalNotMac': return t('error.terminalNotMac');
    case 'terminalNoCli': return t('error.terminalNoCli');
    case 'terminalAppMissing': return t('error.terminalAppMissing');
    case 'aiModelUnfit': return t('error.aiModelUnfit', b.params);
    case 'aiKeyRefused': return t('error.aiKeyRefused');
    case 'aiKeyWhere': return t('error.aiKeyWhere', b.params);
    case 'partnerGone': return t('partners.gone');
    case 'topicGone': return t('knowledge.topicGone');
    case 'notesChanged': return t('partners.notes.changed');
    case 'learnedNameGone': return t('partners.match.learnedGone');
    case 'notesTitle': return t('knowledge.newPage.needsTitle');
    case 'gone': return t(`error.gone.${b.params.what}`);
    case 'fileReferenced': return t('error.fileReferenced', { file: b.params.file, refs: [
      ...b.params.payments.map((ref) => t('error.fileReferenced.payment', { ref })),
      ...b.params.entries.map((ref) => t('error.fileReferenced.entry', { ref })),
      ...(b.params.statements ? [t('error.fileReferenced.statements', { n: b.params.statements })] : []),
    ].join(', ') });
    case 'secretStore': return t('error.secretStore');
    case 'invoice': return invoiceRefusalText(b.params.refusal, b.params.missing);
    case 'invoicingNotSetUp': return t('error.invoicingNotSetUp');
    case 'payToAccount': return t('error.payToAccount', b.params);
    case 'ibanOnInvoices': return t('error.ibanOnInvoices', b.params);
    case 'unknownCustomer': return t('error.unknownCustomer');
    case 'amountZero': return t('error.amountZero');
    case 'noAccount': return t('error.noAccount');
    case 'sameAccount': return t('error.sameAccount', b.params);
    case 'unknownVatCode': return t('error.unknownVatCode', b.params);
    case 'codeNotTaken': return t(b.params.method === 'none' ? 'error.codeNotTaken.none' : 'error.codeNotTaken.netRate', { code: b.params.code });
    case 'clearingNotBalance': return t('error.clearingNotBalance', b.params);
    case 'sinceNotOpen': return t('error.sinceNotOpen', { since: formatDate(b.params.since), from: formatDate(b.params.from) });
    case 'clearingTaken': return t('error.clearingTaken', b.params);
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
    case 'oldLayout': return t('desktop.oldLayout', { root: b.params.root });
    case 'setup': return setupText(b.params);
    case 'openingAccount': return t(`error.openingAccount.${b.params.reason}`, { account: b.params.account });
    case 'openingNotFirstYear': return t('error.openingNotFirstYear', { year: b.params.year });
    case 'openingYearClosed': return t('company.openingClosed', { year: b.params.year });
    case 'mailSourceField': return t(`sources.field.${b.params.field}.invalid` as 'sources.field.address.invalid');
    case 'mailHostUnknown': return t('error.mailHostUnknown', b.params);
    case 'macMail': return t(`sources.macMail.problem.${b.params.problem}`);
    case 'mailboxPassword': return t('error.mailboxPassword');
    case 'sourceDraftMissing': return t('error.sourceDraftMissing', b.params);
    case 'sourceInvalid': return t('error.sourceInvalid', { id: b.params.id, problems: b.params.problems.join('; ') });
    case 'sourceSecret': return t('error.sourceSecret');
    case 'sourceAppId': return t('error.sourceAppId', b.params);
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
    case 'bankName': return t('desktop.setup.bankName');
    default: return t(`desktop.setup.${r.reason}`, { bank: r.bank, detail: r.detail });
  }
}

/** What an invoice still needs before it is issued (Art. 26 MWSTG), one phrase per gap; `line` counts from 0. */
export const missingText = (m: Missing): string =>
  m.line === undefined ? t(`invoice.missing.${m.field}`) : t('invoice.missingLine', { line: m.line + 1, what: t(`invoice.missing.${m.field}`) });

function invoiceRefusalText(code: InvoiceRefusal | 'noBrowser' | 'printFailed', missing?: Missing[]): string {
  // A customer's field is filled in where the customer is kept: the line says so.
  if (code === 'incomplete' && missing?.length) return t('invoice.refusal.incompleteList', { list: missing.map(missingText).join(', ') }) + (missing.some((m) => m.field.startsWith('customer.')) ? ` ${t('invoice.refusal.customerWhere')}` : '');
  return t(`invoice.refusal.${code}`);
}

type Ok = { ok: true };
/** `confirm`: a second bank payment of another payee for a receipt that has one, confirmed (r8h-21). */
type Link = { receiptId: string; transactionRef: string; confirm?: true };
type Linked = Ok & { again: string[]; kept?: string[] };
/** A change by hand; `origin`, `reason` and `by` only from its undo (null: the booking had none). */
export type JournalEntryPatch = Partial<Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'vatCode' | 'description' | 'amount' | 'receipts'>> & { tags?: JournalEntry['tags'] | null }
  & { origin?: JournalEntry['origin'] | null; reason?: string | null; by?: JournalEntry['by'] | null };
/** A new entry by hand; `id`, `transactionRef` and the provenance put a deleted one back (undo): src/books/entry-input.ts. */
export type { JournalEntryInput };
/** A movement made by hand (#88): on the owner's account without `account`; `role` and `label` add an account the firm lacks. */
export type ManualTransactionInput = { date: string; description: string; amount: number; currency?: string; direction?: 'DBIT' | 'CRDT'; account?: string; role?: MoneyRole; label?: string };
export type YearEndEntryInput = Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'amount' | 'description'> & { vatCode?: string; template?: string };
export type YearCloseView = YearClose & { opening?: Opening };
export interface InvoiceList { today: string; invoices: Invoice[]; customers: Customer[]; sent: SentDocument[] }
export type DraftChange = { [K in keyof DraftPatch]?: DraftPatch[K] | null };
export interface CreditInput { reason: string; amount?: number; settlement?: 'refund' | 'offset' }
export interface ReminderInput { date?: string; fee?: number; intro?: string; closing?: string; to?: string; email?: MailMessage }

/** Raw bytes to a route that takes a file. */
async function upload<T>(path: string, body: Blob, type: string): Promise<T> {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': type }, body });
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
  privatePayment: (receiptId: string, part: PrivatePart = {}) => request<{ ref: string; date: string; corrects?: string; exchangeRate?: number; replaced?: JournalEntry[] }>('POST', `/api/receipts/${receiptId}/private-payment`, part),

  /** `inputTaxProof`: the other proof of the input tax, named instead of a receipt (#134). */
  bookPayment: (ref: string, lines: BookingLine[], inputTaxProof?: string) =>
    request<{ entries: JournalEntry[] }>('POST', `/api/transactions/${encodeURIComponent(ref)}/entries`, { lines, ...(inputTaxProof !== undefined && { inputTaxProof }) }).then((r) => r.entries),

  attachEntries: (ref: string, own: string) =>
    request<{ before: JournalEntry[] }>('POST', `/api/transactions/${encodeURIComponent(ref)}/attach`, { ref: own }).then((r) => r.before),

  /** `again`: the payments booked again by a run; `kept`: a booked payment whose booking stays because no model is there to rebook it (r8f-41). */
  addMapping: (link: Link) => request<Linked>('POST', '/api/mapping/add', link),
  removeMapping: (link: Link) => request<Linked>('POST', '/api/mapping/remove', link),
  /** «Zahlung suchen» / «Beleg suchen» (#187): the matching chain for one receipt or one payment. */
  findPayment: (receipt: string) => request<Found>('POST', `/api/receipts/${encodeURIComponent(receipt)}/find-payment`),
  /** «Als Korrektur buchen» on a refund of a filed period a sales report offers (#231): booked in the open period with `corrects`. */
  reportCorrection: (receipt: string, order: string, date: string) => request<{ ok: true; entries: JournalEntry[] }>('POST', `/api/receipts/${encodeURIComponent(receipt)}/report-correction`, { order, date }),
  setFiledPayment: (receipt: string, payment: string | null) => request<{ ok: true }>('POST', `/api/receipts/${encodeURIComponent(receipt)}/filed-payment`, { payment }),
  findReceipt: (payment: string) => request<Found>('POST', `/api/transactions/${encodeURIComponent(payment)}/find-receipt`),

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
  /** A run's lines in the run log, for a run whose details the run store no longer holds. */
  runLog: (id: string) => request<{ lines: RunLogLine[]; stored: boolean }>('GET', `/api/automation/runs/${encodeURIComponent(id)}/log`),
  /** «Verlauf» (#215): the runs that worked on a receipt, a payment or an entry, newest first; `all` lifts the cap. */
  history: (kind: HistoryObject['kind'], id: string, all = false) => request<ObjectHistory>('GET', `/api/history/${kind}/${encodeURIComponent(id)}${all ? '?all=1' : ''}`),
  questions: () => request<QuestionsView>('GET', '/api/questions'),
  ask: (q: { on: QuestionTarget; by: string; text: string; choices: Choice[]; to?: string }) => request<Question>('POST', '/api/questions', q),
  answerQuestion: (id: string, by: string, answer: Answer) => request<Question>('POST', `/api/questions/${id}/answer`, { by, ...answer }),
  undoAnswer: (id: string, by: string) => request<Question>('POST', `/api/questions/${id}/undo`, { by }),
  closeQuestion: (id: string, by: string, how: 'done' | 'withdrawn') => request<Question>('POST', `/api/questions/${id}/close`, { by, how }),
  automationCommand: (cmd: AutomationCommand) => request<CommandResult>('POST', '/api/automation', cmd),
  automationSchedule: (workflow: string, schedule: string | null) => request<{ ok: true }>('PATCH', `/api/automation/workflows/${encodeURIComponent(workflow)}`, { schedule }),
  changes: (since?: string) => request<ChangesView | { unchanged: true }>('GET', `/api/changes${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  changesSave: (oid: string) => request<SaveDetail>('GET', `/api/changes/saves/${encodeURIComponent(oid)}`),
  onboarding: () => request<SetupView>('GET', '/api/onboarding'),
  onboardingStart: () => request<SetupView>('POST', '/api/onboarding/start'),
  onboardingReady: () => request<SetupView>('POST', '/api/onboarding/ready'),
  onboardingAnswer: (q: QuestionId, value: string | null, kept?: VatSetup | null) => request<SetupView>('PUT', `/api/onboarding/answers/${q}`, { value, ...(kept !== undefined ? { kept } : {}) }),
  assistantList: () => request<ConversationSummary[]>('GET', '/api/assistant'),
  /** A file for the next message (src/types/attachment.ts): kept beside the conversations, never in the books. */
  assistantAttach: async (file: File): Promise<Attachment> => {
    const res = await apiFetch(`/api/assistant/attachments?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as ApiErrorBody | null) ?? { error: `HTTP ${res.status}` });
    return res.json() as Promise<Attachment>;
  },
  assistantConversation: (id: string) => request<Conversation>('GET', `/api/assistant/${encodeURIComponent(id)}`),
  assistantUndo: (id: string, change: string) => request<MadeChange[]>('POST', `/api/assistant/${encodeURIComponent(id)}/changes/${encodeURIComponent(change)}/undo`),
  assistantHeld: (id: string, turn: number, take: boolean, language: string) => request<Extract<Turn, { role: 'ai' }>>('POST', `/api/assistant/${encodeURIComponent(id)}/held/${turn}`, { take, language }),
  sources: () => request<SourcesView>('GET', '/api/sources'),
  mailHost: (address: string) => request<MailHost>('GET', `/api/sources/mail-host?address=${encodeURIComponent(address)}`),
  addMailSource: (input: { address: string; host: string; account?: string; password?: string }) => request<{ ok: true; id: string; updated?: true }>('POST', '/api/sources/mail', input),
  saveSourcePassword: (id: string, password: string | null, channel: 'mail' | 'api' = 'mail') => request<{ ok: true }>('PUT', `/api/sources/${encodeURIComponent(id)}/secret`, { password, channel }),
  signInSource: (id: string) => request<{ ok: true }>('POST', `/api/sources/${encodeURIComponent(id)}/sign-in`),
  previewSource: (id: string) => request<SourcePreview>('POST', `/api/sources/${encodeURIComponent(id)}/preview`),
  checkSource: (id: string) => request<MailCheck>('POST', `/api/sources/${encodeURIComponent(id)}/check`),
  quarantine: () => request<QuarantinedFile[]>('GET', '/api/quarantine'),
  takeFromQuarantine: (file: string) => request<{ ok: true; file: string; run?: string }>('POST', `/api/quarantine/${encodeURIComponent(file)}/take`),
  deleteFromQuarantine: (files: string[]) => request<{ ok: true; deleted: number }>('POST', '/api/quarantine/delete', { files }),
  discardReceipts: (ids: string[]) => request<{ ok: true; deleted: number }>('POST', '/api/receipts/discard', { ids }),
  skipSender: (id: string, sender: string, version: string) => request<{ ok: true }>('POST', `/api/sources/${encodeURIComponent(id)}/skip`, { sender, version }),
  receiptSkipOffer: (receipt: string) => request<{ offer: ReceiptSkipOffer | null }>('GET', `/api/sources/skip-offer?receipt=${encodeURIComponent(receipt)}`),
  approveSource: (id: string, version: string) => request<{ ok: true }>('POST', `/api/sources/${encodeURIComponent(id)}/approve`, { version }),
  runReport: (spec: unknown, period?: string) => request<{ result: ReportResult }>('POST', '/api/reports/run', { spec, period }).then((r) => r.result),
  savedReports: () => request<{ reports: SavedReport[] }>('GET', '/api/reports/saved').then((r) => r.reports),
  saveReport: (spec: unknown, slug?: string) => request<SavedWrite>('POST', '/api/reports/saved', { kind: 'save', spec, slug }),
  deleteReport: (slug: string) => request<SavedWrite>('POST', '/api/reports/saved', { kind: 'delete', slug }),
  restoreReport: (w: SavedWrite) => request<SavedWrite>('POST', '/api/reports/saved', { kind: 'restore', slug: w.slug, text: w.before, now: w.after }),
  rules: () => request<RulesView>('GET', '/api/rules'),
  partners: () => request<PartnersView>('GET', '/api/partners'),
  partner: (id: string) => request<PartnerDetail>('GET', `/api/partners/${encodeURIComponent(id)}`),
  removeLearnedName: (id: string, name: string) => request<{ path: string; committed: boolean }>('POST', `/api/partners/${encodeURIComponent(id)}/learned-names/remove`, { name }),
  topics: () => request<{ topics: TopicRow[] }>('GET', '/api/knowledge').then((r) => r.topics),
  topic: (slug: string) => request<{ slug: string; note: Note }>('GET', `/api/knowledge/topics/${encodeURIComponent(slug)}`),
  knowledgeGaps: () => request<GapsView>('GET', '/api/knowledge/gaps'),
  knowledgeApp: () => request<AppLayerView>('GET', '/api/knowledge/app'),
  saveNote: (c: NoteCommand) => request<NoteResult>('POST', '/api/notes', c),
  ruleCommand: (c: RuleCommand) => request<RuleCommandResult>('POST', '/api/rules', c),
  draftRules: (path: string) => request<DraftView>('GET', `/api/rules/draft?path=${encodeURIComponent(path)}`),
  draftCommand: (c: DraftCommand) => request<KeepResult | { ok: boolean }>('POST', '/api/rules/draft', c),
  shareOffer: (ref: string) => request<{ offer: ShareOffer | null }>('GET', `/api/rules/share?ref=${encodeURIComponent(ref)}`),
  draftShare: (ref: string) => request<{ path: string }>('POST', '/api/rules/share', { ref }),
  /** Receipts that add up to a payment, or nearly, and where code stopped looking (#27, #190). */
  receiptSets: (ref: string) => request<{ sets: ReceiptSet[]; cut?: SetCut }>('GET', `/api/transactions/${encodeURIComponent(ref)}/receipt-sets`),
  /** Why a provider's payout waits for the person, or null (#203). */
  payoutWait: (ref: string) => request<{ wait: PayoutWaitView | null }>('GET', `/api/transactions/${encodeURIComponent(ref)}/payout-wait`),
  groupedOffer: (ref: string) => request<{ offer: GroupedOffer | null }>('GET', `/api/rules/grouped?ref=${encodeURIComponent(ref)}`),
  draftGrouped: (ref: string) => request<{ path: string }>('POST', '/api/rules/grouped', { ref }),
  unreadOffer: (ref: string) => request<{ offer: UnreadOffer | null }>('GET', `/api/rules/unread?ref=${encodeURIComponent(ref)}`),
  draftUnread: (ref: string, rate: number) => request<{ path: string }>('POST', '/api/rules/unread', { ref, rate }),
  /** «Immer so?» under an answer to a sale question (#38): the payer rule drafted for its card, or why none. */
  draftSaleRule: (question: string) => request<SaleRuleOffer>('POST', '/api/rules/sale', { question }),
  /** «Regel anpassen?» after a person corrected a rule's booking (r9k-5): the rule's change the correction teaches, and its draft for the card. */
  correctionOffer: (ref: string) => request<{ offer: CorrectionOffer | null }>('GET', `/api/rules/correction?ref=${encodeURIComponent(ref)}`),
  draftCorrection: (ref: string) => request<{ path: string }>('POST', '/api/rules/correction', { ref }),
  /** «Ins Wissen übernehmen?» under a corrected booking no rule made, and the AI's checked draft for it. */
  learnOffer: (ref: string) => request<{ offer: LearnOffer | null }>('GET', `/api/rules/learn?ref=${encodeURIComponent(ref)}`),
  proposeLearned: (ref: string) => request<LearnProposal>('POST', '/api/rules/learn', { ref }),
  /** Several objects at once (#216): done, or with `preview` only shown; what changed, what was left out, and the undo. */
  batch: (body: BatchRequest) => request<BatchAnswer>('POST', '/api/batch', body),
  undoBatch: (batchId: string) => request<{ ok: true }>('POST', '/api/batch/undo', { batchId }),
  handStart: (payment: string) => request<{ start: HandStart | null }>('GET', `/api/rules/hand?payment=${encodeURIComponent(payment)}`),
  draftHand: (rule: HandRule) => request<{ path: string }>('POST', '/api/rules/hand', rule),
  /** «Als Regel vorschlagen» on a sentence of a partner's notes, or «Regel anpassen» after it changed: the rule drafted for its card. */
  draftNoteRule: (c: NoteRuleCommand) => request<{ path: string }>('POST', '/api/rules/note', c),
  dropOpen: () => request<DropSession>('POST', '/api/drop'),
  dropAdd: async (session: string, file: File): Promise<DropSession> => {
    const res = await apiFetch(`/api/drop/${session}/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
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
  /** A bank or card account's balance on 31.12. with the bank's year-end confirmation attached (#119). */
  setYearEndBalance: (year: string, account: string, amount: number, file: File) =>
    upload<{ balance: unknown }>(`/api/year-close/${year}/balances/${encodeURIComponent(account)}?${new URLSearchParams({ amount: String(amount), name: file.name })}`, file, 'application/octet-stream'),
  removeYearEndBalance: (year: string, account: string) => request<Ok>('DELETE', `/api/year-close/${year}/balances/${encodeURIComponent(account)}`),
  yearEndDocumentUrl: (year: string, account: string) => `/api/year-close/${year}/balances/${encodeURIComponent(account)}/document`,
  /** The cash counted on 31.12.; null takes it back. */
  setCashCount: (year: string, account: string, amount: number | null) => request<Ok>('PUT', `/api/year-close/${year}/cash/${encodeURIComponent(account)}`, { amount }),
  rebookYearEndEntry: (year: string, id: string, description: string) => request<{ removed: JournalEntry[]; entry?: JournalEntry }>('POST', `/api/year-close/${year}/templates/${id}/rebook`, { description }),
  closeYear: (year: string) => request<unknown>('POST', `/api/year-close/${year}/close`),
  openYear: (year: string) => request<unknown>('POST', `/api/year-close/${year}/open`),

  /** A PDF or photo into the workspace's inbox (beleg-import/), as the phone app sends it. */
  upload: async (file: Blob, type: ReceiptType, capturedAt: Date) => {
    const res = await apiFetch('/api/upload', { method: 'POST', headers: { 'Content-Type': type, 'X-Captured-At': capturedAt.toISOString() }, body: file });
    if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as ApiErrorBody | null) ?? { error: `HTTP ${res.status}` });
    return (await res.json()) as { filename: string };
  },

  /** A bank account's opening balance of `year`; null takes it back (src/accounting/opening-balance.ts). */
  setOpeningBalance: (year: string, account: string, amount: number | null) =>
    request<Ok>('PUT', `/api/opening-balances/${year}/${encodeURIComponent(account)}`, { amount }),

  /** Firma › MWST › Nachdeklarationen (config.vatAdjustments): `id` on an add only puts a removed line back. */
  addVatAdjustment: (line: Omit<VatAdjustment, 'id'> & { id?: string }) => request<VatAdjustment>('POST', '/api/vat-adjustments', line),
  changeVatAdjustment: ({ id, ...line }: VatAdjustment) => request<VatAdjustment>('PUT', `/api/vat-adjustments/${encodeURIComponent(id)}`, line),
  removeVatAdjustment: (id: string) => request<VatAdjustment>('DELETE', `/api/vat-adjustments/${encodeURIComponent(id)}`),

  /** What a statement file read in says about itself, and the day it was read in (#208). */
  statementFileDetails: (file: string) => request<{ details?: StatementDetails; importedAt?: string }>('GET', `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}/details`),
  /** A statement taken back out of the books (`file`: `<bank>/<filename>` as the import named it): the drop dialog's undo, from the page (r9k-3). */
  deleteStatement: (file: string) => request<StatementRemoved>('DELETE', `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}`),
  /** The undo of «Bewegungen aus dem PDF einlesen» (#254): the camt.053 written from the PDF goes, the PDF stays the statement. */
  unreadStatement: (xml: string) => request<StatementRemoved>('DELETE', `/api/statements/${xml.split('/').map(encodeURIComponent).join('/')}?keepPdf=1`),
  /** «Bewegungen aus dem PDF einlesen» on a kept statement PDF (#254): read now (the model, or the hand form), kept as its question. */
  readStatementPdf: (file: string) => request<StatementAsk>('POST', `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}/read`),
  /** The question's table as the person corrected it. */
  correctStatementRead: (file: string, statement: ReadStatement) => request<StatementAsk>('PUT', `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}/read`, { statement }),
  /** «Einlesen»: the table read in beside the PDF; the question goes. */
  importStatementRead: (file: string, statement: ReadStatement) => request<StatementImport>('POST', `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}/read/import`, { statement }),
  /** «Als Auszug behalten»: the PDF stays the statement, its movements are not read in. */
  keepStatementPdf: (file: string) => request<Ok>('DELETE', `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}/read`),
  /** What a kept statement PDF gives the books: its closing balance, the references and foreign amounts its table adds, or why it has none yet (#243). */
  statementFacts: (file: string) => request<PdfFactsView>('GET', `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}/facts`),
  /** Its table as the person filled it in or corrected it: kept as hers. */
  saveStatementFacts: (file: string, statement: PdfTable) => request<PdfFactsView>('PUT', `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}/facts`, { statement }),
  /** «Neu lesen»: its read goes; the next reading asks the model again. A person's table only `confirmed`. */
  forgetStatementRead: (file: string, confirmed = false) => request<PdfFactsView>('DELETE', `/api/statements/${file.split('/').map(encodeURIComponent).join('/')}/facts${confirmed ? '?confirmed=1' : ''}`),
  /** The kept statement PDFs not read yet, and the reading the person started. */
  statementReads: () => request<StatementReadsView>('GET', '/api/statement-reads'),
  /** «N Kontoauszüge von der KI lesen lassen?» answered yes (`files`: only these). */
  startStatementReads: (files?: string[]) => request<StatementReadsView>('POST', '/api/statement-reads', files ? { files } : {}),
  /** «Abbrechen»: the reading stops after the file being read. */
  cancelStatementReads: () => request<StatementReadsView>('DELETE', '/api/statement-reads'),
  /** «Abgleich bestätigen»: the account's reconciliation as the person decided it (#254): the pairs, and the movements read from PDFs that are payments of their own. */
  confirmReconciliation: (account: string, decision: { pairs: ReconcilePair[]; own: string[] }) => request<Ok>('POST', `/api/reconciliations/${encodeURIComponent(account)}`, decision),
  /** «Trotzdem buchen» on a bank movement booked in a filed quarter as a read one (#254): a payment of its own, booked from then on like any other. */
  bookFiledTwinAnyway: (ref: string) => request<Ok>('DELETE', `/api/transactions/${encodeURIComponent(ref)}/filed-twin`),
  /** The undo of a removal, after the file is read again: its bookings and links back as they were (r10h-3). */
  /** The undo of «Auszug entfernen»: the removed files and every record the removal changed come back as they were. */
  restoreStatement: (undo: string) => request<Ok>('POST', '/api/statements/restore', { undo }),

  /**
   * A camt.053 or statement PDF into bank-statements/, read into the books; `into` names the missing month it is for.
   * A PDF no camt.053 covers is refused (`read`): the drop dialog reads it (#217); `keep` keeps it as the month's statement.
   */
  importStatement: async (file: Blob, name: string, into?: { account: string; month: string }, keep?: boolean) => {
    const qs = new URLSearchParams({ name, ...into, ...(keep ? { keep: '1' } : {}) });
    const res = await apiFetch(`/api/statements?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
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
  /** The standard chart's accounts an account field offers to add; none in the static export, which adds nothing. */
  standardAccounts: () => (STATIC_EXPORT ? Promise.resolve([]) : request<Account[]>('GET', '/api/accounts/standard')),
  workspace: () => request<CompanyInfo>('GET', sources.workspace()),
  /** The desktop app's start screen (src/desktop/server.ts). */
  desktop: {
    info: () => request<DesktopInfo>('GET', '/api/desktop'),
    open: (root: string) => request<KnownBooks>('POST', '/api/desktop/open', { root }),
    create: (setup: SetupRequest) => request<KnownBooks>('POST', '/api/desktop/create', setup),
    demo: () => request<KnownBooks>('POST', '/api/desktop/demo'),
    /** Books in the layout before 0.4.0: moved into vanilla-accounting/ as npm run update does, then opened. */
    upgrade: (root: string) => request<KnownBooks>('POST', '/api/desktop/upgrade', { root }),
    ai: () => request<AiAvailability>('GET', '/api/desktop/ai'),
    folder: (root: string) => request<FolderLook>('GET', `/api/desktop/folder?root=${encodeURIComponent(root)}`),
    setup: (root: string) => request<SetupDraftView>('GET', `/api/desktop/setup?root=${encodeURIComponent(root)}`),
    setupBegin: (root: string, language: string) => request<SetupBegun>('POST', '/api/desktop/setup', { root, language }),
    setupPatch: (root: string, patch: SetupPatch) => request<SetupDraftView>('PUT', '/api/desktop/setup', { root, patch }),
    setupTalk: (root: string, text: string) => request<SetupTalked>('POST', '/api/desktop/setup/talk', { root, text }),
    setupCreate: (root: string) => request<KnownBooks>('POST', '/api/desktop/setup/create', { root }),
    phone: () => request<PhoneInfo>('GET', '/api/desktop/phone'),
    setPhone: (on: boolean) => request<PhoneInfo>('POST', '/api/desktop/phone', { on }),
    renewPhone: () => request<PhoneInfo>('POST', '/api/desktop/phone', { renew: true }),
  },
  /** «Handy koppeln», step 1: where the receipt app is downloaded, and its QR code. */
  phoneApp: () => request<{ url: string; qr: string }>('GET', '/api/phone/app'),
  patchWorkspace: (patch: ManifestPatch) => request<CompanyInfo>('PATCH', '/api/workspace', patch),
  removeAccount: (number: string) => request<Ok>('DELETE', `/api/accounts/${number}`),
  setAccountName: (number: string, name: string) => request<{ number: string; name: string; added: boolean }>('PUT', `/api/accounts/${number}`, { name }),
  uploadLogo: (file: Blob, type: string) => upload<CompanyInfo>('/api/workspace/logo', file, type),
  assistantDetach: (id: string) => request<{ ok: true }>('DELETE', `/api/assistant/attachments/${encodeURIComponent(id)}`),
  assistantExportUrl: (file: string) => `/api/assistant/exports/${encodeURIComponent(file)}`,
  assistantAttachmentUrl: (conversation: string, id: string) => `/api/assistant/${encodeURIComponent(conversation)}/attachments/${encodeURIComponent(id)}`,
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
  ai: () => request<AiView>('GET', '/api/ai'),
  setAiStep: (step: StepId, choice: { provider: ProviderId; model: string } | { provider: null }) => request<AiView>('PUT', `/api/ai/steps/${step}`, choice),
  setAiKey: (provider: ProviderId, key: string | null) => request<AiView>('PUT', `/api/ai/keys/${provider}`, { key }),
  /** This Mac's AI, also before any books exist (src/server/ai-setup.ts). */
  aiSetup: {
    view: () => request<AiSetupView>('GET', '/api/ai/setup'),
    install: (cli: TerminalCli, language: string) => request<{ ok: true }>('POST', `/api/ai/setup/${cli}/install`, { language }),
    signIn: (cli: TerminalCli, language: string) => request<{ ok: true }>('POST', `/api/ai/setup/${cli}/login`, { language }),
    test: (cli: TerminalCli) => request<Probation>('POST', `/api/ai/setup/${cli}/test`),
    key: (provider: SetupKey, key: string | null) => request<KeySaved>('PUT', `/api/ai/setup/keys/${provider}`, { key }),
    choose: (choice: { noAi?: boolean; askOther?: boolean }) => request<AiSetupView>('PUT', '/api/ai/setup/choice', choice),
  },
  terminal: () => request<TerminalView>('GET', '/api/terminal'),
  recheckCodexModels: () => request<AiView>('POST', '/api/ai/codex/models'),
  /** «KI ganz ausschalten» (issue #212), kept on this Mac. */
  setAiOff: (off: boolean) => request<AiView>('PUT', '/api/ai/off', { off }),
  setAiCli: (change: { cli?: TerminalCli | null; askOther?: boolean }) => request<AiView>('PUT', '/api/ai/cli', change),
  setTerminalApp: (app: TerminalApp | null) => request<TerminalView>('PUT', '/api/terminal/app', { app }),
  /** An empty `text`: the CLI starts with no prompt (issue #210). */
  openTerminal: (text: string, choice: { cli?: TerminalCli; app?: TerminalApp } = {}) =>
    request<{ cli: TerminalCli; app: TerminalApp }>('POST', '/api/terminal/open', { ...(text.trim() ? { request: text } : {}), ...choice }),
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
  filingXmlUrl: (period: string) => `/api/filing/${encodeURIComponent(period)}`,

  filedReturns: (year: string) => request<ReturnFigures[]>('GET', sources.filedReturns(year)),
  fxRates: () => request<EstvRateTable>('GET', sources.fxRates()),
  orderPages: () => request<Record<string, OrderPage>>('GET', sources.orderPages()),
  vatCorrections: () => request<Record<string, VatCorrection>>('GET', sources.vatCorrections()),
};
