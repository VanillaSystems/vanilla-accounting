/**
 * The drop dialog's session (docs/0.4.0/intake.md): each file dropped while it is open is
 * recognized and, when nothing is unclear about it, taken at once: a receipt or photo into the
 * inbox, a statement read into the books as the Bank area reads it, what is no receipt into
 * data/quarantine/ with its reason. Each taken file is handed to the inbox's run with what it is
 * (an Arrival); one dropped while that run is under way goes to the run that waits behind it. A
 * file with an open question (a password, a duplicate by its bytes or its facts, unknown content) waits in data/drop/<session>/
 * (outside git) for its answer. «Rückgängig» takes a taken file back out. A ZIP's password is used
 * to unpack it and never written anywhere.
 *
 *   POST   /api/drop                      a new session
 *   POST   /api/drop/:id/files?name=      add a file (a ZIP is unpacked into its files), taken at once
 *   POST   /api/drop/:id/rows/:key        a DropAction on one row
 *   DELETE /api/drop/:id                  close the dialog (what was taken stays)
 */
import express, { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { RequestError, WS, assertOpen, readBooks, receiptDates, receiptPath, reopenWorkspace, updateBooks } from '../books.js';
import { findFile, partDirs, type LedgerBankAccount } from '../../workspace/workspace.js';
import { patchManifest } from '../../workspace/manifest-write.js';
import { compactIban } from '../../workspace/bank-statements.js';
import { INTAKE, bookAgain, engine, handedOver } from './automation.js';
import { removeReceipt } from '../../accounting/classify-force.js';
import { importStatement, removeStatement } from './statements.js';
import { statementDetails } from '../../providers/statement-files.js';
import { accountOfRead, keepCsv, keptCsv, placeByText, readDays } from '../../intake/statement-read.js';
import { askAbout, assertImportable, closeAsk, correctAsk, heldOfRead, importAsk, keepAsk, readAsXml, readPdf, readRefusal, readView, structuredAccount } from '../statement-asks.js';
import { csvStatement, csvTable, guessColumns, MAX_CSV_ROWS } from '../../providers/statement-read/csv.js';
import { parseReadStatement } from '../../books/statement-check.js';
import { imageToPdf, isImageFile } from '../../parsers/image-pdf.js';
import type { CsvColumns, ReadStatement } from '../../types/statement-read.js';
import type { StatementImport } from '../../types/index.js';
import { importSalesReport, recognizeCsv, removeSalesReport, setProviderAccount } from '../../intake/sales-report-import.js';
import { accountName, removeAccount, setAccountName } from '../../workspace/accounts-write.js';
import { assertPlaced } from '../edits.js';
import { asHerAct, bookPayouts, readyPayouts } from '../provider-payouts.js';
import { bookingWaits } from '../booking-waits.js';
import { keepWaitingReport, takeWaitingReportsIfOn } from '../waiting-reports.js';

import type { Arrival } from '../../workflows/model.js';
import { firstPages, recognize } from '../../intake/recognize.js';
import { unzip } from '../../intake/unzip.js';
import { freeName, putInQuarantine, release } from '../../intake/quarantine.js';
import { twinFinder, type Comparable } from '../../intake/duplicates.js';
import { textFacts } from '../../parsers/receipt-text.js';
import { baseCurrency, documents } from '../../engines/index.js';
import { periodLock } from '../../books/store.js';
import type { DropAction, DropRow, DropSession, QuarantineReason } from '../../types/drop.js';

export const router = Router();

const isSupporting = (why: DropRow['document']) => why === 'order-confirmation' || why === 'delivery-note' || why === 'reminder' || why === 'customs-assessment' || why === 'balance-sheet';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dir = (id: string) => join(WS.paths.data, 'drop', id);
const fileOf = (id: string, key: string) => join(dir(id), 'files', key);
/** A row's text, read at drop: what a later row of the session is compared with. */
const textOf = (id: string, key: string) => join(dir(id), 'texts', key);
const sha16 = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);

function load(id: string): DropSession {
  if (!ID.test(id) || !existsSync(join(dir(id), 'session.json'))) throw new RequestError(404, 'Diese Ablage gibt es nicht mehr.');
  return JSON.parse(readFileSync(join(dir(id), 'session.json'), 'utf8')) as DropSession;
}
const save = (s: DropSession) => writeFileSync(join(dir(s.id), 'session.json'), JSON.stringify(s, null, 2));

/** Ids the books or the inbox hold already: a file with one of them is a duplicate. */
function known(): Set<string> {
  const ids = new Set(readBooks().receipts.map((r) => r.id));
  if (existsSync(WS.paths.inbox)) for (const f of readdirSync(WS.paths.inbox)) ids.add(sha16(readFileSync(join(WS.paths.inbox, f))));
  return ids;
}

/** One file as a row (stored in the session unless refused); a ZIP becomes the rows of its files. */
async function add(s: DropSession, name: string, bytes: Buffer, from?: string, password?: string): Promise<void> {
  const id = sha16(bytes);
  const seen = new Set([...known(), ...s.rows.filter((r) => r.state !== 'refused' && r.state !== 'undone').map((r) => r.id)]);
  const { text, ...r } = await recognize(bytes, name, undefined, (b) => recognizeCsv(WS, b));
  const row: DropRow = { key: randomUUID().slice(0, 8), id, name, size: bytes.length, ...(from ? { from } : {}), ...r };
  if (row.kind === 'zip') {
    const out = await unzip(bytes, password);
    if (out.ok) { for (const f of out.files) await add(s, f.name, f.bytes, name); return; }
    if (out.locked) { s.rows.push({ ...row, state: 'locked', ...(out.reason ? { reason: out.reason } : {}) }); writeFileSync(fileOf(s.id, row.key), bytes); return; }
    s.rows.push({ ...row, state: 'refused', reason: out.reason });
    return;
  }
  if (row.state !== 'refused' && seen.has(id)) Object.assign(row, { state: 'duplicate', reason: 'duplicate' });
  if (row.state === 'take' && row.kind === 'receipt' && text) {
    const twin = twinOf(s, row, text);
    if (twin) Object.assign(row, { twin }, twin.relation === 'duplicate' ? { state: 'duplicate', reason: 'possible-duplicate' } : {});
    mkdirSync(join(dir(s.id), 'texts'), { recursive: true });
    writeFileSync(textOf(s.id, row.key), text);
  }
  if (row.state !== 'refused') writeFileSync(fileOf(s.id, row.key), bytes);
  s.rows.push(row);
}

