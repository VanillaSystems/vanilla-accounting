/**
 * The bank side of the books, read from bank-statements/: the transactions of every camt.053,
 * the monthly statement PDFs, and the Wise transfer references only those PDFs keep. `npm run
 * extract` and the statement upload (POST /api/statements) both read the folder through here and
 * merge with mergeIndex, so a statement imported from the UI lands exactly as extract would put it.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { statementSpan, transactionsOf } from '../providers/camt053/camt053.js';
import { pdfText } from '../parsers/pdf-text.js';
import { wiseReferences } from '../providers/wise-pdf/wise-statement-pdf.js';
import type { BankStatement, BankTransaction, Index, Mapping, Receipt, StatementClosingBalance } from '../types/index.js';
import { readBankStatements, type StatementFile } from '../workspace/bank-statements.js';
import { partDirs, type Workspace } from '../workspace/workspace.js';
import { periodLock } from './store.js';

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
  return { files, transactions: files.flatMap((f) => (f.status === 'read' ? transactionsOf(f.statement, f.account) : [])) };
}

/**
 * The books open on 1 January of the first year with opening balances. A bank export often
 * starts a few days earlier; those rows belong to the prior year's books, whose result the
 * opening balances already carry. Books without opening balances keep every row.
 */
export function withinBooks(transactions: BankTransaction[], config: Index['config']): { kept: BankTransaction[]; before?: string } {
  const years = Object.keys(config?.openingBalances ?? {}).sort();
  if (years.length === 0) return { kept: transactions };
  const opens = `${years[0]}-01-01`;
  return { kept: transactions.filter((t) => t.date >= opens), before: opens };
}

// ─── Bank statements from PDF filenames ─────────────────────────────────────

/** The period (and for Wise the currency) a statement PDF's name gives, as Raiffeisen and Wise name them. */
export function statementPdf(filename: string): { fromDate: string; toDate: string; currency?: string } | null {
  // "Kontoauszug 01.01.2026 - 31.01.2026 - CH... - 2026-01-31.pdf"
  const r = filename.match(/(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/);
  if (r) return { fromDate: `${r[3]}-${r[2]}-${r[1]}`, toDate: `${r[6]}-${r[5]}-${r[4]}` };
  // "statement_12345678_CHF_2026-01-01_2026-01-31.pdf"
  const w = filename.match(/statement_\d+_([A-Z]{3})_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.pdf/);
  if (w) return { currency: w[1], fromDate: w[2], toDate: w[3] };
  return null;
}

type Read = Extract<StatementFile, { status: 'read' }>;

export interface StatementFiles {
  statements: BankStatement[];
  /** The balances each camt.053 states (OPBD, CLBD), as the account's balance at the end of a day. */
  balances: StatementClosingBalance[];
}

/**
 * Every statement in each bank's folder of each year: the monthly PDFs named the way Raiffeisen
 * or Wise name them, and each camt.053, which covers the days from its opening to its closing
 * balance. A camt holding statements of several accounts is no one statement and is left out.
 */
export function readStatementFiles(ws: Ws): StatementFiles {
  const statements: BankStatement[] = [];
  for (const bank of new Set(ws.bankAccounts.filter((a) => a.statements).map((a) => a.bank))) {
    for (const dir of partDirs(ws.paths, 'statements').map((d) => join(d, bank)).filter((d) => existsSync(d))) for (const file of readdirSync(dir).filter((f) => f.endsWith('.pdf'))) {
      const parsed = statementPdf(file);
      if (parsed) statements.push({ bank, filename: file, ...parsed });
    }
  }
  const balances: StatementClosingBalance[] = [];
  const byFile = new Map<string, Read[]>();
  for (const f of readBankStatements(ws)) if (f.status === 'read') (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f);
  for (const [file, reads] of byFile) {
    const { account } = reads[0];
    const [folder, filename, ...deeper] = file.split('/');
    if (folder !== account.bank || !filename || deeper.length || reads.some((r) => r.account.account !== account.account)) continue;
    const span = statementSpan(reads.map((r) => r.statement), account, filename);
    if (!span) continue;
    statements.push({ bank: account.bank, filename, fromDate: span.from, toDate: span.to, currency: account.currency });
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
  description: 'bank', type: 'bank', parts: 'bank', reference: 'bank', counterparty: 'bank', counterpartyIban: 'bank',
  source: 'kept', remarks: 'kept', noReceiptNeeded: 'kept',
} as const satisfies Record<keyof BankTransaction, 'bank' | 'kept'>;

function keptFields(t: BankTransaction): Partial<BankTransaction> {
  return Object.fromEntries(
    Object.entries(t).filter(([k]) => TRANSACTION_FIELD_SOURCE[k as keyof BankTransaction] !== 'bank'),
  );
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

  const previousByRef = new Map(previous.transactions.map((t) => [t.ref, t]));
  const freshRefs = new Set(scan.bankTransactions.map((t) => t.ref));
  // A filed transaction is what the books hold, whatever the camt053 says now: the counterparty,
  // reference and parts it was filed with stay, and a later export's wording changes nothing.
  const fromBank = scan.bankTransactions.map((t) => {
    const before = previousByRef.get(t.ref);
    if (!before) return t;
    return isClosed(before) ? before : { ...t, ...keptFields(before) };
  });
  const vanishedClosedTransactions = previous.transactions.filter(
    (t) => t.source !== 'manual' && !freshRefs.has(t.ref) && isClosed(t),
  );
  const manual = previous.transactions.filter((t) => t.source === 'manual');

  const transactions = [...fromBank, ...vanishedClosedTransactions, ...manual].map((t) => {
    if (isClosed(t)) return t;
    const out = { ...t };
    // Wise drops transfer references from camt053; its monthly PDFs keep them. The map holds
    // Wise transaction ids only (CARD-…, TRANSFER-…), read from the folders of `wise` accounts.
    const fromPdf = scan.wiseRefs.get(t.ref.split('~')[0]);
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
