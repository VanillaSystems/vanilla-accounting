/**
 * The kept statement PDFs' tables in the app (#243): what each gives the books (src/books/pdf-reads.ts),
 * the reading the person starts for a backlog («N Kontoauszüge von der KI lesen lassen?», one file
 * after the other, N of M, cancellable), and the table a person fills in or corrects by hand, the
 * way without AI. The bank side of the books is merged again after each, as an import merges it.
 */
import { RequestError, WS, assertOpen, readBooks, updateBooks } from './books.js';
import { mergeBankFiles, reconcileWithFiles, unreferencedFiles, unreferencedLine } from '../books/bank-import.js';
import { keptPdfs, pairLines, readBeside, removeBeside, takeBackReadFacts, writeBeside, type KeptPdf, type KeptRead } from '../books/pdf-reads.js';
import { checkStatement, hasBalances, isBlank, parsePdfTable } from '../books/statement-check.js';
import { differenceAccountOf } from '../books/year-close.js';
import { periodLock, type Books } from '../books/store.js';
import { MAX_READ_PAGES, readFailures, readKeptPdfs, readingKept, unreadPdfs, type KeptReadRun } from '../intake/statement-read.js';
import { ask, modelReady, resolveStep } from '../llm/ask.js';
import { aiOff } from '../llm/off.js';
import { AiRefused } from '../llm/provider.js';
import { NoClaudeError } from '../llm/providers/claude-cli.js';
import { unserved } from '../llm/resolve.js';
import type { PdfFactsView, StatementReadsView } from '../types/statement-read.js';

/** The table kept beside a PDF now, if any: what it gave the payments is taken back when it goes or is replaced (remerge). */
const tableOf = (p: KeptPdf): Pick<KeptRead, 'statement' | 'account'> | undefined => {
  const was = readBeside(p.path);
  return was && 'statement' in was ? { statement: was.statement, account: p.account } : undefined;
};

/** Merges the bank side again; `gone`, a kept PDF's table that went or was replaced, first takes back what it gave the payments. */
const remerge = (gone?: Pick<KeptRead, 'statement' | 'account'>) => {
  updateBooks((b) => {
    if (gone) takeBackReadFacts(b.transactions, gone, periodLock(b).isClosed);
    mergeBankFiles(WS, b);
    reconcileWithFiles(WS, b, differenceAccountOf(WS));
  });
  // A Wise file in the folder whose entries name no bank reference (#401): those payments stay out, and the log says so.
  const unreferenced = unreferencedFiles(WS);
  if (unreferenced.length) console.warn(unreferencedLine(unreferenced));
};

/** What one kept PDF gives the books now, and what it lacks. */
export function factsView(p: KeptPdf, books: Books = readBooks()): PdfFactsView {
  const base = { file: p.file, account: p.account.account, from: p.from, to: p.to };
  const lock = periodLock(books);
  const ask = books.statementAsks?.find((a) => a.file === p.file);
  const beside = ask ? undefined : readBeside(p.path);
  const error = readFailures().get(p.file);
  const statement = ask ? ask.read.statement : beside && 'statement' in beside ? beside.statement : undefined;
  const closing = books.statementBalances?.find((b) => b.source === 'pdf' && b.sourceFile === p.file.slice(p.file.indexOf('/') + 1) && b.account === p.account.account);
  const camt = books.statementBalances?.find((b) => b.source === 'camt' && b.account === p.account.account && b.date === p.to);
  const held = { ...(closing ? { closing: { date: closing.date, amount: closing.amount } } : {}), ...(camt ? { bank: { date: camt.date, amount: camt.amount } } : {}) };
  if (!statement) {
    const state = beside && 'why' in beside ? beside.why : lock.isClosed(p.to) ? 'filed' : 'unread';
    return { ...base, state, ...held, ...(error ? { error } : {}) };
  }
  const by = ask ? (ask.read.by === 'hand' ? 'hand' : 'model') : beside!.by;
  const open = books.transactions.filter((t) => !lock.isClosed(t.date));
  const { pairs, ambiguous, unmatched } = pairLines(statement.movements, open, p.account);
  let references = 0, originals = 0;
  for (const [i, t] of pairs) {
    const l = statement.movements[i];
    if (l.reference && t.reference === l.reference.trim()) references++;
    if (l.original && t.original && t.original.currency === l.original.currency && Math.round(t.original.amount * 100) === Math.round(l.original.amount * 100)) originals++;
  }
  const carries = (i: number) => !!(statement.movements[i].reference || statement.movements[i].original);
  return {
    ...base, state: ask ? 'asked' : by === 'hand' ? 'hand' : 'read', by, statement,
    adds: hasBalances(statement) && (by === 'hand' || checkStatement(statement).ok),
    ...held,
    taken: { references, originals }, ambiguous: ambiguous.filter(carries).length, unmatched: unmatched.filter(carries).length,
  };
}

const keptPdf = (file: string, books: Books = readBooks()): KeptPdf => {
  const p = keptPdfs(WS, books.bankStatements).find((x) => x.file === file);
  if (!p) throw new RequestError(404, `Den Auszug ${file} gibt es nicht.`, { code: 'gone', params: { what: 'file' } });
  return p;
};

export const pdfFacts = (file: string): PdfFactsView => factsView(keptPdf(file));

// ─── The reading the person starts ──────────────────────────────────────────

interface Job { done: number; total: number; current?: string; cancelling?: true; finished?: true; run?: KeptReadRun; error?: string }
let job: Job | undefined;

