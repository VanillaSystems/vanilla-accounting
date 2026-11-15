/**
 * Sharing the books by link through the share service (docs/specs/e2e-and-fiduciary.md B3, ADR 0016;
 * src/share/). The `.vanilla` file (src/server/routes/handover.ts) stays the way for every step
 * without the service.
 *
 *   GET    /api/share                 the service in use, this computer's sender as kept, the mailbox that sends, the shares
 *   PUT    /api/share/service         { url | null }: this computer's service address
 *   GET    /api/share/sender          the sender as the service sees it now (confirmed, refused and why)
 *   POST   /api/share/sender          { email }: registers it; sends the confirmation e-mail from the books' mailbox when it sends from that address
 *   DELETE /api/share/sender          forgets it («Andere Adresse»)
 *   POST   /api/share/link            { to: { name, email }, message?, archive?, language? } → a job: pack, upload the Freigabe-Datei, version; the service sends the invitation
 *   POST   /api/share/preview         { link }: what it holds, from its envelope
 *   POST   /api/share/open            { link, trust?, copy? } → a job: download the Freigabe-Datei into Downloads, open it as a Durchsicht copy whose document it is (`copy`: the answer to shareCopyOther, new | replace)
 *   POST   /api/share/return          { message? } on a copy that came by link → a job: the return into the same share
 *   POST   /api/share/check           on a copy that came by link: a newer state moves it forward, a withdrawn share is noted
 *   POST   /api/share/copy/delete     «Kopie löschen» on a copy whose share was withdrawn
 *   GET    /api/share/jobs/:id        a job's phase and progress, its result or its refusal
 *   POST   /api/share/refresh         asks the service about every running share; returns that arrived are kept for review
 *   GET    /api/share/:id/link        a share's link again («Link kopieren»)
 *   POST   /api/share/:id/invite      «Nochmals senden»: the service sends the invitation again (after a note of «Aktualisieren» that did not go out: the note)
 *   POST   /api/share/:id/returns/:rid/fetch   «Holen»: a return too large to be fetched by itself, fetched now and kept for review
 *   POST   /api/share/:id/update      { notify?, message?, language? } → a job: «Aktualisieren», the whole books again into the same share
 *   DELETE /api/share/:id             «Zurückziehen»
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { RequestError, WS } from '../books.js';
import type { ApiErrorBody, ApiRefusal } from '../../types/api-error.js';
import { isDurchsicht, markerOf } from '../../handover/durchsicht.js';
import { sendingAddress } from '../../invoices/mail.js';
import { secrets } from '../../secrets/secrets.js';
import { ShareServiceError, ShareUnreachable } from '../../share/client.js';
import { setService, shareService } from '../../share/service.js';
import {
  checkCopy, deleteCopy, fetchReturn, forgetSender, inviteAgain, linkFor, openLink, previewLink, readShares, refreshShares, registerSender, returnByLink, revokeShare,
  senderState, shareByLink, ShareFlowError, updateByLink,
} from '../../share/sharing.js';
import { ShareLimitError, type Phase } from '../../share/transport.js';
import { handoverRefusal, leaveCopy, openCopy, sharerOf, shareRequest } from './handover.js';

export const router = Router();



/** Any failure of the flow as the API says it: a refusal with a code the UI words, never a bare 500 for what the service said. */
function asRefusal(e: unknown): unknown {
  if (e instanceof ShareServiceError) {
    const params: { reason: string; limit?: string; per?: string } = { reason: e.detail.refusedReason ?? e.code };
    if (e.detail.limit !== undefined) params.limit = String(e.detail.limit);
    if (e.detail.per) params.per = e.detail.per;
    return new RequestError(e.status >= 500 ? 502 : e.status === 401 ? 403 : e.status, e.message, { code: 'shareServiceRefused', params });
  }
  if (e instanceof ShareUnreachable) return new RequestError(502, e.message, { code: 'shareUnreachable', params: { service: e.service } });
  if (e instanceof ShareLimitError) return new RequestError(413, e.message, { code: 'shareServiceRefused', params: { reason: e.isReturn ? 'returnTooLarge' : 'tooLarge', limit: String(e.max) } });
  if (e instanceof ShareFlowError) return new RequestError(e.code === 'shareLinkInvalid' ? 400 : 409, e.message, { code: e.code, ...(Object.keys(e.params).length ? { params: e.params } : {}) } as ApiRefusal);
  return handoverRefusal(e);
}

