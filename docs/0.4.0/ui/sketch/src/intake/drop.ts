/**
 * The drop dialog's server side (intake.md, screen 8). A drop is a SESSION in data/drop/<id>/,
 * outside git and outside the inbox: "nothing is written while the dialog is open". «Hinzufügen»
 * moves the accepted files into beleg-import/ and emits the outside trigger per file; from then on
 * the rows' progress is the runs' progress (Automation snapshot, item { kind: 'file', id }).
 *
 * Recognition is ADR 0008's cheap-first order and reuses src/intake's detectors: structure
 * (camt.053 namespace, Wise export, known bank PDF), hints (page count, «Preisliste»), then the
 * model only for the rest, and only when the person allows it on a large drop (intake.md "Open").
 */
import type { WorkflowId } from '../workflows/model.js';

export type DropKind = 'receipt' | 'invoice' | 'statement-pdf' | 'camt053' | 'wise-export' | 'attachment' | 'not-receipt';
export type DropTab = 'bankdata' | 'statements' | 'receipts' | 'unclear' | 'skip';

export type DropProblem =
  | { kind: 'duplicate'; of: string; by: 'checksum' | 'facts' }
  | { kind: 'password'; container: 'pdf' | 'zip'; wrong?: boolean }
  | { kind: 'unsure'; choices: [DropKind, DropKind] }
  | { kind: 'not-receipt' }
  | { kind: 'refused'; reason: 'type' | 'damaged' | 'too-large' | 'nested-too-deep'; hint: 'zip' | 'pdf' | null };

export interface DropRow {
  id: string;
  name: string;
  /** "aus belege.zip" */
  from?: string;
  kind?: DropKind;
  how: 'structure' | 'hints' | 'ai';
  facts?: { counterparty?: string; date?: string; amount?: string; account?: string; period?: string; count?: number };
  problem?: DropProblem;
  /** Own photo or scan: made smaller before its id; a received PDF stays byte for byte. */
  shrunk?: { from: number; to: number };
  /** Where it goes on «Hinzufügen»: a workflow (by its outside trigger), or one of the three ends. */
  goes: { to: 'workflow'; workflow: WorkflowId } | { to: 'inbox-task' } | { to: 'quarantine' } | { to: 'refused' };
  tab: DropTab;
}

export type DropCommand =
  | { kind: 'add-files'; files: Array<{ name: string; bytes: Uint8Array }> }
  | { kind: 'password'; row: string; password: string }
  | { kind: 'set'; row: string; name?: string; kind_?: DropKind; take?: boolean }
  | { kind: 'remove'; row: string }
  /** Moves accepted rows into the inbox and emits the outside trigger for each; returns the run ids. */
  | { kind: 'commit' }
  | { kind: 'cancel' };

export interface DropSession {
  id: string;
  rows: DropRow[];
  /** "Startet Beleg aufnehmen 2 · Kontoauszug einlesen 2 · danach …", from model.chainFrom. */
  starts: Array<{ workflow: WorkflowId; n: number }>;
  committed?: { runs: string[] };
}

export function openDrop(/* ws, automation */): {
  create(): DropSession;
  command(id: string, cmd: DropCommand): Promise<DropSession>;
} {
  // TODO zip: unpack in memory up to 3 levels and a total size limit; AES + ZipCrypto (a dependency: fflate has no AES →
  //      @zip.js/zip.js); the password is used and dropped, never stored; 7z/RAR → refused, hint 'zip'
  // TODO pdf password: keep the ORIGINAL bytes; the decrypted copy only for reading (qpdf is not assumed: pdf.js can open with a password)
  throw new Error('not implemented');
}
