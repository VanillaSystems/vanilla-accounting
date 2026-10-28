/**
 * The bank side of the books, read from bank-statements/: the transactions of every camt.053
 * (a bank's export, or one the app wrote from a statement read without camt.053, #217), the monthly
 * statement PDFs, and the Wise transfer references only those PDFs keep. `npm run extract` and the
 * statement upload (POST /api/statements) both read the folder through here and merge with
 * mergeIndex, so a statement imported from the UI lands exactly as extract would put it.
 */
import { legOf, madeByHand } from '../workspace/money-accounts.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assignUniqueRefs, statementSpan, transactionsOf, type CamtStatement } from '../providers/camt053/camt053.js';
import { pdfText } from '../parsers/pdf-text.js';
import { statementPdf } from './statement-facts.js';
import { wiseReferences } from '../providers/wise-pdf/wise-statement-pdf.js';
import type { BankStatement, BankTransaction, Index, JournalEntry, Mapping, Receipt, StatementClosingBalance } from '../types/index.js';
import { readBankStatements, type StatementFile } from '../workspace/bank-statements.js';
import { partDirs, type Workspace } from '../workspace/workspace.js';
import { booksOpen, moduleActor, periodLock, update, type Books } from './store.js';
import { MATCH_DAYS, dayGap, fit, pairUp } from './twins.js';

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
 * left in a read file written before #254 asked about it is taken in file order, as then: the import
 * (alignReads) now keeps every tie out of the read file and asks.
 */
