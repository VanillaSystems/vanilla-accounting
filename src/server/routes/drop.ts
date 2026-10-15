/**
 * The drop dialog's session (docs/0.4.0/intake.md): files dropped while it is open wait in
 * data/drop/<session>/ (outside git), recognized and checked; nothing enters the inbox or the books
 * before «Hinzufügen». Then receipts and photos go into the inbox, statements are read as the Bank
 * area reads them, what is no receipt goes to data/quarantine/ with its reason, and the inbox's
 * workflow starts. A ZIP's password is used to unpack it and never written anywhere.
 *
 *   POST   /api/drop                      a new session
 *   POST   /api/drop/:id/files?name=      add a file (a ZIP is unpacked into its files)
 *   POST   /api/drop/:id/rows/:key        a DropAction on one row
 *   POST   /api/drop/:id/commit           «Hinzufügen»
 *   DELETE /api/drop/:id                  close without adding
 */
import express, { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { RequestError, WS, readBooks } from '../books.js';
import { engine } from './automation.js';
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
  const seen = new Set([...known(), ...s.rows.filter((r) => r.state !== 'refused').map((r) => r.id)]);
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
  if (s.done) throw new RequestError(409, 'Schon hinzugefügt.');
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || !body.length) throw new RequestError(400, 'Keine Datei erhalten.');
  const name = basename(String(req.query.name ?? '')).replace(/[\u0000-\u001f]/g, '').trim().slice(-160) || 'datei';
  await add(s, name, body);
  save(s);
  res.json(s);
});

router.post('/api/drop/:id/rows/:key', async (req, res) => {
  const s = load(req.params.id);
  const row = s.rows.find((r) => r.key === req.params.key);
  if (!row) throw new RequestError(404, 'Diese Zeile gibt es nicht.');
  const a = req.body as DropAction;
  switch (a?.kind) {
    case 'remove':
      s.rows = s.rows.filter((r) => r !== row);
      rmSync(fileOf(s.id, row.key), { force: true });
      break;
    case 'take':
      if (row.state === 'refused' || row.state === 'locked') throw new RequestError(400, 'Diese Datei lässt sich so nicht übernehmen.');
      Object.assign(row, { state: 'take', reason: undefined });
      break;
    case 'as':
      if (row.state === 'refused' || row.state === 'locked') throw new RequestError(400, 'Diese Datei lässt sich so nicht übernehmen.');
      Object.assign(row, a.as === 'quarantine' ? { state: 'quarantine', reason: 'held' } : { kind: 'receipt', state: 'take', reason: undefined });
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

router.post('/api/drop/:id/commit', async (req, res) => {
  const s = load(req.params.id);
  if (s.done) { res.json(s); return; }
  const refused: Array<{ name: string; message: string }> = [];
  // What came in, file by file, for the run that takes it up: the runs table says each in words.
  const arrived: Arrival[] = [];
  let taken = 0;
  for (const row of s.rows) {
    const bytes = () => readFileSync(fileOf(s.id, row.key));
    if (row.state === 'take' && (row.kind === 'receipt' || row.kind === 'photo')) {
      mkdirSync(WS.paths.inbox, { recursive: true });
      writeFileSync(join(WS.paths.inbox, freeName(WS.paths.inbox, row.name)), bytes());
      arrived.push({ kind: 'receipt', file: row.name, id: row.id });
      taken++;
    } else if (row.state === 'take' && (row.kind === 'camt' || row.kind === 'statement-pdf')) {
      try {
        const { month: _month, ...done } = await importStatement(bytes(), row.name);
        arrived.push({ kind: 'statement', ...done });
        taken++;
      } catch (e) {
        refused.push({ name: row.name, message: (e as Error).message });
        arrived.push({ kind: 'refused', file: row.name, reason: (e as Error).message });
      }
    } else if (row.state === 'quarantine') {
      const q = join(WS.paths.data, 'quarantine');
      mkdirSync(q, { recursive: true });
      const name = freeName(q, row.name);
      writeFileSync(join(q, name), bytes());
      writeFileSync(join(q, `${name}.reason.txt`), `${row.reason ?? ''}\n`);
    }
  }
  const started = taken ? await engine().start('receipt-intake', { kind: 'company', id: 'inbox' }, { kind: 'outside', file: s.rows.find((r) => r.state === 'take')?.name ?? '' }, 'live', arrived) : undefined;
  s.done = { taken, ...(started?.ok && started.run ? { run: started.run } : {}), refused };
  rmSync(join(dir(s.id), 'files'), { recursive: true, force: true });
  save(s);
  res.json(s);
});

router.delete('/api/drop/:id', (req, res) => {
  load(req.params.id);
  rmSync(dir(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});
