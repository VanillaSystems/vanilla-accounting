/**
 * A bank statement added from the UI (Kontoauszüge, the add button, N or a drop): a camt.053 XML
 * or a monthly statement PDF goes into bank-statements/<bank>/ under the name the CLI reads, and
 * the bank side of the books is read again from that folder as `npm run extract` reads it
 * (src/books/bank-import.ts), invoice payments matched by their reference. A statement read
 * without camt.053 (#217) comes as the camt.053 the app wrote from it, with the file it was read
 * from kept beside it under the same name. A statement wholly inside a filed quarter is refused
 * before anything is written.
 */
import express, { Router } from 'express';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { accountForStatement, type StatementProblem } from '../../accounting/bank-accounts.js';
import { bankAccountFor, legOf } from '../../workspace/money-accounts.js';
import { heldWithout, mergeBankFiles, readStatementFiles, readTransactions, reconcileWithFiles, sourceOf, structuredSpans, transactionsOfFiles, withCamtBalances, withinBooks, type RateOf } from '../../books/bank-import.js';
import { besidePath } from '../../books/pdf-reads.js';
import { keepAskTable } from '../statement-asks.js';
import { cancelReads, forgetRead, pdfFacts, readsView, saveTable, startReads } from '../statement-reads.js';
import { statementPdf } from '../../books/statement-facts.js';
import { compactIban, readBankStatements } from '../../workspace/bank-statements.js';
import { periodLock, type Books } from '../../books/store.js';
import { loadFxResolver } from '../../accounting/fx-rates.js';
import { rateDateOf } from '../../accounting/fx-conversion.js';
import { openYear } from '../../books/years.js';
import { assignUniqueRefs, readCamt, transactionsOf, type CamtStatement } from '../../providers/camt053/camt053.js';
import { proposedAccount } from '../../accounting/statement-bank.js';
import { statementDetails } from '../../providers/statement-files.js';
import { refDates } from '../books.js';
import { parseStatementBalances } from '../../providers/camt053/statement-balances.js';
import { loadInvoices, saveInvoices } from '../../invoices/store.js';
import { placeByText } from '../../intake/statement-read.js';
import { firstPages } from '../../intake/recognize.js';
import { matchPayments } from '../../invoices/payments.js';
import { confirm, lostWithFile, ReconcileRefused, releaseTwins } from '../reconcile.js';
import { bookedInFiled } from '../../books/twins.js';
import { pending } from '../../books/reconcile.js';
import { bookInvoiceEvents } from '../../invoices/events.js';
import { fileReceipts, paymentContext } from '../../invoices/service.js';
import type { StatementRefusal, UnknownAccount } from '../../types/api-error.js';
import type { BankTransaction, JournalEntry, Mapping, StatementClosingBalance, StatementImport } from '../../types/index.js';
import { parseIban } from '../../workspace/banks.js';
import { findFile, yearPaths, type LedgerBankAccount } from '../../workspace/workspace.js';
import { RequestError, WS, assertOpen, patchBody, readBooks, updateBooks, updateBooksWithEffects, withBooks } from '../books.js';
import { addEntry } from '../edits.js';
import { askAbout, closeAsk, correctAsk, importAsk } from '../statement-asks.js';
import { openingLock, withOpening } from '../../accounting/opening-balance.js';
import { yearEndAccounts } from '../../accounting/year-close.js';
import { chartOf, differenceAccountOf } from '../../books/year-close.js';
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
  /** A camt.053 the app wrote from a statement read without one (#217): its movements carry no bank reference. */
  read?: boolean;
  /** A bank's own camt.053, or one the app wrote from a bank CSV: a structured source of its account (#254). */
  structured?: boolean;
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
  const read = camt.statements.some((s) => s.read);
  const structured = camt.statements.every((s) => sourceOf(s) !== 'pdf');
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
  return { account, filename, first: sorted[0], last, transactions, ...(iban ? { iban } : {}), ...(closing ? { closing } : {}), ...(opening ? { opening } : {}), ...(read ? { read } : {}), ...(structured ? { structured } : {}) };
}