/**
 * A receipt of the books, or a file of this session, whose facts a new PDF repeats or accompanies
 * (src/intake/duplicates.ts). Here, at the drop, because a digital PDF's text and its plain facts
 * are there before anything is written, so the person answers in the row; a photo's text comes
 * only from the run's reading, whose matching step asks the same question before it links.
 */
function twinOf(s: DropSession, row: DropRow, text: string): DropRow['twin'] {
  const facts = (t: string) => { const f = textFacts(t); return { date: f.date, amount: f.amount, currency: f.currency, vatId: f.vatId }; };
  const rows = s.rows.filter((r) => r.state !== 'refused' && r.state !== 'undone' && r.state !== 'quarantine' && existsSync(textOf(s.id, r.key)));
  const own: Comparable[] = rows.map((r) => { const t = readFileSync(textOf(s.id, r.key), 'utf8'); return { id: r.id, extractedText: t, ...facts(t), ...(isSupporting(r.document) ? { kind: 'supporting' as const } : {}) }; });
  const books = readBooks().receipts;
  const me: Comparable = { id: row.id, extractedText: text, ...facts(text), ...(isSupporting(row.document) ? { kind: 'supporting' as const } : {}) };
  const twin = twinFinder([...books, ...own], documents()).find(me);
  if (!twin) return undefined;
  const name = books.find((r) => r.id === twin.of)?.filename ?? rows.find((r) => r.id === twin.of)?.name ?? twin.of;
  return { ...twin, name };
}

/** Each session's requests in turn, by its id: the previous one's end, kept until the queue is empty. */
const queues = new Map<string, Promise<unknown>>();

/**
 * One session's requests one after another (#208). Each loads the session file, changes it while
 * it reads files into the books (which awaits), and saves it: two at once would each save their own
 * copy and lose the other's change, so a statement answered while the drop's next file was still
 * coming in fell back to asking, and the second answer found it read in already.
 */
function inSession<T>(id: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(id) ?? Promise.resolve()).then(work);
  const end = run.then(() => undefined, () => undefined);
  queues.set(id, end);
  void end.then(() => { if (queues.get(id) === end) queues.delete(id); });
  return run;
}

router.post('/api/drop', (_req, res) => {
  const s: DropSession = { id: randomUUID(), rows: [] };
  mkdirSync(join(dir(s.id), 'files'), { recursive: true });
  save(s);
  res.json(s);
});

router.post('/api/drop/:id/files', express.raw({ type: () => true, limit: '200mb' }), (req, res) => inSession(req.params.id, async () => {
  const s = load(req.params.id);
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || !body.length) throw new RequestError(400, 'Keine Datei erhalten.');
  const name = basename(String(req.query.name ?? '')).replace(/[\u0000-\u001f]/g, '').trim().slice(-160) || 'datei';
  await add(s, name, body);
  await takeWaiting(s);
  save(s);
  res.json(s);
}));

