/**
 * The drop dialog's session (docs/0.4.0/intake.md): each file dropped while it is open is
 * recognized and, when nothing is unclear about it, taken at once: a receipt or photo into the
 * inbox, a statement read into the books as the Bank area reads it, what is no receipt into
 * data/quarantine/ with its reason. Each taken file is handed to the inbox's run with what it is
 * (an Arrival); one dropped while that run is under way goes to the run that waits behind it. A
 * file with an open question (a password, a duplicate, unknown content) waits in data/drop/<session>/
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
import { RequestError, WS, assertOpen, readBooks, receiptDates, receiptPath, refDates, updateBooks } from '../books.js';
import { findFile } from '../../workspace/workspace.js';
import { INTAKE, bookAgain, engine, handedOver } from './automation.js';
import { removeReceipt } from '../../accounting/classify-force.js';
import { importStatement } from './statements.js';
import type { Arrival } from '../../workflows/model.js';
import { recognize } from '../../intake/recognize.js';
import { unzip } from '../../intake/unzip.js';
import type { DropAction, DropRow, DropSession } from '../../types/drop.js';

export const router = Router();

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dir = (id: string) => join(WS.paths.data, 'drop', id);
const fileOf = (id: string, key: string) => join(dir(id), 'files', key);
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
  const r = recognize(bytes, name);
  const row: DropRow = { key: randomUUID().slice(0, 8), id, name, size: bytes.length, ...(from ? { from } : {}), ...r };
  if (row.kind === 'zip') {
    const out = await unzip(bytes, password);
    if (out.ok) { for (const f of out.files) await add(s, f.name, f.bytes, name); return; }
    if (out.locked) { s.rows.push({ ...row, state: 'locked', ...(out.reason ? { reason: out.reason } : {}) }); writeFileSync(fileOf(s.id, row.key), bytes); return; }
    s.rows.push({ ...row, state: 'refused', reason: out.reason });
    return;
  }
  if (row.state !== 'refused' && seen.has(id)) Object.assign(row, { state: 'duplicate', reason: 'duplicate' });
  if (row.state !== 'refused') writeFileSync(fileOf(s.id, row.key), bytes);
  s.rows.push(row);
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
    case 'as':
      if (settled || row.state === 'refused' || row.state === 'locked') throw new RequestError(400, 'Diese Datei lässt sich so nicht übernehmen.');
      if (a.as === 'receipt') unquarantine(row);
      Object.assign(row, a.as === 'quarantine' ? { state: 'quarantine', reason: 'held' } : { kind: 'receipt', state: 'take', reason: undefined });
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
    default: throw new RequestError(400, 'Unbekannte Aktion.');
  }
  await takeWaiting(s);
  save(s);
  res.json(s);
});

/** A free name in `folder` for `name`: the same stem with -2, -3 … when taken. */
function freeName(folder: string, name: string): string {
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  let out = name;
  for (let n = 2; existsSync(join(folder, out)); n++) out = `${stem}-${n}${ext}`;
  return out;
}

const QUARANTINE = () => join(WS.paths.data, 'quarantine');

/**
 * Takes every row that can be taken: a receipt goes into the inbox, a statement is read into the
 * books, each handed to the inbox's run with what it is; what is no receipt goes to quarantine.
 */
