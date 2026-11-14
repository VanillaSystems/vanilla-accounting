/**
 * Belege › Aussortiert: what came in and is no receipt by its words (a newsletter, terms, a tracking
 * notice), what a mailbox set aside by a group the person keeps aside or as a duplicate of a receipt,
 * or what a person set aside in the drop dialog (src/intake/quarantine.ts). It never entered the
 * books; «Doch behalten» takes it back into the inbox, and the inbox's run reads it. Taking back a
 * file of a group kept aside switches that group off (src/platform/sources/aside.ts), and the
 * group's other files are kept from then on. What a mailbox set aside is deleted 30 days after it was
 * set aside, by the mailbox's next live pull (src/platform/sources/host.ts sweepAside); reading the
 * list never deletes anything.
 *
 *   GET  /api/quarantine              QuarantinedFile[]
 *   GET  /api/quarantine/.swept       { swept: Swept | null }: the last day files were deleted after 30 days, and how many
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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestError, WS } from '../books.js';
import { INTAKE, engine, handedOver } from './automation.js';
import { namesOf } from './receipts.js';
import { bytesOf, freeName, keepQuarantined, lastSwept, quarantined, quarantinePath, reasonOf, release, type Swept } from '../../intake/quarantine.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { changeKeepingOn, sources } from '../../platform/sources/index.js';
import { switchAsideOff } from '../../platform/sources/aside.js';
import type { Arrival } from '../../workflows/model.js';
import type { GroupStillOn, QuarantineReason } from '../../types/drop.js';

export const router = Router();

const gone = (file: string) => new RequestError(404, `${file} ist nicht in der Quarantäne.`, { code: 'gone', params: { what: 'quarantined' } });

router.get('/api/quarantine', (_req, res) => {
  res.json(quarantined(WS.paths.data));
});

router.get('/api/quarantine/.swept', (_req, res) => {
  res.json({ swept: lastSwept(WS.paths.data) ?? null } satisfies { swept: Swept | null });
});

router.post('/api/quarantine/delete', (req, res) => {
  const files = namesOf(req.body, 'files');
  const missing = files.find((f) => !quarantinePath(WS.paths.data, f));
  if (missing) throw gone(missing);
  for (const f of files) release(WS.paths.data, f);
  res.json({ ok: true, deleted: files.length });
});

router.get('/api/quarantine/:file', (req, res) => {
  const path = quarantinePath(WS.paths.data, req.params.file);
  if (!path) throw gone(req.params.file);
  res.sendFile(path);
});

router.post('/api/quarantine/take', async (req, res) => {
  const files = namesOf(req.body, 'files');
  const missing = files.find((f) => !quarantinePath(WS.paths.data, f));
  if (missing) throw gone(missing);
  const { taken, stillOn } = takeBack(files);
  const run = await handToRun(taken);
  res.json({ ok: true, files: taken.map((t) => t.file), ...(run ? { run } : {}), ...stillOnOf(stillOn) } satisfies TakeResult);
});

router.post('/api/quarantine/:file/take', async (req, res) => {
  if (!quarantinePath(WS.paths.data, req.params.file)) throw gone(req.params.file);
  const { taken: [taken], stillOn } = takeBack([req.params.file]);
  const run = await handToRun([taken]);
  res.json({ ok: true, file: taken.file, ...(run ? { run } : {}), ...stillOnOf(stillOn) } satisfies TakeResult);
});

/**
 * What «Doch behalten» answers. `groupStillOn`: groups whose switch-off failed (a source.yaml
 * changed meanwhile, a file that cannot be written): the files are in the inbox, but the group still
 * sets its next files aside, and the person is told so (code `groupStillOn`).
 */
type TakeResult = { ok: true; file?: string; files?: string[]; run?: string; groupStillOn?: GroupStillOn };
const stillOnOf = (groups: Array<{ source: string; from: string; shape: string }>) => (groups.length ? { groupStillOn: { code: 'groupStillOn' as const, groups } } : {});

/**
 * Quarantined files back into the inbox, all or none: each file's bytes are written into the inbox
 * first; if one cannot be, those written are taken out again and the quarantine stays as it was.
 * Only then do the files leave the quarantine. Last, best effort, a group a taken file was set aside
 * by is switched off and its other files are kept: a person said one of them is a receipt.
 */
function takeBack(files: readonly string[]): { taken: Array<{ file: string; id: string }>; stillOn: Array<{ source: string; from: string; shape: string }> } {
  const reasons = files.map((f) => reasonOf(WS.paths.data, f));
  const written: Array<{ file: string; id: string }> = [];
  try {
    mkdirSync(WS.paths.inbox, { recursive: true });
    for (const f of files) {
      const bytes = bytesOf(WS.paths.data, f);
      if (!bytes) throw gone(f);
      const name = freeName(WS.paths.inbox, f);
      writeFileSync(join(WS.paths.inbox, name), bytes);
      written.push({ file: name, id: createHash('sha256').update(bytes).digest('hex').slice(0, 16) });
    }
  } catch (e) {
    for (const w of written) rmSync(join(WS.paths.inbox, w.file), { force: true });
    throw e;
  }
  for (const f of files) release(WS.paths.data, f);
  const stillOn = new Map<string, { source: string; from: string; shape: string }>();
  for (const r of reasons) {
    const failed = switchGroupOff(r);
    if (failed) stillOn.set(`${failed.source} ${failed.from} ${failed.shape}`, failed);
  }
  return { taken: written, stillOn: [...stillOn.values()] };
}

/**
 * The group a file was set aside by goes off in its source.yaml, and the files of it still set aside
 * are kept. A failure leaves the group as it was (the files taken are in the inbox already) and is
 * returned, for the person to be told.
 */
function switchGroupOff(r: QuarantineReason | undefined): { source: string; from: string; shape: string } | undefined {
  if (r?.kind !== 'not-receipt' || r.why !== 'group' || !r.source || !r.from || !r.shape) return undefined;
  const { source, from, shape } = r;
  const same = (q: QuarantineReason) => q.kind === 'not-receipt' && q.why === 'group' && q.source === source && q.from === from && q.shape === shape;
  keepQuarantined(WS.paths.data, quarantined(WS.paths.data).filter((q) => same(q.reason)).map((q) => q.file));
  const own = sources(WS, APP_ROOT).some((v) => v.kind !== 'invalid' && v.decl.id === source && v.decl.origin === 'company');
  if (!own) return undefined;
  try {
    changeKeepingOn(WS, APP_ROOT, source, (expect) => { switchAsideOff(WS, source, { from, name: shape }, expect); });
    return undefined;
  } catch (e) {
    console.warn(`sources/${source}: group ${from} ${shape} not switched off: ${(e as Error).message}`);
    return { source, from, shape };
  }
}

/** The files taken back, handed to one run of the inbox. */
async function handToRun(taken: Array<{ file: string; id: string }>): Promise<string | undefined> {
  handedOver(taken.map((t) => t.id));
  const arrived: Arrival[] = taken.map((t) => ({ kind: 'receipt', file: t.file, id: t.id, inbox: t.file }));
  const started = await engine().start(INTAKE, { kind: 'company', id: 'inbox' }, { kind: 'outside', file: taken[0].file }, 'live', arrived);
  return started.ok && started.run ? started.run : undefined;
}
