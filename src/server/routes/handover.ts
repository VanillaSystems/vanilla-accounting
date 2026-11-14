/**
 * Sharing the books with a fiduciary and taking back his corrections (docs/specs/e2e-and-fiduciary.md
 * Part B), the transport a `.vanilla` file (B3.7); the link through the share service comes next.
 *
 *   GET  /api/handover                         the content version, a Durchsicht copy's facts, the returns kept
 *   GET  /api/handover/plan?name=&email=&full=&archive=   what a hand-over to that person would carry, with its size
 *   POST /api/handover/share                   { to, message?, full?, archive? } → the `.vanilla` file (writes a version)
 *   POST /api/handover/open                    a `.vanilla` file (raw): a return is kept for review; a hand-over opens as a Durchsicht copy
 *   GET  /api/handover/returns/:id             the review: rows by group, the effect on the VAT figures
 *   POST /api/handover/returns/:id/decide      { row, decision?, question? }
 *   POST /api/handover/returns/:id/apply       { groups: [..] | 'all' } → one save through the write door, a version
 *   POST /api/handover/returns/:id/undo        the take-over back as a whole
 * On a Durchsicht copy:
 *   GET  /api/handover/return                  what «Zurücksenden» would carry
 *   POST /api/handover/return                  { message? } → the return's `.vanilla` file
 *   PUT  /api/handover/notes                   { key, text }: his «Warum?» on a record
 *   POST /api/handover/close                   back to the books opened before the copy
 */
import express, { Router, type Response } from 'express';
import { existsSync } from 'node:fs';
import { RequestError, WS, openBooksAt, readBooks } from '../books.js';
import { currentVersion, readVersions, type Party } from '../../handover/versions.js';
import { makeShare, planShare, type ShareRequest } from '../../handover/share.js';
import { PackageError, readPackage } from '../../handover/package.js';
import { buildReturn, isDurchsicht, markerOf, openPackage, planReturn, readNotes, setNote, changesOf } from '../../handover/durchsicht.js';
import { applyReturn, decide, GROUPS, HandoverRefused, listReturns, receiveReturn, reviewOf, undoReturn, type Decision, type GroupId } from '../../handover/returns.js';
import { OwnershipError } from '../../books/store.js';
import type { ApiRefusal } from '../../types/api-error.js';

export const router = Router();

/** The books opened before a Durchsicht copy, to go back to (a server without the Mac app). */
let before: string | undefined;

const MAX = '1gb';
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const partyOf = (v: unknown): Party => {
  const o = (v ?? {}) as Record<string, unknown>;
  const name = text(o.name, 120);
  if (!name) throw new RequestError(400, 'An wen: ein Name.', { code: 'shareNoRecipient' });
  const email = text(o.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new RequestError(400, `${email} ist keine E-Mail-Adresse.`, { code: 'shareNoRecipient' });
  return { name, ...(email ? { email } : {}) };
};

const refusal = (e: PackageError): ApiRefusal => ({ code: e.code, params: e.params } as ApiRefusal);
function guarded<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof PackageError) throw new RequestError(e.code === 'shareTooLarge' ? 413 : e.code === 'shareBaseMissing' || e.code === 'shareOtherCompany' || e.code === 'shareUnknownBase' ? 409 : 400, e.message, refusal(e));
    if (e instanceof HandoverRefused) throw new RequestError(409, e.message, { code: 'changedSince' });
    if (e instanceof OwnershipError) throw new RequestError(409, e.message);
    throw e;
  }
}

/** The sharer: who the books are handed over by. The person of this Mac is not known yet (B2): the company's owner stands for her. */
const sharer = (): Party => ({ name: WS.company.owner || WS.company.name });

/** Refused on a copy: only the sharer hands her books over (no onward sharing, B2). */
function refuseOnCopy(action: string): void {
  if (isDurchsicht(WS.paths.root)) {
    const m = markerOf(WS.paths.root)!;
    throw new RequestError(403, `Durchsicht: ${action} macht ${m.sharer.name}.`, { code: 'roleRefused', params: { action, name: m.sharer.name } });
  }
}

function sendFile(res: Response, name: string, bytes: Uint8Array): void {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.end(Buffer.from(bytes));
}

router.get('/api/handover', (_req, res) => {
  const version = currentVersion(WS.paths);
  const marker = markerOf(WS.paths.root);
  res.json({
    ...(version ? { version } : {}),
    versions: readVersions(WS.paths).slice(-20).reverse(),
    ...(marker ? {
      durchsicht: {
        firm: marker.firm, sharer: marker.sharer, me: marker.me, version: marker.version, receivedAt: marker.receivedAt,
        ...(marker.message ? { message: marker.message } : {}), questions: marker.questions ?? [], conflicts: marker.conflicts ?? [], dropped: marker.dropped ?? [],
        ...(marker.sent ? { sent: marker.sent } : {}),
        changes: changesOf(WS.paths.root).length, notes: readNotes(WS.paths.root), back: !!before,
      },
    } : {}),
    returns: marker ? [] : listReturns(WS),
  });
});

