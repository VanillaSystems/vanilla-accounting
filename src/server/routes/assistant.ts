/**
 * The AI sidebar over HTTP (src/assistant/). Answers stream as NDJSON, one event per line.
 *
 *   GET  /api/assistant        the conversations, newest first
 *   GET  /api/assistant/:id    one conversation with its turns
 *   POST /api/assistant        an AssistantSend → the answer's events
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Router, type Response } from 'express';
import { RequestError, WS, readBooks, refusalOf, reopenWorkspace, updateBooks } from '../books.js';
import { listConversations, readConversation, RefusedChanges, sendMessage, undoChange, type ApplyChanges } from '../../assistant/conversations.js';
import { isActionChange, isBookChange, isWorkspaceChange, type ActionChange, type AssistantEvent, type AssistantSend, type BookChange, type ContextRef, type MadeChange } from '../../types/assistant.js';
import type { Books } from '../../books/store.js';
import { applyAnswer, applyChange, relinked, unbookedPayments } from '../edits.js';
import { applyWorkspaceChange } from '../workspace-edits.js';
import { learnFromCorrection } from '../questions.js';
import { appMap } from '../app-map.js';
import { bookAgain } from './automation.js';
import { accountsOf } from '../../workspace/reads.js';
import { PRESETS, parseRequest, presetPeriod } from '../../export/model.js';
import { buildBundle, downloadOf, zipBundle } from '../../export/bundle.js';
import { NoBrowserError, printPdf } from '../../invoices/pdf.js';
import { booksOpenPeriod, localToday } from '../../accounting/periods.js';
import { filing } from '../../engines/index.js';

export const router = Router();

const KINDS = new Set<ContextRef['kind']>(['entry', 'payment', 'receipt', 'run', 'workflow', 'file']);

function sendOf(body: unknown): AssistantSend {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = typeof b.text === 'string' ? b.text : '';
  if (!text.trim()) throw new RequestError(400, 'Leere Nachricht.');
  const context = Array.isArray(b.context) ? b.context : [];
  if (context.length > 12 || !context.every((r): r is ContextRef => !!r && KINDS.has(r.kind) && typeof r.id === 'string' && typeof r.label === 'string')) {
    throw new RequestError(400, 'context: Verweise mit kind, id und label.');
  }
  return {
    text: text.slice(0, 20_000), context,
    ...(typeof b.conversation === 'string' && b.conversation ? { conversation: b.conversation } : {}),
    language: typeof b.language === 'string' ? b.language : 'de',
  };
}

function ndjson(res: Response): (e: AssistantEvent) => void {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.flushHeaders();
  return (e) => { res.write(JSON.stringify(e) + '\n'); };
}

router.get('/api/assistant', (_req, res) => {
  res.json(listConversations(WS));
});

router.get('/api/assistant/:id', (req, res) => {
  const c = readConversation(WS, req.params.id);
  if (!c) throw new RequestError(404, 'Dieses Gespräch gibt es nicht.');
  res.json(c);
});

router.post('/api/assistant', async (req, res) => {
  const send = sendOf(req.body);
  const emit = ndjson(res);
  const stop = new AbortController();
  res.on('close', () => { if (!res.writableFinished) stop.abort(); });
  await sendMessage(WS, send, apply, appMap(send.language), emit, stop.signal);
  res.end();
});

/**
 * Changes that took payments' bookings away: new VAT facts of a receipt (src/server/edits.ts
 * setReceipt), a link made or taken back, a receipt set aside with its links (relinked: the
 * changes and their undos, which carry the links). The inbox run books them again.
 */
function bookedAgain(books: Books, changes: readonly BookChange[]): () => void {
  const links = relinked(books, changes);
  const receipts = changes.flatMap((c) => (c.kind === 'receipt' && c.set.vat ? [c.id] : []));
  const payments = [...links.payments, ...unbookedPayments(books, receipts)];
  const file = links.file ?? books.receipts.find((r) => receipts.includes(r.id))?.filename ?? payments[0];
  return payments.length ? () => { bookAgain(file).catch((e) => console.error(`receipt-intake: ${(e as Error).message}`)); } : () => {};
}

const bookChanges = (made: ReadonlyArray<Pick<MadeChange, 'change' | 'undo'>>): BookChange[] =>
  made.flatMap((m) => [m.change, ...(m.undo ? [m.undo] : [])]).filter(isBookChange);

const EXPORTS = () => join(WS.paths.data, 'exports');

