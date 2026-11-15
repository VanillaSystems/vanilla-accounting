/**
 * A fake of the share service in the test process, following its docs/api.md, version 2
 * (docs/share-protocol.md here): senders, shares with the key the app hands over, uploads by PUT to
 * itself, completion, generations («Aktualisieren»), openings without any proof (the link is the
 * access; the key comes with the opening), reads through its own origin, the invitation it sends
 * (kept in `mails`, as it would go to its mail provider), status, withdrawal and returns. It keeps
 * every request it got, so a test can prove what reached it. `refuse` makes the next call of a
 * route answer with a refusal, as the real service would.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { parseHeader } from '../../src/share/crypto/index.js';

export interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Buffer }

interface Generation { n: number; key: string; bytes: number; objects: number; meta?: string; declared: Map<string, number>; stored: Map<string, Buffer> }
interface Share {
  id: string; kind: 'share' | 'return'; parent?: string; sender?: string;
  revokeToken: string; returnToken?: string;
  /** The generation readers get, and the one an update uploads into. */
  current: Generation; pending?: Generation;
  state: 'uploading' | 'ready' | 'expired' | 'revoked';
  createdAt: string; readyAt?: string; firstOpenedAt?: string; expiresAt?: string; endedAt?: string; updatedAt?: string;
  opens: string[]; tickets: Map<string, number>; returns: string[];
  invite?: { to: { name: string; email: string }; from: { name: string; email: string }; message?: string; company?: string; language?: string };
  invites: number; inviteSentAt?: string;
}

/** A mail the service would hand to its mail provider. */
export interface Mail { share: string; kind: 'invite' | 'update'; to: { name: string; email: string }; from: { name: string; email: string }; replyTo: string; link: string; message?: string; company?: string; language?: string }

export interface FakeShareService {
  url: string;
  seen: Seen[];
  shares: Map<string, Share>;
  mails: Mail[];
  /** Moves the fake's clock: a share past its end reads as expired. */
  expire(id: string): void;
  /** Senders confirm at once unless set false; then `confirm(email)` does it, `refuseSender` refuses. */
  autoConfirm: boolean;
  confirm(email: string): void;
  refuseSender(email: string, reason: string): void;
  /** The next request whose path matches answers with this refusal. */
  refuse(path: RegExp, status: number, body: Record<string, unknown>): void;
  stop(): Promise<void>;
}

