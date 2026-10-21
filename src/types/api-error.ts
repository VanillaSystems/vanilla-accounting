import type { AuditSnapshot } from '../audit/sources.js';
import type { Iban } from '../workspace/banks.js';
import type { MailRefusal } from '../invoices/mail.js';
import type { InvoiceRefusal, Missing } from '../invoices/rules.js';
import type { SetupRefusal } from '../workspace/create.js';
import type { SaleGone } from '../questions/model.js';
import type { RuleRefusal } from './rule-refusal.js';
import type { ReportRefusal } from '../reports/spec.js';
import type { AttachmentRefusal } from './attachment.js';
import type { MacMailProblem } from './mac-mail.js';

/**
 * The JSON body of every refused API request. `error` is the German text the CLI, the tests and
 * the logs read; `code` and `params` let the UI say the same in the user's language
 * (src/app/lib/api.ts errorText). A body without a code is shown as its `error` text.
 */
export const CLOSED_REASONS = [
  'editTransaction', 'deleteTransaction', 'newTransaction', 'mapping',
  'editReceipt', 'deleteReceipt', 'editEntry', 'deleteEntry', 'newStatement', 'newEntry',
  'openingBalance',
] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export type ApiRefusal =
  | { code: 'readonly' }
  | { code: 'localOnly' }
  | { code: 'phoneToken' }
  /**
   * `approved`: the date is not filed but held by that period's approved return (r7h-24).
   * `filed`: the period was filed with the tax authority and is not sealed yet; the change would move the books further from the return filed (r10h-4).
   */
  | { code: 'periodClosed'; params: { closedThrough: string; reason?: ClosedReason; approved?: string; filed?: string } }
  | { code: 'manualOnly' }
  /** A payment booked by hand is not booked twice. */
  | { code: 'hasEntries' }
  /** Änderungen › «Rückgängig» of a deletion while the payment has bookings it did not have then (src/server/edits.ts restoreSaved): how many stand, and whether a person or the app booked them. */
  | { code: 'bookedSince'; params: { payment: string; entries: number; by: 'person' | 'app' } }
  /** «Privat oder bar bezahlt» on a receipt a payment already pays (src/server/edits.ts privatePayment). */
  | { code: 'receiptPaid'; params: { receipt: string; payment: string } }
  /** A second bank payment of another payee for a receipt that has one, asked without `confirm` (src/server/edits.ts assertNotSecondPayment, r8h-21). */
  | { code: 'secondPayment'; params: { receipt: string; payment: string } }
  | { code: 'yearClose' }
  /** Cash basis: a booking of a payment keeps the payment's date (src/server/edits.ts applyAnswer). */
  | { code: 'paymentDate'; params: { date: string } }
  /** The bookings of a payment would no longer add up to it: `paid` and `booked` in its currency. */
  | { code: 'paymentBalance'; params: { date: string; currency: string; paid: number; booked: number } }
  | ClassifyRefusal
  /** A file given the AI sidebar it cannot take (src/types/attachment.ts): its type, empty, too big, or gone before the message was sent. */
  | AttachmentRefusal
  /** An AI sidebar answer (src/server/edits.ts applyAnswer, src/server/workspace-edits.ts): it would take back an earlier answer's change, link a receipt set aside, book on an account the chart lacks, or take back an account bookings use. */
  /** Someone answered the question first (the books folder is shared). */
  | { code: 'questionAnswered' }
  | { code: 'questionGone'; params: { why: SaleGone } }
  | { code: 'takesBack' }
  | { code: 'setAside'; params: { receipt: string } }
  | { code: 'unknownAccount'; params: { account: string } }
  /** A report spec the app cannot run (src/reports/spec.ts): from the sidebar, the form or a saved file. */
  | { code: 'report'; params: { refusal: ReportRefusal } }
  | { code: 'oneSided'; params: { account: string } }
  /** The same account on both sides without a VAT code books nothing (src/server/edits.ts assertTwoSides); a VAT-only correction may (M81-2 shapes). */
  | { code: 'sameAccount'; params: { account: string } }
  /** A code whose sign contradicts the line's direction (src/server/edits.ts assertCodeSign): M81 on a credit note, -V81 on a sale; `expected` is the code the line takes. */
  | { code: 'codeSign'; params: { code: string; expected: string } }
  | { code: 'accountInUse'; params: { account: string; entries: number } }
  /** Re-classify of a payment that holds a person's booking (origin manual), asked without `overwrite`. */
  | { code: 'personsBooking'; params: { entries: number } }
  | { code: 'fileExists'; params: { filename: string } }
  /** A restore of a deleted receipt (POST /api/receipts/:id/restore): gone from the trash, deleted again later, or back already. */
  | { code: 'notInTrash' }
  | { code: 'deletedAgain' }
  | { code: 'alreadyBack' }
  | { code: 'statement'; params: StatementParams }
  /** A bank account's IBAN typed in Firma › Bankkonten or the invoicing setup fails the length or check-digit test. */
  | { code: 'iban'; params: { bank: string; detail: string } }
  /** Firma › Firma: the company UID typed has a wrong shape or check digit (r9c-5). */
  | { code: 'uid'; params: { detail: string } }
  /** The account invoices are paid to must keep an IBAN (it is printed on them). */
  | { code: 'payToNeedsIban'; params: { bank: string; currency: string } }
  | { code: 'noBrowser' }
  | { code: 'noClaude' }
  /** Geschäftspartner and Wissen (src/server/routes/knowledge.ts): a partner or a topic page that does not exist, notes changed since they were opened, a new page without a title. */
  | { code: 'partnerGone' }
  | { code: 'topicGone' }
  | { code: 'notesChanged' }
  | { code: 'notesTitle' }
  | { code: 'noWorkspace' }
  | { code: 'notWorkspace' }
  | { code: 'setup'; params: SetupRefusal }
  /** An opening balance typed for an account that takes none by hand (Firma › Eröffnung). */
  | { code: 'openingAccount'; params: { account: string; reason: 'notBalanceSheet' | 'equity' | 'foreign' } }
  /** Opening balances typed for a year an earlier year of the books opens. */
  | { code: 'openingNotFirstYear'; params: { year: string } }
  | { code: 'openingYearClosed'; params: { year: string } }
  | { code: 'mailSourceField'; params: { field: 'address' | 'host' | 'account' } }
  /** «Mail-Programm auf diesem Mac»: the Mail app could not be read (src/platform/sources/mac-mail.ts), or it holds no such account or mailbox. */
  | { code: 'macMail'; params: { problem: MacMailProblem } }
  /** A mailbox the AI drafts: the domain's MX records name no IMAP server the app knows, so the person names it. */
  | { code: 'mailHostUnknown'; params: { domain: string } }
  /** A mailbox the AI drafts with a password: a password goes only into the card's field, never through the chat. */
  | { code: 'mailboxPassword' }
  /** A source the AI names whose draft (data/draft/sources/<id>/) is missing, does not load, holds a secret, or takes the name of the app's own code (src/platform/sources/draft.ts). */
  | { code: 'sourceDraftMissing'; params: { id: string } }
  | { code: 'sourceInvalid'; params: { id: string; problems: string[] } }
  | { code: 'sourceSecret'; params: { id: string; file: string } }
  | { code: 'sourceAppId'; params: { id: string } }
  /** What a change names is not in the books (any more): a receipt, a booking, a payment, a change by hand since the last save. */
  | { code: 'gone'; params: { what: 'receipt' | 'entry' | 'payment' | 'handEdit' | 'file' } }
  /** Firma › Bankkonten › «Entfernen» (or the undo of an add) while statements, bookings or invoices use the account (r9k-1). */
  | { code: 'bankInUse'; params: { account: string; label: string; statements: number; entries: number; invoices: number } }
  /** Firma › Bankkonten › «Bankkonto hinzufügen» on a ledger account another bank account already has (r10h-2): the one that has it. */
  | { code: 'ledgerAccountTaken'; params: { account: string; bank: string; currency: string; label: string } }
  /** The secret store (the Mac's keychain) could not take a password: nothing else was written. */
  | { code: 'secretStore' }
  /** An invoicing refusal met through the AI sidebar (src/server/workspace-edits.ts): which rule, and what is missing. */
  | { code: 'invoice'; params: { refusal: InvoiceRefusal; missing?: Missing[] } }
  /** A change a person can meet that the books refuse: invoicing not set up, a customer the invoices lack, a booking of 0, without an account, a VAT code or text, an account number or name the chart cannot take. */
  | { code: 'invoicingNotSetUp' }
  /** Firma › Rechnungslayout › Zahlungskonten: the account named is no bank account of that currency. */
  | { code: 'payToAccount'; params: { currency: string } }
  /** Firma › Bankkonten: a text that is no IBAN (length or check digits). */
  /** Firma › Bankkonten: the IBAN cleared is printed on invoices (invoicing.payTo); pick another account under Rechnungslayout first. */
  | { code: 'ibanOnInvoices'; params: { currency: string; account: string } }
  | { code: 'unknownCustomer' }
  | { code: 'amountZero' }
  | { code: 'noAccount' }
  | { code: 'unknownVatCode'; params: { code: string } }
  /** A code the firm's form does not take (src/accounting/vat-codes.ts formTakes): none on a firm not registered, no input-tax code on the net tax rate method. */
  | { code: 'codeNotTaken'; params: { code: string; method: 'none' | 'net-rate' } }
  /** A rule made by hand in Firma › Regeln that the app cannot carry out (src/booking/rules.ts parseRule). */
  | { code: 'rule'; params: { refusal: RuleRefusal } }
  | { code: 'noDescription' }
  | { code: 'accountNumber'; params: { account: string } }
  | { code: 'accountName'; params: { account: string } }
  /** The VAT setup (registration, method, period, a rate) holds for whole years: the open year already has entries. */
  | { code: 'vatMethodHeld'; params: { year: string; entries: number } }
  /** A VAT setup the Firma page sent that no firm can have (src/workspace/vat-setup.ts VatSetupRefusal): which rate, and what is wrong with it. */
  | { code: 'vatSetup'; params: { reason: 'activityId' | 'sameRate' | 'rate' | 'rates'; rate: number } }
  /** A question of the AI sidebar offering answers no question card has (src/questions/model.ts questionChoices). */
  | { code: 'questionChoices' }
  /** An account the chart places on neither statement (a closing class such as 9xxx): refused for a new account and for a booking. */
  | { code: 'accountOutsideStatements'; params: { account: string; classes: string } };