function takeTwins(lines: readonly BankTransaction[], pool: Map<string, BankTransaction[]>): Map<number, BankTransaction> {
  const movements = [...new Set(lines.flatMap((l) => pool.get(sameMovement(l)) ?? []))];
  const out = new Map<number, BankTransaction>();
  for (const [i, j] of pairUp(lines, movements, (l, t) => (sameMovement(l) === sameMovement(t) ? -fit(l, t) : undefined))) out.set(i, movements[j]);
  const taken = new Set(out.values());
  for (const [i, l] of lines.entries()) {
    const t = out.has(i) ? undefined : pool.get(sameMovement(l))?.find((x) => !taken.has(x));
    if (t) { out.set(i, t); taken.add(t); }
  }
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

/** A movement read from a PDF that a structured file covering its day does not hold (#254): where it is, and what it is. */
export interface Unmatched { file: string; bank: string; currency: string; date: string; direction: 'CRDT' | 'DBIT'; amount: number; ref: string }

/** A read movement the structured file holds a few days off: it takes the bank's day `to` (#254). */
export interface Realigned extends Unmatched { to: string }

/** What the books say of a read movement (alignReads): whether they hold it, and whether a person booked it by hand. */
export interface HeldReads { holds: (line: Unmatched) => boolean; byPerson: (line: Unmatched) => boolean }

/**
 * What the structured file `structured` (a bank's camt.053, or one the app wrote from a bank CSV) makes
 * of the movements read from statement PDFs of its account on the days it covers (#254). The read
 * statement is the books' first word on those days; the structured file is the bank's own:
 * - a read movement of the same day, direction and amount is its payment (transactionsOfFiles makes
 *   them one transaction under the read's ref, so bookings and receipt links stay); between equal
 *   amounts the counterparty, its IBAN and the text decide (pairUp), and a tie is asked;
 * - one the structured file holds within MATCH_DAYS days for the same amount (a value date read for
 *   the booking day) takes the structured file's day in its read file (`files`), and then is the same;
 *   `realigned` names it, so the app's entries move with it;
 * - one it does not hold, a tie, or one that would move while a person's entry is on it leaves its read
 *   file (`files`) and is named in `unmatched`: the books keep it as a movement of its own until the
 *   person answers (src/books/twins.ts twinQuestions offers the bank's movements it may be), so it is
 *   neither lost nor counted twice.
 * A movement dated on a day `isClosed` says is filed is never changed, nor one the books do not hold.
 * Pure: `xmlOf` gives a read file's text, and `files` holds each read file's new text.
 */
export function alignReads(statementFiles: readonly StatementFile[], structured: string, isClosed: (date: string) => boolean, xmlOf: (file: string) => string, books: HeldReads = { holds: () => true, byPerson: () => false }): { files: Map<string, string>; unmatched: Unmatched[]; realigned: Realigned[] } {
  const read = statementFiles.filter((f): f is Read => f.status === 'read');
  const own = read.filter((f) => f.file === structured && sourceOf(f.statement) !== 'pdf');
  const files = new Map<string, string>();
  const unmatched: Unmatched[] = [];
  const realigned: Realigned[] = [];
  for (const number of new Set(own.map((f) => f.account.account))) {
    const mine = own.filter((f) => f.account.account === number);
    const account = mine[0].account;
    const span = statementSpan(mine.map((f) => f.statement), account, structured.split('/').pop() ?? structured);
    if (!span) continue;
    const pool = mine.flatMap((f) => transactionsOf(f.statement, account));
    const loose: Array<{ file: string; index: number; line: BankTransaction }> = [];
    const pdfs = read.filter((f) => f.account.account === number && sourceOf(f.statement) === 'pdf');
    // File by file, as transactionsOfFiles pairs them: the same day and amount, beyond doubt.
    for (const file of new Set(pdfs.map((f) => f.file))) {
      const lines = pdfs.filter((f) => f.file === file).flatMap((f) => transactionsOf(f.statement, f.account)).map((line, index) => ({ file, index, line }))
        .filter(({ line }) => line.date >= span.from && line.date <= span.to);
      const exact = pairUp(lines.map((l) => l.line), pool, (l, t) => (sameMovement(l) === sameMovement(t) ? -fit(l, t) : undefined));
      for (const j of [...exact.values()].sort((a, b) => b - a)) pool.splice(j, 1);
      loose.push(...lines.filter((l, k) => !exact.has(k) && !isClosed(l.line.date)));
    }
    // The same amount a few days off: the payee first (its IBAN, its name, the text), then the closest day.
    const free = pool.filter((t) => !isClosed(t.date));
    const near = pairUp(loose.map((l) => l.line), free, (l, t) => (t.direction === l.direction && Math.round(Math.abs(t.amount) * 100) === Math.round(Math.abs(l.amount) * 100) && dayGap(t.date, l.date) <= MATCH_DAYS ? dayGap(t.date, l.date) - 10 * fit(l, t) : undefined));
    const changes = new Map<string, Map<number, string | null>>();
    const set = (file: string, index: number, day: string | null) => (changes.get(file) ?? changes.set(file, new Map()).get(file)!).set(index, day);
    for (const [k, l] of loose.entries()) {
      const u: Unmatched = { file: l.file, bank: l.line.bank, currency: l.line.currency, date: l.line.date, direction: l.line.direction, amount: l.line.amount, ref: l.line.ref };
      const t = near.has(k) ? free[near.get(k)!] : undefined;
      if (t && !books.byPerson(u)) {
        set(l.file, l.index, t.date);
        realigned.push({ ...u, to: t.date });
        continue;
      }
      // Only a movement the books hold leaves its read file: it stays in the books as one of its own.
      if (!books.holds(u)) continue;
      set(l.file, l.index, null);
      unmatched.push(u);
    }
    for (const [file, change] of changes) {
      let index = -1;
      files.set(file, (files.get(file) ?? xmlOf(file)).replace(/<Ntry>[\s\S]*?<\/Ntry>\n?/g, (entry) => {
        index++;
        if (!change.has(index)) return entry;
        const day = change.get(index);
        return day === null ? '' : entry.replace(/<BookgDt><Dt>[^<]*<\/Dt><\/BookgDt>/, `<BookgDt><Dt>${day}</Dt></BookgDt>`).replace(/<ValDt><Dt>[^<]*<\/Dt><\/ValDt>/, `<ValDt><Dt>${day}</Dt></ValDt>`);
      }));
    }
  }
  return { files, unmatched, realigned };
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
 * The app's entries of the read movements the bank's file dated otherwise (alignReads `realigned`;
 * `moves`: by the movement's ref): they follow the bank's day (entryToDay), written as the module
 * through the write door. A person's entry is never moved (alignReads asks about its movement
 * instead), and nothing filed moves (alignReads pairs no filed day).
 */
export function followBankDays(books: Books, moves: ReadonlyMap<string, { from: string; to: string }>, rateOf: RateOf): void {
  if (!moves.size) return;
  update(books, moduleActor('bank-import'), (b) => {
    const days = new Map(b.transactions.map((t) => [t.ref, t.date]));
    for (const e of b.journalEntries) {
      const m = moves.get(e.transactionRef) ?? moves.get(e.transactionRef.split('~')[0]);
      if (m && e.origin !== 'manual') entryToDay(e, m.from, m.to, days, rateOf);
    }
  });
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

/** The refs (without a `~n` suffix) of the payments a structured source holds: a bank's camt.053, or one the app wrote from a bank CSV (#254). */
export function structuredRefs(ws: Ws): Set<string> {
  const files = readBankStatements(ws);
  const refs = refsByFile(files);
  return new Set(files.filter((f) => f.status === 'read' && sourceOf(f.statement) !== 'pdf').flatMap((f) => refs.get(f.file) ?? []).map((r) => r.split('~')[0]));
}

/** The balances read from the camt.053 files now, beside the others (a PDF's): the PDF's balance of a day wins. */
export function withCamtBalances(others: StatementClosingBalance[] = [], camt: StatementClosingBalance[]): StatementClosingBalance[] | undefined {
  const kept = others.filter((b) => b.source !== 'camt');
  const day = (b: StatementClosingBalance) => `${b.account} ${b.date}`;
  const given = new Set(kept.map(day));
  const out = [...kept, ...camt.filter((b) => !given.has(day(b)))].sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account));
  return out.length || others.length ? out : undefined;
}

/** Wise drops transfer references from camt053; its monthly PDFs keep them (Wise transaction id → reference). */
export async function readWiseReferences(ws: Ws, warn: (msg: string) => void = () => {}): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  for (const bank of new Set(ws.bankAccounts.filter((a) => a.statements === 'wise').map((a) => a.bank))) {
    for (const dir of partDirs(ws.paths, 'statements').map((d) => join(d, bank)).filter((d) => existsSync(d))) for (const f of readdirSync(dir).filter((x) => x.endsWith('.pdf'))) {
      try {
        for (const [id, ref] of wiseReferences(await pdfText(join(dir, f), 'raw'))) refs.set(id, ref);
      } catch (e) { warn(`${f}: ${e}`); }
    }
  }
  return refs;
}

