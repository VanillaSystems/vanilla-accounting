import express from 'express';
import { ClosedPeriodError } from '../books/store.js';
import { RequestError } from './books.js';
import type { ApiErrorBody, ApiStatus } from '../types/api-error.js';
import { router as classify } from './routes/classify.js';
import { router as scan } from './routes/scan.js';
import { router as receipts } from './routes/receipts.js';
import { router as rename } from './routes/rename.js';
import { router as transactions } from './routes/transactions.js';
import { router as mappings } from './routes/mappings.js';
import { router as journal } from './routes/journal.js';
import { router as config } from './routes/config.js';
import { router as yearClose } from './routes/year-close.js';
import { router as files } from './files.js';

export const app = express();

/**
 * The server listens on the network only so the phone app can upload scans (src/server/routes/scan.ts).
 * Everything else — the books, receipts, every write — answers only to this computer.
 */
export const NETWORK_PATHS: ReadonlySet<string> = new Set(['/scan', '/scan/manifest.json', '/api/upload', '/api/status']);
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
app.use((req, res, next) => {
  if (LOOPBACK.test(req.socket.remoteAddress ?? '') || NETWORK_PATHS.has(req.path)) return next();
  res.status(403).json({ error: 'Nur von diesem Computer aus erreichbar.', code: 'localOnly' } satisfies ApiErrorBody);
});
app.use(express.json());

// Read-only mode (READONLY=1): block all mutations so an auditor can navigate the
// whole app without risk of accidental edits/deletes or triggering paid LLM calls.
export const READONLY = process.env.READONLY === '1';
if (READONLY) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.status(403).json({ error: 'Nur-Lese-Modus: Änderungen sind während der Prüfung deaktiviert.', code: 'readonly' } satisfies ApiErrorBody);
      return;
    }
    next();
  });
}

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, readonly: READONLY } satisfies ApiStatus);
});

app.use(files, scan, receipts, rename, transactions, mappings, journal, config, classify, yearClose);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ClosedPeriodError) {
    const params = { closedThrough: err.closedThrough ?? '', ...(err.reason ? { reason: err.reason } : {}) };
    res.status(403).json({ error: err.message, code: 'periodClosed', params } satisfies ApiErrorBody);
  } else if (err instanceof RequestError) res.status(err.status).json({ error: err.message, ...err.refusal } satisfies ApiErrorBody);
  else {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
