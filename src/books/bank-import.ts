/**
 * The bank side of the books, read from bank-statements/: the transactions of every camt.053
 * (a bank's export, or one the app wrote from a statement read without camt.053, #217), the monthly
 * statement PDFs, and what their tables add to the exports' payments (#243, src/books/pdf-reads.ts). `npm run extract` and the
 * statement upload (POST /api/statements) both read the folder through here and merge with
 * mergeIndex, so a statement imported from the UI lands exactly as extract would put it.
 */
import { accountOf, legOf, madeByHand } from '../workspace/money-accounts.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assignUniqueRefs, bankCodedFees, statementSpan, transactionsOf, type CamtStatement } from '../providers/camt053/camt053.js';
import { statementPdf } from './statement-facts.js';
import { confirmsYearEnd, keptReads, withReadBalances, withReadFacts, type KeptRead } from './pdf-reads.js';
import type { BankStatement, BankTransaction, Index, JournalEntry, Mapping, Receipt, StatementClosingBalance } from '../types/index.js';
import { readBankStatements, type StatementFile } from '../workspace/bank-statements.js';
import { partDirs, type Workspace } from '../workspace/workspace.js';
import { booksOpen, periodLock } from './store.js';
import { MATCH_DAYS, dayGap, fit, pairUp } from './twins.js';
import { openReconciliations, type StatementSides } from './reconcile.js';

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
 * a statement read without camt.053 names fills the export's gap. Within one file nothing is
 * dropped: two entries of one export are two bookings.
 *
 * A statement the app wrote from a PDF, scan, table or CSV (#217) has no bank reference: its
 * movement is the bank export's payment of the same account, day, direction and amount, one for
 * one. Written after the export was in the books it carries the export's ref (camt-writer.ts); read
 * before, its ref stays the payment's, so the bookings on it keep their payment.
 */
/**
 * Whether a payment is a fee row the bank itself coded as its charge for the account or for payments
 * (bankCodedFees), read again from the bank's own exports in bank-statements/: the books keep no bank
 * code (#359). A statement the app wrote from a PDF, a photo or a CSV carries no such code: none of
 * its rows is one. A ref that assignUniqueRefs suffixed is matched by the bank's ref and the movement.
 */
export function bankCodedFee(ws: Ws): (tx: Pick<BankTransaction, 'bank' | 'ref' | 'date' | 'direction' | 'amount' | 'currency'>) => boolean {
  const key = (t: Pick<BankTransaction, 'bank' | 'ref' | 'date' | 'direction' | 'amount' | 'currency'>) => [t.bank, t.ref.split('~')[0], t.date, t.direction, t.amount.toFixed(2), t.currency].join('|');
  const keys = new Set<string>();
  for (const f of readBankStatements(ws)) if (f.status === 'read' && sourceOf(f.statement) === 'export') for (const t of bankCodedFees(f.statement, f.account)) keys.add(key(t));
  return (tx) => keys.has(key(tx));
}

export function transactionsOfFiles(files: StatementFile[]): BankTransaction[] {
  return canonical(files).out;
}

/** The transactions of the files, and for each file the transactions its movements are (another file's when it repeats one). */
function canonical(files: StatementFile[]): { out: BankTransaction[]; perFile: Map<string, BankTransaction[]> } {
  const read = files.filter((f): f is Read => f.status === 'read');
  const out: BankTransaction[] = [];
  const perFile = new Map<string, BankTransaction[]>();
  const byIdentity = new Map<string, { t: BankTransaction; file: string }>();
  // Each structured source's payments no other file had, by movement: a bank's export, then a bank CSV (#254).
  const pools: Record<'export' | 'csv', Map<string, BankTransaction[]>> = { export: new Map(), csv: new Map() };
  // A bank's export first, then a bank CSV, then a statement read from a PDF: the structured source's payment carries its references and IBANs.
  const rank = (r: Read) => ({ export: 0, csv: 1, pdf: 2 })[sourceOf(r.statement)];
  for (const f of [...read].sort((a, b) => rank(a) - rank(b))) {
    const mine = perFile.get(f.file) ?? perFile.set(f.file, []).get(f.file)!;
    const source = sourceOf(f.statement);
    const ts = transactionsOf(f.statement, f.account);
    const firsts = ts.map((t) => byIdentity.get(identity(t)));
    const elsewhere = (i: number) => !!firsts[i] && firsts[i]!.file !== f.file;
    const twins = new Map<number, BankTransaction>();
    for (const pool of source === 'csv' ? [pools.export] : source === 'pdf' ? [pools.export, pools.csv] : []) {
      const left = [...ts.keys()].filter((i) => !elsewhere(i) && !twins.has(i));
      for (const [k, t] of takeTwins(left.map((i) => ts[i]), pool)) twins.set(left[k], t);
    }
    for (const [i, t] of ts.entries()) {
      const twin = elsewhere(i) ? firsts[i]!.t : twins.get(i);
      if (twin) {
        if (!elsewhere(i)) {
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
      if (source !== 'pdf') (pools[source].get(sameMovement(t)) ?? pools[source].set(sameMovement(t), []).get(sameMovement(t))!).push(t);
      out.push(t);
      mine.push(t);
    }
  }
  return { out, perFile };
}

/**
 * The payments of `pool` that `lines` are, of the same day, direction and amount, each taken once and
 * out of the pool: the counterparty, its IBAN and the text decide between equal amounts (pairUp). A tie
 * stays apart: both movements come into the books, and the account's reconciliation asks the person
 * which is which (src/books/reconcile.ts).
 */
function takeTwins(lines: readonly BankTransaction[], pool: Map<string, BankTransaction[]>): Map<number, BankTransaction> {
  const movements = [...new Set(lines.flatMap((l) => pool.get(sameMovement(l)) ?? []))];
  const out = new Map<number, BankTransaction>();
  for (const [i, j] of pairUp(lines, movements, (l, t) => (sameMovement(l) === sameMovement(t) ? -fit(l, t) : undefined))) out.set(i, movements[j]);
  const taken = new Set(out.values());
  for (const t of taken) {
    const list = pool.get(sameMovement(t))!;
    list.splice(list.indexOf(t), 1);
  }
  return out;
}

/**
 * Where a camt.053's movements come from: the bank's own export, a bank CSV the app wrote as one, or a
 * statement read from a PDF, scan or photo, or typed by hand (#217). The first two are structured
 * sources: an account that has one keeps its statement PDFs without reading them (#254).
 */
export const sourceOf = (s: Pick<CamtStatement, 'read'>): 'export' | 'csv' | 'pdf' => (!s.read ? 'export' : s.read.by === 'csv' ? 'csv' : 'pdf');

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

/**
 * What an undone statement `except` must leave in place: `held`, the refs the other files give, as
 * the books hold them; and `moves`, for a statement read without camt.053 (#217), each payment the
 * books hold under its ref whose movement a bank export holds too (one transaction, transactionsOfFiles):
 * it stays, under the ref the export gives it alone (its ref now → that transaction).
 */
export function heldWithout(ws: Ws, except: string, config: Index['config']): { held: Set<string>; moves: Map<string, BankTransaction> } {
  const files = readBankStatements(ws);
  const rest = canonical(files.filter((f) => f.file !== except));
  const kept = new Set(assignUniqueRefs(withinBooks(rest.out, config).kept));
  const held = new Set([...kept].map((t) => t.ref));
  const moves = new Map<string, BankTransaction>();
  const removed = files.find((f): f is Read => f.file === except && f.status === 'read');
  if (!removed?.statement.read) return { held, moves };
  // The same files with `except`: each other file's movements come in the same order, so the i-th is the same movement under the ref the books hold.
  const all = canonical(files);
  assignUniqueRefs(withinBooks(all.out, config).kept);
  for (const [file, now] of rest.perFile) {
    const before = all.perFile.get(file) ?? [];
    for (const [i, t] of now.entries()) {
      const was = before[i]?.ref;
      if (was !== undefined && was !== t.ref && kept.has(t)) moves.set(was, t);
    }
  }
  return { held, moves };
}

/**
 * What the statement files say of the books' movements for the reconciliation (#254, src/books/reconcile.ts):
 * the refs only statements read from PDFs bring, those only a bank export or CSV brings, those both
 * bring (one movement, the same day and amount: canonical), and the days each structured file covers.
 */
export function statementSides(ws: Ws): StatementSides {
  const files = readBankStatements(ws);
  const pdf = new Set(files.filter((f) => f.status === 'read' && sourceOf(f.statement) === 'pdf').map((f) => f.file));
  const refs = refsByFile(files);
  const fromPdf = new Set([...refs].flatMap(([file, rs]) => (pdf.has(file) ? rs : [])));
  const structured = new Set([...refs].flatMap(([file, rs]) => (pdf.has(file) ? [] : rs)));
  return {
    pdf: new Set([...fromPdf].filter((r) => !structured.has(r))),
    structured: new Set([...structured].filter((r) => !fromPdf.has(r))),
    both: new Set([...fromPdf].filter((r) => structured.has(r))),
    spans: structuredSpans(ws),
  };
}

/**
 * Opens, updates or drops the reconciliations of the books of `ws` from its statement files (#254,
 * src/books/reconcile.ts openReconciliations), inside the change that read them in or took one out.
 * `differenceTo`: the chart's exchange-difference account (src/books/year-close.ts differenceAccountOf).
 */
export function reconcileWithFiles(ws: Ws, books: Pick<Index, 'config' | 'transactions' | 'reconciliations'> & { journalEntries: readonly JournalEntry[] }, differenceTo?: string): void {
  openReconciliations(books, statementSides(ws), (t) => accountOf(t, ws.bankAccounts)?.account, new Date().toISOString().slice(0, 10), periodLock(books).isClosed, differenceTo);
}

/**
 * The rate a foreign entry takes on its day (ADR 0001: the ESTV sell rate of its rate day, given
 * the payments' days as the books hold them now), or undefined. src/server/routes/statements.ts
 * builds it from the rate table.
 */
export type RateOf = (e: JournalEntry, days: ReadonlyMap<string, string>) => number | undefined;

/**
 * An entry of a payment whose day moved from `from` to `to` (#254): dated on `from`, it takes `to`, and
 * a foreign one the rate of that day (`rateOf`). One dated otherwise (a tax point of its own) keeps
 * its day and rate.
 */
export function entryToDay(e: JournalEntry, from: string, to: string, days: ReadonlyMap<string, string>, rateOf: RateOf): void {
  if (e.date !== from) return;
  e.date = to;
  const rate = e.exchangeCurrency ? rateOf(e, days) : undefined;
  if (rate !== undefined) e.exchangeRate = Math.round(rate * 1e6) / 1e6;
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

/** A span of days a structured source covers for one account: a bank's own export, or a bank CSV the app wrote as one (`csv`). */
export interface StructuredSpan { account: string; from: string; to: string; file: string; csv?: true }

/**
 * The days each structured source covers, per account (#254): the camt.053 files a bank gave and those
 * the app wrote from a bank CSV, never one written from a statement read off a PDF (#217). An account
 * with one keeps its statement PDFs as statements without reading them; a PDF's movements on days one
 * covers are its movements (src/intake/statement-read.ts coveredDays).
 */
export function structuredSpans(ws: Ws): StructuredSpan[] {
  const byFile = new Map<string, Read[]>();
  for (const f of readBankStatements(ws)) if (f.status === 'read' && sourceOf(f.statement) !== 'pdf') (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f);
  const out: StructuredSpan[] = [];
  for (const [file, reads] of byFile) {
    for (const number of new Set(reads.map((r) => r.account.account))) {
      const mine = reads.filter((r) => r.account.account === number);
      const span = statementSpan(mine.map((r) => r.statement), mine[0].account, file.split('/').pop() ?? file);
      if (span) out.push({ account: number, from: span.from, to: span.to, file, ...(sourceOf(mine[0].statement) === 'csv' ? { csv: true as const } : {}) });
    }
  }
  return out;
}

/**
 * The balances read from the camt.053 files now, beside the others: a camt.053 (the bank's export, or a
 * statement read in once it added up) states the balance of its day over a kept PDF's table, read by
 * the model or typed by a person (#243). Only a year-end confirmation the person attached (#119)
 * stands against it. A balance dated in a closed period is what the books held when it was filed: it
 * stays, and no file adds or replaces one there.
 */
export function withCamtBalances(others: StatementClosingBalance[] = [], camt: StatementClosingBalance[], isClosed: (date: string) => boolean = () => false): StatementClosingBalance[] | undefined {
  const day = (b: StatementClosingBalance) => `${b.account} ${b.date}`;
  const filed = others.filter((b) => isClosed(b.date));
  const open = others.filter((b) => !isClosed(b.date));
  const confirmed = new Set(open.filter((b) => b.source !== 'camt' && confirmsYearEnd(b)).map(day));
  const fresh = camt.filter((b) => !isClosed(b.date) && !confirmed.has(day(b)));
  const theirs = new Set(fresh.map(day));
  const kept = open.filter((b) => b.source !== 'camt' && !theirs.has(day(b)));
  const out = [...filed, ...kept, ...fresh].sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account));
  return out.length || others.length ? out : undefined;
}

// ─── Merge: previous index + what is on disk now → new index ──────────────────

export interface Scan {
  /** Every receipt file on disk, already extracted. */
  receipts: Receipt[];
  /** Transactions parsed from the camt053 files, refs already unique. */
  bankTransactions: BankTransaction[];
  /** The tables of the kept statement PDFs (src/books/pdf-reads.ts keptReads): references, amounts in another currency and closing balances the exports lack (#243). */
  reads: KeptRead[];
  bankStatements: BankStatement[];
  /** The balances the camt.053 files state (readStatementFiles). */
  camtBalances: StatementClosingBalance[];
}

/**
 * Where each transaction field comes from. A rebuild takes the 'bank' fields from the camt053
 * (and the tables of the kept statement PDFs) and keeps every other field from the previous index: a remark, "no
 * receipt needed", whatever a later step adds. A new BankTransaction field does not compile
 * until it is listed here.
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


export { MATCH_DAYS };

const words = (t: Pick<BankTransaction, 'description' | 'counterparty'>) =>
  new Set(`${t.description} ${t.counterparty ?? ''}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
const shares = (a: Set<string>, b: Set<string>) => [...a].some((w) => b.has(w));

/**
 * The statement rows that confirm movements made by hand (#88): a payment typed in, made from a
 * receipt or an answer before its statement was imported. A row confirms a movement on the same
 * account (label and currency) in the same direction for the same amount within MATCH_DAYS days;
 * when both name a counterparty, the names share a word. Each row confirms one movement and each
 * movement takes one row: the closest day first, then the pair whose texts share a word. Only open
 * movements without a row yet take part: a filed record keeps every byte. Returns movement ref → the
 * row's ref; the rows it names are no new movements.
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

/**
 * What became of the open payments a statement read before #401 left on an empty ref (`repairEmptyRefs`):
 * `repaired` of them took their bank's ref; `left` of them stay as they are, with why: `yours`, a
 * person's entry or link stands on the empty ref and several payments share it, so it cannot be told
 * to one of them; `unmatched`, no one statement file holds exactly their movements.
 */
export type EmptyRefRepair = { repaired: number } | { left: number; why: 'yours' | 'unmatched' };

/**
 * Gives the open payments the books hold on an empty ref (a Wise export read before #401 whose
 * references stand in its transaction details) the refs the folder's files give them now, in place,
 * before the import merges the folder. They have no identity of their own but their movement, so the
 * file is the one statement file whose rows the books lack hold exactly as many movements of each
 * account, day, direction and amount as they are; within a movement they are paired in order, and
 * each pair must agree in its counterparty and text. What stands on the empty ref goes with them: with
 * one such payment, every open entry and link moves to its ref; with several, the app's entries and
 * links on it go (they stood on all of them at once; the next run books and pairs again), and a
 * person's entry or link stops the repair (`yours`). With a filed payment on an empty ref no link on it
 * moves. Run as the person, by the statement import (src/server/routes/statements.ts), never by a module.
 */
export function repairEmptyRefs(ws: Ws, books: Index): EmptyRefRepair {
  const lock = periodLock(books);
  const open = books.transactions.filter((t) => !t.ref.trim() && !madeByHand(t) && !lock.isClosed(t.date));
  if (!open.length) return { repaired: 0 };
  const { out, perFile } = canonical(readBankStatements(ws));
  assignUniqueRefs(out);
  const held = new Set(books.transactions.map(legOf));
  const groups = new Map<string, BankTransaction[]>();
  for (const t of open) (groups.get(sameMovement(t)) ?? groups.set(sameMovement(t), []).get(sameMovement(t))!).push(t);
  const rowsOf = (ts: readonly BankTransaction[], key: string) => ts.filter((t) => t.ref.trim() && !held.has(legOf(t)) && sameMovement(t) === key);
  const files = [...perFile.values()].filter((ts) => [...groups].every(([key, g]) => rowsOf(ts, key).length === g.length));
  if (files.length !== 1) return { left: open.length, why: 'unmatched' };
  const pairs = [...groups].flatMap(([key, g]) => { const rows = rowsOf(files[0], key); return g.map((t, i) => [t, rows[i]] as const); });
  if (pairs.some(([t, r]) => (t.counterparty ?? '') !== (r.counterparty ?? '') || t.description !== r.description)) return { left: open.length, why: 'unmatched' };
  const entries = (books.journalEntries ?? []).filter((e) => !e.transactionRef.trim() && !lock.isClosed(e.date));
  const filedEmpty = books.transactions.some((t) => !t.ref.trim() && lock.isClosed(t.date));
  const links = filedEmpty ? [] : books.mappings.filter((m) => !m.transactionRef.trim());
  if (open.length > 1 && (entries.some((e) => e.origin === 'manual') || links.some((m) => m.by === 'human'))) return { left: open.length, why: 'yours' };
  if (open.length === 1) {
    for (const e of entries) e.transactionRef = pairs[0][1].ref;
    for (const m of links) m.transactionRef = pairs[0][1].ref;
  } else {
    books.journalEntries = (books.journalEntries ?? []).filter((e) => !entries.includes(e));
    books.mappings = books.mappings.filter((m) => !links.includes(m));
  }
  for (const [t, r] of pairs) t.ref = r.ref;
  return { repaired: open.length };
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
  // Payments a statement read before #401 left on an empty ref stay exactly as the books hold them (a
  // filed one as filed); the import repairs the open ones first (repairEmptyRefs). A file's row of the
  // same account, day, direction and amount is such a payment, one for one, and no new one.
  const emptyHeld = previous.transactions.filter((t) => !t.ref.trim() && !madeByHand(t));
  const emptyPool = new Map<string, number>();
  for (const t of emptyHeld) emptyPool.set(sameMovement(t), (emptyPool.get(sameMovement(t)) ?? 0) + 1);
  const asEmpty = (t: BankTransaction) => {
    const n = emptyPool.get(sameMovement(t)) ?? 0;
    if (!n || previousByLeg.has(legOf(t))) return false;
    emptyPool.set(sameMovement(t), n - 1);
    return true;
  };
  const rows = scan.bankTransactions.filter((t) => t.ref.trim() !== '' && !asEmpty(t));
  const freshLegs = new Set(rows.map(legOf));
  // A row a movement made by hand took already is that movement (#88); a new row may confirm one now.
  const claimedLeg = (t: BankTransaction) => (t.statement === undefined ? undefined : `${t.statement} ${t.currency}`);
  const claimed = new Set(previous.transactions.map(claimedLeg).filter((l): l is string => l !== undefined));
  // A movement read from a PDF that a confirmed reconciliation paired with a bank movement is that movement (#254): its row in the read statement brings nothing again; a filed one stays as filed.
  const absorbed = new Set((previous.reconciliations ?? []).flatMap((r) => (r.done ? r.pairs.map((p) => p.read) : [])));
  const unclaimed = rows.filter((t) => !claimed.has(legOf(t)) && !(absorbed.has(t.ref) && !previousByLeg.has(legOf(t))));
  const confirmed = matchStatementRows(unclaimed.filter((t) => !previousByLeg.has(legOf(t))), previous.transactions, lock.isClosed);
  const confirming = new Set([...confirmed.values()]);
  const confirmingLegs = new Set(unclaimed.filter((t) => confirming.has(t.ref)).map(legOf));
  // A filed transaction is what the books hold, whatever the camt053 says now: the counterparty,
  // reference and parts it was filed with stay, and a later export's wording changes nothing.
  const fromBank = unclaimed.filter((t) => !confirmingLegs.has(legOf(t))).map((t) => {
    const before = previousByLeg.get(legOf(t));
    if (!before) return t;
    return isClosed(before) ? before : { ...t, ...keptFields(before) };
  });
  const vanishedClosedTransactions = previous.transactions.filter(
    (t) => !madeByHand(t) && t.ref.trim() !== '' && !freshLegs.has(legOf(t)) && isClosed(t),
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

  // A reference or an amount in another currency the export drops and its statement PDF prints (#243).
  const transactions = withReadFacts([...fromBank, ...vanishedClosedTransactions, ...manual], scan.reads, lock.isClosed).concat(emptyHeld);

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
    index: withBalances({ ...previous, receipts: scan.receipts, transactions, bankStatements: scan.bankStatements, mappings }, withCamtBalances(withReadBalances(previous.statementBalances, scan.reads, lock.isClosed), scan.camtBalances, lock.isClosed)),
    brokenClosedLinks,
    vanishedClosedTransactions,
  };
}

function withBalances(index: Index, balances: StatementClosingBalance[] | undefined): Index {
  if (balances) return { ...index, statementBalances: balances };
  const { statementBalances: _, ...rest } = index;
  return rest;
}

/**
 * The bank side of `books` merged again from the folder, as an import merges it: the payments of
 * every statement file, with what the kept PDFs' tables add, and the closing balances. A payment no
 * file holds any more stays until extract's rebuild decides; the books keep their order, new payments
 * come after them.
 */
export function mergeBankFiles(ws: Ws, books: Index): void {
  const fresh = assignUniqueRefs(withinBooks(readTransactions(ws).transactions, books.config).kept);
  const freshLegs = new Set(fresh.map(legOf));
  const lock = periodLock(books);
  const stay = books.transactions.filter((t) => !madeByHand(t) && !freshLegs.has(legOf(t)) && !lock.isClosed(t.date));
  const files = readStatementFiles(ws);
  const merged = mergeIndex(books, { receipts: books.receipts, bankTransactions: [...fresh, ...stay], reads: keptReads(ws, files.statements, books.statementAsks), bankStatements: files.statements, camtBalances: files.balances });
  const pos = new Map(books.transactions.map((t, i) => [t.ref, i]));
  const known = merged.index.transactions.filter((t) => pos.has(t.ref)).sort((a, b) => pos.get(a.ref)! - pos.get(b.ref)!);
  Object.assign(books, merged.index, { transactions: [...known, ...merged.index.transactions.filter((t) => !pos.has(t.ref))] });
}