router.post('/api/drop/:id/rows/:key', (req, res) => inSession(req.params.id, async () => {
  const s = load(req.params.id);
  const row = s.rows.find((r) => r.key === req.params.key);
  if (!row) throw new RequestError(404, 'Diese Zeile gibt es nicht.');
  const a = req.body as DropAction;
  const settled = row.state === 'taken' || row.state === 'undone';
  /** The provider whose payouts her answer may decide (#404). */
  let answered: { id: string; name: string } | undefined;
  switch (a?.kind) {
    case 'remove':
      if (settled) throw new RequestError(400, 'Schon übernommen: «Rückgängig» nimmt es zurück.');
      // A PDF kept with its question (#254) goes out of the books with it.
      if (row.asked) dropAsked(row);
      s.rows = s.rows.filter((r) => r !== row);
      rmSync(fileOf(s.id, row.key), { force: true });
      break;
    case 'take':
      if (settled || row.state === 'refused' || row.state === 'asks' || row.state === 'locked') throw new RequestError(400, 'Diese Datei lässt sich so nicht übernehmen.');
      unquarantine(row);
      // A bank CSV whose payments seemed to be in the books: read anyway, its columns asked (#384).
      // A provider's other export read as a statement anyway (#406): its columns asked, by hand.
      if (row.reason === 'provider-export') delete row.otherExport;
      Object.assign(row, { state: 'take', reason: undefined, ...(row.reason === 'csv-known' || row.reason === 'provider-export' ? { anyway: true as const } : {}) });
      break;
    case 'as': {
      // A PDF its words took for a statement that no account read in, or whose table waits, may still be a receipt: the person says so (#25, #217).
      const notStatement = row.kind === 'statement-pdf' && (row.reason === 'not-imported' || row.reason === 'check-read') && a.as === 'receipt';
      if (settled || ((row.state === 'refused' || row.state === 'asks') && !notStatement) || row.state === 'locked') throw new RequestError(400, 'Diese Datei lässt sich so nicht übernehmen.');
      if (notStatement) { if (row.asked) dropAsked(row); delete row.message; delete row.unknownAccount; delete row.chooseAccount; delete row.details; delete row.read; delete row.confirmed; delete row.keep; delete row.statement; delete row.run; }
      if (a.as === 'receipt') unquarantine(row);
      Object.assign(row, a.as === 'quarantine' ? { state: 'quarantine', reason: 'held' } : { kind: 'receipt', state: 'take', reason: undefined });
      break;
    }
    case 'private':
      setAsidePrivate(s, row);
      break;
    case 'firmAccount': {
      // The account was just added through Firma's validated path (the row's form, #401): the statement is read now, no second drop.
      const iban = row.unknownAccount && compactIban(row.unknownAccount.iban);
      if (settled || !iban || !existsSync(fileOf(s.id, row.key))) throw new RequestError(400, 'Nur ein Auszug eines Kontos, das in den Büchern fehlte, wird so eingelesen.');
      if (!WS.bankAccounts.some((x) => x.iban && compactIban(x.iban) === iban)) throw new RequestError(400, `Kein Bankkonto der Firma hat die IBAN ${row.unknownAccount!.iban}.`);
      for (const k of ['chooseAccount', 'unknownAccount', 'details', 'message'] as const) delete row[k];
      Object.assign(row, { state: 'take', reason: undefined });
      break;
    }
    case 'account':
      if (!row.chooseAccount?.accounts.some((x) => x.account === a.account) || !existsSync(fileOf(s.id, row.key))) throw new RequestError(400, 'Nur eines der angebotenen Konten nimmt diesen Auszug.');
      delete row.chooseAccount;
      delete row.unknownAccount;
      delete row.details;
      delete row.message;
      Object.assign(row, { account: a.account, state: 'take', reason: undefined });
      break;
    case 'otherAccount':
      backToChoice(s, row);
      break;
    case 'provider': {
      const ask = row.askProvider;
      const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const account = text(a.account);
      const since = text(a.since);
      // The cut-over day comes with the clearing account while the provider's file names none.
      const needsAccount = ask?.missing !== 'since';
      if (!ask || (needsAccount && !account) || (ask.missing === 'fees' && !text(a.vat)) || (ask.since !== undefined && !since)) throw new RequestError(400, 'Nur ein Bericht, dessen Konto oder Umstellungstag fehlt, nimmt eines.');
      // The revenue account comes with the clearing account where the row showed its proposal (#404).
      const revenue = ask.revenue ? text(a.revenue) : undefined;
      const set = ask.missing === 'fees' ? { fees: { account: account!, vat: text(a.vat)! } } : ask.missing === 'since' ? { since, ...(revenue ? { revenue } : {}) } : { [ask.missing]: account, ...(since ? { since } : {}), ...(revenue ? { revenue } : {}) };
      // The proposed account the chart lacks is added as Firma › Kontenplan adds one, and taken out again when the answer is refused.
      const create = a.create && ask.propose?.name && account === ask.propose.account && accountName(WS, account) === undefined ? ask.propose.name : undefined;
      if (create) { assertPlaced(account!); setAccountName(WS, account!, create); }
      // Her answer to the app's own question is her switching on: no workflow waits for «Einschalten» because of it (#404).
      const kept = asHerAct(() => setProviderAccount(WS, ask.provider, set));
      if (!kept.ok) {
        if (create) removeAccount(WS, account!);
        throw new RequestError(400, `Konto, Steuercode oder Umstellungstag ${[account, a.vat, since, revenue].filter(Boolean).join(' / ')} geht so nicht.`, kept.refusal);
      }
      // Every row of the provider that asked is asked again by its report: the fee report no longer asks for the clearing account just kept.
      for (const r of s.rows) {
        if (r.askProvider?.provider !== ask.provider) continue;
        delete r.askProvider;
        delete r.message;
        Object.assign(r, { state: 'take', reason: undefined });
      }
      answered = { id: ask.provider, name: ask.name };
      break;
    }
    case 'anyway':
      // No payout of the provider recognised: the person takes the report anyway; the clearing check is the safety net.
      if (!row.payoutUnseen || settled) throw new RequestError(400, 'Nur ein Bericht, dessen Auszahlung die App nicht erkennt, wird so übernommen.');
      delete row.payoutUnseen;
      delete row.message;
      Object.assign(row, { state: 'take', reason: undefined, anyway: true });
      break;
    case 'undo':
      if (row.state !== 'taken') throw new RequestError(400, 'Nur eine übernommene Datei lässt sich zurücknehmen.');
      if (undo(row).length) await bookAgain(row.name);
      break;
    case 'unlock': {
      if (row.state !== 'locked' || typeof a.password !== 'string') throw new RequestError(400, 'Nur ein ZIP mit Passwort wird entsperrt.');
      const out = await unzip(readFileSync(fileOf(s.id, row.key)), a.password);
      if (!out.ok) { Object.assign(row, out.locked ? { reason: out.reason ?? 'wrong-password' } : { state: 'refused', reason: out.reason }); break; }
      s.rows = s.rows.filter((r) => r !== row);
      rmSync(fileOf(s.id, row.key), { force: true });
      for (const f of out.files) await add(s, f.name, f.bytes, row.name);
      break;
    }
    case 'read': {
      // The table as the person corrected it: checked again, its known lines marked again; with «Einlesen» imported (#217).
      if (!row.read || row.state !== 'asks') throw new RequestError(400, 'Nur ein gelesener Auszug wird so korrigiert.');
      if (row.asked) {
        // A PDF kept with its question in the books (#254): the books' question is corrected or answered.
        if (!a.import) { row.read = correctAsk(row.asked.file, a.statement).read; break; }
        const had = new Set(readBooks().transactions.map((t) => t.ref));
        const done = await importAsk(row.asked.file, a.statement, (body, name, account) => importStatement(body, name, account));
        settleAsked(s, row, { file: done.file, refs: readBooks().transactions.filter((t) => !had.has(t.ref)).map((t) => t.ref) });
        await handToRun(row, done);
        break;
      }
      const statement = parseReadStatement(a.statement);
      if (!statement) throw readRefusal('Eine Zeile hat kein Datum oder keinen Betrag, oder ein Saldo fehlt.', { why: 'line' });
      row.read = readView(statement, row.read.by, row.account, { ...(row.read.why ? { why: row.read.why } : {}), ...(row.read.error ? { error: row.read.error } : {}), ...(row.read.pages ? { pages: row.read.pages } : {}), ...(row.read.limit ? { limit: row.read.limit } : {}) });
      if (!a.import) break;
      assertImportable(row.read);
      for (const k of ['chooseAccount', 'unknownAccount', 'details', 'message'] as const) delete row[k];
      Object.assign(row, { state: 'take', reason: undefined, confirmed: true });
      break;
    }
    case 'readPdf': {
      // «Bewegungen aus dem PDF einlesen» on a PDF kept as the statement (#254): read now, its question kept in the books.
      const file = row.statement?.file;
      if (row.kind !== 'statement-pdf' || row.state !== 'taken' || !file?.toLowerCase().endsWith('.pdf')) throw new RequestError(400, 'Nur ein als Auszug behaltener PDF wird so gelesen.');
      const ask = await askAbout(file);
      Object.assign(row, { state: 'asks', reason: 'check-read', asked: { file, month: ask.date.slice(0, 7) }, read: ask.read });
      delete row.keep;
      break;
    }
    case 'keep': {
      // «Als Monatsauszug behalten»: the PDF is kept as the month's statement, as before #217, its movements not imported (no AI, a table not wanted, or days a bank export covers).
      if (row.kind !== 'statement-pdf' || !row.read || row.state !== 'asks') throw new RequestError(400, 'Nur ein Auszug als PDF wird als Monatsauszug behalten.');
      if (row.asked) { closeAsk(row.asked.file); settleAsked(s, row); break; }
      if (!existsSync(fileOf(s.id, row.key))) throw new RequestError(400, 'Nur ein Auszug als PDF wird als Monatsauszug behalten.');
      const statement = (a.statement !== undefined ? parseReadStatement(a.statement) : undefined) ?? row.read.statement;
      const account = accountOfRead(statement, WS.bankAccounts, row.account)?.account ?? row.account;
      for (const k of ['chooseAccount', 'unknownAccount', 'details', 'message', 'read', 'confirmed'] as const) delete row[k];
      Object.assign(row, { state: 'take', reason: undefined, keep: { month: readDays(statement).to.slice(0, 7) }, ...(account ? { account } : {}) });
      break;
    }
    case 'csv': {
      // A bank CSV's columns and account: read into the table, the mapping kept for the account's next CSV (#217).
      if (row.kind !== 'statement-csv' || !row.csv || row.state !== 'asks' || !existsSync(fileOf(s.id, row.key))) throw new RequestError(400, 'Nur eine Bank-CSV nimmt Spalten.');
      const account = WS.bankAccounts.find((x) => x.account === a.account && x.statements);
      if (!account) throw readRefusal(`Konto ${a.account} nimmt keine Auszüge.`, { why: 'account' });
      const columns = columnsOf(a.columns, row.csv.header.length);
      if (!columns) throw readRefusal('Datum und Betrag (oder Belastung und Gutschrift) brauchen je eine Spalte der CSV.', { why: 'columns' });
      const table = csvTable(readFileSync(fileOf(s.id, row.key)));
      const read = table ? csvStatement(table, columns, account) : ({ kind: 'empty' } as const);
      if ('kind' in read) throw csvRefusal(read);
      keepCsv(WS, account.account, row.csv.header, columns);
      Object.assign(row, { account: account.account, csv: { ...row.csv, columns, account: account.account }, read: readView(read, 'csv', account.account), reason: 'check-read' });
      break;
    }
    case 'statement': {
      // A receipt, photo or scan that is a bank statement (#217): taken back out of the inbox and read as one.
      if (row.kind !== 'receipt' && row.kind !== 'photo') throw new RequestError(400, 'Nur ein Beleg, ein Foto oder ein Scan wird als Kontoauszug gelesen.');
      let bytes: Buffer | undefined = existsSync(fileOf(s.id, row.key)) ? readFileSync(fileOf(s.id, row.key)) : undefined;
      if (row.state === 'taken') {
        bytes = takenBytes(row);
        if (!bytes) throw new RequestError(409, 'Die Datei ist nicht mehr da.');
        if (undo(row).length) await bookAgain(row.name);
      } else if (settled || !bytes) throw new RequestError(400, 'Diese Datei lässt sich so nicht übernehmen.');
      const pdf = isImageFile(row.name) || row.kind === 'photo' ? Buffer.from(await imageToPdf(bytes, row.name)) : bytes;
      writeFileSync(fileOf(s.id, row.key), pdf);
      for (const k of ['inbox', 'run', 'twin', 'document', 'quarantined', 'message'] as const) delete row[k];
      Object.assign(row, { kind: 'statement-pdf', how: 'hint', state: 'take', reason: undefined, name: row.name.replace(/\.(png|jpe?g|heic|heif)$/i, '.pdf') });
      break;
    }
    case 'twin': {
      if (row.state !== 'duplicate' || !row.twin || row.twin.relation !== 'duplicate') throw new RequestError(400, 'Nur ein möglicher Doppelbeleg wird so beantwortet.');
      if (a.answer === 'same') {
        Object.assign(row, { reason: 'same' });
        break;
      }
      // «verschieden» is remembered on the receipt of the books, so no step asks again; a receipt of
      // a filed quarter stays as filed (and no payment of it can take the new file anyway).
      const of = row.twin.of;
      updateBooks((b) => {
        const r = b.receipts.find((x) => x.id === of);
        if (r && !receiptDates(b, of).some(periodLock(b).isClosed) && !r.distinctFrom?.includes(row.id)) r.distinctFrom = [...(r.distinctFrom ?? []), row.id];
      });
      Object.assign(row, { state: 'take', reason: undefined });
      break;
    }
    default: throw new RequestError(400, 'Unbekannte Aktion.');
  }
  await takeWaiting(s);
  // The payouts her answer decides are booked now, and the row says how many (#404).
  const ready = answered ? readyPayouts(answered.id) : [];
  if (answered && ready.length) row.payouts = { provider: answered.name, ...(await bookPayouts(ready)) };
  save(s);
  res.json(s);
}));

