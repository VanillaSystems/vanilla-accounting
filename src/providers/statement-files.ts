/**
 * The bank statement file formats a dropped file is tried against (docs/0.4.0/intake.md), one
 * recognizer per provider: the drop dialog asks them by meaning and never names a format.
 */
import { recognizeCamt } from './camt053/recognize.js';
import type { StatementFacts } from '../types/drop.js';

export type StatementFile = (bytes: Buffer) => { facts: StatementFacts } | undefined;

export const STATEMENT_FILES: readonly StatementFile[] = [recognizeCamt];