/** An export preset as the dialog makes it, written to data/exports/ for the card's download. */
async function exported(c: Extract<ActionChange, { kind: 'export' }>, language: string): Promise<Pick<MadeChange, 'note'>> {
  const preset = PRESETS.find((p) => p.id === c.preset)!;
  const books = readBooks();
  const open = booksOpenPeriod(books, localToday(), filing().length);
  const request = parseRequest({ period: c.period ?? presetPeriod(preset, open, open), items: preset.items, sums: preset.sums, oneBook: preset.oneBook, language });
  const names = Object.fromEntries((accountsOf(WS) as Array<{ number: string; name: string }>).map((a) => [a.number, a.name]));
  const bundle = await buildBundle(WS, books, names, request, { print: printPdf });
  const { name } = downloadOf(bundle);
  mkdirSync(EXPORTS(), { recursive: true });
  const path = join(EXPORTS(), name);
  const out = createWriteStream(path);
  if (bundle.files.length === 1) out.write(Buffer.from(bundle.files[0].data));
  else await zipBundle(bundle, (chunk) => out.write(chunk));
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  return { note: { file: { name, path } } };
}

/** What the app runs for an answer, once its changes are made: nothing to undo, a failure is said on its card. */
async function run(c: ActionChange, language: string): Promise<Pick<MadeChange, 'note'>> {
  try {
    if (c.kind === 'export') return await exported(c, language);
    await bookAgain('assistant');
    return {};
  } catch (e) {
    return { note: { failed: e instanceof NoBrowserError ? 'noBrowser' : (e as Error).message } };
  }
}

/**
 * All of an answer's changes, or none: the chart, the invoicing settings and the invoice drafts
 * first (so a booking may use an account the same answer adds), then the books in one write; a
 * refusal of the books takes the others back. The actions (an export, booking again) run last,
 * on the books as the answer left them.
 */
const apply: ApplyChanges = async (changes, earlier, language) => {
  const outside: Array<Omit<MadeChange, 'id'>> = [];
  let after = () => {};
  let books: Array<Omit<MadeChange, 'id'>> = [];
  try {
    for (const c of changes.filter(isWorkspaceChange)) {
      outside.push({ change: c, ...applyWorkspaceChange(WS, readBooks(), c) });
      if (c.kind === 'invoicing') reopenWorkspace();
    }
    const asked = changes.filter(isBookChange);
    if (asked.length) {
      const chart = new Set((accountsOf(WS) as Array<{ number: unknown }>).map((a) => String(a.number)));
      books = updateBooks((b) => {
        const made = applyAnswer(b, asked, { bankAccounts: WS.bankAccounts, chart, earlier });
        after = bookedAgain(b, bookChanges(made));
        return made;
      });
    }
  } catch (e) {
    for (const m of outside.reverse()) {
      if (m.undo && isWorkspaceChange(m.undo)) {
        try { applyWorkspaceChange(WS, readBooks(), m.undo); } catch (err) { console.error(`assistant: ${(err as Error).message}`); }
      }
    }
    reopenWorkspace();
    throw new RefusedChanges((e as Error).message, refusalOf(e));
  }
  after();
  learnFromCorrection(books.flatMap((m) => (m.payment ? [m.payment] : [])));
  const actions: Array<Omit<MadeChange, 'id'>> = [];
  for (const c of changes.filter(isActionChange)) actions.push({ change: c, ...(await run(c, language)) });
  return [...outside, ...books, ...actions].map((m) => ({ id: randomUUID().slice(0, 8), ...m }));
};

/** An export an answer made, from data/exports/. */
router.get('/api/assistant/exports/:file', (req, res) => {
  const file = basename(req.params.file);
  const path = join(EXPORTS(), file);
  if (file !== req.params.file || !existsSync(path)) throw new RequestError(404, 'Diesen Export gibt es nicht mehr.');
  res.download(path, file);
});

/** Undoes one change, with the others of its answer it belongs with (src/assistant/conversations.ts undoChange). */
router.post('/api/assistant/:id/changes/:change/undo', (req, res) => {
  let after = () => {};
  const made = undoChange(WS, req.params.id, req.params.change, (undos) => {
    // The books first: an account an answer added goes only once no booking of it is left.
    const asked = undos.filter(isBookChange);
    if (asked.length) {
      updateBooks((books) => {
        for (const c of asked) applyChange(books, c);
        after = bookedAgain(books, asked);
      });
    }
    for (const c of undos.filter(isWorkspaceChange)) {
      applyWorkspaceChange(WS, readBooks(), c);
      if (c.kind === 'invoicing') reopenWorkspace();
    }
  });
  if (!made) throw new RequestError(404, 'Diese Änderung gibt es nicht.');
  after();
  res.json(made);
});