function csvRefusal(p: Exclude<ReturnType<typeof csvStatement>, ReadStatement>): RequestError {
  return p.kind === 'amount' ? readRefusal(`Zeile ${p.row} der CSV hat ein Datum, aber keinen Betrag.`, { why: 'csvRow', row: p.row })
    : p.kind === 'tooMany' ? readRefusal(`Die CSV hat ${p.rows} Zeilen, höchstens ${p.limit} werden gelesen: nichts gelesen. Den Zeitraum kürzer exportieren.`, { why: 'csvRows', rows: p.rows, limit: p.limit })
    : readRefusal('Keine Zeile der CSV hat ein Datum in der gewählten Spalte.', { why: 'csvEmpty' });
}

/** The person's columns, each an index of the CSV's header, a day and an amount (or a debit or credit) among them. */
function columnsOf(c: unknown, width: number): CsvColumns | undefined {
  const o = c as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const k of ['date', 'valueDate', 'amount', 'debit', 'credit', 'counterparty', 'text', 'reference', 'balance'] as const) {
    const v = o[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= width) return undefined;
    out[k] = v;
  }
  return out.date !== undefined && (out.amount !== undefined || out.debit !== undefined || out.credit !== undefined) ? (out as unknown as CsvColumns) : undefined;
}

/** A taken receipt's bytes, while the inbox or the books hold it (a photo as the PDF it became). */
function takenBytes(row: DropRow): Buffer | undefined {
  if (row.inbox && existsSync(join(WS.paths.inbox, row.inbox))) return readFileSync(join(WS.paths.inbox, row.inbox));
  const run = row.run ? engine().run(row.run) : undefined;
  const arrival = run?.arrived?.find((x) => x.kind === 'receipt' && x.file === row.name);
  const books = readBooks();
  const receipt = books.receipts.find((r) => r.id === (arrival?.kind === 'receipt' ? arrival.id : row.id));
  const path = receipt ? receiptPath(books, receipt) : undefined;
  return path && existsSync(path) ? readFileSync(path) : undefined;
}

