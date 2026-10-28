/**
 * The drop dialog's session (docs/0.4.0/intake.md): every file dropped while it is open, as a row
 * with what it was recognized as and what became of it. A file that can be taken is taken at once
 * (a receipt into the inbox, a statement read into the books) and handed to the inbox's run; a file
 * with an open question waits for its answer. «Rückgängig» takes a file back out. Passwords are
 * never part of it.
 */

import type { AccountChoice, UnknownAccount } from './api-error.js';
import type { OtherWhy, SupportingWhy } from '../core/modules/schema.js';
import type { TwinWhy } from './index.js';
import type { CsvAsk, CsvColumns, ReadBy, ReadStatement, StatementRead } from './statement-read.js';

/** What a file is. Unset while nobody knows (the row asks). */
export type DropKind = 'receipt' | 'photo' | 'camt' | 'statement-pdf' | 'statement-csv' | 'zip' | 'sales-report';

/** How it was recognized: by its structure (bytes, a namespace), or by a hint (a word, the name). */
export type DropHow = 'structure' | 'hint';

/**
 * Where a file stands: to be taken (a moment, while it is written), taken (into the inbox, or read
 * as a bank statement), taken back («Rückgängig»), not taken as a duplicate, quarantined (not a
 * receipt), refused (not stored at all), waiting for a password, waiting for the person to say
 * what it is, or a statement asking its question (which account it is of, or whether an account the
 * books lack is the firm's or private: `chooseAccount`, `unknownAccount`), kept until answered.
 */
export type DropState = 'take' | 'taken' | 'undone' | 'duplicate' | 'quarantine' | 'refused' | 'locked' | 'unclear' | 'asks';

export interface DropRow {
  /** The row's own key in the session. */
  key: string;
  /** The first 16 hex of the file's SHA-256: its receipt id once taken. */
  id: string;
  name: string;
  /** The ZIP it came out of. */
  from?: string;
  size: number;
  kind?: DropKind;
  how?: DropHow;
  /** The key facts of a statement: its account and the period of its bookings. */
  facts?: StatementFacts;
  state: DropState;
  /** Why it is not taken, or what it waits for; the UI words it. */
  reason?: DropReason;
  /** A refusal the books gave in their own words (a statement of a filed quarter, of no account). */
  message?: string;
  /** A statement of an account the books do not know: the UI asks whether it is the firm's and offers «Bankkonto hinzufügen». */
  unknownAccount?: UnknownAccount;
  /** A statement several accounts of its currency could take (none names an IBAN): the UI asks which (#25). */
  chooseAccount?: AccountChoice;
  /** A statement file that asks for its account: what the file says about itself (#208). */
  details?: StatementDetails;
  /**
   * A statement without a bank export (#217): its movements as the model read them off the PDF, scan or
   * photo, as a person fills them by hand, or as a CSV's columns give them; checked, the lines the
   * books hold marked. Corrected in the row, imported with «Einlesen» as an ISO 20022 statement.
   */
  read?: StatementRead;
  /** A bank's CSV waiting for its columns (#217): its header, a few rows, the mapping proposed. */
  csv?: CsvAsk;
  /** A statement read in already (`statement-read`): its file under bank-statements/ and its first payment, which opens it. */
  readAs?: { file: string; ref?: string };
  /** The bank account (ledger number) the person said the statement is of, or the CSV's. */
  account?: string;
  /** The person said «Einlesen» on a statement read without a bank export: it is imported as written. */
  confirmed?: true;
  /** Kept as the month's statement (`month`, when its name does not say), its movements not imported: the person said «Als Monatsauszug behalten», or its account has a camt.053 or bank CSV (#254). */
  keep?: { month: string };
  /**
   * A statement PDF kept as its account's statement at once, its question («Einlesen» or «Als Auszug
   * behalten») kept in the books (#254): the PDF's file under bank-statements/ and its month. Closing
   * the dialog leaves the question in Bank › Kontoauszüge.
   */
  asked?: { file: string; month: string };
  /** Taken: the run that takes it up. */
  run?: string;
  /** A receipt: the name it got in the inbox. */
  inbox?: string;
  /** Not a receipt: the name it got in data/quarantine/. */
  quarantined?: string;
  /** A statement: its file under bank-statements/ and the payments it added. */
  statement?: { file: string; refs: string[] };
  /** A payment provider's sales or fee report (a CSV its file's columns recognise, #203): whose, and which kind. */
  provider?: { id: string; name: string; kind: 'sales' | 'fees' };
  /** A report taken: what it booked onto the provider's clearing account and what it left. */
  report?: ReportSummary;
  /** A report the company's file of its provider cannot book yet: the account (or fee code) the row asks for, once. */
  askProvider?: ProviderAsk;
  /** A report held because no payout of its provider is recognised: why, and what was looked at. */
  payoutUnseen?: PayoutUnseen;
  /** The person took the report anyway («Trotzdem übernehmen»): the unseen-payout check is skipped. */
  anyway?: true;
  /** What its text says it is, when it is no plain receipt (src/intake/document-kind.ts): kept beside an invoice, or no receipt at all. */
  document?: SupportingWhy | OtherWhy;
  /**
   * A receipt of the books (or a row of this session) whose facts it repeats or accompanies
   * (src/intake/duplicates.ts): its id and name. A possible duplicate waits for «ist dasselbe» or
   * «verschieden»; a companion (an order confirmation beside its invoice) is taken.
   */
  twin?: { of: string; name: string; why: TwinWhy; relation: 'duplicate' | 'companion' };
}

