/**
 * The question a statement PDF raises, kept in the books (#254): whether its movements are read in.
 * A PDF of an account that a bank export or bank CSV feeds is its statement and asks nothing; one of an
 * account without either is kept as the statement at once and its question waits in the books
 * (Index.statementAsks) with the table as read, in the drop dialog, in Bank › Kontoauszüge, after a
 * restart. «Bewegungen aus dem PDF einlesen» asks it of any statement PDF. «Einlesen» writes the
 * table as an ISO 20022 statement beside the PDF, «Als Auszug behalten» closes it, and so does the account's
 * first bank export or CSV (src/server/routes/statements.ts importStatement).
 *
 * The question's table is the PDF's one table while it waits (#243, src/books/pdf-reads.ts): the
 * books take its closing balance and references from it, and no model reads the PDF meanwhile. When
 * the question closes, the table as last read or corrected is kept beside the PDF, and a question
 * asked again starts from that table instead of asking the model again.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { RequestError, WS, assertOpen, readBooks, updateBooks } from './books.js';
import { findFile } from '../workspace/workspace.js';
import { structuredSpans } from '../books/bank-import.js';
import { readBeside, writeBeside } from '../books/pdf-reads.js';
import { hasBalances, isBlank, parseReadStatement } from '../books/statement-check.js';
import { accountOfRead, asRead, coveredDays, coversAll, heldOf, isCovered, readDays, readStatementPdf, MAX_READ_PAGES, type PdfRead } from '../intake/statement-read.js';
import { toStatementXml } from '../providers/statement-read/camt-writer.js';
import { ask, modelReady } from '../llm/ask.js';
import { aiOff } from '../llm/off.js';
import type { StatementReadParams } from '../types/api-error.js';
import type { ReadBy, ReadStatement, StatementRead } from '../types/statement-read.js';
import type { BankTransaction, StatementAsk, StatementImport } from '../types/index.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';

/** Whether a bank export or bank CSV of the account is in the books: then its statement PDFs ask nothing. */
export const structuredAccount = (account: string): boolean => structuredSpans(WS).some((s) => s.account === account);

/**
 * A statement checked as the person sees it: its known lines marked against the account it lands on,
 * and the days a structured source of that account covers. A PDF's table imports nothing new on those
 * days (`whole`: it covers every day, nothing to read in); a CSV is still refused beside a bank export.
 */
export function readView(statement: ReadStatement, by: ReadBy, named: string | undefined, extra: Pick<StatementRead, 'why' | 'error' | 'pages' | 'limit'> = {}): StatementRead {
  const account = accountOfRead(statement, WS.bankAccounts, named);
  const days = readDays(statement);
  const covered = account ? coveredDays(structuredSpans(WS), account.account, days.from, days.to, { csv: by !== 'csv' }) : [];
  const whole = by !== 'csv' && covered.length > 0 && coversAll(covered, days.from, days.to);
  return asRead(statement, by, heldOfRead(statement, account), { ...extra, ...(covered.length ? { covered } : {}), ...(whole ? { whole: true as const } : {}) });
}

export const readRefusal = (error: string, params: StatementReadParams) => new RequestError(400, error, { code: 'statementRead', params });

/** Why a corrected table is not imported: unfilled, not adding up, or nothing on days the books lack a structured source for. */
export function assertImportable(read: StatementRead): void {
  const s = read.statement;
  if (isBlank(s)) throw readRefusal('Der Auszug ist leer: keine Bewegung, beide Saldi 0.00. Nichts eingelesen.', { why: 'blank' });
  const first = read.covered?.[0];
  if (first && (read.by === 'csv' || read.whole)) {
    throw readRefusal(`Die Tage ${first.from} bis ${first.to} sind schon aus ${first.file} in den Büchern: keine Bewegung eingelesen.`, { why: 'covered', file: first.file });
  }
  const gap = read.check.gaps.find((g) => g.where !== 'total') ?? read.check.gaps[0];
  if (gap) throw readRefusal(`Der Auszug geht nicht auf: ${gap.gap.toFixed(2)} ${s.currency}${gap.page ? ` auf Seite ${gap.page}` : ''}. Nichts eingelesen.`, { why: 'gap', gap: gap.gap, currency: s.currency, ...(gap.page ? { page: gap.page } : {}) });
}

