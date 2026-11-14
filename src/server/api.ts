import express from 'express';
import { ClosedPeriodError, EmptyRefError, StaleBooksError } from '../books/store.js';
import { RequestError, WS, refusalOf } from './books.js';
import type { ApiErrorBody, ApiStatus, InvoiceErrorBody } from '../types/api-error.js';
import { router as classify } from './routes/classify.js';
import { router as scan } from './routes/scan.js';
import { router as receipts } from './routes/receipts.js';
import { router as transactions } from './routes/transactions.js';
import { router as mappings } from './routes/mappings.js';
import { router as pairing } from './routes/pairing.js';
import { router as journal } from './routes/journal.js';
import { router as config } from './routes/config.js';
import { router as yearClose } from './routes/year-close.js';
import { router as files } from './files.js';
import { router as invoices } from './routes/invoices.js';
import { router as statements } from './routes/statements.js';
import { router as exportBundle } from './routes/export.js';
import { router as automation } from './routes/automation.js';
import { router as changes } from './routes/changes.js';
import { router as assistant } from './routes/assistant.js';
import { router as drop } from './routes/drop.js';
import { router as sourcesRoute } from './routes/sources.js';
import { router as twins } from './routes/twins.js';
import { router as quarantine } from './routes/quarantine.js';
import { router as rules } from './routes/rules.js';
import { router as payouts } from './routes/payouts.js';
import { router as questions } from './routes/questions.js';
import { router as reports } from './routes/reports.js';
import { router as knowledge } from './routes/knowledge.js';
import { router as onboarding } from './routes/onboarding.js';
import { InvoiceRuleError, type InvoiceRefusal } from '../invoices/rules.js';
import { PaymentError } from '../invoices/payments.js';
import { NoBrowserError, PrintFailedError } from '../invoices/pdf.js';
import { MailError, type MailRefusal } from '../invoices/mail.js';
import { router as mail } from './routes/mail.js';
import { router as ai } from './routes/ai.js';
import { router as terminal } from './routes/terminal.js';
import { router as batch } from './routes/batch.js';
import { router as vatAdjustments } from './routes/vat-adjustments.js';
import { router as handover } from './routes/handover.js';
import { markerOf } from '../handover/durchsicht.js';
import { aiSetup } from './ai-setup.js';
import { NoClaudeError } from '../llm/providers/claude-cli.js';
import { AiRefused } from '../llm/provider.js';
import { aiOff } from '../llm/off.js';
import { NETWORK_PATHS, fromThisComputer, loopbackPeer, phoneGate, refuseForeignHost } from './phone.js';

export const app = express();

const MAIL_STATUS: Record<MailRefusal, number> = { notConfigured: 409, noPassword: 409, recipient: 400, failed: 502 };

const INVOICE_STATUS: Record<InvoiceRefusal, number> = {
  incomplete: 400, notFound: 404, notDraft: 409, notIssued: 409, cancelled: 409, paid: 409, creditNote: 409, nothingOpen: 409, changed: 409, uid: 400,
};

// From the network only the phone's paths answer (src/server/phone.ts), the API ones only with the
// pairing token. Everything else (the books, receipts, every write) answers
// only to this computer.
app.use((req, res, next) => {
  if (fromThisComputer(req) || NETWORK_PATHS.has(req.path)) return next();
  if (loopbackPeer(req)) { refuseForeignHost(res); return; }
  res.status(403).json({ error: 'Nur von diesem Computer aus erreichbar.', code: 'localOnly' } satisfies ApiErrorBody);
});
app.use(phoneGate);
app.use(express.json());

// Read-only mode (READONLY=1): block all mutations so an auditor can navigate the
// whole app without risk of accidental edits/deletes or triggering paid LLM calls.
// The export and a report's run and file are POSTs that only read the books: they stay open.
export const READONLY = process.env.READONLY === '1';
const READ_POSTS: ReadonlySet<string> = new Set(['/api/export', '/api/reports/run', '/api/reports/file']);
if (READONLY) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !READ_POSTS.has(req.path)) {
      res.status(403).json({ error: 'Nur-Lese-Modus: Änderungen sind während der Prüfung deaktiviert.', code: 'readonly' } satisfies ApiErrorBody);
      return;
    }
    next();
  });
}