const shareRequest = (q: Record<string, unknown>): ShareRequest => ({
  to: partyOf(q.to ?? { name: q.name, email: q.email }),
  ...(text(q.message, 2000) ? { message: text(q.message, 2000) } : {}),
  ...(q.full === true || q.full === '1' ? { full: true } : {}),
  ...(q.archive ? { archive: String(q.archive).split(',').filter((y) => /^\d{4}$/.test(y)) } : {}),
});

router.get('/api/handover/plan', (req, res) => {
  refuseOnCopy('share');
  const plan = planShare(WS, shareRequest(req.query as Record<string, unknown>));
  const { files: _f, held: _h, omitted, ...rest } = plan;
  res.json({ ...rest, files: plan.files.length, held: plan.held.length, omitted: omitted.length, omittedBytes: omitted.reduce((n, f) => n + f.bytes, 0), version: currentVersion(WS.paths) });
});

router.post('/api/handover/share', async (req, res) => {
  refuseOnCopy('share');
  const made = await makeShare(WS, shareRequest(req.body as Record<string, unknown>), sharer());
  res.setHeader('X-Vanilla-Version', String(made.version.n));
  sendFile(res, made.name, made.bytes);
});

router.post('/api/handover/open', express.raw({ type: () => true, limit: MAX }), async (req, res) => {
  const bytes = new Uint8Array(req.body as Buffer);
  const kind = guarded(() => readPackage(bytes).index.kind);
  if (kind === 'return') {
    refuseOnCopy('return');
    res.json({ kind, ...guarded(() => receiveReturn(WS, bytes)) });
    return;
  }
  const opened = guarded(() => openPackage(bytes));
  if (!isDurchsicht(WS.paths.root)) before = WS.paths.root;
  await openBooksAt(opened.root);
  res.json({ kind: opened.kind, firm: opened.marker.firm.name, version: opened.marker.version.n, conflicts: opened.conflicts, dropped: opened.dropped });
});

router.post('/api/handover/close', async (_req, res) => {
  if (!before || !existsSync(before)) throw new RequestError(409, 'Keine Bücher zum Zurückkehren: im Menü «Ablage» andere Bücher öffnen.');
  const to = before;
  before = undefined;
  await openBooksAt(to);
  res.json({ ok: true });
});

/** A return is taken over only in the books it came back to, never on a copy. */
const refuseReturnOnCopy = () => refuseOnCopy('return');

router.get('/api/handover/returns/:id', (req, res) => {
  res.json(guarded(() => reviewOf(WS, req.params.id, readBooks())));
});

const DECISIONS = new Set<Decision>(['skip', 'mine', 'theirs', 'correction', 'draft']);
router.post('/api/handover/returns/:id/decide', (req, res) => {
  refuseReturnOnCopy();
  const b = (req.body ?? {}) as { row?: unknown; decision?: unknown; question?: unknown };
  if (typeof b.row !== 'string') throw new RequestError(400, 'row erwartet.');
  const decision = b.decision === null ? null : DECISIONS.has(b.decision as Decision) ? (b.decision as Decision) : undefined;
  const question = b.question === null ? null : typeof b.question === 'string' ? b.question : undefined;
  guarded(() => decide(WS, req.params.id, b.row as string, decision, question));
  res.json(guarded(() => reviewOf(WS, req.params.id, readBooks())));
});

router.post('/api/handover/returns/:id/apply', (req, res) => {
  refuseReturnOnCopy();
  const g = (req.body as { groups?: unknown })?.groups;
  const groups = g === 'all' ? 'all' : Array.isArray(g) && g.every((x) => (GROUPS as readonly string[]).includes(x)) ? (g as GroupId[]) : undefined;
  if (!groups) throw new RequestError(400, 'groups: "all" oder eine Liste der Gruppen.');
  const result = guarded(() => applyReturn(WS, req.params.id, groups));
  res.json({ ...result, review: reviewOf(WS, req.params.id, readBooks()) });
});

router.post('/api/handover/returns/:id/undo', (req, res) => {
  refuseReturnOnCopy();
  const result = guarded(() => undoReturn(WS, req.params.id));
  res.json({ ...result, review: reviewOf(WS, req.params.id, readBooks()) });
});

router.get('/api/handover/return', (_req, res) => {
  const plan = guarded(() => planReturn(WS));
  res.json({ changes: plan.changes.map((c) => ({ kind: c.kind, key: c.key, before: c.before, after: c.after, why: c.why })), files: plan.files.length, bytes: plan.bytes, to: markerOf(WS.paths.root)?.sharer });
});

router.post('/api/handover/return', (req, res) => {
  const made = guarded(() => buildReturn(WS, text((req.body as { message?: unknown })?.message, 2000)));
  sendFile(res, made.name, made.bytes);
});

router.put('/api/handover/notes', (req, res) => {
  if (!isDurchsicht(WS.paths.root)) throw new RequestError(409, 'Notizen für die Rücksendung gibt es nur in einer Durchsicht.');
  const b = (req.body ?? {}) as { key?: unknown; text?: unknown };
  if (typeof b.key !== 'string' || !b.key || typeof b.text !== 'string') throw new RequestError(400, 'key und text erwartet.');
  res.json(setNote(WS.paths.root, b.key, b.text));
});
