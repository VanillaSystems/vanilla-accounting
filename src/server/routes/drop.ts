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
import { RequestError, WS, assertOpen, readBooks, receiptDates, receiptPath, updateBooks } from '../books.js';
import { findFile } from '../../workspace/workspace.js';
import { INTAKE, bookAgain, engine, handedOver } from './automation.js';
import { removeReceipt } from '../../accounting/classify-force.js';
import { importStatement, removeStatement } from './statements.js';

import type { Arrival } from '../../workflows/model.js';
import { recognize } from '../../intake/recognize.js';
import { unzip } from '../../intake/unzip.js';
import { freeName, putInQuarantine, release } from '../../intake/quarantine.js';
import { twinFinder, type Comparable } from '../../intake/duplicates.js';
import { textFacts } from '../../parsers/receipt-text.js';
import { documents } from '../../engines/index.js';
import { periodLock } from '../../books/store.js';
import type { DropAction, DropRow, DropSession, QuarantineReason } from '../../types/drop.js';

export const router = Router();

const isSupporting = (why: DropRow['document']) => why === 'order-confirmation' || why === 'delivery-note' || why === 'reminder' || why === 'customs-assessment';

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
  const { text, ...r } = await recognize(bytes, name);
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

router.post('/api/drop', (_req, res) => {
  const s: DropSession = { id: randomUUID(), rows: [] };
  mkdirSync(join(dir(s.id), 'files'), { recursive: true });
  save(s);
  res.json(s);
});

router.post('/api/drop/:id/files', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
  const s = load(req.params.id);
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || !body.length) throw new RequestError(400, 'Keine Datei erhalten.');
  const name = basename(String(req.query.name ?? '')).replace(/[\u0000-\u001f]/g, '').trim().slice(-160) || 'datei';
  await add(s, name, body);
  await takeWaiting(s);
  save(s);
  res.json(s);
});

router.post('/api/drop/:id/rows/:key', async (req, res) => {
  const s = load(req.params.id);
  const row = s.rows.find((r) => r.key === req.params.key);
  if (!row) throw new RequestError(404, 'Diese Zeile gibt es nicht.');
  const a = req.body as DropAction;
  const settled = row.state === 'taken' || row.state === 'undone';
  switch (a?.kind) {
    case 'remove':
      if (settled) throw new RequestError(400, 'Schon übernommen: «Rückgängig» nimmt es zurück.');
      s.rows = s.rows.filter((r) => r !== row);
      rmSync(fileOf(s.id, row.key), { force: true });
      break;
    case 'take':
      if (settled || row.state === 'refused' || row.state === 'locked') throw new RequestError(400, 'Diese Datei lässt sich so nicht übernehmen.');
      unquarantine(row);
      Object.assign(row, { state: 'take', reason: undefined });
      break;
    case 'as': {
      // A PDF its words took for a statement that no account read in may still be a receipt: the person says so (#25).
      const notStatement = row.kind === 'statement-pdf' && row.reason === 'not-imported' && a.as === 'receipt';
      if (settled || (row.state === 'refused' && !notStatement) || row.state === 'locked') throw new RequestError(400, 'Diese Datei lässt sich so nicht übernehmen.');
      if (notStatement) { delete row.message; delete row.unknownAccount; delete row.chooseAccount; }
      if (a.as === 'receipt') unquarantine(row);
      Object.assign(row, a.as === 'quarantine' ? { state: 'quarantine', reason: 'held' } : { kind: 'receipt', state: 'take', reason: undefined });
      break;
    }
    case 'private':
      setAsidePrivate(s, row);
      break;
    case 'account':
      if (!row.chooseAccount?.accounts.some((x) => x.account === a.account) || !existsSync(fileOf(s.id, row.key))) throw new RequestError(400, 'Nur eines der angebotenen Konten nimmt diesen Auszug.');
      delete row.chooseAccount;
      delete row.unknownAccount;
      delete row.message;
      Object.assign(row, { account: a.account, state: 'take', reason: undefined });
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
  save(s);
  res.json(s);
});

/** «Nein, privat» on a statement of an account the books lack: it stays out of the books, its copy in the session goes. */
function setAsidePrivate(s: DropSession, row: DropRow): void {
  if (!row.unknownAccount) throw new RequestError(400, 'Nur ein Auszug eines unbekannten Kontos wird als privat beiseitegelegt.');
  delete row.unknownAccount;
  delete row.chooseAccount;
  delete row.message;
  row.reason = 'private';
  rmSync(fileOf(s.id, row.key), { force: true });
}

const OTHER_WHY = ['newsletter', 'terms', 'price-list', 'tracking', 'no-receipt'] as const;

/**
 * Takes every row that can be taken: a receipt goes into the inbox, a statement is read into the
 * books, each handed to the inbox's run with what it is; what is no receipt goes to quarantine.
 */
async function takeWaiting(s: DropSession): Promise<void> {
  for (const row of s.rows) {
    if (row.state === 'quarantine' && !row.quarantined && existsSync(fileOf(s.id, row.key))) {
      const why = OTHER_WHY.find((w) => w === row.document);
      const reason: QuarantineReason = row.reason === 'not-receipt' ? { kind: 'not-receipt', ...(why ? { why } : {}) } : row.reason === 'unreadable' ? { kind: 'unreadable' } : { kind: 'held' };
      row.quarantined = putInQuarantine(WS.paths.data, row.name, readFileSync(fileOf(s.id, row.key)), reason);
      continue;
    }
    if (row.state !== 'take') continue;
    const bytes = readFileSync(fileOf(s.id, row.key));
    let arrival: Arrival;
    if (row.kind === 'camt' || row.kind === 'statement-pdf') {
      const had = new Set(readBooks().transactions.map((t) => t.ref));
      try {
        const { month: _month, ...done } = await importStatement(bytes, row.name, row.account);
        row.statement = { file: done.file, refs: readBooks().transactions.filter((t) => !had.has(t.ref)).map((t) => t.ref) };
        arrival = { kind: 'statement', ...done };
      } catch (e) {
        const refusal = e instanceof RequestError ? e.refusal : undefined;
        const unknown = refusal?.code === 'statement' ? refusal.params.unknown : undefined;
        const problem = refusal?.code === 'statement' ? refusal.params.problem : undefined;
        Object.assign(row, { state: 'refused', reason: 'not-imported', message: (e as Error).message, ...(unknown ? { unknownAccount: unknown } : {}), ...(problem?.kind === 'whichAccount' ? { chooseAccount: problem } : {}) });
        continue;
      }
    } else {
      mkdirSync(WS.paths.inbox, { recursive: true });
      row.inbox = freeName(WS.paths.inbox, row.name);
      writeFileSync(join(WS.paths.inbox, row.inbox), bytes);
      handedOver([row.id]);
      arrival = { kind: 'receipt', file: row.name, id: row.id, inbox: row.inbox };
    }
    const started = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'outside', file: row.name }, 'live', [arrival]);
    Object.assign(row, { state: 'taken', ...(started.ok && started.run ? { run: started.run } : {}) });
    rmSync(fileOf(s.id, row.key), { force: true });
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
  if (row.statement) {
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
router.delete('/api/drop/:id', async (req, res) => {
  const s = load(req.params.id);
  for (const row of s.rows) {
    if (row.state === 'duplicate' && row.reason === 'possible-duplicate') Object.assign(row, { state: 'take', reason: undefined });
    else if (row.state === 'locked' || row.state === 'unclear') Object.assign(row, { state: 'quarantine', reason: 'held' });
  }
  await takeWaiting(s);
  rmSync(dir(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});
