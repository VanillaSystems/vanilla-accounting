/**
 * The bank side of the books, read from bank-statements/: the transactions of every camt.053
 * (a bank's export, or one the app wrote from a statement read without camt.053, #217) and the
 * monthly statement PDFs. `npm run extract` and the statement upload (POST /api/statements) both
 * read the folder through here and merge with mergeIndex, so a statement imported from the UI lands
 * exactly as extract would put it.
 */
import { legOf, madeByHand } from '../workspace/money-accounts.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assignUniqueRefs, statementSpan, transactionsOf } from '../providers/camt053/camt053.js';
import { statementPdf } from './statement-facts.js';
import type { BankStatement, BankTransaction, Index, Mapping, Receipt, StatementClosingBalance } from '../types/index.js';
import { readBankStatements, type StatementFile } from '../workspace/bank-statements.js';
import { partDirs, type Workspace } from '../workspace/workspace.js';
import { booksOpen, periodLock } from './store.js';

type Ws = Pick<Workspace, 'paths' | 'bankAccounts'>;

// ─── Transactions from camt053 XML ──────────────────────────────────────────

export interface BankFiles {
  transactions: BankTransaction[];
  /** Every file under bank-statements/ and what became of it. */
  files: StatementFile[];
}

/** The transactions of every camt.053 a bank account takes; the files that belong to none are in `files` as unmatched. */
export function readTransactions(ws: Ws): BankFiles {
  const files = readBankStatements(ws);
  return { files, transactions: transactionsOfFiles(files) };
}

/**
 * What a bank booked once is one transaction, however many exports hold it: the next export
 * begins where the last ended, a year-to-date export repeats every month. A payment read from an
 * earlier file (same account, bank reference, date, direction, amount and currency) is not read
 * again from a later one, so it keeps its ref and its bookings; a reference or counterparty only
 * the later file names fills the gap (Wise's PDF names a transfer's reference its camt.053 drops).
 * Within one file nothing is dropped: two entries of one export are two bookings.
 *
 * A statement the app wrote from a PDF, scan, table or CSV (#217) has no bank reference: its
 * movement is the bank export's payment of the same account, day, direction and amount, one for
 * one. Written after the export was in the books it carries the export's ref (camt-writer.ts); read
 * before, its ref stays the payment's, so the bookings on it keep their payment.
 */
export function transactionsOfFiles(files: StatementFile[]): BankTransaction[] {
  return canonical(files).out;
}

/** The transactions of the files, and for each file the transactions its movements are (another file's when it repeats one). */
function canonical(files: StatementFile[]): { out: BankTransaction[]; perFile: Map<string, BankTransaction[]> } {
  const read = files.filter((f): f is Read => f.status === 'read');
  const out: BankTransaction[] = [];
  const perFile = new Map<string, BankTransaction[]>();
  const byIdentity = new Map<string, { t: BankTransaction; file: string }>();
  const exported = new Map<string, BankTransaction[]>();
  for (const f of [...read.filter((r) => !r.statement.read), ...read.filter((r) => r.statement.read)]) {
    const mine = perFile.get(f.file) ?? perFile.set(f.file, []).get(f.file)!;
    for (const t of transactionsOf(f.statement, f.account)) {
      const first = byIdentity.get(identity(t));
      const twin = first && first.file !== f.file ? first.t : f.statement.read ? exported.get(sameMovement(t))?.shift() : undefined;
      if (twin) {
        if (!first || first.file === f.file) {
          // The export's payment that a read statement had first: its ref is the one the books hold.
          if (f.account.statements === 'wise' && !twin.bankTxId) twin.bankTxId = twin.ref;
          twin.ref = t.ref;
        }
        if (!twin.reference && t.reference) twin.reference = t.reference;
        if (!twin.counterparty && t.counterparty) twin.counterparty = t.counterparty;
        mine.push(twin);
        continue;
      }
      byIdentity.set(identity(t), { t, file: f.file });
      if (!f.statement.read) (exported.get(sameMovement(t)) ?? exported.set(sameMovement(t), []).get(sameMovement(t))!).push(t);
      out.push(t);
      mine.push(t);
    }
  }
  return { out, perFile };
}

/** What makes a bank's booking the same transaction in every export that holds it. */
const identity = (t: BankTransaction) => [t.bank, t.ref, t.date, t.direction, t.amount.toFixed(2), t.currency].join('\u0000');

