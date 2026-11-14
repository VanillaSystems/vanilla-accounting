/**
 * What a statement PDF kept as its statement gives the books besides the file itself (#243): its
 * month-end closing balance, and the reference and the amount in another currency of each movement
 * the bank's export lacks. Any bank's PDF, read by the model or filled in by a person; no reader per
 * bank layout.
 *
 * A PDF's table has one home at a time. While its question waits in the books (#254,
 * Index.statementAsks) it is the table there, as last read or corrected; otherwise it is the read
 * kept beside the PDF (`<stem>.read.json`), which closing the question writes. A read beside a PDF
 * holds the model's real answer (a statement, «no statement», an answer code could not take) or the
 * table a person filled in; a call that failed leaves no file, so the next run asks again.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { checkStatement, hasBalances, parsePdfTable, parseReadStatement, withoutPayments } from './statement-check.js';
import { madeByHand } from '../workspace/money-accounts.js';
import { findFile, type LedgerBankAccount, type Workspace } from '../workspace/workspace.js';
import type { BankStatement, BankTransaction, StatementAsk, StatementClosingBalance } from '../types/index.js';
import type { PdfTable, ReadMovement, ReadStatement } from '../types/statement-read.js';

/** What the model answered without a statement code can use: no statement at all, too many pages to read, or an answer that does not parse. */
export type ReadWithout = 'notStatement' | 'pages' | 'unreadable';

/** A read kept beside its PDF, which it names by the SHA-256 of its bytes: a different file under the same name has none. */
export type BesideRead = { pdf: string; at: string } & ({ by: 'model'; statement: ReadStatement } | { by: 'hand'; statement: PdfTable } | { by: 'model'; why: ReadWithout });

export const besidePath = (pdf: string): string => pdf.replace(/\.pdf$/i, '.read.json');
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The read beside the PDF at `path`, when it is of that file and well-formed. */
export function readBeside(path: string): BesideRead | undefined {
  try {
    const raw = JSON.parse(readFileSync(besidePath(path), 'utf8')) as Record<string, unknown>;
    if (raw.pdf !== sha256(readFileSync(path)) || (raw.by !== 'model' && raw.by !== 'hand')) return undefined;
    const base = { pdf: raw.pdf, at: typeof raw.at === 'string' ? raw.at : '' };
    if (raw.by === 'model' && (raw.why === 'notStatement' || raw.why === 'pages' || raw.why === 'unreadable')) return { ...base, by: 'model', why: raw.why };
    if (raw.by === 'hand') { const statement = parsePdfTable(raw.statement); return statement ? { ...base, by: 'hand', statement } : undefined; }
    const statement = parseReadStatement(raw.statement);
    return statement ? { ...base, by: 'model', statement: withoutPayments(statement) } : undefined;
  } catch {
    return undefined;
  }
}

export function writeBeside(path: string, read: { by: 'model'; statement: ReadStatement } | { by: 'hand'; statement: PdfTable } | { by: 'model'; why: ReadWithout }): void {
  writeFileSync(besidePath(path), `${JSON.stringify({ pdf: sha256(readFileSync(path)), at: new Date().toISOString(), ...read }, null, 1)}\n`);
}

export const removeBeside = (path: string): void => rmSync(besidePath(path), { force: true });

/** A statement PDF of the books kept as its statement (no bank statement written from it), at its account. */
export interface KeptPdf {
  /** `<bank>/<file name>`, as Index.statementAsks names it. */
  file: string;
  path: string;
  from: string;
  to: string;
  account: LedgerBankAccount;
}

/** The kept statement PDFs the books list (readStatementFiles), each at the account of its bank's folder and its currency. */
export function keptPdfs(ws: Pick<Workspace, 'paths' | 'bankAccounts'>, statements: readonly BankStatement[]): KeptPdf[] {
  return statements.flatMap((s): KeptPdf[] => {
    if (!/\.pdf$/i.test(s.filename)) return [];
    const file = `${s.bank}/${s.filename}`;
    const path = findFile(ws.paths, 'statements', file);
    const account = ws.bankAccounts.find((a) => a.statements && a.bank === s.bank && a.currency === (s.currency ?? a.currency));
    return path && account ? [{ file, path, from: s.fromDate, to: s.toDate, account }] : [];
  });
}

