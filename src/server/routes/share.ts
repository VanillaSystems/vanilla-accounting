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
 *   POST   /api/share/link            { to, message?, full?, archive?, mail? } → a job: seal, upload, version, invitation
 *   POST   /api/share/open            { link } → a job: fetch, decrypt, open as a Durchsicht copy
 *   POST   /api/share/return          { message? } on a copy that came by link → a job: the return into the same share
 *   GET    /api/share/jobs/:id        a job's phase and progress, its result or its refusal
 *   POST   /api/share/refresh         asks the service about every running share; returns that arrived are kept for review
 *   GET    /api/share/:id/link        a share's link again («Link kopieren»)
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
import { ShareCryptoError } from '../../share/crypto/index.js';
import { setService, shareService } from '../../share/service.js';
import {
  forgetSender, linkFor, openLink, readShares, refreshShares, registerSender, returnByLink, revokeShare, senderState, shareByLink,
  ShareFlowError,
} from '../../share/sharing.js';
import { ShareLimitError, type Phase } from '../../share/transport.js';
import { handoverRefusal, openCopy, sharerOf, shareRequest } from './handover.js';

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
  if (e instanceof ShareLimitError) return new RequestError(413, e.message, { code: 'shareServiceRefused', params: { reason: e.limit === 'bytes' ? 'tooLarge' : 'tooManyObjects', limit: String(e.limit === 'bytes' ? 1024 ** 3 : 5000) } });
  if (e instanceof ShareFlowError) return new RequestError(e.code === 'shareLinkInvalid' ? 400 : 409, e.message, { code: e.code, ...(Object.keys(e.params).length ? { params: e.params } : {}) } as ApiRefusal);
  if (e instanceof ShareCryptoError) return new RequestError(400, `Der Link ist beschädigt oder gehört zu einem anderen Schlüssel (${e.message}).`, { code: 'shareTampered', params: { path: e.code } });
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

// ─── jobs: sealing and uploading takes a while, the dialog shows how far ─────

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
  const job = startJob('share', (progress) => shareByLink(ws, request, sharerOf(), { mail: b.mail === true, progress }));
  res.status(202).json(job);
});

router.post('/api/share/open', (req, res) => {
  const link = (req.body as { link?: unknown })?.link;
  if (typeof link !== 'string' || !link.trim()) throw new RequestError(400, 'link erwartet.', { code: 'shareLinkInvalid' });
  const job = startJob('open', async (progress) => {
    const opened = await openLink(link, { progress });
    await openCopy(opened.root);
    return { kind: opened.kind, firm: opened.marker.firm.name, version: opened.marker.version.n, conflicts: opened.conflicts, dropped: opened.dropped };
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

router.get('/api/share/:id/link', (req, res) => answer(res, async () => ({ link: await linkFor(WS, req.params.id) })));

router.delete('/api/share/:id', (req, res) => answer(res, () => revokeShare(WS, req.params.id)));
