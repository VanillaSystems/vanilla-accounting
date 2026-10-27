/**
 * A bank statement added from the UI (Kontoauszüge, the add button, N or a drop): a camt.053 XML
 * or a monthly statement PDF goes into bank-statements/<bank>/ under the name the CLI reads, and
 * the bank side of the books is read again from that folder as `npm run extract` reads it
 * (src/books/bank-import.ts), invoice payments matched by their reference. A statement wholly
 * inside a filed quarter is refused before anything is written.
 */
import express, { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { accountForStatement, type StatementProblem } from '../../accounting/bank-accounts.js';
import { legOf, madeByHand } from '../../workspace/money-accounts.js';
import { mergeIndex, readStatementFiles, readTransactions, readWiseReferences, refsHeldWithout, transactionsOfFiles, withCamtBalances, withinBooks } from '../../books/bank-import.js';
import { statementPdf } from '../../books/statement-facts.js';
import { compactIban, readBankStatements } from '../../workspace/bank-statements.js';
import { periodLock } from '../../books/store.js';
import { openYear } from '../../books/years.js';
import { assignUniqueRefs, readCamt, transactionsOf, type CamtStatement } from '../../providers/camt053/camt053.js';
import { proposedAccount } from '../../accounting/statement-bank.js';
import { statementDetails } from '../../providers/statement-files.js';
import { refDates } from '../books.js';
import { parseStatementBalances } from '../../providers/camt053/statement-balances.js';
import { extractStatementBalances } from '../../providers/statement-pdf/statement-pdf-balances.js';
import { loadInvoices, saveInvoices } from '../../invoices/store.js';
import { matchPayments } from '../../invoices/payments.js';
import { bookInvoiceEvents } from '../../invoices/events.js';
import { fileReceipts, paymentContext } from '../../invoices/service.js';
import type { StatementRefusal, UnknownAccount } from '../../types/api-error.js';
import type { BankTransaction, JournalEntry, Mapping, StatementClosingBalance, StatementImport } from '../../types/index.js';
import { parseIban } from '../../workspace/banks.js';
import { findFile, partDirs, yearPaths, type LedgerBankAccount } from '../../workspace/workspace.js';
import { RequestError, WS, assertOpen, patchBody, readBooks, updateBooks, updateBooksWithEffects, withBooks } from '../books.js';
import { addEntry } from '../edits.js';
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
  /** A camt export's payments, as the bank gave them (refs not yet made unique). */
  transactions?: BankTransaction[];
  /** The IBAN a camt export names for its account, compact. */
  iban?: string;
}

const refuse = (status: number, error: string, reason: StatementRefusal, detail?: string): never => {
  throw new RequestError(status, error, { code: 'statement', params: { reason, ...(detail ? { detail } : {}) } });
};

const imported = (): LedgerBankAccount[] => WS.bankAccounts.filter((a) => a.statements);

/** Why a statement lands on no account, in the words of the API's `error` (the UI says it in the person's language from `problem`). */
function wordsOf(p: StatementProblem): string {
  switch (p.kind) {
    case 'noAccount': return `Kein Bankkonto der Firma nimmt diesen Auszug (${p.currency}${p.iban ? `, IBAN ${p.iban}` : ''}). Das Konto unter Firma › Bankkonten anlegen.`;
    case 'otherIban': return `Der Auszug ist vom Konto IBAN ${p.iban}; das Bankkonto ${p.account.bank} ${p.currency} hat die IBAN ${p.account.iban}. Das Konto fehlt in den Büchern: unter Firma › Bankkonten anlegen.`;
    case 'twoAccounts': return `Unter ${p.bank} liegen Auszüge zweier ${p.currency}-Konten: IBAN ${p.ibans[0]} und IBAN ${p.ibans[1]}. Das zweite Konto unter Firma › Bankkonten anlegen.`;
    case 'whichAccount': return `Zu welchem ${p.currency}-Konto gehört der Auszug${p.iban ? ` (IBAN ${p.iban})` : ''}? ${p.accounts.map((a) => a.label).join(', ')} haben keine IBAN.`;
  }
}

const refusedAccount = (p: StatementProblem, unknown?: UnknownAccount, bankName?: string, owner?: string): RequestError =>
  new RequestError(400, wordsOf(p), { code: 'statement', params: { reason: 'account', detail: wordsOf(p), problem: p, ...(unknown ? { unknown: { ...unknown, ...(bankName ? { bankName } : {}), ...(owner ? { owner } : {}) } } : {}) } });

