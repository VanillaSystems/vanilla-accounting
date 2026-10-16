import type { AuditSnapshot } from '../audit/sources.js';
import type { Iban } from '../workspace/banks.js';
import type { MailRefusal } from '../invoices/mail.js';
import type { InvoiceRefusal, Missing } from '../invoices/rules.js';
import type { SetupRefusal } from '../workspace/create.js';
import type { SaleGone } from '../questions/model.js';

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
  /** `approved`: the date is not filed but held by that period's approved return (r7h-24). */
  | { code: 'periodClosed'; params: { closedThrough: string; reason?: ClosedReason; approved?: string } }
  | { code: 'manualOnly' }
  /** A payment booked by hand is not booked twice. */
  | { code: 'hasEntries' }
  /** Änderungen › «Rückgängig» of a deletion while the payment has bookings it did not have then (src/server/edits.ts restoreSaved): how many stand, and whether a person or the app booked them. */
  | { code: 'bookedSince'; params: { payment: string; entries: number; by: 'person' | 'app' } }
  /** «Privat oder bar bezahlt» on a receipt a payment already pays (src/server/edits.ts privatePayment). */
  | { code: 'receiptPaid'; params: { receipt: string; payment: string } }
  | { code: 'yearClose' }
  /** Cash basis: a booking of a payment keeps the payment's date (src/server/edits.ts applyAnswer). */
  | { code: 'paymentDate'; params: { date: string } }
  /** The bookings of a payment would no longer add up to it: `paid` and `booked` in its currency. */
  | { code: 'paymentBalance'; params: { date: string; currency: string; paid: number; booked: number } }
  | ClassifyRefusal
  /** An AI sidebar answer (src/server/edits.ts applyAnswer, src/server/workspace-edits.ts): it would take back an earlier answer's change, link a receipt set aside, book on an account the chart lacks, or take back an account bookings use. */
  /** Someone answered the question first (the books folder is shared). */
  | { code: 'questionAnswered' }
  | { code: 'questionGone'; params: { why: SaleGone } }
  | { code: 'takesBack' }
  | { code: 'setAside'; params: { receipt: string } }
  | { code: 'unknownAccount'; params: { account: string } }
  | { code: 'oneSided'; params: { account: string } }
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
  /** The account invoices are paid to must keep an IBAN (it is printed on them). */
  | { code: 'payToNeedsIban'; params: { bank: string; currency: string } }
  | { code: 'noBrowser' }
  | { code: 'noClaude' }
  | { code: 'noWorkspace' }
  | { code: 'notWorkspace' }
  | { code: 'setup'; params: SetupRefusal }
  /** An opening balance typed for an account that takes none by hand (Firma › Eröffnung). */
  | { code: 'openingAccount'; params: { account: string; reason: 'notBalanceSheet' | 'equity' | 'foreign' } }
  /** Opening balances typed for a year an earlier year of the books opens. */
  | { code: 'openingNotFirstYear'; params: { year: string } }
  | { code: 'openingYearClosed'; params: { year: string } }
  | { code: 'mailSourceField'; params: { field: 'address' | 'host' | 'account' } }
  /** What a change names is not in the books (any more): a receipt, a booking, a payment, a change by hand since the last save. */
  | { code: 'gone'; params: { what: 'receipt' | 'entry' | 'payment' | 'handEdit' | 'file' } }
  /** The secret store (the Mac's keychain) could not take a password: nothing else was written. */
  | { code: 'secretStore' }
  /** An invoicing refusal met through the AI sidebar (src/server/workspace-edits.ts): which rule, and what is missing. */
  | { code: 'invoice'; params: { refusal: InvoiceRefusal; missing?: Missing[] } }
  /** A change a person can meet that the books refuse: invoicing not set up, a customer the invoices lack, a booking of 0, without an account, a VAT code or text, an account number or name the chart cannot take. */
  | { code: 'invoicingNotSetUp' }
  /** Firma › Rechnungslayout › Zahlungskonten: the account named is no bank account of that currency. */
  | { code: 'payToAccount'; params: { currency: string } }
  /** Firma › Bankkonten: a text that is no IBAN (length or check digits). */
  | { code: 'iban'; params: { iban: string } }
  /** Firma › Bankkonten: the IBAN cleared is printed on invoices (invoicing.payTo); pick another account under Rechnungslayout first. */
  | { code: 'ibanOnInvoices'; params: { currency: string; account: string } }
  | { code: 'unknownCustomer' }
  | { code: 'amountZero' }
  | { code: 'noAccount' }
  | { code: 'unknownVatCode'; params: { code: string } }
  /** A code the firm's form does not take (src/accounting/vat-codes.ts formTakes): none on a firm not registered, no input-tax code on the net tax rate method. */
  | { code: 'codeNotTaken'; params: { code: string; method: 'none' | 'net-rate' } }
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
 * an entry without an account, or entries that do not add up to what the bank paid.
 */
export type ClassifyRefusal =
  | { code: 'classifyAccount'; params: { description: string } }
  | { code: 'classifyBalance'; params: { date: string; currency: string; paid: number; booked: number } };

/**
 * Why a statement upload (POST /api/statements) was refused: not XML or PDF, an XML that is no
 * camt.053, no bank account takes it (detail: the manifest's problem), a PDF whose name gives no
 * month, or a camt.053 already read (detail: that file).
 */
/** A statement's account the manifest lacks: its IBAN and currency, and the bank's name when the statement gives it. */
export interface UnknownAccount { iban: string; currency: string; bankName?: string }

/**
 * Why a statement lands on no account, for the UI to say in the person's words (and the drop
 * dialog to offer the account). `noAccount`: no account takes its currency (with its IBAN when it
 * names one). `otherIban`: the account of its folder has another IBAN. `twoAccounts`: the folder
 * already holds statements of another IBAN in that currency (src/workspace/bank-statements.ts). Built in src/accounting/bank-accounts.ts.
 */
export type StatementProblem =
  | { kind: 'noAccount'; currency: string; iban?: Iban }
  | { kind: 'otherIban'; currency: string; iban: Iban; account: { bank: string; iban: Iban } }
  | { kind: 'twoAccounts'; currency: string; bank: string; ibans: [first: string, second: string]; iban?: Iban };

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
