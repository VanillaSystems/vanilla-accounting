/**
 * What a statement PDF kept beside a bank export adds to the books once the model has read it
 * (#243): a bank's camt.053 may drop the payment reference or the amount in the currency a card
 * charge was made in, which its monthly statement prints, and the statement's closing balance
 * closes a month the export does not. Each read line is the export's payment of the same day,
 * direction and amount (heldLines), one for one; a line no payment matches adds nothing. The
 * read is kept beside the PDF (src/intake/statement-read.ts keptReads), so a rebuild of the books
 * asks no model.
 */
import { heldLines } from './bank-import.js';
import { checkStatement } from './statement-check.js';
import type { BankTransaction, StatementClosingBalance } from '../types/index.js';
import type { ReadStatement } from '../types/statement-read.js';

/** A statement PDF's read, kept beside it, with the account it lies at. */
export interface KeptRead {
  /** The PDF's name in its bank's folder. */
  file: string;
  account: { account: string; bank: string; currency: string };
  statement: ReadStatement;
}

export interface ReadFacts {
  /** Payment ref → the reference its statement line prints, for payments the export holds without one. */
  references: Map<string, string>;
  /** Payment ref → the amount in the other currency its line prints, for payments the export holds without one. */
  originals: Map<string, { amount: number; currency: string }>;
  /** Read lines no payment of the export matches. */
  unmatched: number;
}

export function factsOfRead(s: ReadStatement, account: { bank: string; currency: string }, exported: readonly BankTransaction[]): ReadFacts {
  const held = heldLines(s.movements, exported.filter((t) => t.bank === account.bank && t.currency === account.currency), account);
  const references = new Map<string, string>();
  const originals = new Map<string, { amount: number; currency: string }>();
  for (const [i, t] of held) {
    const line = s.movements[i];
    const reference = line.reference?.trim();
    if (reference && !t.reference) references.set(t.ref, reference);
    if (line.original && line.original.currency !== account.currency && !t.original) originals.set(t.ref, line.original);
  }
  return { references, originals, unmatched: s.movements.length - held.size };
}

/** The closing balance of a kept read that adds up (opening and movements make it, to the cent): a misread one closes no month. */
export function closingOfRead(r: KeptRead): StatementClosingBalance | undefined {
  if (!checkStatement(r.statement).ok) return undefined;
  const { account, bank, currency } = r.account;
  return { account, bank, currency, date: r.statement.closing.date, amount: r.statement.closing.amount, source: 'pdf', sourceFile: r.file };
}