// A Durchsicht copy (docs/specs/e2e-and-fiduciary.md B4): the recipient books and corrects; filing, sealing, the year's
// close, the company's settings and sharing onward are the sharer's. A guard against mistakes, not security (B2).
const SHARER_ONLY: Array<[string, RegExp, string]> = [
  ['POST', /^\/api\/year-close\/\d{4}\/(close|open)$/, 'yearClose'],
  ['PATCH', /^\/api\/workspace$/, 'settings'],
  ['POST', /^\/api\/workspace\/logo$/, 'settings'],
  ['POST', /^\/api\/handover\/share$/, 'share'],
];
app.use((req, res, next) => {
  const m = markerOf(WS.paths.root);
  if (!m) return next();
  const filing = req.method === 'POST' && req.path === '/api/automation' && (req.body as { kind?: string; workflow?: string } | undefined)?.kind === 'start' && ['vat-filing', 'year-close'].includes(String((req.body as { workflow?: string }).workflow));
  const hit = filing ? 'filing' : SHARER_ONLY.find(([method, path]) => req.method === method && path.test(req.path))?.[2];
  if (!hit) return next();
  res.status(403).json({ error: `Durchsicht: das macht ${m.sharer.name}.`, code: 'roleRefused', params: { action: hit, name: m.sharer.name } } satisfies ApiErrorBody);
});

app.get('/api/status', (_req, res) => {
  res.json({ ok: true, readonly: READONLY, ...(aiOff() ? { aiOff: true } : {}) } satisfies ApiStatus);
});

app.use(files, scan, receipts, transactions, mappings, pairing, journal, config, classify, yearClose, invoices, statements, exportBundle, mail, ai, aiSetup, terminal, automation, changes, assistant, drop, quarantine, sourcesRoute, twins, rules, payouts, questions, reports, batch, vatAdjustments, handover);
app.use(knowledge);
app.use(onboarding);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ClosedPeriodError) res.status(403).json({ error: err.message, ...refusalOf(err) } satisfies ApiErrorBody);
  else if (err instanceof EmptyRefError) res.status(409).json({ error: err.message, code: 'emptyRef', params: {} } satisfies ApiErrorBody);
  else if (err instanceof StaleBooksError) res.status(409).json({ error: err.message, ...refusalOf(err) } satisfies ApiErrorBody);
  else if (err instanceof RequestError) res.status(err.status).json({ error: err.message, ...err.refusal } satisfies ApiErrorBody);
  else if (err instanceof InvoiceRuleError) {
    res.status(INVOICE_STATUS[err.code]).json({ error: err.message, invoiceRefusal: err.code, ...(err.missing ? { missing: err.missing } : {}) } satisfies InvoiceErrorBody);
  } else if (err instanceof PaymentError) res.status(409).json({ error: err.message });
  else if (err instanceof MailError) res.status(MAIL_STATUS[err.code]).json({ error: err.message, mailRefusal: err.code, ...(err.detail ? { detail: err.detail } : {}) } satisfies ApiErrorBody);
  else if (err instanceof NoClaudeError) res.status(503).json({ error: err.message, code: 'noClaude', params: err.step ? { step: err.step } : {} } satisfies ApiErrorBody);
  else if (err instanceof AiRefused) res.status(503).json({ error: err.message, code: 'aiRefused', params: err.refusal } satisfies ApiErrorBody);
  else if (err instanceof NoBrowserError) res.status(503).json({ error: err.message, invoiceRefusal: 'noBrowser' } satisfies InvoiceErrorBody);
  else if (err instanceof PrintFailedError) res.status(503).json({ error: err.message, invoiceRefusal: 'printFailed' } satisfies InvoiceErrorBody);
  else {
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
