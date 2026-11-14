/**
 * Belege › Aussortiert: what came in and is no receipt by its words (a newsletter, terms, a tracking
 * notice), what a mailbox set aside by a group the person keeps aside or as a duplicate of a receipt,
 * or what a person set aside in the drop dialog (src/intake/quarantine.ts). It never entered the
 * books; «Doch behalten» takes it back into the inbox, and the inbox's run reads it. Taking back a
 * file of a group kept aside switches that group off (src/platform/sources/aside.ts). What a mailbox
 * set aside is deleted 30 days after it came; the list is swept when it is read.
 *
 *   GET  /api/quarantine              QuarantinedFile[]
 *   GET  /api/quarantine/:file        the file itself, to look at
 *   POST /api/quarantine/:file/take   back into the inbox, handed to the run
 *   POST /api/quarantine/take         { files }: all of them back into the inbox (a group), all or none
 *   POST /api/quarantine/delete       { files }: deleted for good (#228), all or none
 *
 * The quarantine lies in data/, outside the books and outside git: no record refers to its files
 * and no period holds them, so a delete changes nothing in the books.
 */
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestError, WS } from '../books.js';
import { INTAKE, engine, handedOver } from './automation.js';
import { namesOf } from './receipts.js';
import { freeName, quarantined, quarantinePath, reasonOf, release, sweepQuarantine } from '../../intake/quarantine.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { changeKeepingOn, sources } from '../../platform/sources/index.js';
import { switchAsideOff } from '../../platform/sources/aside.js';
import type { Arrival } from '../../workflows/model.js';

export const router = Router();

router.get('/api/quarantine', (_req, res) => {
  sweepQuarantine(WS.paths.data);
  res.json(quarantined(WS.paths.data));
});

router.post('/api/quarantine/delete', (req, res) => {
  const files = namesOf(req.body, 'files');
  const missing = files.find((f) => !quarantinePath(WS.paths.data, f));
  if (missing) throw new RequestError(404, `${missing} ist nicht in der Quarantäne.`, { code: 'gone', params: { what: 'quarantined' } });
  for (const f of files) release(WS.paths.data, f);
  res.json({ ok: true, deleted: files.length });
});

router.get('/api/quarantine/:file', (req, res) => {
  const path = quarantinePath(WS.paths.data, req.params.file);
  if (!path) throw new RequestError(404, 'Diese Datei ist nicht in der Quarantäne.');
  res.sendFile(path);
});

router.post('/api/quarantine/take', async (req, res) => {
  const files = namesOf(req.body, 'files');
  const missing = files.find((f) => !quarantinePath(WS.paths.data, f));
  if (missing) throw new RequestError(404, `${missing} ist nicht in der Quarantäne.`, { code: 'gone', params: { what: 'quarantined' } });
  const taken = files.map(takeBack);
  const run = await handToRun(taken);
  res.json({ ok: true, files: taken.map((t) => t.file), ...(run ? { run } : {}) });
});

router.post('/api/quarantine/:file/take', async (req, res) => {
  if (!quarantinePath(WS.paths.data, req.params.file)) throw new RequestError(404, 'Diese Datei ist nicht in der Quarantäne.');
  const taken = takeBack(req.params.file);
  const run = await handToRun([taken]);
  res.json({ ok: true, file: taken.file, ...(run ? { run } : {}) });
});

/**
 * A quarantined file back into the inbox under a free name. A file a mailbox set aside by a group the
 * person keeps aside switches that group off: the person said one of its files is a receipt.
 */
function takeBack(file: string): { file: string; id: string } {
  const reason = reasonOf(WS.paths.data, file);
  const bytes = release(WS.paths.data, file)!;
  if (reason?.kind === 'not-receipt' && reason.why === 'group' && reason.source && reason.from && reason.shape) {
    const { source, from, shape } = reason;
    const own = sources(WS, APP_ROOT).some((v) => v.kind !== 'invalid' && v.decl.id === source && v.decl.origin === 'company');
    if (own) changeKeepingOn(WS, APP_ROOT, source, () => { switchAsideOff(WS, source, { from, name: shape }); });
  }
  mkdirSync(WS.paths.inbox, { recursive: true });
  const name = freeName(WS.paths.inbox, file);
  writeFileSync(join(WS.paths.inbox, name), bytes);
  return { file: name, id: createHash('sha256').update(bytes).digest('hex').slice(0, 16) };
}

/** The files taken back, handed to one run of the inbox. */
async function handToRun(taken: Array<{ file: string; id: string }>): Promise<string | undefined> {
  handedOver(taken.map((t) => t.id));
  const arrived: Arrival[] = taken.map((t) => ({ kind: 'receipt', file: t.file, id: t.id, inbox: t.file }));
  const started = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'outside', file: taken[0].file }, 'live', arrived);
  return started.ok && started.run ? started.run : undefined;
}