/** A kept PDF's table as the books take it: the question's while it waits, else the read beside it. */
export interface KeptRead {
  /** The PDF's name in its bank's folder: the `sourceFile` of its closing balance. */
  file: string;
  account: Pick<LedgerBankAccount, 'account' | 'bank' | 'currency'>;
  statement: PdfTable;
  by: 'model' | 'hand';
}

/** The table of each kept PDF that has one, in the account's currency. */
export function keptReads(ws: Pick<Workspace, 'paths' | 'bankAccounts'>, statements: readonly BankStatement[], asks: readonly StatementAsk[] = []): KeptRead[] {
  return keptPdfs(ws, statements).flatMap((p): KeptRead[] => {
    const ask = asks.find((a) => a.file === p.file);
    const beside = ask ? undefined : readBeside(p.path);
    const statement = ask ? ask.read.statement : beside && 'statement' in beside ? beside.statement : undefined;
    if (!statement || statement.currency !== p.account.currency) return [];
    const by = ask ? (ask.read.by === 'hand' ? 'hand' : 'model') : beside!.by;
    return [{ file: p.file.slice(p.file.indexOf('/') + 1), account: p.account, statement, by }];
  });
}

// ─── Which payment each read line is ────────────────────────────────────────

/** What a table adds to the payments of its account (payment ref → value), and the lines with a fact left out. */
export interface ReadFacts {
  references: Map<string, string>;
  originals: Map<string, { amount: number; currency: string }>;
  /** Lines with a reference or a foreign amount that more than one payment could be: nothing taken from them. */
  ambiguous: number;
  /** Lines with a reference or a foreign amount that no payment of their day, direction and amount is. */
  unmatched: number;
}

const cents = (n: number) => Math.round(n * 100);
const wordsOf = (...texts: (string | undefined)[]) => new Set(texts.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
const shared = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w)).length;
const signedOf = (t: BankTransaction) => (t.direction === 'DBIT' ? -Math.abs(t.amount) : Math.abs(t.amount));
const factOf = (l: ReadMovement, currency: string) => ({
  reference: l.reference?.trim() || undefined,
  original: l.original && l.original.currency !== currency ? l.original : undefined,
});
const sameFacts = (a: ReturnType<typeof factOf>, b: ReturnType<typeof factOf>) =>
  a.reference === b.reference && a.original?.currency === b.original?.currency && cents(a.original?.amount ?? 0) === cents(b.original?.amount ?? 0);

/**
 * Pairs each line of a table with the payment of the account it is: the payment a person named on
 * the line, else the one payment of its day, direction and amount. Where a day holds several of the
 * same amount, a line takes the payment whose counterparty and text share the most words with its own
 * when each is the other's only best; lines that stay alike in what they add take the payments in
 * order, any other line is left out and counted as ambiguous. A movement made by hand is no payment
 * of the bank's (#88). Line index → payment.
 */