/**
 * A statement reaching into a filed period may repeat payments the books hold (a year-to-date
 * export, a bank export of days a PDF was read for, #254): those stay as filed. One it would add
 * there (golden rule 1) refuses the file, naming the payments and the first open day a new export
 * should start on. Decided by the merge's own rule: the folder's files as they are now, the new one
 * written, give each payment its ref (transactionsOfFiles); one dated in the filed period whose ref
 * the books lack, and no movement by hand stands for, would be new.
 */
function assertNoFiledPayments(): void {
  const books = readBooks();
  const lock = periodLock(books);
  const through = books.config.closedThrough;
  if (!through) return;
  const legs = new Set(books.transactions.map(legOf));
  const claimed = new Set(books.transactions.flatMap((t) => (t.statement === undefined ? [] : [`${t.statement} ${t.currency}`])));
  const fresh = assignUniqueRefs(withinBooks(readTransactions(WS).transactions, books.config).kept);
  const missing = fresh.filter((t) => lock.isClosed(t.date) && !legs.has(legOf(t)) && !claimed.has(legOf(t)));
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
function placePdf(filename: string, hint?: LedgerBankAccount, month?: string, days?: { from: string; to: string }): Placed {
  const named = statementPdf(filename);
  if (!named) {
    if (!hint || (!month && !days)) return refuse(400, 'Der Dateiname sagt nicht, welchen Monat der Auszug zeigt.', 'name');
    // The days the statement itself shows when they are known (#254), else its whole month.
    const from = days?.from ?? `${month}-01`, to = days?.to ?? monthEnd(month!);
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

/**
 * The account and month a statement PDF is kept for without a question (#254): its text or name names
 * the account and its days, and a camt.053 or bank CSV of that account is in the books. Undefined when
 * the file does not say, or the account has none: then it is read.
 */
export function keptAsStatement(text: string, name: string): { account: string; month: string; days: { from: string; to: string } } | undefined {
  const { account, period } = placeByText(text, name, WS.bankAccounts);
  if (!account || !period) return undefined;
  return structuredSpans(WS).some((s) => s.account === account.account) ? { account: account.account, month: period.to.slice(0, 7), days: period } : undefined;
}

router.post('/api/statements', express.raw({ type: () => true, limit: '50mb' }), async (req, res) => {
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) throw new RequestError(400, 'Keine Datei erhalten.');
  const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : undefined;
  const name = basename(String(req.query.name ?? '')).trim();
  // A PDF of an account a camt.053 or bank CSV feeds is kept as its statement without a question (#254); any other is read in the drop dialog, as a dropped one is (#217). `keep=1` keeps it as the month's statement (the undo of «Auszug entfernen»).
  if (/\.pdf$/i.test(name) && req.query.keep !== '1') {
    const kept = keptAsStatement(await firstPages(body) ?? '', name);
    if (!kept) refuse(409, 'Das Konto dieses Auszugs hat kein camt.053 und keine CSV: er wird im Ablage-Dialog gelesen.', 'read');
    else return void res.json(await importStatement(body, name, kept.account, month ?? kept.month, undefined, month ? undefined : kept.days));
  }
  res.json(await importStatement(body, name, typeof req.query.account === 'string' ? req.query.account : undefined, month));
});

/**
 * Reads one statement file (camt.053 or a PDF) into the books: placed by its account and month,
 * refused as a RequestError when it belongs to no account, lies in a closed period or is read
 * already. The Bank area's upload and the drop dialog both take this one way in. `days`: those a PDF
 * whose name does not say shows, for its name (else its `month`'s). `source`: the file
 * a camt.053 the app wrote was read from (#217), written beside it under the same stem (refused when
 * a file of that name is there); the import's failure removes only what it wrote.
 */
export async function importStatement(body: Buffer, given: string, accountHint?: string, month?: string, source?: { ext: string; bytes: Buffer }, days?: { from: string; to: string }): Promise<StatementImport> {
  const name = basename(given).trim();
  const hint = imported().find((a) => a.account === accountHint);
  const xml = /\.xml$/i.test(name);
  if (!xml && !/\.pdf$/i.test(name)) refuse(400, 'Nur camt.053 (XML) oder PDF.', 'format');
  const placed = xml ? placeCamt(body, name, hint) : placePdf(name, hint, month, days);
  assertOpen(readBooks(), [placed.last], 'newStatement');

  const year = openYear(placed.last.slice(0, 4), readBooks().config.closedThrough);
  const dir = join(yearPaths(WS.paths, year).statements, placed.account.bank);
  const mine = `${placed.account.bank}/${placed.filename}`;
  const path = findFile(WS.paths, 'statements', mine) ?? join(dir, placed.filename);
  if (existsSync(path)) {
    const same = readFileSync(path).equals(body);
    throw new RequestError(409, same ? `${placed.filename} ist schon eingelesen.` : `Datei ${placed.filename} existiert bereits.`,
      same ? { code: 'statement', params: { reason: 'duplicate', detail: mine } } : { code: 'fileExists', params: { filename: placed.filename } });
  }
  // The file a written camt.053 was read from goes beside it under its stem: never over a file of that name, nor taking one up as its own (drop.ts gives the read a free stem).
  const beside = source && xml ? path.replace(/\.xml$/i, `.${source.ext}`) : undefined;
  if (beside && existsSync(beside)) throw new RequestError(409, `Datei ${basename(beside)} existiert bereits.`, { code: 'fileExists', params: { filename: basename(beside) } });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, body);
  if (beside && source) writeFileSync(beside, source.bytes);
  try {
    assertNoFiledPayments();
    const bank = readTransactions(WS);
    const unmatched = bank.files.find((f) => f.status === 'unmatched');
    if (unmatched?.status === 'unmatched') throw refusedAccount(unmatched.refusal, unmatched.unknown);
    for (const f of bank.files) {
      if (f.status !== 'duplicate' || (f.file !== mine && f.of !== mine)) continue;
      const other = f.file === mine ? f.of : f.file;
      refuse(409, `Schon eingelesen aus ${other}.`, 'duplicate', other);
    }

    const invoices = loadInvoices(WS);
    const payments = paymentContext(WS);
    return updateBooksWithEffects((books): StatementImport => {
      assertOpen(books, [placed.last], 'newStatement');
      // The account's PDFs waiting for their question are its statements now, a filed period's too: closing a question books nothing.
      const asked = (books.statementAsks ?? []).length;
      if (placed.structured && books.statementAsks) {
        // Their tables stay theirs (#243): kept beside each PDF, so the books take its balance and references and no model reads it again.
        for (const a of books.statementAsks.filter((x) => x.account === placed.account.account)) keepAskTable(a);
        books.statementAsks = books.statementAsks.filter((a) => a.account !== placed.account.account);
        if (!books.statementAsks.length) delete books.statementAsks;
      }
      const before = new Set(books.transactions.map((t) => t.ref));
      const confirmedBefore = new Set(books.transactions.filter((t) => t.statement !== undefined).map((t) => t.ref));
      mergeBankFiles(WS, books);
      // Movements read from PDFs and the bank's file of the same days: the account's reconciliation, before any run books them (#254).
      reconcileWithFiles(WS, books, differenceAccountOf(WS));
      const waiting = pending(books).find((r) => r.account === placed.account.account);
      const closedAsks = asked - (books.statementAsks ?? []).length;
      // On the agreed basis an issued document's event comes first: its payment then only settles the receivable.
      const events = payments ? bookInvoiceEvents(books, invoices, payments) : undefined;
      if (events) fileReceipts(WS, books, events.files);
      const paid = payments ? matchPayments(books, invoices, payments) : undefined;
      if (paid) { fileReceipts(WS, books, paid.files); saveInvoices(WS, invoices); }
      // A kept PDF's closing balance comes from its table once it is read (#243); a camt.053's balance of its last day stands over it.
      const own = books.statementBalances?.filter((b) => b.sourceFile === placed.filename && b.account === placed.account.account).sort((a, b) => a.date.localeCompare(b.date)).at(-1)
        ?? books.statementBalances?.find((b) => b.source === 'camt' && b.account === placed.account.account && b.date === placed.last);
      const closing = placed.closing ?? (own && { date: own.date, amount: own.amount });
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
        ...(waiting ? { reconcile: { read: waiting.read.length, bank: waiting.bank.length } } : {}),
        ...(closedAsks ? { closedAsks } : {}),
      };
    });
  } catch (e) {
    rmSync(path, { force: true });
    if (beside) rmSync(beside, { force: true });
    throw e;
  }
}

