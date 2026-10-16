/**
 * A bank statement added from the UI (Kontoauszüge, the add button, N or a drop): a camt.053 XML
 * or a monthly statement PDF goes into bank-statements/<bank>/ under the name the CLI reads, and
 * the bank side of the books is read again from that folder as `npm run extract` reads it
 * (src/books/bank-import.ts), invoice payments matched by their reference. A statement wholly
 * inside a filed quarter is refused before anything is written.
 */
import express, { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { accountForStatement } from '../../accounting/bank-accounts.js';
import { mergeIndex, readStatementFiles, readTransactions, readWiseReferences, statementPdf, withinBooks } from '../../books/bank-import.js';
import { periodLock } from '../../books/store.js';
import { openYear } from '../../books/years.js';
import { assignUniqueRefs, readCamt, transactionsOf } from '../../providers/camt053/camt053.js';
import { parseStatementBalances } from '../../providers/camt053/statement-balances.js';
import { extractStatementBalances } from '../../providers/statement-pdf/statement-pdf-balances.js';
import { loadInvoices, saveInvoices } from '../../invoices/store.js';
import { matchPayments } from '../../invoices/payments.js';
import { fileReceipts, paymentContext } from '../../invoices/service.js';
import type { StatementRefusal } from '../../types/api-error.js';
import type { StatementClosingBalance, StatementImport } from '../../types/index.js';
import { parseIban } from '../../workspace/banks.js';
import { findFile, partDirs, yearPaths, type LedgerBankAccount } from '../../workspace/workspace.js';
import { RequestError, WS, assertOpen, readBooks, updateBooks, withBooks } from '../books.js';
import { openingLock, withOpening } from '../../accounting/opening-balance.js';
import { yearEndAccounts } from '../../accounting/year-close.js';
import { chartOf } from '../../books/year-close.js';
import { baseCurrency, chart } from '../../engines/index.js';

export const router = Router();

/** Where an uploaded statement goes, and the last day it covers. */
interface Placed {
  account: LedgerBankAccount;
  filename: string;
  first?: string;
  last: string;
  /** A camt export's last closing balance (CLBD); a PDF's comes from its text after it is placed. */
  closing?: { date: string; amount: number };
  /** A camt export's first opening balance (OPBD). */
  opening?: { date: string; amount: number };
}

const refuse = (status: number, error: string, reason: StatementRefusal, detail?: string): never => {
  throw new RequestError(status, error, { code: 'statement', params: { reason, ...(detail ? { detail } : {}) } });
};

const imported = (): LedgerBankAccount[] => WS.bankAccounts.filter((a) => a.statements);

function placeCamt(body: Buffer, filename: string, hint?: LedgerBankAccount): Placed {
  let camt: ReturnType<typeof readCamt>;
  try { camt = readCamt(body.toString('utf8')); } catch { return refuse(400, 'Keine camt.053-Datei.', 'notCamt'); }
  if (camt.message !== 'camt.053' || !camt.statements.length) return refuse(400, 'Keine camt.053-Datei (Kontoauszug).', 'notCamt');
  let account: LedgerBankAccount | undefined;
  const dates: string[] = [];
  const closings: Array<{ date: string; amount: number }> = [];
  const openings: Array<{ date: string; amount: number }> = [];
  for (const statement of camt.statements) {
    const match = accountForStatement(WS.bankAccounts, { iban: statement.iban, currency: statement.currency, folder: hint?.bank ?? '' });
    if ('problem' in match) throw new RequestError(400, match.problem, { code: 'statement', params: { reason: 'account', detail: match.problem, ...(match.unknown ? { unknown: { ...match.unknown, ...(statement.bankName ? { bankName: statement.bankName } : {}) } } : {}) } });
    if (account && account.bank !== match.account.bank) return refuse(400, 'Die Datei hält Auszüge zweier Banken.', 'account');
    account = match.account;
    const balances = parseStatementBalances(statement, account.bank, filename);
    dates.push(...transactionsOf(statement, match.account).map((t) => t.date), ...balances.map((b) => b.date));
    closings.push(...balances.filter((b) => b.type === 'CLBD').map((b) => ({ date: b.date, amount: b.amount })));
    openings.push(...balances.filter((b) => b.type === 'OPBD' && b.currency === match.account.currency).map((b) => ({ date: b.date, amount: b.amount })));
  }
  const sorted = dates.filter(Boolean).sort();
  const last = sorted.at(-1);
  if (!account || !last) return refuse(400, 'Der Auszug hat keine Daten.', 'notCamt');
  const closing = closings.sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const opening = openings.sort((a, b) => a.date.localeCompare(b.date))[0];
  return { account, filename, first: sorted[0], last, ...(closing ? { closing } : {}), ...(opening ? { opening } : {}) };
}

const monthEnd = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const swiss = (iso: string) => iso.split('-').reverse().join('.');

/**
 * A PDF keeps its bank's name (Raiffeisen "Kontoauszug 01.09.2026 - 30.09.2026 …", Wise
 * "statement_…_EUR_2026-09-01_2026-09-30.pdf"), which gives its month. Another name is renamed
 * that way when the upload names the account and month (the missing month's well).
 */
function placePdf(filename: string, hint?: LedgerBankAccount, month?: string): Placed {
  const named = statementPdf(filename);
  if (!named) {
    if (!hint || !month) return refuse(400, 'Der Dateiname sagt nicht, welchen Monat der Auszug zeigt.', 'name');
    const from = `${month}-01`, to = monthEnd(month);
    const canonical = hint.statements === 'wise' ? `statement_0_${hint.currency}_${from}_${to}.pdf` : `Kontoauszug ${swiss(from)} - ${swiss(to)}.pdf`;
    return { account: hint, filename: canonical, first: from, last: to };
  }
  const iban = /\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/.exec(filename.replace(/\s+(?=\d)/g, ''))?.[1];
  const byIban = iban ? imported().find((a) => a.iban && a.iban === parseIban(iban)) : undefined;
  const wise = named.currency ? imported().find((a) => a.statements === 'wise' && a.currency === named.currency) : undefined;
  const chf = imported().filter((a) => a.statements !== 'wise' && a.currency === baseCurrency());
  const account = byIban ?? wise ?? hint ?? (chf.length === 1 ? chf[0] : undefined);
  if (!account) return refuse(400, 'Zu welchem Konto gehört der Auszug? Aus dem fehlenden Monat hinzufügen.', 'account');
  return { account, filename, first: named.fromDate, last: named.toDate };
}

/** The new closing balances replace those of the same account and day; the others stay. */
function mergeBalances(old: StatementClosingBalance[] = [], fresh: StatementClosingBalance[]): StatementClosingBalance[] {
  const key = (b: StatementClosingBalance) => `${b.account} ${b.date}`;
  const out = new Map(old.map((b) => [key(b), b]));
  for (const b of fresh) out.set(key(b), b);
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account));
}