/** The same movement of one account, whatever ref each file gives it: day, direction, amount. */
const sameMovement = (t: Pick<BankTransaction, 'bank' | 'currency' | 'date' | 'direction' | 'amount'>) =>
  [t.bank, t.currency, t.date, t.direction, Math.abs(t.amount).toFixed(2)].join('\u0000');

/**
 * The lines of a statement read without camt.053 (#217) that are payments the books hold already
 * (`held`: the account's transactions), each held one taken once: line index → that transaction.
 * A movement made by hand is no such payment: a statement row confirms it on import (#88).
 */
export function heldLines(lines: readonly { date: string; amount: number }[], held: readonly BankTransaction[], account: { bank: string; currency: string }): Map<number, BankTransaction> {
  const pool = new Map<string, BankTransaction[]>();
  for (const t of held) if (!madeByHand(t)) (pool.get(sameMovement(t)) ?? pool.set(sameMovement(t), []).get(sameMovement(t))!).push(t);
  const out = new Map<number, BankTransaction>();
  for (const [i, l] of lines.entries()) {
    const t = pool.get(sameMovement({ ...account, date: l.date, direction: l.amount < 0 ? 'DBIT' : 'CRDT', amount: l.amount }))?.shift();
    if (t) out.set(i, t);
  }
  return out;
}

/**
 * The payments each file holds, named by the refs the books carry (the first file's ref, made
 * unique as the books make it): what a statement lists (r10c-2). A payment the books have from
 * another file is named in both files' lists.
 */
export function refsByFile(files: StatementFile[]): Map<string, string[]> {
  const { out, perFile } = canonical(files);
  assignUniqueRefs(out);
  return new Map([...perFile].map(([file, ts]) => [file, [...new Set(ts.map((t) => t.ref))]]));
}

/** The refs the statement files other than `except` give, as the books hold them: what an undone statement must leave in place. */
export function refsHeldWithout(ws: Ws, except: string, config: Index['config']): Set<string> {
  const others = readBankStatements(ws).filter((f) => f.file !== except);
  return new Set(assignUniqueRefs(withinBooks(transactionsOfFiles(others), config).kept).map((t) => t.ref));
}

/**
 * The books open on 1 January of the first year with opening balances. A bank export often
 * starts a few days earlier; those rows belong to the prior year's books, whose result the
 * opening balances already carry. Books without opening balances keep every row.
 */
export function withinBooks(transactions: BankTransaction[], config: Index['config']): { kept: BankTransaction[]; before?: string } {
  const opens = booksOpen({ config });
  if (!opens) return { kept: transactions };
  return { kept: transactions.filter((t) => t.date >= opens), before: opens };
}

// ─── Bank statements from PDF filenames (src/books/statement-facts.ts statementPdf) ────────

type Read = Extract<StatementFile, { status: 'read' }>;

export interface StatementFiles {
  statements: BankStatement[];
  /** The balances each camt.053 states (OPBD, CLBD), as the account's balance at the end of a day. */
  balances: StatementClosingBalance[];
}

/**
 * Every statement in each bank's folder of each year: the monthly PDFs named the way Raiffeisen
 * or Wise name them, and each camt.053, which covers the days from its opening to its closing
 * balance. A camt holding statements of several accounts is no one statement and is left out. A
 * PDF beside the camt.053 the app wrote from it (the same name, #217) is that statement, listed once.
 */
export function readStatementFiles(ws: Ws): StatementFiles {
  const statements: BankStatement[] = [];
  for (const bank of new Set(ws.bankAccounts.filter((a) => a.statements).map((a) => a.bank))) {
    for (const dir of partDirs(ws.paths, 'statements').map((d) => join(d, bank)).filter((d) => existsSync(d))) for (const file of readdirSync(dir).filter((f) => f.endsWith('.pdf') && !existsSync(join(dir, f.replace(/\.pdf$/, '.xml'))))) {
      const parsed = statementPdf(file);
      if (parsed) statements.push({ bank, filename: file, ...parsed });
    }
  }
  const balances: StatementClosingBalance[] = [];
  const files = readBankStatements(ws);
  const refs = refsByFile(files);
  const byFile = new Map<string, Read[]>();
  for (const f of files) if (f.status === 'read') (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f);
  for (const [file, reads] of byFile) {
    const { account } = reads[0];
    const [folder, filename, ...deeper] = file.split('/');
    if (folder !== account.bank || !filename || deeper.length || reads.some((r) => r.account.account !== account.account)) continue;
    const span = statementSpan(reads.map((r) => r.statement), account, filename);
    if (!span) continue;
    statements.push({ bank: account.bank, filename, fromDate: span.from, toDate: span.to, currency: account.currency, refs: refs.get(file) ?? [] });
    balances.push(...span.balances);
  }
  return { statements: statements.sort((a, b) => a.fromDate.localeCompare(b.fromDate)), balances };
}