export function pairLines(lines: readonly ReadMovement[], payments: readonly BankTransaction[], account: Pick<LedgerBankAccount, 'bank' | 'currency'>): { pairs: Map<number, BankTransaction>; ambiguous: number[]; unmatched: number[] } {
  const mine = payments.filter((t) => t.bank === account.bank && t.currency === account.currency && !madeByHand(t));
  const pairs = new Map<number, BankTransaction>();
  const taken = new Set<string>();
  for (const [i, l] of lines.entries()) {
    const named = l.payment ? mine.find((t) => t.ref === l.payment && !taken.has(t.ref)) : undefined;
    if (named) { pairs.set(i, named); taken.add(named.ref); }
  }
  const key = (date: string, amount: number) => `${date} ${cents(amount)}`;
  const byKey = new Map<string, BankTransaction[]>();
  for (const t of mine) if (!taken.has(t.ref)) (byKey.get(key(t.date, signedOf(t))) ?? byKey.set(key(t.date, signedOf(t)), []).get(key(t.date, signedOf(t)))!).push(t);
  const linesByKey = new Map<string, number[]>();
  for (const [i, l] of lines.entries()) if (!pairs.has(i)) (linesByKey.get(key(l.date, l.amount)) ?? linesByKey.set(key(l.date, l.amount), []).get(key(l.date, l.amount))!).push(i);
  const ambiguous: number[] = [];
  const unmatched: number[] = [];
  for (const [k, idx] of linesByKey) {
    let ls = [...idx];
    let ps = [...(byKey.get(k) ?? [])];
    if (!ps.length) { unmatched.push(...ls); continue; }
    for (let changed = true; changed && ls.length && ps.length;) {
      changed = false;
      if (ls.length === 1 && ps.length === 1) { pairs.set(ls[0], ps[0]); ls = []; ps = []; break; }
      const score = (i: number, t: BankTransaction) => shared(wordsOf(lines[i].counterparty, lines[i].text), wordsOf(t.counterparty, t.description));
      const bestOf = <A, B>(a: A, bs: readonly B[], s: (a: A, b: B) => number): B | undefined => {
        const scored = bs.map((b) => [b, s(a, b)] as const).sort((x, y) => y[1] - x[1]);
        return scored[0][1] > 0 && (scored.length === 1 || scored[0][1] > scored[1][1]) ? scored[0][0] : undefined;
      };
      for (const i of ls) {
        const t = bestOf(i, ps, score);
        if (t && bestOf(t, ls, (p, j) => score(j, p)) === i) {
          pairs.set(i, t);
          ls = ls.filter((j) => j !== i);
          ps = ps.filter((p) => p !== t);
          changed = true;
          break;
        }
      }
    }
    if (!ls.length) continue;
    const facts = ls.map((i) => factOf(lines[i], account.currency));
    if (ls.length === ps.length && facts.every((f) => sameFacts(f, facts[0]))) ls.forEach((i, n) => pairs.set(i, ps[n]));
    else ambiguous.push(...ls);
  }
  return { pairs, ambiguous, unmatched };
}

/**
 * What a table adds to the open payments of its account: a reference or a foreign amount the payment
 * lacks, from the line that is it beyond doubt (pairLines). `payments`: the open ones; a filed
 * payment keeps what it was filed with.
 */
export function factsOfRead(r: Pick<KeptRead, 'statement' | 'account'>, payments: readonly BankTransaction[]): ReadFacts {
  const { pairs, ambiguous, unmatched } = pairLines(r.statement.movements, payments, r.account);
  const references = new Map<string, string>();
  const originals = new Map<string, { amount: number; currency: string }>();
  for (const [i, t] of pairs) {
    const f = factOf(r.statement.movements[i], r.account.currency);
    if (f.reference && !t.reference) references.set(t.ref, f.reference);
    if (f.original && !t.original) originals.set(t.ref, f.original);
  }
  const carries = (i: number) => { const f = factOf(r.statement.movements[i], r.account.currency); return !!(f.reference || f.original); };
  return { references, originals, ambiguous: ambiguous.filter(carries).length, unmatched: unmatched.filter(carries).length };
}

/** The open payments with what the tables add (factsOfRead); a filed payment stays as it is. */
export function withReadFacts(transactions: readonly BankTransaction[], reads: readonly KeptRead[], isClosed: (date: string) => boolean): BankTransaction[] {
  const open = transactions.filter((t) => !isClosed(t.date));
  const facts = reads.map((r) => factsOfRead(r, open));
  const references = new Map(facts.flatMap((f) => [...f.references]));
  const originals = new Map(facts.flatMap((f) => [...f.originals]));
  return transactions.map((t) => {
    if (isClosed(t.date)) return t;
    const reference = references.get(t.ref), original = originals.get(t.ref);
    return reference || original ? { ...t, ...(reference ? { reference } : {}), ...(original ? { original } : {}) } : t;
  });
}

