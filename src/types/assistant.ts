/**
 * The AI sidebar's wire format (docs/0.4.0/views.md, "The AI, as a sidebar"; src/assistant/,
 * src/server/routes/assistant.ts, src/app/assistant/): what a message refers to, a stored
 * conversation, the changes an answer made to the books and the events it streams as (NDJSON).
 */
import type { ApiRefusal } from './api-error.js';
import type { JournalEntry, Receipt, ReceiptKind } from './index.js';
import type { Choice, Question, QuestionTarget } from '../questions/model.js';
import type { ReportSpec } from '../reports/spec.js';
import type { ReportResult } from '../reports/result.js';

/** The invoices' languages and own texts (src/invoices/model.ts INVOICE_LANGUAGES, OWN_TEXTS), which the invoicing settings change. */
type InvoiceLanguage = 'de' | 'fr' | 'it' | 'en';
type OwnText = 'salutation' | 'intro' | 'closing' | 'mailSubject' | 'mailBody';

/** An invoice line as an answer gives it; the invoices' own reader checks it (src/invoices/service.ts parseDraftPatch). */
export interface DraftLine { text: string; quantity: number; unit?: string; price: number; vatRate: number }

/** What the person is looking at, referred to and never copied: the server reads it when the message is sent. */
export type ContextRef =
  | { kind: 'entry'; id: string; label: string }
  | { kind: 'payment'; id: string; label: string }
  | { kind: 'receipt'; id: string; label: string }
  | { kind: 'run'; id: string; label: string }
  | { kind: 'workflow'; id: string; label: string }
  | { kind: 'file'; id: string; label: string };

/**
 * A receipt's facts as a person sets them; `null` clears a date or an amount, `vat` replaces the
 * VAT facts (as a person's, vatBy 'human'). An undo puts back the facts as they were: with their
 * line items, and `vatBy: null` for facts the AI had read.
 */
export interface ReceiptSet {
  date?: string | null;
  amount?: number | null;
  currency?: string;
  description?: string;
  vat?: Pick<Receipt, 'hasSwissVat' | 'vatSummary' | 'vatId' | 'lineItems'>;
  vatBy?: null;
}

/** A booking's fields as a change sets them; `origin`, `reason` and `by` only from an undo, `null` for a booking that had none. */
export type EntrySet = Partial<Pick<JournalEntry, 'date' | 'accountDebit' | 'accountCredit' | 'vatCode' | 'description' | 'amount' | 'receipts'>> & { origin?: JournalEntry['origin'] | null; reason?: string | null; by?: JournalEntry['by'] | null };

/**
 * A new booking: on a payment (`transactionRef`) or, without one, standing alone under the next
 * manual ref. `id`, `origin` and the rest of a JournalEntry come only from an undo, which puts a
 * deleted booking back as it was.
 */
export type NewEntry = Omit<JournalEntry, 'id' | 'transactionRef'> & Partial<Pick<JournalEntry, 'id' | 'transactionRef'>>;

/**
 * One change to the books (src/server/edits.ts): a receipt's facts, a link between receipt and
 * payment, a booking changed, added or deleted, a receipt's kind (a duplicate or noise: its links
 * go; `links` are the payments an undo links it to again).
 */
export type BookChange =
  | { kind: 'receipt'; id: string; set: ReceiptSet }
  | { kind: 'link' | 'unlink'; receipt: string; payment: string }
  | { kind: 'entry'; id: string; set: EntrySet }
  | { kind: 'newEntry'; entry: NewEntry }
  | { kind: 'deleteEntry'; id: string }
  | { kind: 'receiptKind'; id: string; as: ReceiptKind | null; by?: Receipt['kindBy'] | null; rule?: string | null; links?: string[] };

/** Firma › Rechnungslayout as a change sets it: the payment term, the texts per language (null: the app's own text again). */
export interface InvoicingSet {
  paymentTermsDays?: number;
  texts?: Partial<Record<InvoiceLanguage, Partial<Record<OwnText, string | null>>>>;
}

/**
 * One change to how the company works outside the books (src/server/workspace-edits.ts): an
 * account of the chart (`name: null` takes back one the change added), the invoicing settings
 * (`customers`: the terms an undo gives each customer back), an invoice draft (for a customer of
 * the invoices, or a new one) and its undo, which drops it again, a question to a person and its
 * undo, which withdraws it.
 */
export type WorkspaceChange =
  | { kind: 'account'; number: string; name: string | null }
  | { kind: 'invoicing'; set: InvoicingSet; customers?: Record<string, number> }
  | { kind: 'invoiceDraft'; customer?: string; newCustomer?: { name: string } & Record<string, unknown>; draft: { lines: DraftLine[] } & Record<string, unknown> }
  | { kind: 'dropInvoiceDraft'; id: string; customer?: string }
  /** A question to the owner the AI cannot decide (src/server/questions.ts); its undo withdraws it. */
  | { kind: 'question'; on: QuestionTarget; text: string; choices?: Choice[]; to?: string }
  | { kind: 'withdrawQuestion'; id: string };

/**
 * What the app runs for an answer, with nothing to undo: an export of a preset, the inbox run's
 * booking of every open payment, a report the AI wrote as a spec (src/reports/spec.ts), which the
 * app runs on the books for its card (`period`: another than the spec's own).
 */
export type ActionChange =
  | { kind: 'export'; preset: string; period?: string }
  | { kind: 'bookAgain' }
  | { kind: 'report'; spec: ReportSpec; period?: string };

