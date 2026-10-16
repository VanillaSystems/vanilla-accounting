import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RequestError, WS, readBooks } from '../books.js';
import type { InboxFile } from '../../types/index.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { RECEIPT_TYPES, receiptType, type ReceiptType } from '../../types/upload.js';
import { capturedStem } from '../../intake/captured.js';
import { smallerPdf } from '../../parsers/smaller.js';
import { INTAKE, engine } from './automation.js';

export const router = Router();

// ─── Scan PWA ────────────────────────────────────────────────────────────────

router.get('/scan', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(readFileSync(join(APP_ROOT, 'src', 'server', 'scan.html'), 'utf8'));
});

router.get('/scan/manifest.json', (_req, res) => {
  res.json({
    name: 'Beleg scannen',
    short_name: 'Beleg',
    start_url: '/scan',
    display: 'standalone',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    icons: [],
  });
});

router.post('/api/upload', express.raw({ type: Object.keys(RECEIPT_TYPES), limit: '50mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'No PDF or photo (JPG, PNG, HEIC) received' }); return;
  }
  const ext = RECEIPT_TYPES[req.headers['content-type']?.split(';')[0].trim().toLowerCase() as ReceiptType];
  mkdirSync(WS.paths.inbox, { recursive: true });
  const capturedAtHeader = req.headers['x-captured-at'] as string | undefined;
  const ts = capturedAtHeader ? new Date(capturedAtHeader) : new Date();
  const stamp = capturedStem(isNaN(ts.getTime()) ? new Date() : ts);
  // The phone's own scan: made smaller before its id (a photo is, once the read step wraps it).
  // Before the name is chosen: from there to the write nothing waits, so two uploads never take one name.
  const bytes = ext === 'pdf' ? await smallerPdf(req.body) : req.body;
  // Several files dropped at once share their second: none may overwrite another.
  // A photo's PDF takes the photo's name, so no two files may share a name before the extension.
  const stems = new Set(readdirSync(WS.paths.inbox).map((f) => f.replace(/\.[^.]+$/, '')));
  let name = stamp;
  for (let n = 2; stems.has(name); n++) name = `${stamp}-${n}`;
  const filename = `${name}.${ext}`;
  writeFileSync(join(WS.paths.inbox, filename), bytes);
  console.log(`  scan upload: ${filename} (${req.body.length} bytes${bytes.length < req.body.length ? `, made smaller to ${bytes.length}` : ''})`);
  res.json({ ok: true, filename });
});

/**
 * The PDFs in the inbox (beleg-import/) that the books do not hold yet: dropped or scanned, not
 * read by the inbox processing (src/intake/) so far. Each carries the id its receipt will have (the first 16 hex
 * of its SHA-256, as extract computes it), so a link to it keeps working once it is read.
 * `photos` adds the photos the processing wraps into PDFs; Belege shows them only once wrapped.
 */
export function inboxFiles({ withRead = false, photos = false } = {}): InboxFile[] {
  if (!existsSync(WS.paths.inbox)) return [];
  const known = new Set(withRead ? [] : readBooks().receipts.filter((r) => r.location === 'staged').map((r) => r.filename));
  return readdirSync(WS.paths.inbox)
    .filter((f) => {
      const type = receiptType({ type: '', name: f });
      return (type === 'application/pdf' || (photos && type !== undefined)) && !known.has(f);
    })
    .map((filename) => {
      const path = join(WS.paths.inbox, filename);
      const content = readFileSync(path);
      return { id: createHash('sha256').update(content).digest('hex').slice(0, 16), filename, size: content.length, addedAt: statSync(path).mtime.toISOString() };
    });
}

/** The inbox's files; one whose last run stopped carries that run and its reason, so no file reads as «wird gelesen» for good. */
router.get('/api/inbox', (_req, res) => {
  const runs = engine().runs().filter((r) => r.workflow === INTAKE && r.item.id === 'inbox').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  res.json(inboxFiles().map((f) => {
    const last = runs.find((r) => r.arrived?.some((a) => a.kind === 'receipt' && a.id === f.id) || r.startedAt >= f.addedAt);
    return last?.state.status === 'stuck' ? { ...f, failed: { run: last.id, error: last.state.reason } } : f;
  }));
});

// A page that still shows the file as waiting may ask for it after the processing has read it.
router.get('/api/inbox/:id', (req, res) => {
  const file = inboxFiles({ withRead: true }).find((f) => f.id === req.params.id);
  if (!file) throw new RequestError(404, 'Not in the inbox', { code: 'gone', params: { what: 'file' } });
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(join(WS.paths.inbox, file.filename));
});
