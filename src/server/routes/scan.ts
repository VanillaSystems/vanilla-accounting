import express, { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WS } from '../books.js';
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