const confirmedCount = (n: number) => (n ? { confirmed: n } : {});

/** The refs a statement file alone brought: every ref the folder's files hold, less those the other files hold. */
function refsOnlyIn(file: string): string[] {
  const books = readBooks();
  const all = assignUniqueRefs(withinBooks(transactionsOfFiles(readBankStatements(WS).filter((f) => f.status === 'read')), books.config).kept).map((t) => t.ref);
  const { held, moves } = heldWithout(WS, file, books.config);
  return all.filter((ref) => !held.has(ref) && !moves.has(ref));
}

/**
 * A statement taken back (the drop dialog's «Rückgängig», the statement page's «Auszug entfernen»,
 * the toast after an import, r9k-3): its file, its closing balances, the payments it alone brought
 * (`refs`: as the import recorded them, else read from the folder) with their links and entries;
 * a payment another file on disk still holds (the bank's exports overlap) stays with its bookings,
 * and the statement list is read again from the folder. Never in the closed period, never over an
 * entry a person booked by hand (such a payment stays, and the refusal says so).
 */
export function removeStatement(file: string, refs?: readonly string[], o: { keepPdf?: boolean } = {}): StatementRemoved {
  const path = findFile(WS.paths, 'statements', file);
  if (!path) throw new RequestError(404, `Den Auszug ${file} gibt es nicht.`, { code: 'gone', params: { what: 'file' } });
  const books = readBooks();
  const { held, moves } = heldWithout(WS, file, books.config);
  const mine = new Set((refs ?? refsOnlyIn(file)).filter((ref) => !held.has(ref) && !moves.has(ref)));
  // A payment of a statement read without camt.053 that a bank export holds too stays, under the export's ref (#217).
  const moved = [...moves].filter(([was, t]) => books.transactions.some((x) => x.ref === was) && !books.transactions.some((x) => x.ref === t.ref));
  assertOpen(books, [...mine, ...moved.map(([was]) => was)].flatMap((ref) => refDates(books, ref)), 'deleteTransaction');
  // A bank movement a confirmed reconciliation set in a read movement's place (#254): the read one left the books, and its row brings nothing again, so the payment, its entries and links would be lost.
  const twins = lostWithFile(books, mine);
  if (twins.length) throw new RequestError(409, `Der bestätigte Abgleich hat aus PDFs gelesene Bewegungen durch Bewegungen dieses Auszugs ersetzt (${twins.slice(0, 5).join(', ')}): er bleibt.`, { code: 'reconciledTwins', params: { refs: twins } });
  if ((books.journalEntries ?? []).some((e) => mine.has(e.transactionRef) && e.origin === 'manual')) throw new RequestError(409, 'Auf einer dieser Zahlungen steht eine Buchung von Hand. Erst sie löschen.');
  const bytes = readFileSync(path);
  const lock = periodLock(books);
  // A camt.053 the app wrote from a statement read without one (#217) takes the file it was read from along.
  const from = /\.xml$/i.test(path) ? readCamtSafe(bytes)?.statements.find((x) => x.read)?.read?.from : undefined;
  const beside = from ? join(dirname(path), basename(from)) : undefined;
  // `keepPdf`: only the reading goes (the undo of «Bewegungen aus dem PDF einlesen», #254); the PDF stays the statement.
  const besideBytes = !o.keepPdf && beside && existsSync(beside) && beside !== path ? readFileSync(beside) : undefined;
  // A kept statement PDF takes its table along (#243).
  const read = /\.pdf$/i.test(path) && existsSync(besidePath(path)) ? besidePath(path) : undefined;
  const readBytes = read ? readFileSync(read) : undefined;
  rmSync(path, { force: true });
  if (besideBytes) rmSync(beside!, { force: true });
  if (read) rmSync(read, { force: true });
  try {
    return updateBooks((b) => {
      const removed = { entries: b.journalEntries.filter((e) => mine.has(e.transactionRef)), mappings: b.mappings.filter((m) => mine.has(m.transactionRef)) };
      b.transactions = b.transactions.filter((t) => !mine.has(t.ref));
      // A movement made by hand this statement confirmed stays, with its bookings, as not confirmed (#88).
      for (const t of b.transactions) if (t.statement !== undefined && mine.has(t.statement) && !lock.isClosed(t.date)) delete t.statement;
      b.journalEntries = b.journalEntries.filter((e) => !mine.has(e.transactionRef));
      b.mappings = b.mappings.filter((m) => !mine.has(m.transactionRef));
      releaseTwins(b, mine);
      for (const [was, now] of moved) {
        const t = b.transactions.find((x) => x.ref === was);
        if (!t) continue;
        t.ref = now.ref;
        if (now.bankTxId) t.bankTxId = now.bankTxId;
        else delete t.bankTxId;
        for (const e of b.journalEntries) if (e.transactionRef === was) e.transactionRef = now.ref;
        for (const m of b.mappings) if (m.transactionRef === was) m.transactionRef = now.ref;
        for (const x of b.transactions) if (x.statement === was) x.statement = now.ref;
      }
      const files = readStatementFiles(WS);
      b.bankStatements = files.statements;
      const balances = withCamtBalances(b.statementBalances?.filter((x) => x.sourceFile !== basename(file)), files.balances);
      if (balances) b.statementBalances = balances;
      else delete b.statementBalances;
      reconcileWithFiles(WS, b, differenceAccountOf(WS));
      return { ok: true, removed };
    });
  } catch (e) {
    writeFileSync(path, bytes);
    if (besideBytes) writeFileSync(beside!, besideBytes);
    if (read && readBytes) writeFileSync(read, readBytes);
    throw e;
  }
}

