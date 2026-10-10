import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RequestError, WS, readBooks } from '../books.js';
import type { InboxFile } from '../../types/index.js';
import { APP_ROOT } from '../../workspace/workspace.js';

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

router.post('/api/upload', express.raw({ type: 'application/pdf', limit: '50mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'No PDF body received' }); return;
  }
  mkdirSync(WS.paths.inbox, { recursive: true });
  const capturedAtHeader = req.headers['x-captured-at'] as string | undefined;
  const ts = capturedAtHeader ? new Date(capturedAtHeader) : new Date();
  const date = isNaN(ts.getTime()) ? new Date() : ts;
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  // Several files dropped at once share their second: none may overwrite another.
  let filename = `${stamp}.pdf`;
  for (let n = 2; existsSync(join(WS.paths.inbox, filename)); n++) filename = `${stamp}-${n}.pdf`;
  writeFileSync(join(WS.paths.inbox, filename), req.body);
  console.log(`  scan upload: ${filename} (${req.body.length} bytes)`);
  res.json({ ok: true, filename });
});

/**
 * The PDFs in the inbox (beleg-import/) that the books do not hold yet: dropped or scanned, not
 * read by `npm run extract` so far. Each carries the id its receipt will have (the first 16 hex
 * of its SHA-256, as extract computes it), so a link to it keeps working once it is read.
 */
function inboxFiles(): InboxFile[] {
  if (!existsSync(WS.paths.inbox)) return [];
  const known = new Set(readBooks().receipts.filter((r) => r.location === 'staged').map((r) => r.filename));
  return readdirSync(WS.paths.inbox)
    .filter((f) => f.toLowerCase().endsWith('.pdf') && !known.has(f))
    .map((filename) => {
      const path = join(WS.paths.inbox, filename);
      const content = readFileSync(path);
      return { id: createHash('sha256').update(content).digest('hex').slice(0, 16), filename, size: content.length, addedAt: statSync(path).mtime.toISOString() };
    });
}

router.get('/api/inbox', (_req, res) => {
  res.json(inboxFiles());
});

router.get('/api/inbox/:id', (req, res) => {
  const file = inboxFiles().find((f) => f.id === req.params.id);
  if (!file) throw new RequestError(404, 'Not in the inbox');
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(join(WS.paths.inbox, file.filename));
});
