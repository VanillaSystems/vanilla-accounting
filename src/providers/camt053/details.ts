/**
 * What a camt.053 says about itself, for the drop row that asks for its account (#208): read by
 * the same parser that reads it into the books, before it is tied to any ledger account.
 */
import type { StatementDetails, StatementMovement } from '../../types/drop.js';
import { readCamt, transactionsOf } from './camt053.js';
import { parseStatementBalances } from './statement-balances.js';

/** The file's details, undefined when it is no camt.053 with a statement. Several statements in one file are summed up. */
export function camtDetails(xml: string, filename: string, preview: number): StatementDetails | undefined {
  let camt: ReturnType<typeof readCamt>;
  try { camt = readCamt(xml); } catch { return undefined; }
  const [first] = camt.statements;
  if (!first) return undefined;
  const pick = <K extends 'bankName' | 'bic' | 'iban' | 'ownerName'>(k: K) => camt.statements.find((s) => s[k])?.[k];
  const moves: StatementMovement[] = camt.statements.flatMap((s) => transactionsOf(s, { bank: '', statements: 'camt053' }).map((t) => ({
    date: t.date,
    amount: t.direction === 'DBIT' ? -Math.abs(t.amount) : Math.abs(t.amount),
    ...(t.counterparty ? { counterparty: t.counterparty } : {}),
    ...(t.description.trim() && t.description.trim() !== t.counterparty ? { text: t.description.trim() } : {}),
  }))).sort((a, b) => a.date.localeCompare(b.date));
  const days = moves.map((m) => m.date).filter(Boolean);
  const balances = camt.statements.flatMap((s) => parseStatementBalances(s, '', filename)).filter((b) => b.date && b.currency === first.currency);
  const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
  const opening = balances.filter((b) => b.type === 'OPBD').sort(byDate)[0];
  const closing = balances.filter((b) => b.type === 'CLBD').sort(byDate).at(-1);
  const periods = camt.statements.flatMap((s) => (s.period ? [s.period] : []));
  const bankName = pick('bankName'), bic = pick('bic'), iban = pick('iban'), owner = pick('ownerName');
  const read = camt.statements.find((s) => s.read)?.read;
  return {
    ...(read ? { read } : {}),
    ...(bankName ? { bankName } : {}),
    ...(bic ? { bic } : {}),
    currency: first.currency,
    ...(iban ? { iban: iban.replace(/\s+/g, '').toUpperCase() } : {}),
    ...(owner ? { owner } : {}),
    ...(periods.length ? { period: { from: periods.map((p) => p.from).sort()[0], to: periods.map((p) => p.to).sort().at(-1)! } } : {}),
    ...(days.length ? { booked: { first: days[0], last: days.at(-1)! } } : {}),
    movements: moves.length,
    ...(opening ? { opening: { date: opening.date, amount: opening.amount } } : {}),
    ...(closing ? { closing: { date: closing.date, amount: closing.amount } } : {}),
    preview: moves.slice(0, preview),
    more: Math.max(0, moves.length - preview),
  };
}