async function takeWaiting(s: DropSession): Promise<void> {
  for (const row of s.rows) {
    if (row.state === 'quarantine' && !row.quarantined && existsSync(fileOf(s.id, row.key))) {
      mkdirSync(QUARANTINE(), { recursive: true });
      const name = freeName(QUARANTINE(), row.name);
      writeFileSync(join(QUARANTINE(), name), readFileSync(fileOf(s.id, row.key)));
      writeFileSync(join(QUARANTINE(), `${name}.reason.txt`), `${row.reason ?? ''}\n`);
      row.quarantined = name;
      continue;
    }
    if (row.state !== 'take') continue;
    const bytes = readFileSync(fileOf(s.id, row.key));
    let arrival: Arrival;
    if (row.kind === 'camt' || row.kind === 'statement-pdf') {
      const had = new Set(readBooks().transactions.map((t) => t.ref));
      try {
        const { month: _month, ...done } = await importStatement(bytes, row.name);
        row.statement = { file: done.file, refs: readBooks().transactions.filter((t) => !had.has(t.ref)).map((t) => t.ref) };
        arrival = { kind: 'statement', ...done };
      } catch (e) {
        const refusal = e instanceof RequestError ? e.refusal : undefined;
        const unknown = refusal?.code === 'statement' ? refusal.params.unknown : undefined;
        Object.assign(row, { state: 'refused', reason: 'not-imported', message: (e as Error).message, ...(unknown ? { unknownAccount: unknown } : {}) });
        continue;
      }
    } else {
      mkdirSync(WS.paths.inbox, { recursive: true });
      row.inbox = freeName(WS.paths.inbox, row.name);
      writeFileSync(join(WS.paths.inbox, row.inbox), bytes);
      handedOver([row.id]);
      arrival = { kind: 'receipt', file: row.name, id: row.id };
    }
    const started = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'outside', file: row.name }, 'live', [arrival]);
    Object.assign(row, { state: 'taken', ...(started.ok && started.run ? { run: started.run } : {}) });
    rmSync(fileOf(s.id, row.key), { force: true });
  }
}

function unquarantine(row: DropRow): void {
  if (!row.quarantined) return;
  rmSync(join(QUARANTINE(), row.quarantined), { force: true });
  rmSync(join(QUARANTINE(), `${row.quarantined}.reason.txt`), { force: true });
  delete row.quarantined;
}

/**
 * «Rückgängig» for a taken file. A receipt leaves the inbox and the books, with its links and the
 * entries booked with it (removeReceipt); returns its payments, to be booked again as they would
 * be without it. A statement leaves with its file, its closing balances, the payments it added,
 * and their links and entries. Never while its run works on it, never in the closed period, never
 * an entry a person booked by hand (such a payment stays, and the refusal says so).
 */
function undo(row: DropRow): string[] {
  let again: string[] = [];
  const run = row.run ? engine().run(row.run) : undefined;
  if (run && run.state.status === 'running') throw new RequestError(409, 'Der Lauf arbeitet gerade daran. Gleich noch einmal.');
  if (row.statement) {
    const refs = new Set(row.statement.refs);
    const books = readBooks();
    assertOpen(books, [...refs].flatMap((ref) => refDates(books, ref)), 'deleteTransaction');
    if ((books.journalEntries ?? []).some((e) => refs.has(e.transactionRef) && e.origin === 'manual')) throw new RequestError(409, 'Auf einer dieser Zahlungen steht eine Buchung von Hand. Erst sie löschen.');
    const path = findFile(WS.paths, 'statements', row.statement.file);
    const file = basename(row.statement.file);
    updateBooks((b) => {
      b.transactions = b.transactions.filter((t) => !refs.has(t.ref));
      b.journalEntries = b.journalEntries.filter((e) => !refs.has(e.transactionRef));
      b.mappings = b.mappings.filter((m) => !refs.has(m.transactionRef));
      if (b.statementBalances) b.statementBalances = b.statementBalances.filter((x) => x.sourceFile !== file);
    });
    if (path) rmSync(path, { force: true });
  } else {
    const books = readBooks();
    const receipt = books.receipts.find((r) => r.id === row.id);
    if (receipt) {
      assertOpen(books, receiptDates(books, row.id), 'deleteReceipt');
      const pdf = receiptPath(books, receipt);
      again = updateBooks((b) => removeReceipt(b, row.id));
      rmSync(pdf, { force: true });
    }
    if (row.inbox) rmSync(join(WS.paths.inbox, row.inbox), { force: true });
  }
  if (row.run) engine().withdraw(row.run, row.inbox ? row.name : row.statement?.file ?? row.name);
  row.state = 'undone';
  return again;
}

router.delete('/api/drop/:id', (req, res) => {
  load(req.params.id);
  rmSync(dir(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});