const readCamtSafe = (bytes: Buffer) => { try { return readCamt(bytes.toString('utf8')); } catch { return undefined; } };

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
  res.json(removeStatement(`${req.params.bank}/${basename(req.params.filename)}`, undefined, { keepPdf: req.query.keepPdf === '1' }));
});

/** A kept statement PDF's question (#254, src/server/statement-asks.ts). */
const pdfOf = (req: express.Request) => `${req.params.bank}/${basename(String(req.params.filename))}`;

/** «Bewegungen aus dem PDF einlesen»: read now (the model, or the hand form) and kept as the PDF's question. */
router.post('/api/statements/:bank/:filename/read', async (req, res) => {
  res.json(await askAbout(pdfOf(req)));
});

/** The question's table as the person corrected it: checked again and kept. */
router.put('/api/statements/:bank/:filename/read', (req, res) => {
  res.json(correctAsk(pdfOf(req), (req.body as { statement?: unknown } | undefined)?.statement));
});

/** «Einlesen»: the table written as a camt.053 beside the PDF and read in; the question goes. */
router.post('/api/statements/:bank/:filename/read/import', async (req, res) => {
  res.json(await importAsk(pdfOf(req), (req.body as { statement?: unknown } | undefined)?.statement, (body, name, account) => importStatement(body, name, account)));
});