/** The balances read from the camt.053 files now, beside the others (a PDF's): the PDF's balance of a day wins. */
export function withCamtBalances(others: StatementClosingBalance[] = [], camt: StatementClosingBalance[]): StatementClosingBalance[] | undefined {
  const kept = others.filter((b) => b.source !== 'camt');
  const day = (b: StatementClosingBalance) => `${b.account} ${b.date}`;
  const given = new Set(kept.map(day));
  const out = [...kept, ...camt.filter((b) => !given.has(day(b)))].sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account));
  return out.length || others.length ? out : undefined;
}

// ─── Merge: previous index + what is on disk now → new index ──────────────────

export interface Scan {
  /** Every receipt file on disk, already extracted. */
  receipts: Receipt[];
  /** Transactions parsed from the camt053 files, refs already unique. */
  bankTransactions: BankTransaction[];
  bankStatements: BankStatement[];
  /** The balances the camt.053 files state (readStatementFiles). */
  camtBalances: StatementClosingBalance[];
}

/**
 * Where each transaction field comes from. A rebuild takes the 'bank' fields from the camt053
 * files and keeps every other field from the previous index: a remark, "no receipt needed",
 * whatever a later step adds. A reference once read stays when the files name none now (Wise's
 * camt.053 drops a transfer's reference that a statement read from its PDF gave). A new
 * BankTransaction field does not compile until it is listed here.
 */
const TRANSACTION_FIELD_SOURCE = {
  ref: 'bank', bank: 'bank', date: 'bank', amount: 'bank', currency: 'bank', direction: 'bank',
  description: 'bank', type: 'bank', parts: 'bank', reference: 'bank', counterparty: 'bank', counterpartyIban: 'bank', bankTxId: 'bank', original: 'bank',
  source: 'kept', statement: 'kept', businessPart: 'kept', replaced: 'kept', remarks: 'kept', noReceiptNeeded: 'kept', waitsForPerson: 'kept', waitsForReceipt: 'kept', inputTaxProof: 'kept',
} as const satisfies Record<keyof BankTransaction, 'bank' | 'kept'>;

function keptFields(t: BankTransaction): Partial<BankTransaction> {
  return Object.fromEntries(
    Object.entries(t).filter(([k]) => TRANSACTION_FIELD_SOURCE[k as keyof BankTransaction] !== 'bank'),
  );
}


/** How many days a statement row may lie from the day of a movement made by hand: a receipt's day and the bank's booking day. */
export const MATCH_DAYS = 7;