// ─── Merge: previous index + what is on disk now → new index ──────────────────

export interface Scan {
  /** Every receipt file on disk, already extracted. */
  receipts: Receipt[];
  /** Transactions parsed from the camt053 files, refs already unique. */
  bankTransactions: BankTransaction[];
  /** Wise transaction id → transfer reference, from the monthly statement PDFs of the `wise` accounts. */
  wiseRefs: Map<string, string>;
  bankStatements: BankStatement[];
  /** The balances the camt.053 files state (readStatementFiles). */
  camtBalances: StatementClosingBalance[];
}

/**
 * Where each transaction field comes from. A rebuild takes the 'bank' fields from the camt053
 * (and the Wise PDFs) and keeps every other field from the previous index: a remark, "no
 * receipt needed", whatever a later step adds. A new BankTransaction field does not compile
 * until it is listed here.
 */
const TRANSACTION_FIELD_SOURCE = {
  ref: 'bank', bank: 'bank', date: 'bank', amount: 'bank', currency: 'bank', direction: 'bank',
  description: 'bank', type: 'bank', parts: 'bank', reference: 'bank', counterparty: 'bank', counterpartyIban: 'bank', bankTxId: 'bank', original: 'bank',
  source: 'kept', statement: 'kept', businessPart: 'kept', replaced: 'kept', remarks: 'kept', noReceiptNeeded: 'kept', waitsForPerson: 'kept', unmatched: 'kept', waitsForReceipt: 'kept', inputTaxProof: 'kept',
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
 * movements without a row yet take part: a filed record keeps every byte. A movement read from a PDF
 * that the bank's file did not take (`unmatched`, #254) is none: its question is the person's
 * («Ist das dieselbe Zahlung?», src/books/twins.ts). Returns movement ref → the row's ref; the rows
 * it names are no new movements.
 */
export function matchStatementRows(rows: readonly BankTransaction[], books: readonly BankTransaction[], isClosed: (date: string) => boolean): Map<string, string> {
  const open = books.filter((t) => madeByHand(t) && !t.unmatched && t.statement === undefined && t.amount !== 0 && !isClosed(t.date));
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
    return isClosed(before) ? before : { ...t, ...keptFields(before) };
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

  const transactions = [...fromBank, ...vanishedClosedTransactions, ...manual].map((t) => {
    if (isClosed(t)) return t;
    const out = { ...t };
    // Wise drops transfer references from camt053; its monthly PDFs keep them. The map holds
    // Wise transaction ids only (CARD-…, TRANSFER-…), read from the folders of `wise` accounts.
    const fromPdf = scan.wiseRefs.get(t.bankTxId ?? t.ref.split('~')[0]);
    if (fromPdf && !out.reference) out.reference = fromPdf;
    return out;
  });

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
