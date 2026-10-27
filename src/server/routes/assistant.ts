/**
 * The AI sidebar over HTTP (src/assistant/). Answers stream as NDJSON, one event per line.
 *
 *   GET  /api/assistant        the conversations, newest first
 *   GET  /api/assistant/:id    one conversation with its turns
 *   POST /api/assistant        an AssistantSend → the answer's events
 *   POST /api/assistant/attachments?name=…   a file's bytes for the next message → its Attachment
 *   DELETE /api/assistant/attachments/:att   an upload taken off before it was sent
 *   GET  /api/assistant/:id/attachments/:att a sent attachment's file
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import express, { Router, type Response } from 'express';
import { RequestError, WS, readBooks, refusalOf, reopenWorkspace, updateBooks } from '../books.js';
import { listConversations, readConversation, RefusedChanges, sendMessage, settleHeld, undoChange, type ApplyChanges } from '../../assistant/conversations.js';
import { PURPOSES, isActionChange, isBookChange, isWorkspaceChange, type Purpose, type ActionChange, type AssistantEvent, type AssistantSend, type BookChange, type ContextRef, type MadeChange } from '../../types/assistant.js';
import type { Books } from '../../books/store.js';
import { applyAnswer, applyChange, relinked, unbookedPayments } from '../edits.js';
import { applyWorkspaceChange, withMailHosts } from '../workspace-edits.js';
import { collectionNow } from '../collection-now.js';
import { learnFromCorrection, undoAnswer } from '../questions.js';
import { heldRows, holdReasons, withoutProof } from '../../assistant/held.js';
import { takeInProposals } from '../../assistant/terminal-drafts.js';
import { appMap } from '../app-map.js';
import { gate } from '../../llm/off.js';
import { automationView, bookAgain, engine } from './automation.js';
import { openWork } from '../open-work.js';
import { askedBy } from '../../workflows/held.js';
import { accountsOf } from '../../workspace/reads.js';
import { PRESETS, parseRequest, presetPeriod } from '../../export/model.js';
import { buildBundle, downloadOf, zipBundle } from '../../export/bundle.js';
import { NoBrowserError, printPdf } from '../../invoices/pdf.js';
import { booksOpenPeriod, localToday } from '../../accounting/periods.js';
import { filing } from '../../engines/index.js';
import { factsRefusal, refused, runSpec } from './reports.js';
import { previewOf } from '../../reports/run.js';
import { AttachmentError, attachmentFile, dropPending, findAttachments, saveAttachment } from '../../assistant/attachments.js';
import { ATTACHMENT_MAX_MB } from '../../types/attachment.js';
import { readProgress, rememberConversation } from '../../onboarding/store.js';
import { setupFacts } from './onboarding.js';
import { SETUP_PURPOSE, setupNote } from '../../onboarding/prompt.js';
import { wordsIn } from '../../export/texts.js';

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
  const attachments = Array.isArray(b.attachments) ? b.attachments : [];
  if (attachments.length > 10 || !attachments.every((a): a is string => typeof a === 'string')) throw new RequestError(400, 'attachments: höchstens 10 Ids.');
  return {
    text: text.slice(0, 20_000), context, ...(attachments.length ? { attachments } : {}),
    ...(typeof b.conversation === 'string' && b.conversation ? { conversation: b.conversation } : {}),
    ...(PURPOSES.includes(b.purpose as Purpose) ? { purpose: b.purpose as Purpose } : {}),
    language: typeof b.language === 'string' ? b.language : 'de',
  };
}

function ndjson(res: Response): (e: AssistantEvent) => void {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.flushHeaders();
  return (e) => { res.write(JSON.stringify(e) + '\n'); };
}

router.get('/api/assistant', async (_req, res) => {
  // What an AI in the terminal proposed comes in as a conversation, held for «Übernehmen» (issue #146).
  await takeInProposals(WS, apply);
  res.json(listConversations(WS));
});

router.get('/api/assistant/:id', (req, res) => {
  const c = readConversation(WS, req.params.id);
  if (!c) throw new RequestError(404, 'Dieses Gespräch gibt es nicht.');
  res.json(c);
});

/**
 * What waits under Aufgaben now (the questions, the workflows' tasks with the rule that held each,
 * the payments without a booking), and how receipts come in now. A conversation with a purpose gets
 * only its own context, so the AI has nothing unrelated to bring up.
 */
