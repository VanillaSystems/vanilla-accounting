import express from 'express';
import { ClosedPeriodError } from '../books/store.js';
import { RequestError, WS } from './books.js';
import type { ApiErrorBody, ApiStatus, InvoiceErrorBody } from '../types/api-error.js';
import { router as classify } from './routes/classify.js';
import { router as scan } from './routes/scan.js';
import { router as receipts } from './routes/receipts.js';
import { router as transactions } from './routes/transactions.js';
import { router as mappings } from './routes/mappings.js';
import { router as journal } from './routes/journal.js';
import { router as config } from './routes/config.js';
import { router as yearClose } from './routes/year-close.js';
import { router as files } from './files.js';
import { router as invoices } from './routes/invoices.js';
import { router as statements } from './routes/statements.js';
import { router as exportBundle } from './routes/export.js';
import { router as intake } from './routes/intake.js';
import { router as automation, queueCommit } from './routes/automation.js';
import { openRecordsCommitter } from '../saving/records.js';
import { InvoiceRuleError, type InvoiceRefusal } from '../invoices/rules.js';
import { PaymentError } from '../invoices/payments.js';
import { NoBrowserError } from '../invoices/pdf.js';
import { MailError, type MailRefusal } from '../invoices/mail.js';
import { router as mail } from './routes/mail.js';
import { NoClaudeError } from '../llm/ask.js';

export const app = express();

const MAIL_STATUS: Record<MailRefusal, number> = { notConfigured: 409, noPassword: 409, recipient: 400, failed: 502 };

const INVOICE_STATUS: Record<InvoiceRefusal, number> = {
  incomplete: 400, notFound: 404, notDraft: 409, notIssued: 409, cancelled: 409, paid: 409, creditNote: 409, nothingOpen: 409, changed: 409,
};

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
// The export is a POST that only reads the books: it stays open.
export const READONLY = process.env.READONLY === '1';
const READ_POSTS: ReadonlySet<string> = new Set(['/api/export']);
if (READONLY) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !READ_POSTS.has(req.path)) {
      res.status(403).json({ error: 'Nur-Lese-Modus: Änderungen sind während der Prüfung deaktiviert.', code: 'readonly' } satisfies ApiErrorBody);
      return;
    }
    next();
  });
}

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, readonly: READONLY } satisfies ApiStatus);
});

// A person's direct edit of the books is one commit (docs/0.4.0/ui/design.md, "Two paths into git"):
// after a write to the records succeeded, the app commits ledger.json and transactional-data/.
const RECORDS: Array<[RegExp, string]> = [
  [/^\/api\/receipts/, 'Beleg bearbeitet'], [/^\/api\/vision/, 'Beleg gelesen'], [/^\/api\/transactions/, 'Bewegung bearbeitet'],
  [/^\/api\/mapping/, 'Zuordnung bearbeitet'], [/^\/api\/journal-entries/, 'Buchung bearbeitet'], [/^\/api\/statements/, 'Kontoauszug eingelesen'],
  [/^\/api\/year-close/, 'Jahresabschluss'], [/^\/api\/invoices\/[^/]+\/payments/, 'Zahlung einer Rechnung gebucht']
];
app.use((req, res, next) => {
  const hit = req.method !== 'GET' ? RECORDS.find(([re]) => re.test(req.path)) : undefined;
  if (hit) res.on('finish', () => { if (res.statusCode < 400) void queueCommit(() => openRecordsCommitter(WS).commitEdit(hit[1])); });
  next();
});

app.use(files, scan, receipts, transactions, mappings, journal, config, classify, yearClose, invoices, statements, exportBundle, intake, mail, automation);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ClosedPeriodError) {
    const params = { closedThrough: err.closedThrough ?? '', ...(err.reason ? { reason: err.reason } : {}) };
    res.status(403).json({ error: err.message, code: 'periodClosed', params } satisfies ApiErrorBody);
  } else if (err instanceof RequestError) res.status(err.status).json({ error: err.message, ...err.refusal } satisfies ApiErrorBody);
  else if (err instanceof InvoiceRuleError) {
    res.status(INVOICE_STATUS[err.code]).json({ error: err.message, invoiceRefusal: err.code, ...(err.missing ? { missing: err.missing } : {}) } satisfies InvoiceErrorBody);
  } else if (err instanceof PaymentError) res.status(409).json({ error: err.message });
  else if (err instanceof MailError) res.status(MAIL_STATUS[err.code]).json({ error: err.message, mailRefusal: err.code, ...(err.detail ? { detail: err.detail } : {}) } satisfies ApiErrorBody);
  else if (err instanceof NoClaudeError) res.status(503).json({ error: err.message, code: 'noClaude' } satisfies ApiErrorBody);
  else if (err instanceof NoBrowserError) res.status(503).json({ error: err.message, invoiceRefusal: 'noBrowser' } satisfies InvoiceErrorBody);
  else {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