const bodyOf = (e: unknown): { status: number; body: ApiErrorBody } => {
  const r = asRefusal(e);
  if (r instanceof RequestError) return { status: r.status, body: { error: r.message, ...r.refusal } as ApiErrorBody };
  return { status: 500, body: { error: (r as Error)?.message ?? String(r) } };
};

async function answer(res: import('express').Response, fn: () => Promise<unknown>): Promise<void> {
  try { res.json(await fn()); } catch (e) { const { status, body } = bodyOf(e); res.status(status).json(body); }
}

// ─── jobs: packing, uploading and downloading take a while, the dialog shows how far ─────

interface Job { id: string; kind: 'share' | 'open' | 'return'; phase: Phase | 'pack' | 'done' | 'failed'; done: number; total: number; result?: unknown; error?: ApiErrorBody; at: number }
const jobs = new Map<string, Job>();

function startJob(kind: Job['kind'], run: (progress: (p: { phase: Phase; done: number; total: number }) => void) => Promise<unknown>): Job {
  for (const [id, j] of jobs) if (Date.now() - j.at > 3600_000) jobs.delete(id);
  const job: Job = { id: randomUUID(), kind, phase: 'pack', done: 0, total: 0, at: Date.now() };
  jobs.set(job.id, job);
  void run((p) => Object.assign(job, p)).then(
    (result) => { job.phase = 'done'; job.result = result; },
    (e) => { job.phase = 'failed'; job.error = bodyOf(e).body; },
  );
  return job;
}

router.get('/api/share/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) throw new RequestError(404, 'Unbekannter Auftrag.');
  res.json(job);
});

// ─── the service and the sender ─────────────────────────────────────────────

router.get('/api/share', async (_req, res) => {
  const service = shareService();
  const kept = await secrets.get('share:sender').catch(() => undefined);
  let senderEmail: string | undefined;
  try { const s = kept ? (JSON.parse(kept) as { email?: string; service?: string }) : undefined; if (s?.service === service.url) senderEmail = s?.email; } catch { /* none kept */ }
  res.json({
    service, keeps: secrets.inApp(), ...(senderEmail ? { sender: senderEmail } : {}),
    ...(sendingAddress(WS) ? { mailFrom: sendingAddress(WS) } : {}),
    shares: isDurchsicht(WS.paths.root) ? [] : readShares(WS),
  });
});

router.put('/api/share/service', (req, res) => {
  const url = (req.body as { url?: unknown })?.url;
  if (url !== null && typeof url !== 'string') throw new RequestError(400, 'url: eine Adresse oder null.');
  try { setService(url); } catch (e) { throw new RequestError(400, (e as Error).message, { code: 'shareLinkInvalid' }); }
  res.json({ service: shareService() });
});

router.get('/api/share/sender', (_req, res) => answer(res, () => senderState()));

router.post('/api/share/sender', (req, res) => answer(res, () => {
  const email = String((req.body as { email?: unknown })?.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RequestError(400, `${email || '(leer)'} ist keine E-Mail-Adresse.`, { code: 'shareServiceRefused', params: { reason: 'badEmail' } });
  return registerSender(WS, email);
}));

router.delete('/api/share/sender', (_req, res) => answer(res, async () => { await forgetSender(); return { ok: true }; }));

// ─── sharing, opening, returning ────────────────────────────────────────────

router.post('/api/share/link', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const request = shareRequest(b);
  const ws = WS;
  const language = typeof b.language === 'string' ? b.language.slice(0, 8) : undefined;
  const job = startJob('share', async (progress) => {
    const done = await shareByLink(ws, request, sharerOf(), { progress, ...(language ? { language } : {}) });
    // A mail the service did not send is said in words beside the share it made; the share stands.
    return { ...done, inviteError: done.inviteError === undefined ? undefined : bodyOf(done.inviteError).body };
  });
  res.status(202).json(job);
});

