import express from 'express';
import { ClosedPeriodError } from '../books/store.js';
import { RequestError } from './books.js';
import { router as classify } from './routes/classify.js';
import { router as scan } from './routes/scan.js';
import { router as receipts } from './routes/receipts.js';
import { router as rename } from './routes/rename.js';
import { router as transactions } from './routes/transactions.js';
import { router as mappings } from './routes/mappings.js';
import { router as journal } from './routes/journal.js';
import { router as config } from './routes/config.js';
import { router as files } from './files.js';

export const app = express();
app.use(express.json());

// Read-only mode (READONLY=1): block all mutations so an auditor can navigate the
// whole app without risk of accidental edits/deletes or triggering paid LLM calls.
export const READONLY = process.env.READONLY === '1';
if (READONLY) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.status(403).json({ error: 'Nur-Lese-Modus: Änderungen sind während der Prüfung deaktiviert.' });
      return;
    }
    next();
  });
}

app.get('/api/status', (_req, res) => {
  res.json({ ok: true });
});

app.use(files, scan, receipts, rename, transactions, mappings, journal, config, classify);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ClosedPeriodError) res.status(403).json({ error: err.message });
  else if (err instanceof RequestError) res.status(err.status).json({ error: err.message });
  else {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
