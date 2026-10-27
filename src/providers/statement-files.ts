/**
 * The bank statement file formats a dropped file is tried against (docs/0.4.0/intake.md), one
 * recognizer per provider: the drop dialog asks them by meaning and never names a format.
 */
import { recognizeCamt } from './camt053/recognize.js';
import { camtDetails } from './camt053/details.js';
import type { StatementDetails, StatementFacts } from '../types/drop.js';

export type StatementFile = (bytes: Buffer) => { facts: StatementFacts } | undefined;

export const STATEMENT_FILES: readonly StatementFile[] = [recognizeCamt];

/** How many movements a row's details show; the rest are counted («… und N weitere»). */
export const STATEMENT_PREVIEW = 5;

/** What a statement file says about itself, for the drop row that asks for its account (#208); undefined for a format that tells nothing. */
export function statementDetails(bytes: Buffer, filename: string): StatementDetails | undefined {
  return recognizeCamt(bytes) ? camtDetails(bytes.toString('utf8'), filename, STATEMENT_PREVIEW) : undefined;
}