/** «Als Auszug behalten»: the PDF stays the statement, its movements are not read in. */
router.delete('/api/statements/:bank/:filename/read', (req, res) => {
  closeAsk(pdfOf(req));
  res.json({ ok: true });
});

/** What a kept statement PDF gives the books: its closing balance, the references and foreign amounts it adds, or why it has none yet (#243, src/server/statement-reads.ts). */
router.get('/api/statements/:bank/:filename/facts', (req, res) => {
  res.json(pdfFacts(pdfOf(req)));
});

/** Its table as a person filled it in or corrected it: kept as hers. */
router.put('/api/statements/:bank/:filename/facts', (req, res) => {
  res.json(saveTable(pdfOf(req), (req.body as { statement?: unknown } | undefined)?.statement));
});

/** «Neu lesen»: its read goes, the next reading asks the model again; a person's table only with `?confirmed=1`. */
router.delete('/api/statements/:bank/:filename/facts', (req, res) => {
  res.json(forgetRead(pdfOf(req), req.query.confirmed === '1'));
});

/** The kept statement PDFs not read yet and the reading the person started. */
router.get('/api/statement-reads', async (_req, res) => {
  res.json(await readsView());
});

/** «N Kontoauszüge von der KI lesen lassen?» answered yes: those not read yet (`files`: only these), one after the other. */
router.post('/api/statement-reads', async (req, res) => {
  const files = (req.body as { files?: unknown } | undefined)?.files;
  res.json(await startReads(Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : undefined));
});

