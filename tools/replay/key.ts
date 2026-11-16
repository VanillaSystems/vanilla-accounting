/**
 * The answer key of a replay: what the real books hold for the replayed period, read from the
 * source workspace before the cut, and the comparison's own shapes. Written to <run>/key.json by
 * the cut (cut.ts), read by the oracle (oracle.ts) and the comparison (compare.ts). It holds the
 * company's books: it stays in the run folder, outside every repository.
 */
import type { BankTransaction, JournalEntry, VatAdjustment } from '../../src/types/index.js';

/** One booking line as the comparison sees it (compare.ts lineOf). */
export interface Line {
  date: string;
  debit: string;
  credit: string;
  /** The VAT code, '' for none. */
  vat: string;
  /** In the books' currency, to the cent. */
  amount: number;
}

/** One bank payment of the period: the unit the replay counts. */
export interface KeyCase {
  ref: string;
  tx: BankTransaction;
  /** The real entries of the payment (all of them, a correction of a filed period on it included). */
  entries: JournalEntry[];
  /** The receipts the real books link to it, by id (a receipt's id is the hash of its file, so the replay's drop gives the same id). */
  receipts: string[];
}

/** A movement a person entered by hand (cash, a private outlay): no statement brings it, the oracle enters it. */
export interface KeyManual {
  ref: string;
  tx: BankTransaction;
  entries: JournalEntry[];
  receipts: string[];
}

/** Entries of the period without a payment of their own: a provider report's (by its ref), or a person's by hand. */
export interface KeyOther {
  ref: string;
  entries: JournalEntry[];
  receipts: string[];
  /** `report`: a provider report's ref (SR-…, SF-…), booked by the app from the dropped report; `hand`: a person's own booking. */
  kind: 'report' | 'hand';
}

export interface InputFile {
  /** Where the replay copy keeps it (inputs/…), relative to the run folder. */
  path: string;
  /** The name it is dropped under: the name it arrived with. */
  name: string;
  kind: 'statement' | 'receipt';
  /** For a statement: its bank label (the folder it lay in). */
  bank?: string;
  /** The receipt's id (hash of its bytes). */
  id?: string;
}

export interface AnswerKey {
  /** The replayed filing period, e.g. 2026-Q3. */
  period: string;
  from: string;
  to: string;
  /** The day the books are cut after: the period's eve. */
  cut: string;
  cases: KeyCase[];
  manual: KeyManual[];
  other: KeyOther[];
  /** Entries dated in the period that correct a filed period (`corrects`): out of scope, counted only. */
  correctionsOfFiled: number;
  /** The VAT adjustments the source declares in the period: the oracle enters them. */
  vatAdjustments: VatAdjustment[];
  /** The receipts the period's inputs bring, by id: file name as dropped, and the kind the real books gave it. */
  receipts: Record<string, { name: string; kind?: string }>;
  /** The return's figures the source books give for the period (vat().figures), and whether that return is filed. */
  figures: { ziffern: Record<string, number>; payable: number; filed: boolean };
  inputs: InputFile[];
}