const ID = () => [...randomBytes(26)].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('');
const token = () => randomBytes(32).toString('base64url');
/** The live service's codes are base64url: this prefix makes every fake one carry its `-` and `_`. */
const CODE_PREFIX = 'a-b_';
const body = (req: IncomingMessage) => new Promise<Buffer>((resolve) => { const parts: Buffer[] = []; req.on('data', (c) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });

export async function startShareService(): Promise<FakeShareService> {
  const seen: Seen[] = [];
  const shares = new Map<string, Share>();
  const senders = new Map<string, { email: string; confirmed: boolean; refusedReason?: string }>();
  const refusals: Array<{ path: RegExp; status: number; body: Record<string, unknown> }> = [];
  const mails: Mail[] = [];
  let base = '';
  const fake = { autoConfirm: true } as FakeShareService;

  const server: Server = createServer(async (req, res) => {
    const raw = await body(req);
    const url = new URL(req.url ?? '/', base);
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    const no = (status: number, code: string, extra: Record<string, unknown> = {}) => send(status, { error: `refused: ${code}`, code, ...extra });
    const refusal = refusals.findIndex((r) => r.path.test(url.pathname));
    if (refusal >= 0) { const [r] = refusals.splice(refusal, 1); send(r.status, r.body); return; }
    const json = (): Record<string, unknown> => { try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return {}; } };
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const live = (s: Share) => { if ((s.state === 'ready' || s.state === 'uploading') && s.expiresAt && Date.parse(s.expiresAt) <= Date.now()) { s.state = 'expired'; s.current.stored.clear(); } return s.state; };
    const status = (s: Share) => ({
      id: s.id, kind: s.kind, state: live(s), bytes: s.current.bytes, objects: s.current.objects, createdAt: s.createdAt, readyAt: s.readyAt ?? null,
      firstOpenedAt: s.firstOpenedAt ?? null, expiresAt: s.expiresAt ?? null, endedAt: s.endedAt ?? null, opens: s.opens,
      generation: s.current.n, updatedAt: s.updatedAt ?? null, invite: s.inviteSentAt ? { sentAt: s.inviteSentAt, count: s.invites } : null,
      returns: s.returns.map((id) => shares.get(id)!).map((r) => ({ id: r.id, state: live(r), bytes: r.current.bytes, createdAt: r.createdAt, readyAt: r.readyAt ?? null, expiresAt: r.expiresAt ?? null })),
      pollAfterSeconds: 900,
    });
    const key = (b: Record<string, unknown>) => (typeof b.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(b.key) ? b.key : undefined);
    const generation = (n: number, b: Record<string, unknown>, k: string): Generation => ({ n, key: k, bytes: b.bytes as number, objects: b.objects as number, ...(b.meta ? { meta: String(b.meta) } : {}), declared: new Map(), stored: new Map() });
    const p = url.pathname.split('/').filter(Boolean);

    if (req.method === 'POST' && url.pathname === '/api/senders') {
      const email = String(json().email ?? '');
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return no(400, 'badEmail');
      const t = token();
      senders.set(t, { email, confirmed: fake.autoConfirm });
      return send(201, { senderToken: t, confirmed: fake.autoConfirm, confirmation: { to: `confirm@${new URL(base).hostname}`, subject: `Vanilla Accounting confirmation ${CODE_PREFIX}${randomBytes(9).toString('base64url')}`, text: 'Bestätigung', expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
    }
    if (req.method === 'GET' && url.pathname === '/api/senders/me') {
      const s = senders.get(bearer);
      if (!s) return no(401, 'senderUnknown');
      return send(200, { confirmed: s.confirmed, confirmedAt: s.confirmed ? new Date().toISOString() : null, refusedReason: s.refusedReason ?? null, confirmationExpiresAt: null });
    }
    if (req.method === 'POST' && url.pathname === '/api/shares') {
      const s = senders.get(bearer);
      if (!s) return no(401, 'senderUnknown');
      if (!s.confirmed) return no(403, 'senderNotConfirmed');
      const b = json();
      const k = key(b);
      if (!k) return no(426, 'appTooOld');
      if ((b.bytes as number) > 1024 ** 3) return no(413, 'tooLarge', { limit: 1024 ** 3, bytes: b.bytes });
      const sh: Share = {
        id: ID(), kind: 'share', sender: s.email, revokeToken: token(), returnToken: token(), current: generation(1, b, k),
        state: 'uploading', createdAt: new Date().toISOString(), opens: [], tickets: new Map(), returns: [], invites: 0,
      };
      shares.set(sh.id, sh);
      return send(201, { id: sh.id, revokeToken: sh.revokeToken, returnToken: sh.returnToken, state: sh.state, shareUrl: `${base}/${sh.id}`, uploadExpiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(), batch: 100 });
    }
    if (p[0] === 'api' && p[1] === 'shares' && p[2]) {
      const sh = shares.get(p[2]);
      if (!sh) return no(404, 'notFound');
      const rest = p.slice(3).join('/');
      // Uploads go into the pending generation of an update, else into the share's first.
      const target = () => sh.pending ?? (sh.state === 'uploading' ? sh.current : undefined);
      if (req.method === 'PUT' && p[3] === 'put') {
        const name = p[4];
        const g = target();
        if (!g) return no(409, 'notUploading');
        if (req.headers['if-none-match'] !== '*') return no(400, 'badJson', { why: 'If-None-Match: * missing' });
        if (g.stored.has(name)) return no(412, 'exists');
        if (g.declared.get(name) !== raw.length) return no(400, 'sizeMismatch');
        g.stored.set(name, raw);
        res.writeHead(200); res.end(); return;
      }
      if (req.method === 'POST' && rest === 'uploads') {
        if (bearer !== sh.revokeToken) return no(403, 'wrongToken');
        const g = target();
        if (!g) return no(409, 'notUploading');
        const list = (json().objects ?? []) as Array<{ name: string; bytes: number }>;
        for (const o of list) {
          if (g.declared.has(o.name) && g.declared.get(o.name) !== o.bytes) return no(409, 'sizeChanged');
          g.declared.set(o.name, o.bytes);
        }
        if ([...g.declared.values()].reduce((n, x) => n + x, 0) > g.bytes || g.declared.size > g.objects) return no(400, 'overDeclared');
        return send(200, { targets: list.map((o) => ({ object: o.name, method: 'PUT', url: `${base}/api/shares/${sh.id}/put/${o.name}`, headers: { 'If-None-Match': '*' } })), expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      if (req.method === 'POST' && rest === 'complete') {
        if (bearer !== sh.revokeToken) return no(403, 'wrongToken');
        const g = target();
        if (!g) return send(200, status(sh));
        const missing = [...g.declared.keys()].filter((n) => !g.stored.has(n));
        if (missing.length) return no(409, 'missingObjects', { missing });
        if (g.declared.size !== g.objects) return no(400, 'undeclared');
        try { parseHeader(g.stored.get('index')!, 'index'); } catch { return no(400, 'notAPackage'); }
        if (sh.pending) { sh.current = sh.pending; delete sh.pending; sh.updatedAt = new Date().toISOString(); for (const t of sh.tickets.keys()) sh.tickets.delete(t); }
        sh.state = 'ready'; sh.readyAt ??= new Date().toISOString(); sh.expiresAt = new Date(Date.now() + 14 * 86400_000).toISOString();
        return send(200, status(sh));
      }
      if (req.method === 'POST' && rest === 'update') {
        if (bearer !== sh.revokeToken) return no(403, 'wrongToken');
        if (live(sh) !== 'ready') return no(410, sh.state);
        const b = json();
        const k = key(b);
        if (!k) return no(400, 'badKey');
        sh.pending = generation(sh.current.n + 1, b, k);
        return send(201, { id: sh.id, generation: sh.pending.n, state: 'uploading', uploadExpiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(), batch: 100 });
      }
      if (req.method === 'POST' && rest === 'invite') {
        if (bearer !== sh.revokeToken) return no(403, 'wrongToken');
        if (sh.kind !== 'share' || live(sh) !== 'ready') return no(409, 'notReady');
        const b = json() as NonNullable<Share['invite']> & { kind?: 'invite' | 'update' };
        const { kind, ...fields } = b;
        const next = { ...(sh.invite ?? {}), ...fields } as NonNullable<Share['invite']>;
        if (!next.to?.email || !next.from?.email) return no(400, 'badJson');
        if (next.from.email !== sh.sender) return no(403, 'notSender');
        if (sh.invites >= 10) return no(429, 'tooManyInvites', { limit: 10, per: 'share' });
        sh.invite = next;
        sh.invites++;
        sh.inviteSentAt = new Date().toISOString();
        mails.push({ share: sh.id, kind: kind ?? 'invite', to: next.to, from: next.from, replyTo: next.from.email, link: `${base}/${sh.id}`, ...(next.message ? { message: next.message } : {}), ...(next.company ? { company: next.company } : {}), ...(next.language ? { language: next.language } : {}) });
        return send(200, { sentAt: sh.inviteSentAt, invites: sh.invites, limit: 10 });
      }
      if (req.method === 'GET' && rest === '') {
        const state = live(sh);
        return send(200, { id: sh.id, kind: sh.kind, state, expiresAt: sh.expiresAt ?? null, firstOpenedAt: sh.firstOpenedAt ?? null, meta: state === 'ready' ? sh.current.meta ?? null : null, bytes: sh.current.bytes, key: state === 'ready' ? sh.current.key : null, generation: sh.current.n, updatedAt: sh.updatedAt ?? null });
      }
      if (req.method === 'POST' && rest === 'open') {
        const state = live(sh);
        if (state === 'revoked' || state === 'expired') return no(410, state);
        if (state !== 'ready') return no(409, 'notReady');
        if (sh.kind === 'return' && bearer !== shares.get(sh.parent!)!.revokeToken) return no(403, 'wrongToken');
        const ticket = token();
        sh.tickets.set(ticket, sh.current.n);
        sh.opens.push(new Date().toISOString());
        sh.firstOpenedAt ??= sh.opens[0];
        return send(200, { key: sh.current.key, index: { object: 'index', method: 'GET', url: `/api/shares/${sh.id}/objects/index?ticket=${ticket}`, headers: {} }, ticket, expiresAt: sh.expiresAt, generation: sh.current.n, updatedAt: sh.updatedAt ?? null });
      }
      if (req.method === 'POST' && rest === 'urls') {
        const b = json();
        if (sh.tickets.get(String(b.ticket)) !== sh.current.n) return no(403, 'ticketExpired');
        const objects = (b.objects ?? []) as string[];
        if (objects.includes('index') || objects.length > 100) return no(400, 'badObjects');
        return send(200, { targets: objects.map((o) => ({ object: o, method: 'GET', url: `/api/shares/${sh.id}/objects/${o}?ticket=${b.ticket}`, headers: {} })) });
      }
      if (req.method === 'GET' && p[3] === 'objects') {
        if (sh.tickets.get(url.searchParams.get('ticket') ?? '') !== sh.current.n) return no(403, 'ticketExpired');
        const blob = sh.current.stored.get(p[4]);
        if (!blob) return no(404, 'notFound');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(blob); return;
      }
      if (req.method === 'GET' && rest === 'status') {
        if (bearer !== sh.revokeToken) return no(403, 'wrongToken');
        return send(200, status(sh));
      }
      if (req.method === 'DELETE' && rest === '') {
        if (bearer !== sh.revokeToken) return no(403, 'wrongToken');
        sh.state = 'revoked'; sh.endedAt = new Date().toISOString(); sh.current.stored.clear(); delete sh.pending; delete sh.invite; sh.current.key = '';
        return send(200, status(sh));
      }
      if (req.method === 'POST' && rest === 'returns') {
        if (bearer !== sh.returnToken) return no(403, 'wrongToken');
        if (sh.state === 'revoked') return no(410, 'revoked');
        if (sh.state === 'uploading') return no(409, 'notReady');
        if (sh.returns.length >= 5) return no(429, 'tooManyReturns', { limit: 5 });
        const b = json();
        const k = key(b);
        if (!k) return no(426, 'appTooOld');
        const r: Share = {
          id: ID(), kind: 'return', parent: sh.id, revokeToken: token(), current: generation(1, b, k),
          state: 'uploading', createdAt: new Date().toISOString(), opens: [], tickets: new Map(), returns: [], invites: 0,
        };
        shares.set(r.id, r);
        sh.returns.push(r.id);
        return send(201, { id: r.id, revokeToken: r.revokeToken, state: r.state, uploadExpiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(), batch: 100 });
      }
    }
    no(404, 'notFound');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    url: base, seen, shares, mails,
    expire: (id: string) => { const sh = shares.get(id); if (sh) sh.expiresAt = new Date(Date.now() - 1000).toISOString(); },
    confirm: (email: string) => { for (const s of senders.values()) if (s.email === email) { s.confirmed = true; delete s.refusedReason; } },
    refuseSender: (email: string, reason: string) => { for (const s of senders.values()) if (s.email === email) s.refusedReason = reason; },
    refuse: (path: RegExp, status: number, b: Record<string, unknown>) => { refusals.push({ path, status, body: b }); },
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  });
}

/** Whether `needle` (a key, as base64url or hex) appears anywhere in what the service got. */
export function anywhere(seen: readonly Seen[], needle: string): boolean {
  return seen.some((s) => s.url.includes(needle) || JSON.stringify(s.headers).includes(needle) || s.body.includes(Buffer.from(needle)));
}

export const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
