/**
 * The drop dialog's session (docs/0.4.0/intake.md): every file dropped while it is open, as a row
 * with what it was recognized as and what will happen to it. Nothing is written into the books or
 * the inbox until «Hinzufügen». Passwords are never part of it.
 */

/** What a file is. Unset while nobody knows (the row asks). */
export type DropKind = 'receipt' | 'photo' | 'camt' | 'statement-pdf' | 'zip';

/** How it was recognized: by its structure (bytes, a namespace), or by a hint (a word, the name). */
export type DropHow = 'structure' | 'hint';

/**
 * What happens on «Hinzufügen»: taken (into the inbox, or read as a bank statement), not taken as
 * a duplicate, quarantined (not a receipt), refused (not stored at all), waiting for a password,
 * or waiting for the person to say what it is.
 */
export type DropState = 'take' | 'duplicate' | 'quarantine' | 'refused' | 'locked' | 'unclear';

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
}

export interface StatementFacts { iban?: string; from?: string; to?: string; entries?: number }

export type DropReason =
  | 'duplicate' | 'not-receipt' | 'held' | 'pdf-password'
  | 'as-zip' | 'as-pdf' | 'not-statement' | 'damaged' | 'too-deep' | 'too-big' | 'wrong-password';

export interface DropSession {
  id: string;
  rows: DropRow[];
  /** After «Hinzufügen»: how many went in, the run that takes them up, and what a statement import refused. */
  done?: { taken: number; run?: string; refused: Array<{ name: string; message: string }> };
}

export type DropAction =
  | { kind: 'take' }
  | { kind: 'remove' }
  | { kind: 'as'; as: 'receipt' | 'quarantine' }
  /** The password of a protected ZIP: used to unpack it, never stored. */
  | { kind: 'unlock'; password: string };