/**
 * A camt.053 asking which account it is of names the one whose bank it names, when exactly one
 * does (#208): by the IBANs the manifest and the folder's statements already show under each label.
 */
function withProposal(p: StatementProblem, statement: CamtStatement): StatementProblem {
  if (p.kind !== 'whichAccount') return p;
  const read = readBankStatements(WS).flatMap((f) => (f.status === 'read' && f.statement.iban ? [{ bank: f.account.bank, iban: f.statement.iban }] : []));
  const known = (bank: string) => [...WS.bankAccounts.filter((a) => a.bank === bank && a.iban).map((a) => a.iban!), ...read.filter((x) => x.bank === bank).map((x) => x.iban)];
  const proposed = proposedAccount(p, statement, known);
  return proposed ? { ...p, proposed } : p;
}

function placeCamt(body: Buffer, filename: string, hint?: LedgerBankAccount): Placed {
  let camt: ReturnType<typeof readCamt>;
  try { camt = readCamt(body.toString('utf8')); } catch { return refuse(400, 'Keine camt.053-Datei.', 'notCamt'); }
  if (camt.message !== 'camt.053' || !camt.statements.length) return refuse(400, 'Keine camt.053-Datei (Kontoauszug).', 'notCamt');
  let account: LedgerBankAccount | undefined;
  const dates: string[] = [];
  const closings: Array<{ date: string; amount: number }> = [];
  const openings: Array<{ date: string; amount: number }> = [];
  const transactions: BankTransaction[] = [];
  let iban: string | undefined;
  for (const statement of camt.statements) {
    // The account the person named takes a statement of its currency, unless an IBAN the books know says otherwise.
    const named = statement.iban ? parseIban(statement.iban) : undefined;
    const known = !!named && WS.bankAccounts.some((a) => a.iban === named && a.currency === statement.currency);
    const chosen = hint?.statements && !known && hint.currency === statement.currency && (!hint.iban || !named || hint.iban === named) ? { ...hint, statements: hint.statements } : undefined;
    const match = chosen ? { account: chosen } : accountForStatement(WS.bankAccounts, { iban: statement.iban, currency: statement.currency, folder: hint?.bank ?? '' });
    if ('problem' in match) throw refusedAccount(withProposal(match.refusal, statement), match.unknown, statement.bankName, statement.ownerName);
    const found = match.account;
    if (account && account.bank !== found.bank) return refuse(400, 'Die Datei hält Auszüge zweier Banken.', 'account');
    account = found;
    const stated = statement.iban ? compactIban(statement.iban) : undefined;
    iban ??= stated;
    // The folder's other statements name this account's IBAN when the manifest does not: another IBAN is another account.
    if (stated && !found.iban) {
      const first = readBankStatements(WS).find((f) => f.status === 'read' && f.account.bank === found.bank && f.account.currency === found.currency && f.statement.iban && compactIban(f.statement.iban) !== stated);
      if (first?.status === 'read') {
        const valid = parseIban(stated);
        const unknown = valid ? { iban: valid, currency: statement.currency } : undefined;
        throw refusedAccount({ kind: 'twoAccounts', currency: found.currency, bank: found.bank, ibans: [compactIban(first.statement.iban!), stated], ...(valid ? { iban: valid } : {}) }, unknown, statement.bankName, statement.ownerName);
      }
    }
    const balances = parseStatementBalances(statement, found.bank, filename);
    const mine = transactionsOf(statement, found);
    transactions.push(...mine);
    dates.push(...mine.map((t) => t.date), ...balances.map((b) => b.date));
    closings.push(...balances.filter((b) => b.type === 'CLBD').map((b) => ({ date: b.date, amount: b.amount })));
    openings.push(...balances.filter((b) => b.type === 'OPBD' && b.currency === match.account.currency).map((b) => ({ date: b.date, amount: b.amount })));
  }
  const sorted = dates.filter(Boolean).sort();
  const last = sorted.at(-1);
  if (!account || !last) return refuse(400, 'Der Auszug hat keine Daten.', 'notCamt');
  const closing = closings.sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const opening = openings.sort((a, b) => a.date.localeCompare(b.date))[0];
  return { account, filename, first: sorted[0], last, transactions, ...(iban ? { iban } : {}), ...(closing ? { closing } : {}), ...(opening ? { opening } : {}) };
}

/**
 * A statement reaching into a filed period may repeat payments the books hold (a year-to-date
 * export): those stay as filed. One it holds that the books lack cannot be added there (golden
 * rule 1), so the file is refused before anything is written, naming the payments and the first
 * open day a new export should start on.
 */
