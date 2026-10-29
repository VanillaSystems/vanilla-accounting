/**
 * A bank statement without a bank export (#217): a PDF, scan or photo of any bank read by the model into
 * the typed statement (src/types/statement-read.ts), or, without the model, the same table for the
 * person to fill by hand, or a bank's CSV read by its column mapping, kept per account in
 * knowledge/bank-csv.yaml once the person confirms it. Code checks every one the same way
 * (src/books/statement-check.ts) and marks the lines the books hold already; the drop dialog shows
 * the table and imports it as an ISO 20022 statement (src/providers/statement-read/camt-writer.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { pdfRuns, textOf } from '../parsers/pdf-text.js';
import { buildStatementReadPrompt, parseStatementRead } from '../llm/prompts.js';
import { checkStatement } from '../books/statement-check.js';
import { heldLines, type StructuredSpan } from '../books/bank-import.js';
import { AiRefused, type AiRefusal } from '../llm/provider.js';
import { NoClaudeError } from '../llm/providers/claude-cli.js';
import { statementPdf, statementPeriod } from '../books/statement-facts.js';
import { accountForStatement } from '../accounting/bank-accounts.js';
import { baseCurrency } from '../engines/index.js';
import type { BankTransaction, Index } from '../types/index.js';
import { keptPdfs, readBeside, writeBeside, type KeptPdf } from '../books/pdf-reads.js';
import type { CoveredDays, CsvColumns, HandWhy, ReadBy, ReadStatement, StatementRead } from '../types/statement-read.js';
import type { LedgerBankAccount, Workspace } from '../workspace/workspace.js';
import type { AskOptions } from '../llm/ask.js';

/** The most pages the model reads of one statement; a longer one is a table to fill (or its CSV), and the row says so with this number. */
export const MAX_READ_PAGES = 20;

const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/;

/** The statement to fill by hand: what the file's own text gives (its IBAN, its period), the rest empty. */
export function handStatement(text: string, currency = baseCurrency()): ReadStatement {
  const iban = IBAN.exec(text)?.[0].replace(/\s/g, '');
  const period = statementPeriod(text);
  const today = new Date().toISOString().slice(0, 10);
  return {
    ...(iban ? { iban } : {}), currency, ...(period ? { period } : {}),
    opening: { date: period?.from ?? today, amount: 0 }, closing: { date: period?.to ?? today, amount: 0 }, movements: [],
  };
}

export type Asker = (prompt: string, opts: AskOptions) => Promise<string>;

/**
 * A read of a statement file: the statement, who filled it, and why it is a table to fill by hand
 * (with the provider's words when the call failed). `threw`: the call itself failed (a timeout, a
 * plan's limit, signed out, no program that serves the step), so the model gave no answer at all.
 */
export interface PdfRead { statement: ReadStatement; by: ReadBy; why?: HandWhy; error?: string; pages?: number; threw?: { stop: boolean; refusal?: AiRefusal } }

/**
 * The statement in the PDF at `path` (a photo made a PDF first): read by the model when `ask` is
 * given and the file has no more than MAX_READ_PAGES pages, else the table to fill by hand with
 * why: `none` when there is no model to ask (the AI switched off, or no provider answers here),
 * `pages`, `failed` (with the provider's words when the call failed, none when its answer was no
 * statement code could take), `notStatement` (the model says the file is none: then it may be a receipt).
 */
export async function readStatementPdf(path: string, ask: Asker | undefined, none: 'noAi' | 'noProvider' = 'noAi'): Promise<PdfRead> {
  let text = '';
  let pages: number | undefined;
  try {
    const runs = await pdfRuns(readFileSync(path));
    pages = runs.length;
    text = textOf(runs, 'layout');
  } catch {
    // A PDF pdf.js cannot open: the model may still read it; the hand table starts empty.
  }
  const hand = (why: HandWhy, error?: string): PdfRead => ({ statement: handStatement(text), by: 'hand', why, ...(error ? { error } : {}), ...(pages !== undefined ? { pages } : {}) });
  if (!ask) return hand(none);
  if (pages !== undefined && pages > MAX_READ_PAGES) return hand('pages');
  let answer: ReturnType<typeof parseStatementRead>;
  try {
    answer = parseStatementRead(await ask(buildStatementReadPrompt(path, text), { step: 'statement-read', attachments: [path], timeoutMs: 300_000 }));
  } catch (e) {
    // «KI ganz ausschalten» switched on while it read: the AI is off, not failed (#212).
    if (e instanceof AiRefused && e.refusal.reason === 'off') return hand('noAi');
    return { ...hand('failed', ((e as Error).message || String(e)).split('\n')[0].slice(0, 200)), threw: { stop: e instanceof AiRefused || e instanceof NoClaudeError, ...(e instanceof AiRefused ? { refusal: e.refusal } : {}) } };
  }
  if (answer === 'notStatement') return hand('notStatement');
  return answer ? { statement: answer, by: 'model', ...(pages !== undefined ? { pages } : {}) } : hand('failed');
}