async function waitingNow(language: string, purpose: Purpose | undefined): Promise<string> {
  if (purpose === 'collection-setup') return [PURPOSE_NOTE[purpose], await collectionNow(WS, language, readBooks().receipts)].join('\n\n');
  if (purpose === 'onboarding') {
    const books = readBooks();
    return [PURPOSE_NOTE[purpose], setupNote(readProgress(WS), setupFacts(), wordsIn(language).t), await collectionNow(WS, language, books.receipts)].join('\n\n');
  }
  const runs = new Map(engine().runs().map((r) => [r.id, r]));
  const tasks = automationView().tasks.map((x) => { const rule = runs.get(x.run) && askedBy(runs.get(x.run)!); return rule ? { ...x, rule } : x; });
  const books = readBooks();
  return [openWork(WS, books, tasks, language), await collectionNow(WS, language, books.receipts)].filter(Boolean).join('\n\n');
}

const PURPOSE_NOTE: Record<Purpose, string> = {
  'collection-setup': 'This conversation\'s purpose: setting up how receipts come in (the person started it with «Mit KI einrichten»). Stay on it.',
  onboarding: SETUP_PURPOSE,
};

/** An attachment refused at the boundary: its words, and its code for the UI's. */
const asRequest = (e: unknown) => (e instanceof AttachmentError ? new RequestError(e.refusal.params.reason === 'size' ? 413 : 400, e.message, e.refusal) : e);

/** A file for the next message, kept outside the books until it is sent (src/assistant/attachments.ts); the raw limit is above ours, so ours says why. */
router.post('/api/assistant/attachments', express.raw({ type: () => true, limit: `${ATTACHMENT_MAX_MB + 5}mb` }), async (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name : '';
  const bytes = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
  try {
    res.json(await saveAttachment(WS, name, req.get('Content-Type') ?? '', bytes));
  } catch (e) { throw asRequest(e); }
});

router.delete('/api/assistant/attachments/:att', (req, res) => {
  dropPending(WS, req.params.att);
  res.json({ ok: true });
});