export interface StatementFacts { iban?: string; from?: string; to?: string; entries?: number }

/**
 * What a bank statement file says about itself, shown folded under a row that asks for its account (#208), so
 * the person can tell several dropped files apart: the bank as it names itself (or its BIC), the
 * account's currency, IBAN and owner, the period the bank states and the days it booked, the
 * number of movements, the opening and closing balance with their days, and the first movements
 * (`preview`, at most STATEMENT_PREVIEW of src/providers/statement-files.ts; `more` says how many are not shown).
 */
export interface StatementDetails {
  /** An ISO 20022 statement the app wrote from a statement read without one (#217): the file it was read from, and how. */
  read?: { from: string; by: ReadBy };
  bankName?: string;
  bic?: string;
  currency: string;
  iban?: string;
  owner?: string;
  period?: { from: string; to: string };
  booked?: { first: string; last: string };
  movements: number;
  opening?: { date: string; amount: number };
  closing?: { date: string; amount: number };
  preview: StatementMovement[];
  more: number;
}

/** One movement of a statement's preview: signed (money out negative), in the account's currency. */
export interface StatementMovement { date: string; amount: number; counterparty?: string; text?: string }

/** Why a provider's payout waits for the person, as its line in Kontoauszüge says it (GET /api/transactions/:ref/payout-wait, src/booking/providers.ts PayoutWait). */
export interface PayoutWaitView { why: 'clearing' | 'since' | 'gap'; provider: string; file: string; since?: string }

/**
 * What the company's file of a provider lacks for its report: its clearing account (with the cut-over
 * day), the cut-over day alone, its revenue account, or its fee account and code; `file`: where it is
 * kept; `since`: the cut-over day proposed (the first day of the open period) while the file names none.
 */
export interface ProviderAsk { provider: string; name: string; missing: 'clearing' | 'since' | 'revenue' | 'fees'; file: string; since?: string }

/**
 * A report held because no payout of its provider is recognised (src/intake/sales-report-import.ts
 * unseenPayout): the bank's payments are in through `through` (the first order the provider collected
 * from the cut-over day `since` on, plus its payout days), on the accounts `banks` (label and
 * currency; only the one the provider pays into, `account`, when its file names one), and none from
 * `since` on is its payout. «Trotzdem übernehmen» books it (DropAction 'anyway'); the payout's name
 * belongs into the provider's file `file` under `match.tx`.
 */
export interface PayoutUnseen { provider: string; name: string; since: string; through: string; banks: string[]; file: string; account?: string }

/** Why an order of a report was not booked by code (src/booking/sales-report.ts ReportHold). */
export interface ReportHeld { order: string; why: 'noTax' | 'rate' | 'abroadTax' | 'foreignTax' | 'country' | 'changed' | 'noRate' | 'refundDate' | 'refundMismatch' | 'noPayment' | 'legacy' | 'charges' }

/**
 * What a report booked (src/intake/sales-report-import.ts): orders, refunds and fees booked; `known`
 * already in the books; `filed` and `before`: rows dated in a filed period or before the books, not
 * booked (a correction is the person's); `beforeSince`: rows dated before `reach` (the provider's
 * cut-over day `since` less its payout days: no payout from the clearing account can have paid them),
 * booked the way they were and never by the report, the first ones named (`beforeSinceRows`, the rest
 * `beforeSinceMore`), with the payout days `reach` was counted by (`payoutDays`) and the company's file
 * that may say more (`home`); `other`: orders the provider did not collect (paid otherwise:
 * PayPal, bank transfer, a gift card, a test), not booked, with how they were paid (`ways`, the first
 * ones, `waysMore` the rest); `test`: orders the report's test column flags, not booked; `held`: orders
 * the person decides (the first ones, `heldMore` the rest);
 * `unread`: rows code could not read; `proofs`: order documents linked to their sale. A payments
 * (fee) report takes the provider's sales reports again (#214): `orders` and `refunds` are what that
 * booked of theirs. `unpaid`: sales the books carry of the provider whose order a payments report
 * should name and names not; they stay booked, and the app asks the person on each (askUnpaid).
 * `corrections`: the sales reports' receipts that offer a refund paid in a filed period as a correction
 * (SalesReportFacts.filedRefunds, #231): the row lists those offers from the books, each with its button
 * (one whose sale sits in an old entry naming other orders too, `byHand`, #239: named without it).
 */
