/**
 * The bank side of the books, read from bank-statements/: the transactions of every camt.053,
 * the monthly statement PDFs, and the Wise transfer references only those PDFs keep. `npm run
 * extract` and the statement upload (POST /api/statements) both read the folder through here and
 * merge with mergeIndex, so a statement imported from the UI lands exactly as extract would put it.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { transactionsOf } from '../parsers/camt053.js';
import { wiseReferences } from '../parsers/wise-statement-pdf.js';
import type { BankStatement, BankTransaction, Index, Mapping, Receipt } from '../types/index.js';
import { readBankStatements, type StatementFile } from '../workspace/bank-statements.js';
import type { Workspace } from '../workspace/workspace.js';
import { periodLock } from './store.js';

const execFileAsync = promisify(execFile);

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

/** The monthly statement PDFs in each bank's folder, named the way Raiffeisen or Wise name them. */
export function readStatementPdfs(ws: Ws): BankStatement[] {
  const statements: BankStatement[] = [];
  for (const bank of new Set(ws.bankAccounts.filter((a) => a.statements).map((a) => a.bank))) {
    const dir = join(ws.paths.statements, bank);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.pdf'))) {
      const parsed = statementPdf(file);
      if (parsed) statements.push({ bank, filename: file, ...parsed });
    }
  }
  return statements.sort((a, b) => a.fromDate.localeCompare(b.fromDate));
}

/** Wise drops transfer references from camt053; its monthly PDFs keep them (Wise transaction id → reference). */
export async function readWiseReferences(ws: Ws, warn: (msg: string) => void = () => {}): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  for (const bank of new Set(ws.bankAccounts.filter((a) => a.statements === 'wise').map((a) => a.bank))) {
    const dir = join(ws.paths.statements, bank);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.pdf'))) {
      try {
        const { stdout } = await execFileAsync('pdftotext', ['-raw', join(dir, f), '-']);
        for (const [id, ref] of wiseReferences(stdout)) refs.set(id, ref);
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
}

/**
 * Where each transaction field comes from. A rebuild takes the 'bank' fields from the camt053
 * (and the Wise PDFs) and keeps every other field from the previous index: a remark, "no
 * receipt needed", whatever a later step adds. A new BankTransaction field does not compile
 * until it is listed here.
 */
const TRANSACTION_FIELD_SOURCE = {
  ref: 'bank', bank: 'bank', date: 'bank', amount: 'bank', currency: 'bank', direction: 'bank',
  description: 'bank', type: 'bank', parts: 'bank', reference: 'bank',
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
  const fromBank = scan.bankTransactions.map((t) => {
    const before = previousByRef.get(t.ref);
    return before ? { ...t, ...keptFields(before) } : t;
  });
  const vanishedClosedTransactions = previous.transactions.filter(
    (t) => t.source !== 'manual' && !freshRefs.has(t.ref) && isClosed(t),
  );
  const manual = previous.transactions.filter((t) => t.source === 'manual');

  const transactions = [...fromBank, ...vanishedClosedTransactions, ...manual].map((t) => {
    const out = { ...t };
    // Wise drops transfer references from camt053; its monthly PDFs keep them. The map holds
    // Wise transaction ids only (CARD-…, TRANSFER-…), read from the folders of `wise` accounts.
    const fromPdf = scan.wiseRefs.get(t.ref.split('~')[0]);
    if (fromPdf && !out.reference) out.reference = fromPdf;
    // A closed transaction stays exactly as filed, so batch parts and references are only
    // attached in open periods.
    if (isClosed(out)) { delete out.parts; delete out.reference; }
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
    index: { ...previous, receipts: scan.receipts, transactions, bankStatements: scan.bankStatements, mappings },
    brokenClosedLinks,
    vanishedClosedTransactions,
  };
}
