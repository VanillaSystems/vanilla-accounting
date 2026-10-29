/**
 * The kept statement PDFs' tables in the app (#243): what each gives the books (src/books/pdf-reads.ts),
 * the reading the person starts for a backlog («N Kontoauszüge von der KI lesen lassen?», one file
 * after the other, N of M, cancellable), and the table a person fills in or corrects by hand, the
 * way without AI. The bank side of the books is merged again after each, as an import merges it.
 */
import { RequestError, WS, assertOpen, readBooks, updateBooks } from './books.js';
import { mergeBankFiles, reconcileWithFiles } from '../books/bank-import.js';
import { keptPdfs, keptReads, pairLines, readBeside, removeBeside, writeBeside, type KeptPdf } from '../books/pdf-reads.js';
import { checkStatement, isBlank, parseReadStatement } from '../books/statement-check.js';
import { differenceAccountOf } from '../books/year-close.js';
import { periodLock, type Books } from '../books/store.js';
import { MAX_READ_PAGES, readFailures, readKeptPdfs, readingKept, readsWithoutAsking, unreadPdfs, type KeptReadRun } from '../intake/statement-read.js';
import { ask, modelReady, resolveStep } from '../llm/ask.js';
import { aiOff } from '../llm/off.js';
import { AiRefused } from '../llm/provider.js';
import { NoClaudeError } from '../llm/providers/claude-cli.js';
import { unserved } from '../llm/resolve.js';
import type { PdfFactsView, StatementReadsView } from '../types/statement-read.js';

const remerge = () => updateBooks((b) => {
  mergeBankFiles(WS, b);
  reconcileWithFiles(WS, b, differenceAccountOf(WS));
});

/** What one kept PDF gives the books now, and what it lacks. */
export function factsView(p: KeptPdf, books: Books = readBooks()): PdfFactsView {
  const base = { file: p.file, account: p.account.account, from: p.from, to: p.to };
  const lock = periodLock(books);
  const ask = books.statementAsks?.find((a) => a.file === p.file);
  const beside = ask ? undefined : readBeside(p.path);
  const error = readFailures().get(p.file);
  const statement = ask ? ask.read.statement : beside && 'statement' in beside ? beside.statement : undefined;
  const closing = books.statementBalances?.find((b) => b.source === 'pdf' && b.sourceFile === p.file.slice(p.file.indexOf('/') + 1) && b.account === p.account.account);
  const held = closing ? { closing: { date: closing.date, amount: closing.amount } } : {};
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
    adds: by === 'hand' || checkStatement(statement).ok,
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
    withoutAsking: readsWithoutAsking(WS),
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
 * which no read of the model replaces; its closing balance and references go into the books. Only in
 * the open period. A PDF whose question waits takes its correction there (PUT …/read).
 */
export function saveTable(file: string, raw: unknown): PdfFactsView {
  const books = readBooks();
  const p = keptPdf(file, books);
  assertOpen(books, [p.to], 'newStatement');
  if (books.statementAsks?.some((a) => a.file === file)) throw new RequestError(409, 'Dieser Auszug wartet auf seine Frage: die Tabelle dort korrigieren.', { code: 'statementRead', params: { why: 'asked' } });
  const statement = parseReadStatement(raw);
  if (!statement) throw new RequestError(400, 'Eine Zeile hat kein Datum oder keinen Betrag, oder ein Saldo fehlt.', { code: 'statementRead', params: { why: 'line' } });
  if (isBlank(statement)) throw new RequestError(400, 'Der Auszug ist leer: keine Bewegung, beide Saldi 0.00.', { code: 'statementRead', params: { why: 'blank' } });
  if (statement.currency !== p.account.currency) throw new RequestError(400, `Der Auszug ist in ${statement.currency}, das Konto in ${p.account.currency}.`, { code: 'statementRead', params: { why: 'currency', currency: p.account.currency } });
  writeBeside(p.path, { by: 'hand', statement });
  remerge();
  return pdfFacts(file);
}

/** «Neu lesen»: the read beside the PDF goes (the model's or a person's), so the next reading asks again. A balance it gave stays until another replaces it. */
export function forgetRead(file: string): PdfFactsView {
  const books = readBooks();
  const p = keptPdf(file, books);
  assertOpen(books, [p.to], 'newStatement');
  removeBeside(p.path);
  remerge();
  return pdfFacts(file);
}