/**
 * The ISO 20022 statement a confirmed table is written as (#217): a line the books hold carries its ref, so it
 * is not added twice; a line on a day a bank export or CSV of the account covers that the books do not
 * hold is left out (#254), since that file's movements are the account's there.
 */
export function readAsXml(read: StatementRead, account: LedgerBankAccount | undefined, o: { id: string; source: string }): string {
  const held = heldOfRead(read.statement, account);
  const covered = read.by === 'csv' ? [] : read.covered ?? [];
  const keep = read.statement.movements.map((m, i) => held.has(i) || !isCovered(covered, m.date));
  const refs = new Map<number, string>();
  let n = 0;
  for (const [i, kept] of keep.entries()) {
    if (!kept) continue;
    const t = held.get(i);
    if (t) refs.set(n, t.ref.split('~')[0]);
    n++;
  }
  const movements = read.statement.movements.flatMap((m, i) => (keep[i] ? [held.has(i) ? { ...m, date: held.get(i)!.date } : m] : []));
  return toStatementXml({ ...read.statement, movements }, { id: o.id, source: o.source, by: read.by, refs });
}

/**
 * The lines of a read statement the account's payments in the books are already: the same day and
 * amount (heldOf). A line near a bank export's or CSV's days that the bank holds otherwise comes in, and
 * the account's reconciliation sets it against the bank's (#254, src/books/reconcile.ts).
 */
/** The lines of a statement the books hold already on its account (by day and amount), by their index. */
export const heldOfRead = (statement: ReadStatement, account: LedgerBankAccount | undefined): Map<number, BankTransaction> => heldOf(statement, account, readBooks().transactions);

/** The PDF read now: by the model when one answers here, else the hand form saying why (the AI switched off, or no provider). */
export async function readPdf(path: string): Promise<PdfRead & { limit?: number }> {
  const read = await readStatementPdf(path, await modelReady() ? ask : undefined, aiOff() ? 'noAi' : 'noProvider');
  return { ...read, ...(read.why === 'pages' ? { limit: MAX_READ_PAGES } : {}) };
}

const sha16 = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);

/** A statement PDF of the books by its file (`<bank>/<name>`): kept as a statement, its movements not read in yet. */
function keptPdf(file: string): { path: string; account: LedgerBankAccount } {
  const path = /\.pdf$/i.test(file) ? findFile(WS.paths, 'statements', file) : undefined;
  if (!path) throw new RequestError(404, `Den Auszug ${file} gibt es nicht.`, { code: 'gone', params: { what: 'file' } });
  if (existsSync(path.replace(/\.pdf$/i, '.xml'))) throw new RequestError(409, `Die Bewegungen von ${basename(file)} sind schon eingelesen.`, { code: 'statement', params: { reason: 'duplicate', detail: file.replace(/\.pdf$/i, '.xml') } });
  const listed = readBooks().bankStatements.find((s) => `${s.bank}/${s.filename}` === file);
  const account = listed && WS.bankAccounts.find((a) => a.statements && a.bank === listed.bank && a.currency === (listed.currency ?? a.currency));
  if (!listed || !account) throw new RequestError(404, `Den Auszug ${file} gibt es nicht.`, { code: 'gone', params: { what: 'file' } });
  return { path, account };
}

/** The question of a kept statement PDF, as the books hold it. */
export const askOf = (file: string): StatementAsk | undefined => readBooks().statementAsks?.find((a) => a.file === file);

/** Keeps `read` as the question of the kept PDF `file` (a new one, or the table corrected). Never in a filed period. */
export function keepAsk(file: string, account: string, date: string, read: StatementRead): StatementAsk {
  return updateBooks((b) => {
    assertOpen(b, [date], 'newStatement');
    const was = b.statementAsks?.find((a) => a.file === file);
    const ask: StatementAsk = { file, account, date, since: was?.since ?? new Date().toISOString().slice(0, 10), read };
    b.statementAsks = [...(b.statementAsks ?? []).filter((a) => a.file !== file), ask];
    return ask;
  });
}

/** A question's table kept beside its PDF as the PDF's read: a person's as hers, the model's (corrected or not) as its read. A blank table is no read. */
export function keepAskTable(ask: StatementAsk): void {
  if (isBlank(ask.read.statement)) return;
  const path = findFile(WS.paths, 'statements', ask.file);
  if (path) writeBeside(path, ask.read.by === 'hand' ? { by: 'hand', statement: ask.read.statement } : { by: 'model', statement: ask.read.statement });
}