/** Whether the CSV's rows, by these columns, hold a movement: a day and an amount other than zero. */
function moves(table: NonNullable<ReturnType<typeof csvTable>>, columns: CsvColumns): boolean {
  const read = csvStatement(table, columns, { currency: baseCurrency() });
  return 'kind' in read ? read.kind !== 'empty' : read.movements.some((m) => m.amount !== 0);
}

/**
 * A statement without a bank export read into its table (#217): the PDF by the model when one answers
 * here, else the table to fill by hand; a CSV by the mapping kept for its header, else its
 * columns asked. The row then waits for «Einlesen».
 */
async function readInto(s: DropSession, row: DropRow, bytes: Buffer): Promise<void> {
  if (row.kind === 'statement-csv') {
    const table = csvTable(bytes);
    if (!table) { Object.assign(row, { state: 'refused', reason: 'bank-csv' }); return; }
    const kept = keptCsv(WS, table.header);
    const takers = WS.bankAccounts.filter((x) => x.statements);
    const accounts = takers.map((x) => ({ account: x.account, label: x.label, currency: x.currency }));
    // The columns its header names are a proposal only when they read as a statement (#406): a day and an amount other
    // than zero on its rows. Columns that yield no movement (a list whose «amount» column is all zero) are no proposal
    // and no table of empty lines: the columns are asked with nothing chosen, the way by hand.
    const header = kept ? undefined : guessColumns(table.header);
    const guessed = header && moves(table, header) ? header : undefined;
    // A CSV whose every payment the books hold on one account already (its bank export of the same days, #384): nothing to ask, nothing to read in.
    // Only on the account the file names by its IBAN when it names one; without, only a file of three payments or more (one or two equal rows of
    // another account are no proof). «Trotzdem übernehmen» (`anyway`) asks the columns as before.
    const named = takers.filter((a) => a.iban && compactIban(bytes.toString('utf8')).includes(compactIban(a.iban)));
    const holder = guessed && !row.anyway && (named.length ? named : takers).find((a) => {
      const r = csvStatement(table, guessed, a);
      return !('kind' in r) && (named.length > 0 || r.movements.length >= 3) && r.movements.length > 0 && heldOfRead(r, a).size === r.movements.length;
    });
    if (holder) { Object.assign(row, { state: 'duplicate', reason: 'csv-known', account: holder.account }); return; }
    row.csv = { header: table.header, sample: table.rows.slice(0, 5), rows: table.rows.length, accounts, ...(kept ? { columns: kept.columns, account: kept.account } : guessed ? { columns: guessed } : {}) };
    // The columns code recognises from the header and the one account that takes statements: only the check is left to her.
    const only = guessed && takers.length === 1 ? takers[0] : undefined;
    const account = kept ? WS.bankAccounts.find((x) => x.account === kept.account && x.statements) : only;
    const read = account ? csvStatement(table, kept?.columns ?? guessed!, account) : undefined;
    if (account && read && !('kind' in read)) Object.assign(row, { account: account.account, read: readView(read, 'csv', account.account), state: 'asks', reason: 'check-read' });
    else Object.assign(row, { state: 'asks', reason: 'csv-columns', ...(read && 'kind' in read && read.kind === 'tooMany' ? { message: csvRefusal(read).message } : {}) });
    return;
  }
  const path = join(dir(s.id), 'read', `${row.key}.pdf`);
  mkdirSync(join(dir(s.id), 'read'), { recursive: true });
  writeFileSync(path, bytes);
  let read: Awaited<ReturnType<typeof readPdf>>;
  try { read = await readPdf(path); } finally { rmSync(path, { force: true }); }
  const { statement, by, ...extra } = read;
  Object.assign(row, { state: 'asks', reason: 'check-read', read: readView(statement, by, row.account, extra) });
}

/**
 * A dropped statement PDF (#254), kept as its account's statement at once. Of an account a bank export or
 * bank CSV feeds it asks nothing, and is read only when its own words do not name the account and its
 * days. Of any other account it is read, and its question («Einlesen» or «Als Auszug behalten») is
 * kept in the books with the table. One whose account and month neither its words nor the model's
 * read tell waits in the row for «Einlesen» or «Als Monatsauszug behalten», which ask the account.
 */