const dayGap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const words = (t: Pick<BankTransaction, 'description' | 'counterparty'>) =>
  new Set(`${t.description} ${t.counterparty ?? ''}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
const shares = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));

/**
 * The statement rows that confirm movements made by hand (#88): a payment typed in, made from a
 * receipt or an answer before its statement was imported. A row confirms a movement on the same
 * account (label and currency) in the same direction for the same amount within MATCH_DAYS days;
 * when both name a counterparty, the names share a word. Each row confirms one movement and each
 * movement takes one row: the closest day first, then the pair whose texts share a word. Only open
 * movements without a row yet take part: a filed record keeps every byte. Returns movement ref →
 * the row's ref; the rows it names are no new movements.
 */
export function matchStatementRows(rows: readonly BankTransaction[], books: readonly BankTransaction[], isClosed: (date: string) => boolean): Map<string, string> {
  const open = books.filter((t) => madeByHand(t) && t.statement === undefined && t.amount !== 0 && !isClosed(t.date));
  const pairs: { row: BankTransaction; hand: BankTransaction; gap: number; alike: boolean }[] = [];
  for (const row of rows) {
    if (row.amount === 0 || isClosed(row.date)) continue;
    for (const hand of open) {
      if (hand.bank !== row.bank || hand.currency !== row.currency || hand.direction !== row.direction) continue;
      if (Math.round(Math.abs(hand.amount) * 100) !== Math.round(Math.abs(row.amount) * 100)) continue;
      const gap = dayGap(hand.date, row.date);
      if (gap > MATCH_DAYS) continue;
      if (hand.counterparty && row.counterparty && !shares(words({ description: '', counterparty: hand.counterparty }), words({ description: '', counterparty: row.counterparty }))) continue;
      pairs.push({ row, hand, gap, alike: shares(words(hand), words(row)) });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || Number(b.alike) - Number(a.alike) || a.row.date.localeCompare(b.row.date) || a.row.ref.localeCompare(b.row.ref) || a.hand.ref.localeCompare(b.hand.ref));
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const { row, hand } of pairs) {
    if (out.has(hand.ref) || taken.has(legOf(row))) continue;
    out.set(hand.ref, row.ref);
    taken.add(legOf(row));
  }
  return out;
}

export interface Merged {
  index: Index;
  /** Links in a filed quarter whose receipt file is gone. Kept: a person must re-link them. */
  brokenClosedLinks: Mapping[];
  /** Filed-quarter bank transactions no camt053 file contains any more. Kept as they were. */
  vanishedClosedTransactions: BankTransaction[];
}

export function mergeIndex(previous: Index, scan: Scan): Merged {
  // Golden rule 1: whatever is dated in a filed quarter stays exactly as filed.
  const lock = periodLock(previous);
  const isClosed = (t: BankTransaction | undefined) => lock.isClosed(t?.date);

  const previousByLeg = new Map(previous.transactions.map((t) => [legOf(t), t]));
  const freshLegs = new Set(scan.bankTransactions.map(legOf));
  // A row a movement made by hand took already is that movement (#88); a new row may confirm one now.
  const claimedLeg = (t: BankTransaction) => (t.statement === undefined ? undefined : `${t.statement} ${t.currency}`);
  const claimed = new Set(previous.transactions.map(claimedLeg).filter((l): l is string => l !== undefined));
  const unclaimed = scan.bankTransactions.filter((t) => !claimed.has(legOf(t)));
  const confirmed = matchStatementRows(unclaimed.filter((t) => !previousByLeg.has(legOf(t))), previous.transactions, lock.isClosed);
  const confirming = new Set([...confirmed.values()]);
  const confirmingLegs = new Set(unclaimed.filter((t) => confirming.has(t.ref)).map(legOf));
  // A filed transaction is what the books hold, whatever the camt053 says now: the counterparty,
  // reference and parts it was filed with stay, and a later export's wording changes nothing.
  const fromBank = unclaimed.filter((t) => !confirmingLegs.has(legOf(t))).map((t) => {
    const before = previousByLeg.get(legOf(t));
    if (!before) return t;
    return isClosed(before) ? before : { ...t, ...keptFields(before), ...(!t.reference && before.reference ? { reference: before.reference } : {}) };
  });
  const vanishedClosedTransactions = previous.transactions.filter(
    (t) => !madeByHand(t) && !freshLegs.has(legOf(t)) && isClosed(t),
  );
  // A movement made by hand keeps its row while a statement holds it, takes a row that confirms it now, and loses one no file holds any more.
  const manual = previous.transactions.filter(madeByHand).map((t): BankTransaction => {
    if (isClosed(t)) return t;
    const row = confirmed.get(t.ref);
    if (row !== undefined) return { ...t, statement: row };
    const leg = claimedLeg(t);
    if (leg === undefined || freshLegs.has(leg)) return t;
    const { statement: _, ...rest } = t;
    return rest;
  });

  const transactions = [...fromBank, ...vanishedClosedTransactions, ...manual];

  const receiptIds = new Set(scan.receipts.map((r) => r.id));
  const byRef = new Map(transactions.map((t) => [t.ref, t]));
  const brokenClosedLinks: Mapping[] = [];
  const mappings = previous.mappings.filter((m) => {
    if (m.transactionRef === undefined) return false;
    if (receiptIds.has(m.receiptId)) return true;
    if (!isClosed(byRef.get(m.transactionRef))) return false;
    brokenClosedLinks.push(m);
    return true;
  });

  return {
    index: withBalances({ ...previous, receipts: scan.receipts, transactions, bankStatements: scan.bankStatements, mappings }, withCamtBalances(previous.statementBalances, scan.camtBalances)),
    brokenClosedLinks,
    vanishedClosedTransactions,
  };
}

function withBalances(index: Index, balances: StatementClosingBalance[] | undefined): Index {
  if (balances) return { ...index, statementBalances: balances };
  const { statementBalances: _, ...rest } = index;
  return rest;
}