/**
 * «Als Auszug behalten»: the PDF stays the statement, its movements are not read in; the question goes,
 * its table stays the PDF's (keepAskTable).
 * Also in a filed period: nothing booked changes, and a question there could never be answered otherwise.
 */
export function closeAsk(file: string): void {
  const was = askOf(file);
  if (was) keepAskTable(was);
  updateBooks((b) => {
    const ask = b.statementAsks?.find((a) => a.file === file);
    if (!ask) return;
    b.statementAsks = b.statementAsks!.filter((a) => a !== ask);
    if (!b.statementAsks.length) delete b.statementAsks;
  });
}

/**
 * «Bewegungen aus dem PDF einlesen» on a kept statement PDF: its table kept beside it when it has one
 * (#243), else read now (the model, or the hand form), kept as its question.
 */
export async function askAbout(file: string): Promise<StatementAsk> {
  const { path, account } = keptPdf(file);
  const listed = readBooks().bankStatements.find((s) => `${s.bank}/${s.filename}` === file)!;
  assertOpen(readBooks(), [listed.toDate], 'newStatement');
  const beside = readBeside(path);
  // A person's table without balances asks with 0.00 for each, as the hand form starts.
  const table = beside && 'statement' in beside ? (hasBalances(beside.statement) ? beside.statement : { ...beside.statement, opening: { date: listed.fromDate, amount: 0 }, closing: { date: listed.toDate, amount: 0 } }) : undefined;
  if (table) return keepAsk(file, account.account, listed.toDate, readView(table, beside!.by, account.account));
  const dir = join(WS.paths.data, 'statement-read');
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `${sha16(readFileSync(path))}.pdf`);
  writeFileSync(copy, readFileSync(path));
  let read: Awaited<ReturnType<typeof readPdf>>;
  try { read = await readPdf(copy); } finally { rmSync(copy, { force: true }); }
  const { statement, by, ...extra } = read;
  return keepAsk(file, account.account, listed.toDate, readView(statement, by, account.account, extra));
}

/** The table of a kept PDF's question as the person corrected it: checked again and kept. */
export function correctAsk(file: string, raw: unknown): StatementAsk {
  const was = askOf(file);
  if (!was) throw new RequestError(404, `${basename(file)} wartet auf keine Antwort.`, { code: 'gone', params: { what: 'file' } });
  const statement = parseReadStatement(raw);
  if (!statement) throw readRefusal('Eine Zeile hat kein Datum oder keinen Betrag, oder ein Saldo fehlt.', { why: 'line' });
  const { why, error, pages, limit } = was.read;
  return keepAsk(file, was.account, was.date, readView(statement, was.read.by, was.account, { ...(why ? { why } : {}), ...(error ? { error } : {}), ...(pages ? { pages } : {}), ...(limit ? { limit } : {}) }));
}

/**
 * «Einlesen» on a kept PDF's question: the table, checked again, is written as an ISO 20022 statement beside the
 * PDF under its name (listed from then on as that statement, its PDF beside it) and read in as every
 * statement is; the question goes. `import`: the statement import (src/server/routes/statements.ts).
 */
export async function importAsk(file: string, raw: unknown, importStatement: (body: Buffer, name: string, account?: string) => Promise<StatementImport>): Promise<StatementImport> {
  const was = askOf(file);
  if (!was) throw new RequestError(404, `${basename(file)} wartet auf keine Antwort.`, { code: 'gone', params: { what: 'file' } });
  const { path, account } = keptPdf(file);
  const statement = parseReadStatement(raw);
  if (!statement) throw readRefusal('Eine Zeile hat kein Datum oder keinen Betrag, oder ein Saldo fehlt.', { why: 'line' });
  const read = readView(statement, was.read.by, was.account);
  assertImportable(read);
  const stem = basename(path).replace(/\.pdf$/i, '');
  const xml = readAsXml(read, account, { id: `read-${sha16(readFileSync(path))}`, source: basename(path) });
  const done = await importStatement(Buffer.from(xml), `${stem}.xml`, was.account);
  closeAsk(file);
  return done;
}
