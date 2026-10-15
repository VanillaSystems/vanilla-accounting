/**
 * The drop dialog's session (docs/0.4.0/intake.md): every file dropped while it is open, as a row
 * with what it was recognized as and what became of it. A file that can be taken is taken at once
 * (a receipt into the inbox, a statement read into the books) and handed to the inbox's run; a file
 * with an open question waits for its answer. «Rückgängig» takes a file back out. Passwords are
 * never part of it.
 */

import type { UnknownAccount } from './api-error.js';
import type { OtherWhy, SupportingWhy } from '../core/modules/schema.js';
import type { TwinWhy } from './index.js';

/** What a file is. Unset while nobody knows (the row asks). */
export type DropKind = 'receipt' | 'photo' | 'camt' | 'statement-pdf' | 'zip';

/** How it was recognized: by its structure (bytes, a namespace), or by a hint (a word, the name). */
export type DropHow = 'structure' | 'hint';

/**
 * Where a file stands: to be taken (a moment, while it is written), taken (into the inbox, or read
 * as a bank statement), taken back («Rückgängig»), not taken as a duplicate, quarantined (not a
 * receipt), refused (not stored at all), waiting for a password, or waiting for the person to say
 * what it is.
 */
export type DropState = 'take' | 'taken' | 'undone' | 'duplicate' | 'quarantine' | 'refused' | 'locked' | 'unclear';

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
  /** Taken: the run that takes it up. */
  run?: string;
  /** A receipt: the name it got in the inbox. */
  inbox?: string;
  /** Not a receipt: the name it got in data/quarantine/. */
  quarantined?: string;
  /** A statement: its file under bank-statements/ and the payments it added. */
  statement?: { file: string; refs: string[] };
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

/** `duplicate`: the same bytes; `possible-duplicate`: the same facts, asked; `same`: the person said it is the same; `not-receipt`: its words say so (`document` says what it is). */
export type DropReason =
  | 'duplicate' | 'possible-duplicate' | 'same' | 'not-receipt' | 'held' | 'pdf-password'
  | 'as-zip' | 'as-pdf' | 'bank-csv' | 'office' | 'not-statement' | 'damaged' | 'too-deep' | 'too-big' | 'wrong-password' | 'not-imported'
  /** A statement of an account the owner said is private: set aside, not read into the books. */
  | 'private';

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
  /** A possible duplicate: «ist dasselbe» (not taken) or «verschieden» (taken, and the pair is not asked again). */
  | { kind: 'twin'; answer: 'same' | 'distinct' };