async function placeStatementPdf(s: DropSession, row: DropRow, bytes: Buffer): Promise<void> {
  const byText = placeByText(await firstPages(bytes) ?? '', row.name, WS.bankAccounts);
  let account = (row.account ? WS.bankAccounts.find((x) => x.account === row.account && x.statements) : undefined) ?? byText.account ?? sessionAccount(s, row.facts?.iban);
  let period = byText.period;
  if (!(account && period && structuredAccount(account.account)) && !row.read) await readInto(s, row, bytes);
  if (row.read?.why === 'notStatement') return;
  // Only the model's read names what the file does not: the hand form's days and currency are a start, no fact.
  const model = row.read?.by === 'model' ? row.read.statement : undefined;
  if (model) { account ??= accountOfRead(model, WS.bankAccounts); period ??= readDays(model); }
  if (!account || !period) return;
  const month = period.to.slice(0, 7);
  const done = await intoBooks(row, bytes, row.name, account.account, month, undefined, period);
  if (!done) return;
  if (structuredAccount(account.account) || !row.read) {
    delete row.read;
    Object.assign(row, { state: 'taken', reason: undefined, keep: { month } });
    rmSync(fileOf(s.id, row.key), { force: true });
    return;
  }
  const { statement, by, why, error, pages, limit } = row.read;
  const ask = keepAsk(done.file, account.account, done.to, readView(statement, by, account.account, { ...(why ? { why } : {}), ...(error ? { error } : {}), ...(pages ? { pages } : {}), ...(limit ? { limit } : {}) }));
  Object.assign(row, { state: 'asks', reason: 'check-read', account: account.account, asked: { file: done.file, month }, read: ask.read });
}

/** A row's PDF kept with its question, settled: kept as the statement, or read in (`statement`: the ISO 20022 statement written beside it). */
function settleAsked(s: DropSession, row: DropRow, statement?: { file: string; refs: string[] }): void {
  const month = row.asked!.month;
  delete row.asked;
  delete row.read;
  Object.assign(row, { state: 'taken', reason: undefined, ...(statement ? { statement } : { keep: { month } }) });
  rmSync(fileOf(s.id, row.key), { force: true });
}

/** A row's PDF kept with its question taken back out of the books (× or «Ist ein Beleg»). */
function dropAsked(row: DropRow): void {
  const file = row.asked!.file;
  closeAsk(file);
  if (findFile(WS.paths, 'statements', file)) removeStatement(file, []);
  delete row.asked;
}

/**
 * Reads a statement file into the books and hands it to the inbox's run; a refusal leaves the row
 * asking its question (which account, firm or private) or refused, and a statement read in already
 * links to it. Undefined when nothing was read in.
 */
async function intoBooks(row: DropRow, body: Buffer, name: string, account: string | undefined, month: string | undefined, source?: { ext: string; bytes: Buffer }, days?: { from: string; to: string }): Promise<StatementImport | undefined> {
  const had = new Set(readBooks().transactions.map((t) => t.ref));
  let done: StatementImport;
  try {
    done = await importStatement(body, name, account, month, source, days);
  } catch (e) {
    const refusal = e instanceof RequestError ? e.refusal : undefined;
    const unknown = refusal?.code === 'statement' ? refusal.params.unknown : undefined;
    const problem = refusal?.code === 'statement' ? refusal.params.problem : undefined;
    const read = refusal?.code === 'statement' && refusal.params.reason === 'duplicate' ? refusal.params.detail : undefined;
    if (read) {
      // Read in already (by an earlier drop or upload): not a failure, the statement is in the books; the row links to it.
      const ref = readBooks().bankStatements?.find((b) => `${b.bank}/${b.filename}` === read)?.refs?.[0];
      for (const k of ['chooseAccount', 'unknownAccount', 'details', 'message'] as const) delete row[k];
      Object.assign(row, { state: 'duplicate', reason: 'statement-read', readAs: { file: read, ...(ref ? { ref } : {}) } });
      return undefined;
    }
    const choose = problem?.kind === 'whichAccount' ? problem : undefined;
    // A statement asking which account it is of, or whether an unknown one is the firm's, waits for that answer with its file (#208).
    const asks = !!(unknown || choose);
    const details = asks ? statementDetails(body, name) : undefined;
    Object.assign(row, { state: asks ? 'asks' : 'refused', reason: 'not-imported', message: (e as Error).message, ...(unknown ? { unknownAccount: unknown } : {}), ...(choose ? { chooseAccount: choose } : {}), ...(details ? { details } : {}) });
    return undefined;
  }
  // A file read once more only to repair payments without a reference (#401) brought nothing of its own: its row has nothing to take back.
  row.statement = { file: done.file, refs: done.again ? [] : readBooks().transactions.filter((t) => !had.has(t.ref)).map((t) => t.ref), account: done.account, ...(done.emptyRefs ? { emptyRefs: done.emptyRefs } : {}), ...(done.again ? { again: true as const } : {}) };
  if (done.byBank) row.byBank = done.byBank;
  await handToRun(row, done);
  return done;
}

/** A statement read in, handed to the inbox's run, which books its payments. */
async function handToRun(row: DropRow, done: StatementImport): Promise<void> {
  const { month: _month, ...arrived } = done;
  const started = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'outside', file: row.name }, 'live', [{ kind: 'statement', ...arrived }]);
  if (started.ok && started.run) row.run = started.run;
}

/** The ISO 20022 statement a confirmed table is imported as: its lines the books hold carry their refs, so they are not added twice. */
function asCamt(row: DropRow, bytes: Buffer): { body: Buffer; name: string; source: { ext: string; bytes: Buffer } } {
  const read = row.read!;
  const ext = row.kind === 'statement-csv' ? 'csv' : 'pdf';
  const stem = freeStem(basename(row.name, extname(row.name)).replace(/[/\\]/g, '-') || 'auszug', ext);
  const xml = readAsXml(read, accountOfRead(read.statement, WS.bankAccounts, row.account), { id: `read-${row.id}`, source: `${stem}.${ext}` });
  return { body: Buffer.from(xml), name: `${stem}.xml`, source: { ext, bytes } };
}

/**
 * A stem under which no statement folder holds a file yet, as the ISO 20022 statement or as the file it is read
 * from (`ext`): the read's two files never meet a file that is there (a PDF kept as a month's
 * statement of the same name), so the undo removes only what the read wrote.
 */
function freeStem(stem: string, ext: string): string {
  const banks = partDirs(WS.paths, 'statements').filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).map((b) => join(d, b)));
  const taken = (n: string) => banks.some((b) => existsSync(join(b, `${n}.xml`)) || existsSync(join(b, `${n}.${ext}`)));
  let name = stem;
  for (let i = 2; taken(name); i++) name = `${stem}-${i}`;
  return name;
}