/**
 * The days of [from, to] the account's structured sources cover (a bank export, a bank CSV, #254),
 * each clipped to those days, oldest first. A statement read off a PDF adds no movement on them: a read
 * value date or a line misread by a day would not meet its twin and be counted twice, so the structured
 * source's movements are the account's there. `csv: false` leaves the CSVs out (a CSV read beside one).
 */
export function coveredDays(spans: readonly StructuredSpan[], account: string, from: string, to: string, o: { csv?: boolean } = {}): CoveredDays[] {
  return spans.filter((s) => s.account === account && s.from <= to && s.to >= from && (o.csv !== false || !s.csv))
    .map((s) => ({ file: s.file, from: s.from > from ? s.from : from, to: s.to < to ? s.to : to }))
    .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
}

const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Whether the covered days hold every day of [from, to]. */
export function coversAll(covered: readonly CoveredDays[], from: string, to: string): boolean {
  let next = from;
  for (const c of covered) {
    if (c.from > next) return false;
    if (c.to >= next) next = nextDay(c.to);
    if (next > to) return true;
  }
  return next > to;
}

/** Whether a day lies in the covered days. */
export const isCovered = (covered: readonly CoveredDays[], day: string): boolean => covered.some((c) => c.from <= day && c.to >= day);

/**
 * The account and days a statement PDF names by itself, before any read (#254): its account by the IBAN
 * its text or name prints, else as a monthly PDF of its bank's naming is placed (a Wise statement by
 * its currency, another by the only account of the books' currency); its days by its text or name.
 * Either may be missing: then the read gives it.
 */
export function placeByText(text: string, name: string, accounts: readonly LedgerBankAccount[]): { account?: LedgerBankAccount; period?: { from: string; to: string } } {
  const iban = (IBAN.exec(text)?.[0] ?? IBAN.exec(name.replace(/\s+(?=\d)/g, ''))?.[0])?.replace(/\s/g, '').toUpperCase();
  const named = statementPdf(name);
  const period = statementPeriod(text) ?? (named ? { from: named.fromDate, to: named.toDate } : undefined);
  const byIban = iban ? accounts.find((a) => a.statements && a.iban && a.iban.replace(/\s/g, '').toUpperCase() === iban) : undefined;
  const base = accounts.filter((a) => a.statements && a.statements !== 'wise' && a.currency === baseCurrency());
  const byName = !iban && named ? (named.currency ? accounts.find((a) => a.statements === 'wise' && a.currency === named.currency) : base.length === 1 ? base[0] : undefined) : undefined;
  const account = byIban ?? byName;
  return { ...(account ? { account } : {}), ...(period ? { period } : {}) };
}

/** The days a read statement covers: its period as printed, else from its opening to its closing day. */
export const readDays = (s: ReadStatement): { from: string; to: string } => ({ from: s.period?.from ?? s.opening.date, to: s.period?.to ?? s.closing.date });

/** The account a statement lands on as a bank export would (by its IBAN, else the only account of its currency), or the one the person named. */
export function accountOfRead(s: ReadStatement, accounts: readonly LedgerBankAccount[], named?: string): LedgerBankAccount | undefined {
  const hint = named ? accounts.find((a) => a.account === named && a.statements) : undefined;
  if (hint) return hint;
  const match = accountForStatement(accounts, { iban: s.iban, currency: s.currency, folder: '' });
  return 'account' in match ? match.account : undefined;
}

/** The lines of the statement the account's payments in the books are already (index → that payment). */
export function heldOf(s: ReadStatement, account: LedgerBankAccount | undefined, transactions: readonly BankTransaction[]): Map<number, BankTransaction> {
  if (!account) return new Map();
  return heldLines(s.movements, transactions.filter((t) => t.bank === account.bank && t.currency === account.currency), account);
}

/** The statement checked and its known lines marked, as the drop row shows it. */
export function asRead(statement: ReadStatement, by: ReadBy, held: Map<number, BankTransaction>, extra: Pick<StatementRead, 'why' | 'error' | 'pages' | 'limit' | 'covered' | 'whole'> = {}): StatementRead {
  return {
    by, statement, check: checkStatement(statement),
    known: [...held.keys()].map((i) => ({ date: statement.movements[i].date, amount: statement.movements[i].amount })),
    ...extra,
  };
}

// ─── A statement PDF kept as its statement, read for what its export lacks (#243) ───

/**
 * The kept statement PDFs still to read: of an open month, no question of theirs waiting in the books
 * (its table is the one, src/books/pdf-reads.ts), and no read beside them yet. A filed month's PDF
 * is not read: nothing filed takes what it would give.
 */
export function unreadPdfs(ws: Pick<Workspace, 'paths' | 'bankAccounts'>, books: Pick<Index, 'bankStatements' | 'statementAsks' | 'config'>): KeptPdf[] {
  const asked = new Set((books.statementAsks ?? []).map((a) => a.file));
  const closed = books.config?.closedThrough;
  return keptPdfs(ws, books.bankStatements).filter((p) => (!closed || p.to > closed) && !asked.has(p.file) && !readBeside(p.path));
}