router.post('/api/statements', express.raw({ type: () => true, limit: '50mb' }), async (req, res) => {
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) throw new RequestError(400, 'Keine Datei erhalten.');
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : undefined;
  res.json(await importStatement(body, String(req.query.name ?? ''), typeof req.query.account === 'string' ? req.query.account : undefined, month));
});

/**
 * Reads one statement file (camt.053 or a PDF) into the books: placed by its account and month,
 * refused as a RequestError when it belongs to no account, lies in a closed period or is read
 * already. The Bank area's upload and the drop dialog both take this one way in.
 */
export async function importStatement(body: Buffer, given: string, accountHint?: string, month?: string): Promise<StatementImport> {
  const name = basename(given).trim();
  const hint = imported().find((a) => a.account === accountHint);
  const xml = /\.xml$/i.test(name);
  if (!xml && !/\.pdf$/i.test(name)) refuse(400, 'Nur camt.053 (XML) oder PDF.', 'format');
  const placed = xml ? placeCamt(body, name, hint) : placePdf(name, hint, month);
  assertOpen(readBooks(), [placed.last], 'newStatement');

  const year = openYear(placed.last.slice(0, 4), readBooks().config.closedThrough);
  const dir = join(yearPaths(WS.paths, year).statements, placed.account.bank);
  const mine = `${placed.account.bank}/${placed.filename}`;
  const path = findFile(WS.paths, 'statements', mine) ?? join(dir, placed.filename);
  if (existsSync(path)) {
    const same = readFileSync(path).equals(body);
    throw new RequestError(409, same ? `${placed.filename} ist schon eingelesen.` : `Datei ${placed.filename} existiert bereits.`,
      same ? { code: 'statement', params: { reason: 'duplicate', detail: placed.filename } } : { code: 'fileExists', params: { filename: placed.filename } });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, body);
  try {
    const bank = readTransactions(WS);
    const unmatched = bank.files.find((f) => f.status === 'unmatched');
    if (unmatched?.status === 'unmatched') refuse(400, unmatched.problem, 'account', unmatched.problem);
    for (const f of bank.files) {
      if (f.status !== 'duplicate' || (f.file !== mine && f.of !== mine)) continue;
      const other = f.file === mine ? f.of : f.file;
      refuse(409, `Schon eingelesen aus ${other}.`, 'duplicate', other);
    }

    const wiseRefs = await readWiseReferences(WS);
    const balances = xml ? undefined : (await extractStatementBalances(partDirs(WS.paths, 'statements'), WS.bankAccounts)).balances;
    const invoices = loadInvoices(WS);
    const payments = paymentContext(WS);
    return updateBooks((books): StatementImport => {
      assertOpen(books, [placed.last], 'newStatement');
      const before = new Set(books.transactions.map((t) => t.ref));
      const fresh = assignUniqueRefs(withinBooks(bank.transactions, books.config).kept);
      const freshRefs = new Set(fresh.map((t) => t.ref));
      // An upload adds: a payment no file holds any more stays until extract's rebuild decides.
      const lock = periodLock(books);
      const stay = books.transactions.filter((t) => t.source !== 'manual' && !freshRefs.has(t.ref) && !lock.isClosed(t.date));
      const files = readStatementFiles(WS);
      const merged = mergeIndex(books, { receipts: books.receipts, bankTransactions: [...fresh, ...stay], wiseRefs, bankStatements: files.statements, camtBalances: files.balances });
      // The books keep their order; the new payments come after them.
      const pos = new Map(books.transactions.map((t, i) => [t.ref, i]));
      const known = merged.index.transactions.filter((t) => pos.has(t.ref)).sort((a, b) => pos.get(a.ref)! - pos.get(b.ref)!);
      Object.assign(books, merged.index, { transactions: [...known, ...merged.index.transactions.filter((t) => !pos.has(t.ref))] });
      if (balances) books.statementBalances = mergeBalances(books.statementBalances, balances);
      const paid = payments ? matchPayments(books, invoices, payments) : undefined;
      if (paid) { fileReceipts(WS, books, paid.files); saveInvoices(WS, invoices); }
      const closing = placed.closing ?? balances?.filter((b) => b.sourceFile === placed.filename && b.account === placed.account.account)
        .sort((a, b) => a.date.localeCompare(b.date)).map((b) => ({ date: b.date, amount: b.amount })).at(-1);
      return {
        file: `${placed.account.bank}/${placed.filename}`,
        account: placed.account.account,
        month: placed.last.slice(0, 7),
        added: books.transactions.filter((t) => !before.has(t.ref)).length,
        bank: placed.account.bank,
        currency: placed.account.currency,
        ...(placed.first ? { from: placed.first } : {}),
        to: placed.last,
        ...(closing ? { closing } : {}),
        ...(placed.opening ? { opening: placed.opening } : {}),
      };
    });
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  }
}