/**
 * «ändern» on a statement taken onto the one account of the bank it names (#273): it leaves that
 * account with its payments, as «Rückgängig» takes it, the IBAN kept there for it goes too, and the
 * row asks which account it is of, as it would have.
 */
function backToChoice(s: DropSession, row: DropRow): void {
  const choice = row.byBank;
  const path = row.statement && findFile(WS.paths, 'statements', row.statement.file);
  if (row.state !== 'taken' || !choice || !path) throw new RequestError(400, 'Nur ein Auszug, den die App dem Konto seiner Bank zugeordnet hat, wird so geändert.');
  const bytes = readFileSync(path);
  const account = row.statement!.account;
  undo(row);
  const kept = WS.bankAccounts.find((a) => a.account === account && a.iban === choice.iban);
  if (kept) { patchManifest(WS.paths.manifest, { banks: [{ bank: kept.bank, currency: kept.currency, iban: null }] }); reopenWorkspace(); }
  writeFileSync(fileOf(s.id, row.key), bytes);
  for (const k of ['byBank', 'statement', 'run'] as const) delete row[k];
  Object.assign(row, { state: 'asks', reason: 'not-imported', chooseAccount: choice, details: statementDetails(bytes, row.name) });
}

/** «Nein, privat» on a statement of an account the books lack: it stays out of the books, its copy in the session goes. */
function setAsidePrivate(s: DropSession, row: DropRow): void {
  if (!row.unknownAccount) throw new RequestError(400, 'Nur ein Auszug eines unbekannten Kontos wird als privat beiseitegelegt.');
  delete row.unknownAccount;
  delete row.chooseAccount;
  delete row.details;
  delete row.message;
  Object.assign(row, { state: 'refused', reason: 'private' });
  rmSync(fileOf(s.id, row.key), { force: true });
}

const OTHER_WHY = ['newsletter', 'terms', 'price-list', 'tracking', 'no-receipt'] as const;

/**
 * Takes every row that can be taken: a receipt goes into the inbox, a statement is read into the
 * books, each handed to the inbox's run with what it is; what is no receipt goes to quarantine.
 */
async function takeWaiting(s: DropSession): Promise<void> {
  syncAsked(s);
  await takeRows(s);
  // A bank export or CSV taken in this drop feeds its account: the statement PDFs of its IBAN that asked meanwhile are its statements (#273).
  if (toItsExport(s)) await takeRows(s);
  syncAsked(s);
}

/**
 * The account of a bank export or bank CSV this session read in for an IBAN. A statement PDF of that
 * IBAN in the same drop is that account's statement without a question, whichever file came first and
 * whether or not the IBAN is on the account (#273).
 */
function sessionAccount(s: DropSession, iban: string | undefined): LedgerBankAccount | undefined {
  const wanted = iban && compactIban(iban);
  if (!wanted) return undefined;
  const row = s.rows.find((r) => r.state === 'taken' && (r.kind === 'camt' || r.kind === 'statement-csv') && r.statement?.account
    && ((r.facts?.iban && compactIban(r.facts.iban) === wanted) || WS.bankAccounts.some((a) => a.account === r.statement!.account && a.iban === wanted)));
  return row ? WS.bankAccounts.find((a) => a.account === row.statement!.account && a.statements) : undefined;
}

/** The statement PDFs asking in their row whose IBAN a bank export or CSV of this drop names, placed again on its account. Whether any was. */
function toItsExport(s: DropSession): boolean {
  let any = false;
  for (const row of s.rows) {
    if (row.kind !== 'statement-pdf' || row.state !== 'asks' || row.asked || row.account || row.confirmed) continue;
    const account = sessionAccount(s, row.facts?.iban ?? row.read?.statement.iban);
    if (!account) continue;
    for (const k of ['read', 'chooseAccount', 'unknownAccount', 'details', 'message'] as const) delete row[k];
    Object.assign(row, { state: 'take', reason: undefined, account: account.account });
    any = true;
  }
  return any;
}

async function takeRows(s: DropSession): Promise<void> {
  // Reports a closed drop kept while «Buchen» waited are taken once it books again (#413).
  takeWaitingReportsIfOn();
  for (const row of s.rows) {
    if (row.state === 'quarantine' && !row.quarantined && existsSync(fileOf(s.id, row.key))) {
      const why = OTHER_WHY.find((w) => w === row.document);
      const reason: QuarantineReason = row.reason === 'not-receipt' ? { kind: 'not-receipt', ...(why ? { why } : {}) } : row.reason === 'unreadable' ? { kind: 'unreadable' } : { kind: 'held' };
      row.quarantined = putInQuarantine(WS.paths.data, row.name, readFileSync(fileOf(s.id, row.key)), reason);
      continue;
    }
    if (row.state !== 'take') continue;
    const bytes = readFileSync(fileOf(s.id, row.key));
    if (row.kind === 'sales-report') {
      // A provider's report is booked here, by code, as a statement is read: it needs no run of the inbox (#203).
      // It books by the provider's file: while «Buchen» waits for «Einschalten» it waits in its row (#413).
      const waits = bookingWaits();
      if (waits) { Object.assign(row, { state: 'unclear', reason: 'booking-waits', bookingWaits: waits }); continue; }
      delete row.bookingWaits;
      // An error refuses this row only: the session is saved, the other rows are taken.
      let done: ReturnType<typeof importSalesReport>;
      try {
        done = importSalesReport(WS, bytes, row.name, { anyway: row.anyway });
      } catch (e) {
        Object.assign(row, { state: 'refused', reason: 'report-failed', message: (e as Error).message });
        continue;
      }
      if (done.ok) {
        Object.assign(row, { state: 'taken', report: done.summary });
        rmSync(fileOf(s.id, row.key), { force: true });
      } else if (done.unseen) Object.assign(row, { state: 'unclear', reason: 'payout-unseen', payoutUnseen: done.unseen, message: done.message });
      else Object.assign(row, done.ask ? { state: 'unclear', reason: 'provider-account', askProvider: done.ask, message: done.message } : { state: 'refused', reason: 'not-imported', message: done.message });
      continue;
    }
    if (row.kind === 'statement-pdf' && !row.confirmed && !row.keep && !row.asked) {
      await placeStatementPdf(s, row, bytes);
      continue;
    }
    if (row.kind === 'statement-csv' && !row.confirmed) {
      await readInto(s, row, bytes);
      continue;
    }
    if (row.kind === 'camt' || row.kind === 'statement-pdf' || row.kind === 'statement-csv') {
      const camt = row.read ? asCamt(row, bytes) : { body: bytes, name: row.name };
      if (!await intoBooks(row, camt.body, camt.name, row.account, row.keep?.month, 'source' in camt ? camt.source : undefined)) continue;
      Object.assign(row, { state: 'taken' });
      rmSync(fileOf(s.id, row.key), { force: true });
      continue;
    }
    mkdirSync(WS.paths.inbox, { recursive: true });
    row.inbox = freeName(WS.paths.inbox, row.name);
    writeFileSync(join(WS.paths.inbox, row.inbox), bytes);
    handedOver([row.id]);
    const arrival: Arrival = { kind: 'receipt', file: row.name, id: row.id, inbox: row.inbox };
    const started = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'outside', file: row.name }, 'live', [arrival]);
    Object.assign(row, { state: 'taken', ...(started.ok && started.run ? { run: started.run } : {}) });
    rmSync(fileOf(s.id, row.key), { force: true });
  }
}