router.get('/api/assistant/:id/attachments/:att', (req, res) => {
  const file = attachmentFile(WS, req.params.id, req.params.att);
  if (!file) throw new RequestError(404, 'Diese Datei gibt es nicht mehr.');
  res.type(file.attachment.type);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.attachment.name)}`);
  res.sendFile(file.path);
});

router.post('/api/assistant', async (req, res) => {
  const send = sendOf(req.body);
  gate();
  let attachments;
  try { attachments = findAttachments(WS, send.attachments ?? [], send.conversation); } catch (e) { throw asRequest(e); }
  const emit = ndjson(res);
  const stop = new AbortController();
  res.on('close', () => { if (!res.writableFinished) stop.abort(); });
  const known = send.conversation ? readConversation(WS, send.conversation) : undefined;
  const purpose = known ? known.purpose : send.purpose;
  // The setup conversation is kept with the checklist, so reopening the setup continues it.
  const told = purpose === 'onboarding' ? (e: AssistantEvent) => { if (e.type === 'conversation') rememberConversation(WS, e.id, new Date().toISOString()); emit(e); } : emit;
  await sendMessage(WS, send, apply, { map: appMap(send.language), waiting: await waitingNow(send.language, purpose), attachments }, told, stop.signal);
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
    if (c.kind === 'report') return { note: { report: previewOf(runSpec(c.spec, c.period)) } };
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
 * on the books as the answer left them. With `hold`, the changes to the books are tried on a copy
 * first: an answer that rebooks rather than fixes one booking (src/assistant/held.ts) changes
 * nothing and comes back as the rows of its card.
 */
const apply: ApplyChanges = async (answered, earlier, language, { conversation, hold }) => {
  const changes = await withMailHosts(answered);
  // A report whose filter names an account the chart lacks, or a code the form does not take, refuses the answer before anything is made.
  for (const c of changes) {
    const r = c.kind === 'report' ? factsRefusal(c.spec) : undefined;
    if (r) { const e = refused(r); throw new RefusedChanges(e.message, e.refusal); }
  }
  const outside: Array<Omit<MadeChange, 'id'>> = [];
  let after = () => {};
  let books: Array<Omit<MadeChange, 'id'>> = [];
  const asked = changes.filter(isBookChange);
  const chart = new Set((accountsOf(WS) as Array<{ number: unknown }>).map((a) => String(a.number)));
  if (hold === 'always' || (hold && asked.length)) {
    const added = changes.flatMap((c) => (c.kind === 'account' && c.name !== null ? [c.number] : []));
    const before = readBooks();
    const trial = readBooks();
    try {
      applyAnswer(trial, asked, { bankAccounts: WS.bankAccounts, chart: chart.size ? new Set([...chart, ...added]) : chart, earlier, conversation, uid: WS.company.uid });
    } catch (e) {
      throw new RefusedChanges((e as Error).message, refusalOf(e));
    }
    const rows = heldRows(before, trial);
    const why = [...(hold === 'always' ? ['terminal' as const] : []), ...holdReasons(rows)];
    if (why.length) return { held: { why, rows } };
  }
  try {
    for (const c of changes.filter(isWorkspaceChange)) {
      outside.push({ change: c, ...applyWorkspaceChange(WS, readBooks(), c) });
      if (c.kind === 'invoicing') reopenWorkspace();
    }
    if (asked.length) {
      const now = new Set((accountsOf(WS) as Array<{ number: unknown }>).map((a) => String(a.number)));
      books = updateBooks((b) => {
        const made = applyAnswer(b, asked, { bankAccounts: WS.bankAccounts, chart: now, earlier, conversation, uid: WS.company.uid });
        for (const m of made) {
          const id = m.change.kind === 'entry' ? m.change.id : m.undo?.kind === 'deleteEntry' ? m.undo.id : undefined;
          const e = id ? b.journalEntries.find((x) => x.id === id) : undefined;
          if (e && withoutProof(b, e)) m.note = { ...m.note, noReceipt: true };
        }
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
  // A sale's code set on the wish answers the app's question about it; the change's undo opens it again.
  for (const q of learnFromCorrection(books.flatMap((m) => (m.payment ? [m.payment] : [])))) {
    const m = books.find((x) => x.payment === q.on.id);
    if (m) m.answered = [...(m.answered ?? []), q.id];
  }
  const actions: Array<Omit<MadeChange, 'id'>> = [];
  for (const c of changes.filter(isActionChange)) actions.push({ change: c, ...(await run(c, language)) });
  return { made: [...outside, ...books, ...actions].map((m) => ({ id: randomUUID().slice(0, 8), ...m })) };
};

/** «Übernehmen» or «Verwerfen» on an answer's held changes (src/assistant/conversations.ts settleHeld): the turn as it is now. */
router.post('/api/assistant/:id/held/:turn', async (req, res) => {
  const { take, language } = (req.body ?? {}) as { take?: unknown; language?: unknown };
  if (typeof take !== 'boolean') throw new RequestError(400, 'take: true (Übernehmen) oder false (Verwerfen).');
  let turn;
  try {
    turn = await settleHeld(WS, req.params.id, Number(req.params.turn), take, typeof language === 'string' ? language : 'de', apply);
  } catch (e) {
    if (e instanceof RefusedChanges) throw new RequestError(400, e.message, e.refusal);
    throw e;
  }
  if (!turn) throw new RequestError(404, 'Diese Antwort hält keine Änderungen.');
  res.json(turn);
});

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
  // The question a change answered is open again: the change it was answered by is gone.
  for (const id of made.flatMap((m) => m.answered ?? [])) {
    try { undoAnswer(id, WS.company.owner); } catch (e) { if (!(e instanceof RequestError)) throw e; }
  }
  res.json(made);
});
