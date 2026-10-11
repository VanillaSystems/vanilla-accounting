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
import { mergeIndex, readStatementPdfs, readTransactions, readWiseReferences, statementPdf, withinBooks } from '../../books/bank-import.js';
import { periodLock } from '../../books/store.js';
import { assignUniqueRefs, readCamt, transactionsOf } from '../../parsers/camt053.js';
import { parseStatementBalances } from '../../parsers/statement-balances.js';
import { extractStatementBalances } from '../../parsers/statement-pdf-balances.js';
import { loadInvoices, saveInvoices } from '../../invoices/store.js';
import { matchPayments } from '../../invoices/payments.js';
import { fileReceipts, paymentContext } from '../../invoices/service.js';
import type { StatementRefusal } from '../../types/api-error.js';
import type { StatementClosingBalance, StatementImport } from '../../types/index.js';
import { parseIban } from '../../workspace/banks.js';
import type { LedgerBankAccount } from '../../workspace/workspace.js';
import { RequestError, WS, assertOpen, readBooks, withBooks } from '../books.js';

export const router = Router();

/** Where an uploaded statement goes, and the last day it covers. */
interface Placed {
  account: LedgerBankAccount;
  filename: string;
  last: string;
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
  for (const statement of camt.statements) {
    const match = accountForStatement(WS.bankAccounts, { iban: statement.iban, currency: statement.currency, folder: hint?.bank ?? '' });
    if ('problem' in match) return refuse(400, match.problem, 'account', match.problem);
    if (account && account.bank !== match.account.bank) return refuse(400, 'Die Datei hält Auszüge zweier Banken.', 'account');
    account = match.account;
    dates.push(...transactionsOf(statement, match.account).map((t) => t.date), ...parseStatementBalances(statement, account.bank, filename).map((b) => b.date));
  }
  const last = dates.filter(Boolean).sort().at(-1);
  if (!account || !last) return refuse(400, 'Der Auszug hat keine Daten.', 'notCamt');
  return { account, filename, last };
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
    return { account: hint, filename: canonical, last: to };
  }
  const iban = /\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/.exec(filename.replace(/\s+(?=\d)/g, ''))?.[1];
  const byIban = iban ? imported().find((a) => a.iban && a.iban === parseIban(iban)) : undefined;
  const wise = named.currency ? imported().find((a) => a.statements === 'wise' && a.currency === named.currency) : undefined;
  const chf = imported().filter((a) => a.statements !== 'wise' && a.currency === 'CHF');
  const account = byIban ?? wise ?? hint ?? (chf.length === 1 ? chf[0] : undefined);
  if (!account) return refuse(400, 'Zu welchem Konto gehört der Auszug? Aus dem fehlenden Monat hinzufügen.', 'account');
  return { account, filename, last: named.toDate };
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
  const name = basename(String(req.query.name ?? '')).trim();
  const hint = imported().find((a) => a.account === req.query.account);
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : undefined;
  const xml = /\.xml$/i.test(name);
  if (!xml && !/\.pdf$/i.test(name)) refuse(400, 'Nur camt.053 (XML) oder PDF.', 'format');
  const placed = xml ? placeCamt(body, name, hint) : placePdf(name, hint, month);
  assertOpen(readBooks(), [placed.last], 'newStatement');

  const dir = join(WS.paths.statements, placed.account.bank);
  const path = join(dir, placed.filename);
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
    const mine = relative(WS.paths.statements, path);
    for (const f of bank.files) {
      if (f.status !== 'duplicate' || (f.file !== mine && f.of !== mine)) continue;
      const other = f.file === mine ? f.of : f.file;
      refuse(409, `Schon eingelesen aus ${other}.`, 'duplicate', other);
    }

    const wiseRefs = await readWiseReferences(WS);
    const balances = xml ? undefined : (await extractStatementBalances(WS.paths.statements, WS.bankAccounts)).balances;
    const invoices = loadInvoices(WS);
    const payments = paymentContext(WS);
    withBooks(res, (books): StatementImport => {
      assertOpen(books, [placed.last], 'newStatement');
      const before = new Set(books.transactions.map((t) => t.ref));
      const fresh = assignUniqueRefs(withinBooks(bank.transactions, books.config).kept);
      const freshRefs = new Set(fresh.map((t) => t.ref));
      // An upload adds: a payment no file holds any more stays until extract's rebuild decides.
      const lock = periodLock(books);
      const stay = books.transactions.filter((t) => t.source !== 'manual' && !freshRefs.has(t.ref) && !lock.isClosed(t.date));
      const merged = mergeIndex(books, { receipts: books.receipts, bankTransactions: [...fresh, ...stay], wiseRefs, bankStatements: readStatementPdfs(WS) });
      // The books keep their order; the new payments come after them.
      const pos = new Map(books.transactions.map((t, i) => [t.ref, i]));
      const known = merged.index.transactions.filter((t) => pos.has(t.ref)).sort((a, b) => pos.get(a.ref)! - pos.get(b.ref)!);
      Object.assign(books, merged.index, { transactions: [...known, ...merged.index.transactions.filter((t) => !pos.has(t.ref))] });
      if (balances) books.statementBalances = mergeBalances(books.statementBalances, balances);
      const paid = payments ? matchPayments(books, invoices, payments) : undefined;
      if (paid) { fileReceipts(WS, paid.files); saveInvoices(WS, invoices); }
      return {
        file: `${placed.account.bank}/${placed.filename}`,
        account: placed.account.account,
        month: placed.last.slice(0, 7),
        added: books.transactions.filter((t) => !before.has(t.ref)).length,
      };
    });
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  }
});