/**
 * A row whose PDF waits with its question in the books (#254), answered elsewhere meanwhile: in Bank,
 * or closed by the account's first bank export or CSV. It shows what became of it.
 */
function syncAsked(s: DropSession): void {
  if (!s.rows.some((r) => r.asked)) return;
  const open = new Set((readBooks().statementAsks ?? []).map((a) => a.file));
  for (const row of s.rows) {
    if (!row.asked || open.has(row.asked.file)) continue;
    const xml = row.asked.file.replace(/\.pdf$/i, '.xml');
    settleAsked(s, row, findFile(WS.paths, 'statements', xml) ? { file: xml, refs: [] } : undefined);
  }
}

function unquarantine(row: DropRow): void {
  if (!row.quarantined) return;
  release(WS.paths.data, row.quarantined);
  delete row.quarantined;
}

/**
 * «Rückgängig» for a taken file. A receipt leaves the inbox and the books, with its links and the
 * entries booked with it (removeReceipt); returns its payments, to be booked again as they would
 * be without it. A statement leaves with its file, its closing balances, the payments it alone
 * brought, and their links and entries: a payment another statement on disk still holds (the
 * bank's exports overlap) stays with its bookings, and the statement list is read again from the
 * folder. Never while its run works on it, never in the closed period, never an entry a person
 * booked by hand (such a payment stays, and the refusal says so).
 */
function undo(row: DropRow): string[] {
  let again: string[] = [];
  const run = row.run ? engine().run(row.run) : undefined;
  if (run && run.state.status === 'running') throw new RequestError(409, 'Der Lauf arbeitet gerade daran. Gleich noch einmal.');
  if (row.report) {
    // A report's bookings go with its receipt; one a person changed, or of a filed period, keeps it (removeSalesReport).
    if (!removeSalesReport(WS, row.id)) throw new RequestError(409, 'Eine Buchung dieses Berichts ist eingereicht oder von Hand geändert: er bleibt. Die Buchungen von Hand korrigieren.');
  } else if (row.statement?.again) {
    throw new RequestError(400, 'Dieser Auszug war schon in den Büchern; das Hineinziehen hat nur Referenzen ergänzt. Nichts zurückzunehmen.');
  } else if (row.statement) {
    // The same convergent undo as the statement page's «Auszug entfernen» (r9k-3); a file already gone (removed there) leaves nothing to do.
    if (findFile(WS.paths, 'statements', row.statement.file)) removeStatement(row.statement.file, row.statement.refs);
  } else {
    // A photo became a PDF under another name and id: the run's arrival says which (r8k-9).
    const arrival = run?.arrived?.find((a) => a.kind === 'receipt' && a.file === row.name);
    const id = arrival?.kind === 'receipt' ? arrival.id : row.id;
    const inbox = arrival?.kind === 'receipt' ? arrival.inbox ?? row.inbox : row.inbox;
    const books = readBooks();
    const receipt = books.receipts.find((r) => r.id === id);
    if (receipt) {
      assertOpen(books, receiptDates(books, id), 'deleteReceipt');
      const pdf = receiptPath(books, receipt);
      again = updateBooks((b) => removeReceipt(b, id));
      rmSync(pdf, { force: true });
    }
    if (inbox) rmSync(join(WS.paths.inbox, inbox), { force: true });
  }
  if (row.run) engine().withdraw(row.run, row.inbox ? row.name : row.statement?.file ?? row.name);
  row.state = 'undone';
  return again;
}

/**
 * Closing the dialog loses no file (r6h-23). A possible duplicate nobody answered goes in like any
 * receipt: the run's matching step holds it back from its payment and Belege asks the same
 * question. A ZIP still waiting for its password, and a file nobody said what it is, wait in
 * quarantine, where Belege lists them with «Ist ein Beleg». A copy by its bytes is there already.
 */
router.delete('/api/drop/:id', (req, res) => inSession(req.params.id, async () => {
  const s = load(req.params.id);
  for (const row of s.rows) {
    if (row.state === 'duplicate' && row.reason === 'possible-duplicate') Object.assign(row, { state: 'take', reason: undefined });
    // A report waiting for «Einschalten» (#413) is kept for it, never put in quarantine: «Einschalten» takes it.
    else if (row.reason === 'booking-waits' && existsSync(fileOf(s.id, row.key))) Object.assign(row, { state: 'taken', waitingReport: keepWaitingReport(row.name, readFileSync(fileOf(s.id, row.key))) });
    else if (row.state === 'locked' || row.state === 'unclear') Object.assign(row, { state: 'quarantine', reason: 'held' });
    // A statement still asking in the row (its account, its columns, a table no account takes yet) waits in quarantine; one kept with its question waits in the books (#254).
    else if (row.state === 'asks' && !row.asked) Object.assign(row, { state: 'quarantine', reason: 'held' });
  }
  await takeWaiting(s);
  rmSync(dir(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
}));