/**
 * The classifier's answer would have booked a payment wrong (src/booking/classify.ts paymentRefusal):
 * an entry without an account, an entry on an account the chart does not have, or entries that do
 * not add up to what the bank paid.
 */
export type ClassifyRefusal =
  | { code: 'classifyAccount'; params: { description: string } }
  | { code: 'classifyUnknownAccount'; params: { account: string; description: string } }
  | { code: 'classifyBalance'; params: { date: string; currency: string; paid: number; booked: number } };

/**
 * Why a statement upload (POST /api/statements) was refused: not XML or PDF, an XML that is no
 * camt.053, no bank account takes it (detail: the manifest's problem), a PDF whose name gives no
 * month, or a camt.053 already read (detail: that file).
 */
/** A statement's account the manifest lacks: its IBAN and currency, and the bank's name when the statement gives it. */
export interface UnknownAccount {
  iban: string;
  currency: string;
  bankName?: string;
  /** The account holder the statement names (camt Acct/Ownr/Nm): the owner sees whose account it is (r9k-1). */
  owner?: string;
}

/**
 * Why a statement lands on no account, for the UI to say in the person's words (and the drop
 * dialog to offer the account). `noAccount`: no account takes its currency (with its IBAN when it
 * names one). `otherIban`: the account of its folder has another IBAN. `twoAccounts`: the folder
 * already holds statements of another IBAN in that currency (src/workspace/bank-statements.ts). Built in src/accounting/bank-accounts.ts.
 */
