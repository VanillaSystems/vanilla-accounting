/**
 * Parity of the per-bank statement PDF readers and the model's read (#243), per statement: what each
 * puts onto the books. The readers give the month-end closing balance (statement-pdf) and the
 * transfer references a Wise camt.053 drops (wise-pdf); the read gives both through factsOfRead,
 * and the original amount in another currency, compared with what the books know already
 * (camt InstdAmt or the description, originalOf).
 */
import { heldLines } from '../../src/books/bank-import.js';
import { factsOfRead } from '../../src/books/statement-read-facts.js';
import { originalOf } from '../../src/intake/pairing.js';
import type { BankTransaction, StatementClosingBalance } from '../../src/types/index.js';
import type { ReadStatement } from '../../src/types/statement-read.js';

export interface Tally { equal: number; differ: number; readerOnly: number; modelOnly: number }

export interface FileParity {
  file: string;
  account?: string;
  balance: 'equal' | 'differ' | 'readerOnly' | 'modelOnly' | 'none';
  references: Tally;
  /** Original amounts: `readerOnly` counts what the books know and the read misses. */
  originals: Tally;
  readLines: number;
  unmatchedLines: number;
  /** Payment keys and fields that differ, for the private report only. */
  differences: string[];
}

/** The bank's own transaction id the Wise reader keys by, else the ref before the uniqueness suffix. */
const paymentKey = (t: Pick<BankTransaction, 'ref' | 'bankTxId'>): string => t.bankTxId ?? t.ref.split('~')[0];
const empty = (): Tally => ({ equal: 0, differ: 0, readerOnly: 0, modelOnly: 0 });
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const cents = (n: number) => Math.round(n * 100);

function tallyMaps<T>(reader: Map<string, T>, model: Map<string, T>, same: (a: T, b: T) => boolean, label: string, differences: string[]): Tally {
  const t = empty();
  for (const [key, a] of reader) {
    const b = model.get(key);
    if (b === undefined) { t.readerOnly++; differences.push(`${label} missing ${key}`); }
    else if (same(a, b)) t.equal++;
    else { t.differ++; differences.push(`${label} differs ${key}`); }
  }
  for (const key of model.keys()) if (!reader.has(key)) { t.modelOnly++; differences.push(`${label} extra ${key}`); }
  return t;
}

export interface ReaderSide {
  balance?: StatementClosingBalance;
  /** Bank transaction id → reference, as the Wise reader gives it for this file. */
  references: Map<string, string>;
}

export interface ModelSide { statement: ReadStatement; account: { account: string; bank: string; currency: string } }

/**
 * One statement: `exported` is every payment the bank exports hold (the books' bank side). A
 * reader's reference counts where the books take it, on an exported payment without one.
 */
export function fileParity(file: string, reader: ReaderSide, model: ModelSide | undefined, exported: readonly BankTransaction[]): FileParity {
  const differences: string[] = [];
  const lacking = new Set(exported.filter((t) => !t.reference).map(paymentKey));
  const readerRefs = new Map([...reader.references].filter(([key]) => lacking.has(key)).map(([k, v]) => [k, norm(v)]));
  if (!model) {
    return {
      file, account: reader.balance?.account, balance: reader.balance ? 'readerOnly' : 'none',
      references: { ...empty(), readerOnly: readerRefs.size }, originals: empty(), readLines: 0, unmatchedLines: 0, differences: ['no model read'],
    };
  }
  const { statement, account } = model;
  const facts = factsOfRead(statement, account, exported);
  const byRef = new Map(exported.map((t) => [t.ref, paymentKey(t)]));
  const modelRefs = new Map([...facts.references].map(([ref, v]) => [byRef.get(ref) ?? ref, norm(v)]));
  const references = tallyMaps(readerRefs, modelRefs, (a, b) => a === b, 'reference', differences);

  const mine = exported.filter((t) => t.bank === account.bank && t.currency === account.currency);
  const known = new Map<string, { amount: number; currency: string }>();
  const read = new Map<string, { amount: number; currency: string }>();
  for (const [i, t] of heldLines(statement.movements, mine, account)) {
    const k = originalOf(t);
    if (k && k.currency !== account.currency) known.set(paymentKey(t), k);
    const r = statement.movements[i].original;
    if (r && r.currency !== account.currency) read.set(paymentKey(t), r);
  }
  const originals = tallyMaps(known, read, (a, b) => a.currency === b.currency && cents(a.amount) === cents(b.amount), 'original', differences);

  const b = reader.balance;
  const modelBalance = { account: account.account, ...statement.closing };
  let balance: FileParity['balance'];
  if (!b) balance = 'modelOnly';
  else if (b.account === modelBalance.account && b.date === modelBalance.date && cents(b.amount) === cents(modelBalance.amount)) balance = 'equal';
  else { balance = 'differ'; differences.push(`balance ${b.account} ${b.date} vs ${modelBalance.account} ${modelBalance.date}${cents(b.amount) === cents(modelBalance.amount) ? '' : ' amount'}`); }

  return { file, account: account.account, balance, references, originals, readLines: statement.movements.length, unmatchedLines: facts.unmatched, differences };
}

export interface Summary { files: number; read: number; balance: Record<FileParity['balance'], number>; references: Tally; originals: Tally; readLines: number; unmatchedLines: number }

export function summarize(results: readonly FileParity[]): Summary {
  const add = (a: Tally, b: Tally): Tally => ({ equal: a.equal + b.equal, differ: a.differ + b.differ, readerOnly: a.readerOnly + b.readerOnly, modelOnly: a.modelOnly + b.modelOnly });
  const balance = { equal: 0, differ: 0, readerOnly: 0, modelOnly: 0, none: 0 };
  for (const r of results) balance[r.balance]++;
  return {
    files: results.length,
    read: results.filter((r) => !r.differences.includes('no model read')).length,
    balance,
    references: results.reduce((a, r) => add(a, r.references), empty()),
    originals: results.reduce((a, r) => add(a, r.originals), empty()),
    readLines: results.reduce((a, r) => a + r.readLines, 0),
    unmatchedLines: results.reduce((a, r) => a + r.unmatchedLines, 0),
  };
}