const linkOfBody = (body: unknown): string => {
  const link = (body as { link?: unknown })?.link;
  if (typeof link !== 'string' || !link.trim()) throw new RequestError(400, 'link erwartet.', { code: 'shareLinkInvalid' });
  return link;
};

/** What a link holds, without spending an opening: the person sees whose books, from whom, through which service, and confirms. */
router.post('/api/share/preview', (req, res) => answer(res, () => previewLink(linkOfBody(req.body))));

/** `trust` only as the person confirmed it after the preview: a link naming another service; `copy` only as she answered shareCopyOther. */
router.post('/api/share/open', (req, res) => {
  const link = linkOfBody(req.body);
  const b = req.body as { trust?: unknown; copy?: unknown };
  const copy = b.copy === 'new' || b.copy === 'replace' ? b.copy : undefined;
  const job = startJob('open', async (progress) => {
    const opened = await openLink(link, { progress, trust: b.trust === true, ...(copy ? { copy } : {}) });
    await openCopy(opened.root);
    return { kind: opened.kind, firm: opened.marker.firm.name, version: opened.marker.version.n, conflicts: opened.conflicts, dropped: opened.dropped, carried: opened.carried, ...(opened.document ? { document: opened.document } : {}) };
  });
  res.status(202).json(job);
});

router.post('/api/share/return', (req, res) => {
  if (!markerOf(WS.paths.root)) throw new RequestError(409, 'Zurückschicken gibt es nur in einer Durchsicht.', { code: 'shareWrongKind' });
  const message = (req.body as { message?: unknown })?.message;
  const ws = WS;
  const job = startJob('return', (progress) => returnByLink(ws, typeof message === 'string' && message.trim() ? message.trim().slice(0, 2000) : undefined, { progress }));
  res.status(202).json(job);
});

router.post('/api/share/refresh', (_req, res) => answer(res, async () => {
  if (isDurchsicht(WS.paths.root)) return { shares: [], arrived: [] };
  return refreshShares(WS);
}));

/** Asked when a copy that came by link opens: a newer state moves it forward (and the books are read again), a withdrawn share is noted. */
router.post('/api/share/check', (_req, res) => answer(res, async () => {
  if (!markerOf(WS.paths.root)) return { state: 'none' };
  const root = WS.paths.root;
  const found = await checkCopy(root);
  if (found.state === 'updated') await openCopy(root);
  return found;
}));

/** «Kopie löschen»: the books opened before come back (or the start screen in the Mac app), then the copy's folder goes. */
router.post('/api/share/copy/delete', (_req, res) => answer(res, async () => {
  if (!markerOf(WS.paths.root)) throw new RequestError(409, 'Löschen geht nur bei einer Kopie zur Durchsicht.', { code: 'shareNotCopy' });
  const root = WS.paths.root;
  const back = await leaveCopy();
  deleteCopy(root);
  return { deleted: true, back };
}));

router.get('/api/share/:id/link', (req, res) => answer(res, async () => ({ link: await linkFor(WS, req.params.id) })));

router.post('/api/share/:id/invite', (req, res) => answer(res, () => inviteAgain(WS, req.params.id, sharerOf())));

router.post('/api/share/:id/update', (req, res) => {
  if (isDurchsicht(WS.paths.root)) throw new RequestError(403, 'Aktualisieren macht, wer geteilt hat.', { code: 'roleRefused', params: { action: 'share', name: markerOf(WS.paths.root)?.sharer.name ?? '' } });
  const b = (req.body ?? {}) as { notify?: unknown; message?: unknown; language?: unknown };
  const ws = WS;
  const id = req.params.id;
  const job = startJob('share', (progress) => updateByLink(ws, id, sharerOf(), {
    progress, notify: b.notify === true,
    ...(typeof b.message === 'string' && b.message.trim() ? { message: b.message } : {}),
    ...(typeof b.language === 'string' ? { language: b.language.slice(0, 8) } : {}),
  }));
  res.status(202).json(job);
});

router.post('/api/share/:id/returns/:rid/fetch', (req, res) => answer(res, async () => {
  const done = await fetchReturn(WS, req.params.id, req.params.rid);
  return done.record;
}));

router.delete('/api/share/:id', (req, res) => answer(res, () => revokeShare(WS, req.params.id)));