export type StatementProblem =
  | { kind: 'noAccount'; currency: string; iban?: Iban }
  | { kind: 'otherIban'; currency: string; iban: Iban; account: { bank: string; iban: Iban } }
  | { kind: 'twoAccounts'; currency: string; bank: string; ibans: [first: string, second: string]; iban?: Iban }
  | AccountChoice;

/** `whichAccount`: several accounts of its currency name no IBAN, so any of them could be it; the person picks one (the drop dialog asks, #25). */
export interface AccountChoice { kind: 'whichAccount'; currency: string; iban?: Iban; accounts: Array<{ account: string; bank: string; label: string }> }

export type StatementRefusal = 'format' | 'notCamt' | 'account' | 'name' | 'duplicate' | 'filedPayments';

/**
 * Why a statement was refused (nothing written). `account`: it lands on no bank account, `problem`
 * says why in detail and `unknown` names the account the UI offers to add. `filedPayments`: it
 * holds payments dated in a filed period that the books lack (`closed`).
 */
export interface StatementParams {
  reason: StatementRefusal;
  detail?: string;
  unknown?: UnknownAccount;
  problem?: StatementProblem;
  closed?: { n: number; through: string; refs: string[] };
}

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
  /** The desktop app: the password is saved in Firma › E-Mail-Versand into the keychain store. */
  inApp: boolean;
}