function assertNoFiledPayments(placed: Placed): void {
  const books = readBooks();
  const lock = periodLock(books);
  const through = books.config.closedThrough;
  if (!through || !placed.transactions) return;
  const key = (t: BankTransaction) => [t.bank, t.ref.split('~')[0], t.date, t.direction, t.amount.toFixed(2), t.currency].join('\u0000');
  const held = new Set(books.transactions.map(key));
  const missing = placed.transactions.filter((t) => lock.isClosed(t.date) && !held.has(key(t)));
  if (!missing.length) return;
  const refs = missing.map((t) => t.ref);
  throw new RequestError(403, `Der Auszug enthält ${missing.length} Zahlung${missing.length === 1 ? '' : 'en'} bis ${through}, die in den Büchern fehlen (${refs.slice(0, 5).join(', ')}). Die Periode ist eingereicht: nichts eingelesen. Einen Auszug ab dem ersten offenen Tag einlesen.`,
    { code: 'statement', params: { reason: 'filedPayments', closed: { n: missing.length, through, refs } } });
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
  if (!account) {
    const currency = named.currency ?? baseCurrency();
    // A PDF's name rarely gives its IBAN: then any account of its currency could be it.
    const open = (named.currency ? imported().filter((a) => a.currency === currency) : chf).filter((a) => !iban || !a.iban);
    if (open.length > 1) throw refusedAccount({ kind: 'whichAccount', currency, accounts: open.map((a) => ({ account: a.account, bank: a.bank, label: a.label })) });
    return refuse(400, 'Zu welchem Konto gehört der Auszug? Aus dem fehlenden Monat hinzufügen.', 'account');
  }
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
  assertNoFiledPayments(placed);

  const year = openYear(placed.last.slice(0, 4), readBooks().config.closedThrough);
  const dir = join(yearPaths(WS.paths, year).statements, placed.account.bank);
  const mine = `${placed.account.bank}/${placed.filename}`;
  const path = findFile(WS.paths, 'statements', mine) ?? join(dir, placed.filename);
  if (existsSync(path)) {
    const same = readFileSync(path).equals(body);
    throw new RequestError(409, same ? `${placed.filename} ist schon eingelesen.` : `Datei ${placed.filename} existiert bereits.`,
      same ? { code: 'statement', params: { reason: 'duplicate', detail: mine } } : { code: 'fileExists', params: { filename: placed.filename } });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, body);
  try {
    const bank = readTransactions(WS);
    const unmatched = bank.files.find((f) => f.status === 'unmatched');
    if (unmatched?.status === 'unmatched') throw refusedAccount(unmatched.refusal, unmatched.unknown);
    for (const f of bank.files) {
      if (f.status !== 'duplicate' || (f.file !== mine && f.of !== mine)) continue;
      const other = f.file === mine ? f.of : f.file;
      refuse(409, `Schon eingelesen aus ${other}.`, 'duplicate', other);
    }

    const wiseRefs = await readWiseReferences(WS);
    const balances = xml ? undefined : (await extractStatementBalances(partDirs(WS.paths, 'statements'), WS.bankAccounts)).balances;
    const invoices = loadInvoices(WS);
    const payments = paymentContext(WS);
    return updateBooksWithEffects((books): StatementImport => {
      assertOpen(books, [placed.last], 'newStatement');
      const before = new Set(books.transactions.map((t) => t.ref));
      const confirmedBefore = new Set(books.transactions.filter((t) => t.statement !== undefined).map((t) => t.ref));
      const fresh = assignUniqueRefs(withinBooks(bank.transactions, books.config).kept);
      const freshLegs = new Set(fresh.map(legOf));
      // An upload adds: a payment no file holds any more stays until extract's rebuild decides.
      const lock = periodLock(books);
      const stay = books.transactions.filter((t) => !madeByHand(t) && !freshLegs.has(legOf(t)) && !lock.isClosed(t.date));
      const files = readStatementFiles(WS);
      const merged = mergeIndex(books, { receipts: books.receipts, bankTransactions: [...fresh, ...stay], wiseRefs, bankStatements: files.statements, camtBalances: files.balances });
      // The books keep their order; the new payments come after them.
      const pos = new Map(books.transactions.map((t, i) => [t.ref, i]));
      const known = merged.index.transactions.filter((t) => pos.has(t.ref)).sort((a, b) => pos.get(a.ref)! - pos.get(b.ref)!);
      Object.assign(books, merged.index, { transactions: [...known, ...merged.index.transactions.filter((t) => !pos.has(t.ref))] });
      if (balances) books.statementBalances = mergeBalances(books.statementBalances, balances);
      // On the agreed basis an issued document's event comes first: its payment then only settles the receivable.
      const events = payments ? bookInvoiceEvents(books, invoices, payments) : undefined;
      if (events) fileReceipts(WS, books, events.files);
      const paid = payments ? matchPayments(books, invoices, payments) : undefined;
      if (paid) { fileReceipts(WS, books, paid.files); saveInvoices(WS, invoices); }
      const closing = placed.closing ?? balances?.filter((b) => b.sourceFile === placed.filename && b.account === placed.account.account)
        .sort((a, b) => a.date.localeCompare(b.date)).map((b) => ({ date: b.date, amount: b.amount })).at(-1);
      return {
        file: `${placed.account.bank}/${placed.filename}`,
        account: placed.account.account,
        month: placed.last.slice(0, 7),
        added: books.transactions.filter((t) => !before.has(t.ref)).length,
        ...confirmedCount(books.transactions.filter((t) => t.statement !== undefined && !confirmedBefore.has(t.ref)).length),
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

const confirmedCount = (n: number) => (n ? { confirmed: n } : {});

/** The refs a statement file alone brought: every ref the folder's files hold, less those the other files hold. */
function refsOnlyIn(file: string): string[] {
  const books = readBooks();
  const all = assignUniqueRefs(withinBooks(transactionsOfFiles(readBankStatements(WS).filter((f) => f.status === 'read')), books.config).kept).map((t) => t.ref);
  const held = refsHeldWithout(WS, file, books.config);
  return all.filter((ref) => !held.has(ref));
}

/**
 * A statement taken back (the drop dialog's «Rückgängig», the statement page's «Auszug entfernen»,
 * the toast after an import, r9k-3): its file, its closing balances, the payments it alone brought
 * (`refs`: as the import recorded them, else read from the folder) with their links and entries;
 * a payment another file on disk still holds (the bank's exports overlap) stays with its bookings,
 * and the statement list is read again from the folder. Never in the closed period, never over an
 * entry a person booked by hand (such a payment stays, and the refusal says so).
 */
export function removeStatement(file: string, refs?: readonly string[]): StatementRemoved {
  const path = findFile(WS.paths, 'statements', file);
  if (!path) throw new RequestError(404, `Den Auszug ${file} gibt es nicht.`, { code: 'gone', params: { what: 'file' } });
  const books = readBooks();
  const held = refsHeldWithout(WS, file, books.config);
  const mine = new Set((refs ?? refsOnlyIn(file)).filter((ref) => !held.has(ref)));
  assertOpen(books, [...mine].flatMap((ref) => refDates(books, ref)), 'deleteTransaction');
  if ((books.journalEntries ?? []).some((e) => mine.has(e.transactionRef) && e.origin === 'manual')) throw new RequestError(409, 'Auf einer dieser Zahlungen steht eine Buchung von Hand. Erst sie löschen.');
  const bytes = readFileSync(path);
  const lock = periodLock(books);
  rmSync(path, { force: true });
  try {
    return updateBooks((b) => {
      const removed = { entries: b.journalEntries.filter((e) => mine.has(e.transactionRef)), mappings: b.mappings.filter((m) => mine.has(m.transactionRef)) };
      b.transactions = b.transactions.filter((t) => !mine.has(t.ref));
      // A movement made by hand this statement confirmed stays, with its bookings, as not confirmed (#88).
      for (const t of b.transactions) if (t.statement !== undefined && mine.has(t.statement) && !lock.isClosed(t.date)) delete t.statement;
      b.journalEntries = b.journalEntries.filter((e) => !mine.has(e.transactionRef));
      b.mappings = b.mappings.filter((m) => !mine.has(m.transactionRef));
      const files = readStatementFiles(WS);
      b.bankStatements = files.statements;
      const balances = withCamtBalances(b.statementBalances?.filter((x) => x.sourceFile !== basename(file)), files.balances);
      if (balances) b.statementBalances = balances;
      else delete b.statementBalances;
      return { ok: true, removed };
    });
  } catch (e) {
    writeFileSync(path, bytes);
    throw e;
  }
}

/** What a removal took with the statement's payments: the undo puts them back once the file is read again (r10h-3). */
export interface StatementRemoved { ok: true; removed: { entries: JournalEntry[]; mappings: Mapping[] } }

/**
 * What a statement file read in says about itself (Kontoauszüge › Dateien, #208): its own words
 * (the bank, BIC, owner, the balances as stated) and the day it was read in (the file's time).
 */
router.get('/api/statements/:bank/:filename/details', (req, res) => {
  const file = `${req.params.bank}/${basename(req.params.filename)}`;
  const path = findFile(WS.paths, 'statements', file);
  if (!path) throw new RequestError(404, `Den Auszug ${file} gibt es nicht.`, { code: 'gone', params: { what: 'file' } });
  const details = statementDetails(readFileSync(path), basename(path));
  const importedAt = statSync(path).mtime.toISOString().slice(0, 10);
  res.json({ ...(details ? { details: { ...details, preview: [], more: 0 } } : {}), importedAt });
});

router.delete('/api/statements/:bank/:filename', (req, res) => {
  res.json(removeStatement(`${req.params.bank}/${basename(req.params.filename)}`));
});

/**
 * The undo of «Auszug entfernen», second half (r10h-3): after the file is read again, the bookings
 * and links the removal took go back as they were (who booked them included), no run in between.
 * An entry whose payment the books do not hold, or one booked meanwhile, is refused with the rest.
 */
router.post('/api/statements/bookings', (req, res) => {
  const b = patchBody(req.body, ['entries', 'mappings']);
  const entries = Array.isArray(b.entries) ? b.entries as JournalEntry[] : [];
  const mappings = Array.isArray(b.mappings) ? b.mappings as Mapping[] : [];
  for (const e of entries) if (!e || typeof e.id !== 'string' || typeof e.transactionRef !== 'string' || typeof e.date !== 'string') throw new RequestError(400, 'entries: Buchungen mit id, transactionRef und date.');
  for (const m of mappings) if (!m || typeof m.receiptId !== 'string' || typeof m.transactionRef !== 'string') throw new RequestError(400, 'mappings: receiptId und transactionRef.');
  withBooks(res, (books) => {
    assertOpen(books, entries.map((e) => e.date), 'newEntry');
    for (const e of entries) addEntry(books, { ...e, description: e.description ?? e.transactionRef });
    const refs = new Set(books.transactions.map((t) => t.ref));
    const receipts = new Set(books.receipts.map((r) => r.id));
    const has = (m: Mapping) => books.mappings.some((x) => x.receiptId === m.receiptId && x.transactionRef === m.transactionRef);
    for (const m of mappings) if (refs.has(m.transactionRef) && receipts.has(m.receiptId) && !has(m)) books.mappings.push(m);
    return { ok: true };
  });
});

/**
 * An account's opening balance of a year: a bank account's as its first statement offers it
 * (src/accounting/opening-balance.ts), any balance-sheet account's as Firma › Eröffnung types it
 * for the books' first year. `amount` sets it, null takes it back; the difference goes to retained
 * earnings. A year closed through 31.12. keeps its openings (a filed quarter does not: an opening is
 * in no VAT return and no seal); a later year is opened by the close of
 * the one before; a foreign-currency account also needs its native balance (npm run import-opening).
 */
router.put('/api/opening-balances/:year/:account', (req, res) => {
  const { year, account } = req.params;
  const amount: unknown = req.body?.amount;
  if (!/^\d{4}$/.test(year)) throw new RequestError(400, 'Kein Jahr.');
  if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount))) throw new RequestError(400, 'Betrag fehlt.');
  const equity = yearEndAccounts(chartOf(WS), WS.company.legalForm).resultTo;
  const side = chart().sideOf(account);
  const refuse = (reason: 'notBalanceSheet' | 'equity' | 'foreign', text: string) => new RequestError(400, text, { code: 'openingAccount', params: { account, reason } });
  if (side !== 'assets' && side !== 'liabilities') throw refuse('notBalanceSheet', `Konto ${account} ist kein Bilanzkonto.`);
  if (account === equity) throw refuse('equity', `Konto ${account} nimmt die Differenz der Eröffnung auf.`);
  if (WS.bankAccounts.some((a) => a.account === account && a.currency !== baseCurrency())) throw refuse('foreign', `Konto ${account} führt eine Fremdwährung: npm run import-opening.`);
  withBooks(res, (books) => {
    const lock = openingLock(books, year);
    if (lock === 'closed') throw new RequestError(403, `${year} ist bis zum 31.12. abgeschlossen: seine Eröffnung bleibt, wie sie ist.`, { code: 'openingYearClosed', params: { year } });
    if (lock) throw new RequestError(400, `${year} ist nicht das erste Jahr dieser Bücher: der Abschluss des Vorjahres eröffnet es.`, { code: 'openingNotFirstYear', params: { year } });
    const next = withOpening(books.config.openingBalances, year, account, amount, equity, side === 'liabilities');
    if (next) books.config.openingBalances = next;
    else delete books.config.openingBalances;
    return { ok: true };
  });
});
