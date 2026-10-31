/**
 * Belege › Quarantäne: what came in and is no receipt by its words (a newsletter, terms, a tracking
 * notice), or what a person set aside in the drop dialog (src/intake/quarantine.ts). It never
 * entered the books; «Ist ein Beleg» takes it back into the inbox, and the inbox's run reads it.
 *
 *   GET  /api/quarantine              QuarantinedFile[]
 *   GET  /api/quarantine/:file        the file itself, to look at
 *   POST /api/quarantine/:file/take   back into the inbox, handed to the run
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
import { freeName, quarantined, quarantinePath, release } from '../../intake/quarantine.js';

export const router = Router();

router.get('/api/quarantine', (_req, res) => {
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

router.post('/api/quarantine/:file/take', async (req, res) => {
  const bytes = release(WS.paths.data, req.params.file);
  if (!bytes) throw new RequestError(404, 'Diese Datei ist nicht in der Quarantäne.');
  mkdirSync(WS.paths.inbox, { recursive: true });
  const name = freeName(WS.paths.inbox, req.params.file);
  writeFileSync(join(WS.paths.inbox, name), bytes);
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  handedOver([id]);
  const started = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'outside', file: name }, 'live', [{ kind: 'receipt', file: name, id, inbox: name }]);
  res.json({ ok: true, file: name, ...(started.ok && started.run ? { run: started.run } : {}) });
});