/** Whether the model reads statements here: the AI switched off, no provider, or none that reads a PDF (Codex alone). */
async function aiState(): Promise<StatementReadsView['ai']> {
  if (aiOff()) return 'noAi';
  if (!(await modelReady())) return 'noProvider';
  return (await resolveStep('statement-read')).source === 'unserved' ? 'unserved' : 'ready';
}

export async function readsView(): Promise<StatementReadsView> {
  // Asked first: the files and the reading's state below are then read in one go, so a reading that ends meanwhile shows its files read.
  const ai = await aiState();
  const unread = unreadPdfs(WS, readBooks()).map((p) => p.file);
  return {
    ai,
    unread,
    limit: MAX_READ_PAGES,
    failures: [...readFailures()].map(([file, error]) => ({ file, error })),
    ...(job ? { job: { done: job.done, total: job.total, ...(job.current ? { current: job.current } : {}), ...(job.cancelling ? { cancelling: true as const } : {}), ...(job.finished ? { finished: true as const } : {}),
      read: job.run?.read ?? 0, failed: job.run?.failed ?? [], ...(job.run?.stopped ? { stopped: job.run.stopped } : {}), ...(job.error ? { error: job.error } : {}) } } : {}),
  };
}

/**
 * Reads the kept PDFs still to read (or those of `files` among them) with the model, one after the
 * other, in the background: the person said yes to it. Refused while a reading runs and where no
 * model reads a PDF here; the bank side is merged again when it ends, also after a cancel.
 */
export async function startReads(files?: readonly string[]): Promise<StatementReadsView> {
  if ((job && !job.finished) || readingKept()) throw new RequestError(409, 'Die Kontoauszüge werden schon gelesen.', { code: 'readsRunning', params: {} });
  const ai = await aiState();
  if (ai === 'noAi') throw new AiRefused({ reason: 'off' }, 'Die KI ist auf diesem Mac ausgeschaltet (Firma › KI).');
  if (ai === 'noProvider') throw new NoClaudeError('statement-read');
  if (ai === 'unserved') throw unserved('statement-read');
  const pdfs = unreadPdfs(WS, readBooks()).filter((p) => !files || files.includes(p.file));
  const mine: Job = { done: 0, total: pdfs.length };
  job = mine;
  void (async () => {
    try {
      mine.run = await readKeptPdfs(pdfs, ask, {
        progress: (done, total, file) => Object.assign(mine, { done, total, current: file }),
        cancelled: () => !!mine.cancelling,
        log: (line) => console.log(line),
      });
      if (mine.run.read) remerge();
    } catch (e) {
      mine.error = ((e as Error).message || String(e)).split('\n')[0];
    } finally {
      mine.done = (mine.run?.read ?? 0) + (mine.run?.failed.length ?? 0);
      delete mine.current;
      mine.finished = true;
    }
  })();
  return readsView();
}

/** Cancels the reading after the file being read. */
export function cancelReads(): void {
  if (job && !job.finished) job.cancelling = true;
}

// ─── By hand ────────────────────────────────────────────────────────────────

/**
 * A kept PDF's table as a person filled it in or corrected it: kept beside the PDF as hers (`hand`),
 * which no read of the model replaces; its references go into the books, and its closing balance when
 * she typed one (a table without one gives none). Only in the open period. A PDF whose question waits takes its correction there (PUT …/read).
 */
export function saveTable(file: string, raw: unknown): PdfFactsView {
  const books = readBooks();
  const p = keptPdf(file, books);
  assertOpen(books, [p.to], 'newStatement');
  if (books.statementAsks?.some((a) => a.file === file)) throw new RequestError(409, 'Dieser Auszug wartet auf seine Frage: die Tabelle dort korrigieren.', { code: 'statementRead', params: { why: 'asked' } });
  const statement = parsePdfTable(raw);
  if (!statement) throw new RequestError(400, 'Eine Zeile hat kein Datum oder keinen Betrag, oder ein Saldo fehlt.', { code: 'statementRead', params: { why: 'line' } });
  if (isBlank(statement)) throw new RequestError(400, 'Der Auszug ist leer: keine Bewegung, beide Saldi 0.00.', { code: 'statementRead', params: { why: 'blank' } });
  if (statement.currency !== p.account.currency) throw new RequestError(400, `Der Auszug ist in ${statement.currency}, das Konto in ${p.account.currency}.`, { code: 'statementRead', params: { why: 'currency', currency: p.account.currency } });
  const was = tableOf(p);
  writeBeside(p.path, { by: 'hand', statement });
  remerge(was);
  return pdfFacts(file);
}

/**
 * «Neu lesen»: the read beside the PDF goes (the model's or a person's), so the next reading asks
 * again. A person's table goes only once she confirmed it (`confirmed`, after the app named what goes).
 * A balance it gave stays until another replaces it; its references and foreign amounts go with it.
 */
export function forgetRead(file: string, confirmed = false): PdfFactsView {
  const books = readBooks();
  const p = keptPdf(file, books);
  assertOpen(books, [p.to], 'newStatement');
  if (!confirmed && readBeside(p.path)?.by === 'hand') throw new RequestError(409, 'Diese Tabelle ist von Hand erfasst: erst bestätigen, dass sie gehen soll.', { code: 'statementRead', params: { why: 'hand' } });
  const was = tableOf(p);
  removeBeside(p.path);
  remerge(was);
  return pdfFacts(file);
}