/**
 * An account's opening balance of a year: a bank account's as its first statement offers it
 * (src/accounting/opening-balance.ts), any balance-sheet account's as Firma › Eröffnung types it
 * for the books' first year. `amount` sets it, null takes it back; the difference goes to retained
 * earnings. A year with a closed period keeps its openings; a later year is opened by the close of
 * the one before; a foreign-currency account also needs its native balance (npm run import-opening).
 */
router.put('/api/opening-balances/:year/:account', (req, res) => {
  const { year, account } = req.params;
  const amount: unknown = req.body?.amount;
  if (!/^\d{4}$/.test(year)) throw new RequestError(400, 'Kein Jahr.');
  if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount))) throw new RequestError(400, 'Betrag fehlt.');
  const equity = yearEndAccounts(chartOf(WS)).retainedEarnings;
  const side = chart().sideOf(account);
  const refuse = (reason: 'notBalanceSheet' | 'equity' | 'foreign', text: string) => new RequestError(400, text, { code: 'openingAccount', params: { account, reason } });
  if (side !== 'assets' && side !== 'liabilities') throw refuse('notBalanceSheet', `Konto ${account} ist kein Bilanzkonto.`);
  if (account === equity) throw refuse('equity', `Konto ${account} nimmt die Differenz der Eröffnung auf.`);
  if (WS.bankAccounts.some((a) => a.account === account && a.currency !== baseCurrency())) throw refuse('foreign', `Konto ${account} führt eine Fremdwährung: npm run import-opening.`);
  withBooks(res, (books) => {
    assertOpen(books, [`${year}-01-01`], 'openingBalance');
    if (openingLock(books, year)) throw new RequestError(400, `${year} ist nicht das erste Jahr dieser Bücher: der Abschluss des Vorjahres eröffnet es.`, { code: 'openingNotFirstYear', params: { year } });
    const next = withOpening(books.config.openingBalances, year, account, amount, equity, side === 'liabilities');
    if (next) books.config.openingBalances = next;
    else delete books.config.openingBalances;
    return { ok: true };
  });
});