/**
 * Takes back, in place, the references and foreign amounts a table gave the open payments of its
 * account (the lines paired as factsOfRead pairs them, where the payment holds the line's value): the
 * merge keeps a fact no file states now (#522), so a table that goes («Neu lesen») or is replaced
 * by a person's takes its own along. The next merge gives back what a file still states.
 */
export function takeBackReadFacts(transactions: BankTransaction[], r: Pick<KeptRead, 'statement' | 'account'>, isClosed: (date: string) => boolean): void {
  const { pairs } = pairLines(r.statement.movements, transactions.filter((t) => !isClosed(t.date)), r.account);
  for (const [i, t] of pairs) {
    const f = factOf(r.statement.movements[i], r.account.currency);
    if (f.reference && t.reference === f.reference) delete t.reference;
    if (f.original && t.original && sameFacts({ reference: undefined, original: t.original }, { reference: undefined, original: f.original })) delete t.original;
  }
}

/**
 * A PDF's table replaced by another (a question's table corrected, kept beside its PDF), in place:
 * what `was` gave the open payments is taken back (takeBackReadFacts), what `now` gives goes on.
 */
export function replaceReadFacts(transactions: BankTransaction[], was: Pick<KeptRead, 'statement' | 'account'> | undefined, now: Pick<KeptRead, 'statement' | 'account'>, isClosed: (date: string) => boolean): void {
  if (was) takeBackReadFacts(transactions, was, isClosed);
  const open = transactions.filter((t) => !isClosed(t.date));
  const { references, originals } = factsOfRead(now, open);
  for (const t of open) {
    const reference = references.get(t.ref), original = originals.get(t.ref);
    if (reference) t.reference = reference;
    if (original) t.original = original;
  }
}

// ─── The month-end balance ──────────────────────────────────────────────────

/**
 * A table's closing balance: a person's as she typed it, the model's only when its figures add up to
 * the cent. A person's table gives none when she typed none: no balance, or both at 0.00 as the hand
 * form starts them.
 */
export function closingOfRead(r: KeptRead): StatementClosingBalance | undefined {
  const s = r.statement;
  if (!hasBalances(s) || (r.by === 'model' ? !checkStatement(s).ok : s.opening.amount === 0 && s.closing.amount === 0)) return undefined;
  const { account, bank, currency } = r.account;
  return { account, bank, currency, date: s.closing.date, amount: s.closing.amount, source: 'pdf', sourceFile: r.file };
}

/** A bank's year-end confirmation the person attached (#119): its balance stands for its day against any other. */
export const confirmsYearEnd = (b: StatementClosingBalance): boolean => b.sourceFile.startsWith('year-end/');

/**
 * The closing balances of the tables beside the others. A table's balance replaces what the books
 * hold from its file; a file whose table gives none keeps the balance it has (one an older reader
 * wrote, #243). A balance of a filed day is never replaced or added. A year-end confirmation of the
 * day (#119) stays and the table's is left out.
 */
export function withReadBalances(others: readonly StatementClosingBalance[] = [], reads: readonly KeptRead[], isClosed: (date: string) => boolean): StatementClosingBalance[] {
  const read = reads.flatMap((r) => closingOfRead(r) ?? []).filter((b) => !isClosed(b.date));
  const files = new Set(read.map((b) => b.sourceFile));
  const kept = others.filter((b) => !(b.source === 'pdf' && files.has(b.sourceFile) && !isClosed(b.date)));
  const day = (b: StatementClosingBalance) => `${b.account} ${b.date}`;
  const confirmed = new Set(kept.filter(confirmsYearEnd).map(day));
  return [...kept, ...read.filter((b) => !confirmed.has(day(b)))];
}

/** Whether a kept PDF's read file is there and of it, for a caller that only asks. */
export const hasBeside = (path: string): boolean => existsSync(besidePath(path)) && !!readBeside(path);