export interface ReportSummary {
  provider: string; name: string; kind: 'sales' | 'fees'; from: string; to: string; file: string; since: string; reach: string;
  orders: number; refunds: number; fees: number; known: number; filed: number; before: number; beforeSince: number;
  beforeSinceRows: string[]; beforeSinceMore: number; payoutDays: number; home: string;
  other: number; ways: string[]; waysMore: number; test: number; unpaid: number;
  held: ReportHeld[]; heldMore: number; unread: number; proofs: number;
  corrections: string[];
}

/** `duplicate`: the same bytes; `possible-duplicate`: the same facts, asked; `same`: the person said it is the same; `not-receipt`: its words say so (`document` says what it is). */
export type DropReason =
  | 'duplicate' | 'possible-duplicate' | 'same' | 'not-receipt' | 'held' | 'pdf-password'
  | 'as-zip' | 'as-pdf' | 'bank-csv' | 'office' | 'not-statement' | 'damaged' | 'too-deep' | 'too-big' | 'wrong-password' | 'not-imported'
  /** A PDF header on bytes no PDF reader opens (damaged, cut short): quarantine, nothing will ever read it (r8k-9). */
  | 'unreadable'
  /** A statement whose file is read in already (`readAs`): its movements are in the books. */
  | 'statement-read'
  /** A statement without a bank export read into a table (`read`): the person checks it and says «Einlesen». */
  | 'check-read'
  /** A bank's CSV: the person says which column holds what (`csv`). */
  | 'csv-columns'
  /** A statement of an account the owner said is private: set aside, not read into the books. */
  | 'private'
  /** A provider's report its file cannot book yet: the row asks for the missing account (`askProvider`). */
  | 'provider-account'
  /** Taking a provider's report failed on an error (`message`): nothing of it was booked, the session goes on. */
  | 'report-failed'
  /** A provider's report held: no payout of the provider is recognised among the bank's payments of its days (`payoutUnseen`). */
  | 'payout-unseen';

export interface DropSession {
  id: string;
  rows: DropRow[];
}

export type DropAction =
  | { kind: 'take' }
  | { kind: 'remove' }
  | { kind: 'as'; as: 'receipt' | 'quarantine' }
  /** The password of a protected ZIP: used to unpack it, never stored. */
  | { kind: 'unlock'; password: string }
  /** Take a taken file back out: the inbox file, or what it made in the books. */
  | { kind: 'undo' }
  /** A statement of an unknown account is the owner's private one: set aside. */
  | { kind: 'private' }
  /** A statement of one of the accounts it offered (`chooseAccount`): read into that one. */
  | { kind: 'account'; account: string }
  /** A possible duplicate: «ist dasselbe» (not taken) or «verschieden» (taken, and the pair is not asked again). */
  | { kind: 'twin'; answer: 'same' | 'distinct' }
  /** A report's provider lacks an account (`askProvider`): the person names it, it is kept in the company's file of the provider, and the report is taken. */
  | { kind: 'provider'; account?: string; vat?: string; since?: string }
  /** A report held because no payout of its provider is recognised (`payoutUnseen`): «Trotzdem übernehmen» books it. */
  | { kind: 'anyway' }
  /** A statement read without a bank export (`read`), as the person corrected it: checked again and, with `import`, imported («Einlesen»). */
  | { kind: 'read'; statement: ReadStatement; import?: boolean }
  /** A bank's CSV (`csv`): its columns and its account; the mapping is kept for the account's next CSV. */
  | { kind: 'csv'; columns: CsvColumns; account: string }
  /** A receipt, photo or scan that is a bank statement: read as one (#217). */
  | { kind: 'statement' }
  /** A statement PDF whose table waits (`read`): kept as the month's statement instead, its movements not imported; `statement`: the table as shown, for its days. */
  | { kind: 'keep'; statement?: ReadStatement }
  /** «Bewegungen aus dem PDF einlesen» on a statement PDF kept as the statement (#254): read now, its question kept in the books. */
  | { kind: 'readPdf' };

/** Why a file is in data/quarantine/: its words say it is no receipt (and which kind, and the mail's sender), a person set it aside, or it is no PDF inside. */
export type QuarantineReason = { kind: 'not-receipt'; why?: OtherWhy; from?: string } | { kind: 'held' } | { kind: 'unreadable' };

/** A file in data/quarantine/ as Belege lists it (src/intake/quarantine.ts). */
export interface QuarantinedFile { file: string; reason: QuarantineReason; at: string }
