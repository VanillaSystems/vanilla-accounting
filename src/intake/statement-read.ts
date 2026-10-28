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
import { heldLines } from '../books/bank-import.js';
import { statementPdf, statementPeriod } from '../books/statement-facts.js';
import { accountForStatement } from '../accounting/bank-accounts.js';
import { baseCurrency } from '../engines/index.js';
import type { BankStatement, BankTransaction } from '../types/index.js';
import type { CsvColumns, HandWhy, ReadBy, ReadStatement, StatementRead } from '../types/statement-read.js';
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
 * The statement in the PDF at `path` (a photo made a PDF first): read by the model when `ask` is
 * given and the file has no more than MAX_READ_PAGES pages, else the table to fill by hand with
 * why (`notStatement`: the model says the file is none, then it may be a receipt).
 */
export async function readStatementPdf(path: string, ask: Asker | undefined): Promise<{ statement: ReadStatement; by: ReadBy; why?: HandWhy; pages?: number }> {
  let text = '';
  let pages: number | undefined;
  try {
    const runs = await pdfRuns(readFileSync(path));
    pages = runs.length;
    text = textOf(runs, 'layout');
  } catch {
    // A PDF pdf.js cannot open: the model may still read it; the hand table starts empty.
  }
  const hand = (why: HandWhy) => ({ statement: handStatement(text), by: 'hand' as const, why, ...(pages !== undefined ? { pages } : {}) });
  if (!ask) return hand('noAi');
  if (pages !== undefined && pages > MAX_READ_PAGES) return hand('pages');
  let answer: ReturnType<typeof parseStatementRead>;
  try {
    answer = parseStatementRead(await ask(buildStatementReadPrompt(path, text), { step: 'statement-read', attachments: [path], timeoutMs: 300_000 }));
  } catch {
    return hand('failed');
  }
  if (answer === 'notStatement') return hand('notStatement');
  return answer ? { statement: answer, by: 'model', ...(pages !== undefined ? { pages } : {}) } : hand('failed');
}

/**
 * The account and month of a statement PDF whose movements a bank export in the books covers
 * already (its account by the IBAN its text or name prints, its days by its text or name): then
 * there is nothing to read, the PDF is kept as that month's statement as before. Undefined when the
 * file does not say, or no bank export covers it: then it is read.
 */
export function coveredByExport(text: string, name: string, accounts: readonly LedgerBankAccount[], statements: readonly BankStatement[]): { account: string; month: string } | undefined {
  const iban = (IBAN.exec(text)?.[0] ?? IBAN.exec(name.replace(/\s+(?=\d)/g, ''))?.[0])?.replace(/\s/g, '').toUpperCase();
  const named = statementPdf(name);
  const period = statementPeriod(text) ?? (named ? { from: named.fromDate, to: named.toDate } : undefined);
  const account = iban ? accounts.find((a) => a.statements && a.iban && a.iban.replace(/\s/g, '').toUpperCase() === iban) : undefined;
  if (!account || !period) return undefined;
  // A bank export lists its payments (refs); a PDF kept as a month's statement does not.
  const covered = statements.some((s) => s.bank === account.bank && s.refs !== undefined && !s.filename.toLowerCase().endsWith('.pdf') && s.fromDate <= period.from && s.toDate >= period.to);
  return covered ? { account: account.account, month: period.to.slice(0, 7) } : undefined;
}

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
export function asRead(statement: ReadStatement, by: ReadBy, held: Map<number, BankTransaction>, extra: Pick<StatementRead, 'why' | 'pages' | 'limit'> = {}): StatementRead {
  return {
    by, statement, check: checkStatement(statement),
    known: [...held.keys()].map((i) => ({ date: statement.movements[i].date, amount: statement.movements[i].amount })),
    ...extra,
  };
}

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