/** «Abbrechen»: the reading stops after the file being read. */
router.delete('/api/statement-reads', async (_req, res) => {
  cancelReads();
  res.json(await readsView());
});

/**
 * «Trotzdem buchen» on a bank movement booked in a filed quarter as a movement read from a PDF (#254):
 * the person says it is a payment of its own. The mark goes, and with it a difference line its answer
 * booked; from then on it is booked like any other payment.
 */
router.delete('/api/transactions/:ref/filed-twin', (req, res) => {
  withBooks(res, (books) => {
    const t = books.transactions.find((x) => x.ref === req.params.ref);
    if (t) assertOpen(books, [t.date], 'editTransaction');
    if (!t || !bookedInFiled(t)) throw new RequestError(404, 'Diese Bewegung ist nicht im abgerechneten Quartal gebucht.', { code: 'gone', params: { what: 'payment' } });
    delete t.waitsForPerson;
    books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== t.ref);
    return { ok: true };
  });
});

/** A foreign entry's ESTV sell rate of its rate day (ADR 0001), from the rate table. */
function estvRate(): RateOf {
  const fx = loadFxResolver();
  return (e, days) => fx.daily(e.exchangeCurrency!, rateDateOf(e, days));
}

/**
 * «Abgleich bestätigen» (#254): the account's reconciliation that waits, as the person decided it
 * (src/server/reconcile.ts confirm): `pairs`, each movement read from a PDF and the bank's movement it
 * is (`account`: where a filed pair's difference goes), and `own`, those that are payments of their own.
 * Nothing filed changes: a filed read movement stays as it was filed.
 */
router.post('/api/reconciliations/:account', (req, res) => {
  const body = (req.body ?? {}) as { pairs?: unknown; own?: unknown };
  const pairs = Array.isArray(body.pairs) ? body.pairs : [];
  const own = Array.isArray(body.own) ? body.own : [];
  const ref = (x: unknown) => typeof x === 'string' && x.length > 0;
  if (!pairs.every((p) => p && ref(p.read) && ref(p.bank) && (p.account === undefined || ref(p.account))) || !own.every(ref)) throw new RequestError(400, 'pairs: [{ read, bank, account? }], own: [refs].');
  const ctx = paymentContext(WS);
  const book = ctx ? loadInvoices(WS) : undefined;
  // The invoice PDFs are filed and the invoices saved only once the books are: a stale save is refused, never run twice.
  let saved: Books | undefined;
  const files = updateBooksWithEffects((books) => {
    saved = books;
    const r = pending(books).find((x) => x.account === req.params.account);
    if (!r) throw new RequestError(404, 'Dieses Konto wartet auf keinen Abgleich.', { code: 'gone', params: { what: 'payment' } });
    const lock = periodLock(books);
    // No assertOpen over its movements: a filed one may take part (a bank movement of 28.09 filed, a PDF read for 02.10), and confirm leaves it as filed; the write door refuses any change to it.
    try {
      return confirm(books, r, { pairs: pairs as { read: string; bank: string; account?: string }[], own: own as string[] }, {
        rateOf: estvRate(), isClosed: lock.isClosed, chart: new Set(chartOf(WS)), bankOf: (t) => bankAccountFor(t, WS.bankAccounts), today: new Date().toISOString().slice(0, 10),
        ...(book && ctx ? { invoices: { book, ctx } } : {}),
      });
    } catch (e) {
      if (e instanceof ReconcileRefused) throw new RequestError(e.status, e.message, { code: e.code, params: e.params } as never);
      throw e;
    }
  });
  if (book && saved) {
    fileReceipts(WS, saved, files);
    saveInvoices(WS, book);
  }
  res.json({ ok: true });
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