/** The reads that failed since the app started, by file (`<bank>/<name>`): said to the person; nothing is kept on disk, so the next run asks again. */
const failures = new Map<string, string>();
export const readFailures = (): ReadonlyMap<string, string> => failures;

let reading = false;
/** Whether kept statement PDFs are being read now (one reading at a time per process: the inbox run's and the person's). */
export const readingKept = (): boolean => reading;

export interface KeptReadRun {
  read: number;
  failed: { file: string; error: string }[];
  /** Why the reading stopped before the end: a refusal no further call gets past (signed out, a plan's limit, no program for the step). */
  stopped?: { error: string; refusal?: AiRefusal };
  busy?: true;
}

/**
 * Reads `pdfs` with the model one after the other and keeps each answer beside its PDF: a statement,
 * «no statement», an answer code could not take, too many pages. A call that fails keeps nothing and
 * is told (`failed`, readFailures); one that no further call gets past ends the reading (`stopped`).
 * `cancelled` is asked before each file: the file being read is finished.
 */
export async function readKeptPdfs(pdfs: readonly KeptPdf[], ask: Asker, o: { progress?(done: number, total: number, file?: string): void; cancelled?(): boolean; log?(line: string): void } = {}): Promise<KeptReadRun> {
  if (reading) return { read: 0, failed: [], busy: true };
  reading = true;
  const run: KeptReadRun = { read: 0, failed: [] };
  try {
    for (const [i, p] of pdfs.entries()) {
      if (o.cancelled?.()) break;
      o.progress?.(i, pdfs.length, p.file);
      const r = await readStatementPdf(p.path, ask);
      if (r.threw || r.why === 'noAi') {
        const error = r.why === 'noAi' ? 'off' : r.error ?? 'failed';
        failures.set(p.file, error);
        run.failed.push({ file: p.file, error });
        o.log?.(`  ${p.file}: not read (${error}); the next run asks again`);
        if (r.why === 'noAi' || r.threw?.stop) { run.stopped = { error, ...(r.threw?.refusal ? { refusal: r.threw.refusal } : r.why === 'noAi' ? { refusal: { reason: 'off' as const } } : {}) }; break; }
        continue;
      }
      failures.delete(p.file);
      if (r.by === 'model') writeBeside(p.path, { by: 'model', statement: r.statement });
      else writeBeside(p.path, { by: 'model', why: r.why === 'notStatement' || r.why === 'pages' ? r.why : 'unreadable' });
      run.read++;
      o.log?.(`  ${p.file}: ${r.by === 'model' ? `read, ${r.statement.movements.length} movement(s)${checkStatement(r.statement).ok ? '' : ', its figures do not add up'}` : `no statement taken (${r.why})`}`);
    }
    o.progress?.(Math.min(run.read + run.failed.length, pdfs.length), pdfs.length);
    return run;
  } finally {
    reading = false;
  }
}

/** The most kept PDFs the inbox run reads without asking: one month's statement of each account that takes statements. A larger backlog waits for the person («N Kontoauszüge von der KI lesen lassen?»). */
export const readsWithoutAsking = (ws: Pick<Workspace, 'bankAccounts'>): number => Math.max(1, ws.bankAccounts.filter((a) => a.statements).length);

// ─── The column mappings of bank CSVs, kept per account ──────────────────────

interface KeptCsv { account: string; header: string[]; columns: CsvColumns }

const csvFile = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.root, 'knowledge', 'bank-csv.yaml');
const sameHeader = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((h, i) => h.trim().toLowerCase() === b[i].trim().toLowerCase());

function keptMappings(ws: Pick<Workspace, 'paths'>): KeptCsv[] {
  const file = csvFile(ws);
  if (!existsSync(file)) return [];
  const body = (parse(readFileSync(file, 'utf8')) ?? {}) as { mappings?: KeptCsv[] };
  return Array.isArray(body.mappings) ? body.mappings.filter((m) => m && typeof m.account === 'string' && Array.isArray(m.header) && m.columns && typeof m.columns.date === 'number') : [];
}

/** The mapping kept for a CSV with this header (the account it was kept for), when there is one. */
export function keptCsv(ws: Pick<Workspace, 'paths'>, header: readonly string[]): KeptCsv | undefined {
  return keptMappings(ws).find((m) => sameHeader(m.header, header));
}

/** Keeps the person's mapping for the account's CSVs with this header: the next one reads by itself. */
export function keepCsv(ws: Pick<Workspace, 'paths'>, account: string, header: readonly string[], columns: CsvColumns): void {
  const others = keptMappings(ws).filter((m) => !(m.account === account && sameHeader(m.header, header)));
  const file = csvFile(ws);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# How each bank account's CSV export is read (#217): which column holds what, 0-based. Kept from the drop dialog.\n${stringify({ mappings: [...others, { account, header: [...header], columns }] }, { lineWidth: 0 })}`);
}