export type Change = BookChange | WorkspaceChange | ActionChange;

const BOOK_KINDS = new Set<string>(['receipt', 'link', 'unlink', 'entry', 'newEntry', 'deleteEntry', 'receiptKind'] satisfies Array<BookChange['kind']>);
const ACTION_KINDS = new Set<string>(['export', 'bookAgain', 'report'] satisfies Array<ActionChange['kind']>);
export const isBookChange = (c: Change): c is BookChange => BOOK_KINDS.has(c.kind);
export const isActionChange = (c: Change): c is ActionChange => ACTION_KINDS.has(c.kind);
export const isWorkspaceChange = (c: Change): c is WorkspaceChange => !isBookChange(c) && !isActionChange(c);

/** What the app adds to a change it made, for its card: the VAT code it took from the account, the file an export wrote, the invoice draft made. */
export interface ChangeNote {
  vatFollowed?: { from: string; to: string };
  file?: { name: string; path: string };
  draft?: { id: string; customer: string };
  customers?: number;
  /** The question asked, and its answer when a precedent gave one at once; `open`: the payment's question that was open already, asked by `by`, which stands instead. */
  question?: { id: string; to?: string; answered?: string; open?: Pick<Question, 'on' | 'text' | 'by' | 'topic'> };
  /** An action that did not run: why (`noBrowser`, or the error's text). */
  failed?: string;
  /** The booking now claims input tax at a rate that no receipt of its payment shows. */
  noReceipt?: boolean;
  /** A report's run for its card: its first rows, and the totals of all of them (src/reports/run.ts previewOf). */
  report?: ReportResult;
}

/** Why the app holds an answer's changes for the person's «Übernehmen» (src/assistant/held.ts). */
export type HoldReason = 'payments' | 'deletes' | 'rateWithoutReceipt';

/** A booking's lines as a held card shows them. */
export interface HeldLine { accountDebit: string; accountCredit: string; vatCode?: string; amount: number }

/** One booking a held answer changes: as it is (`before`, absent for a new one) and as it would be (`after`, absent when deleted). */
export interface HeldRow {
  entry: string;
  ref: string;
  date: string;
  text: string;
  before?: HeldLine;
  after?: HeldLine;
  /** It would claim input tax at a rate that no receipt of its payment shows. */
  noReceipt?: boolean;
}

/**
 * An answer's changes that rebook the books rather than fix one booking: nothing of them is made
 * until the person presses «Übernehmen» on their card, which lists each booking before → after.
 * `taken`: made (the turn's `changes` then holds them, each with its undo); `dropped`: discarded.
 */
export interface HeldChanges { changes: Change[]; why: HoldReason[]; rows: HeldRow[]; status: 'held' | 'taken' | 'dropped' }

/**
 * A change an answer made, with what undoes it (none for an action). `payment`: the payment whose
 * bookings it changed; its changes are undone together, so they keep adding up.
 */
export interface MadeChange {
  id: string; change: Change; undo?: Change; payment?: string; note?: ChangeNote; undone?: boolean;
  /** The questions the change answered (a sale's VAT code set on the person's wish): its undo opens them again. */
  answered?: string[];
}

/** POST /api/assistant. Without `conversation` a new one starts. */
export interface AssistantSend {
  conversation?: string;
  text: string;
  context: ContextRef[];
  /** The UI's language: the AI answers in it. */
  language: string;
}

export interface ToolUse { name: string; detail: string; denied?: boolean }

export type Turn =
  | { role: 'me'; text: string; at: string; context: ContextRef[] }
  | {
    role: 'ai'; text: string; at: string; tools: ToolUse[]; changes?: MadeChange[]; refused?: string; refusal?: ApiRefusal; error?: string; done: boolean;
    /** Changes the app holds for the person's «Übernehmen» instead of making them (HeldChanges). */
    held?: HeldChanges;
    /** What the answer said before the app refused its changes; `text` is then what it says now that nothing was changed. */
    withdrawn?: string;
  };

/** data/assistant/<id>.json: one conversation, its Claude session continued by every message. */
export interface Conversation {
  id: string;
  title: string;
  at: string;
  session?: string;
  turns: Turn[];
}

export interface ConversationSummary { id: string; title: string; at: string; context: string[] }

export type AssistantEvent =
  /** The first event of every answer: the conversation the message went into. */
  | { type: 'conversation'; id: string }
  | { type: 'session'; session: string }
  /** A piece of the answer, appended to what came before. */
  | { type: 'text'; text: string }
  /** The AI uses a tool (`detail`: the file, command or pattern); `denied` when its permissions refused it. */
  | { type: 'tool'; name: string; detail: string; denied?: boolean }
  /** The changes the answer made to the books, all of them or, with `refused`, none. */
  | { type: 'changes'; changes: MadeChange[] }
  /** The answer's changes, held for the person's «Übernehmen»: nothing is made yet. */
  | { type: 'held'; held: HeldChanges }
  /** `refusal`: its code, so the UI says why in the person's language. */
  | { type: 'refused'; message: string; refusal?: ApiRefusal }
  /** The answer's text, whole, in place of what streamed: after a refusal, what was not done and why; after changes made, with the app's line on what it made. */
  | { type: 'replace'; text: string }
  | { type: 'done'; session?: string; isError: boolean }
  | { type: 'error'; message: string };
