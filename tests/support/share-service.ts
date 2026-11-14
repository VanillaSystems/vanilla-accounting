/**
 * A fake of the share service in the test process, following its docs/api.md (docs/share-protocol.md
 * here): senders, shares, uploads by PUT to itself, completion, openings with the open proof,
 * reads through its own origin, status, withdrawal and returns. It keeps every request it got, so
 * a test can prove that no key, path or name ever reached it. `refuse` makes the next call of a
 * route answer with a refusal, as the real service would.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { parseHeader } from '../../src/share/crypto/index.js';

export interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Buffer }

interface Share {
  id: string; kind: 'share' | 'return'; parent?: string; sender?: string;
  proof: string; revokeToken: string; returnToken?: string;
  bytes: number; objects: number; meta?: string;
  state: 'uploading' | 'ready' | 'spent' | 'expired' | 'revoked';
  declared: Map<string, number>; stored: Map<string, Buffer>;
  createdAt: string; readyAt?: string; firstOpenedAt?: string; expiresAt?: string; endedAt?: string;
  opens: string[]; tickets: Set<string>; wrappedKey?: string; returns: string[];
}

export interface FakeShareService {
  url: string;
  seen: Seen[];
  shares: Map<string, Share>;
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
const body = (req: IncomingMessage) => new Promise<Buffer>((resolve) => { const parts: Buffer[] = []; req.on('data', (c) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });

export async function startShareService(): Promise<FakeShareService> {
  const seen: Seen[] = [];
  const shares = new Map<string, Share>();
  const senders = new Map<string, { email: string; confirmed: boolean; refusedReason?: string }>();
  const refusals: Array<{ path: RegExp; status: number; body: Record<string, unknown> }> = [];
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
    const status = (s: Share) => ({
      id: s.id, kind: s.kind, state: s.state, bytes: s.bytes, objects: s.objects, createdAt: s.createdAt, readyAt: s.readyAt ?? null,
      firstOpenedAt: s.firstOpenedAt ?? null, expiresAt: s.expiresAt ?? null, endedAt: s.endedAt ?? null, maxOpens: 3, opens: s.opens,
      returns: s.returns.map((id) => shares.get(id)!).map((r) => ({ id: r.id, state: r.state, bytes: r.bytes, createdAt: r.createdAt, readyAt: r.readyAt ?? null, expiresAt: r.expiresAt ?? null, wrappedKey: r.wrappedKey ?? null })),
      pollAfterSeconds: 900,
    });
    const p = url.pathname.split('/').filter(Boolean);

    if (req.method === 'POST' && url.pathname === '/api/senders') {
      const email = String(json().email ?? '');
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return no(400, 'badEmail');
      const t = token();
      senders.set(t, { email, confirmed: fake.autoConfirm });
      return send(201, { senderToken: t, confirmed: fake.autoConfirm, confirmation: { to: `confirm@${new URL(base).hostname}`, subject: `Vanilla Accounting confirmation ${randomBytes(12).toString('hex')}`, text: 'Bestätigung', expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
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
      if ((b.bytes as number) > 1024 ** 3) return no(413, 'tooLarge', { limit: 1024 ** 3, bytes: b.bytes });
      const sh: Share = {
        id: ID(), kind: 'share', sender: s.email, proof: String(b.openProof), revokeToken: token(), returnToken: token(), bytes: b.bytes as number, objects: b.objects as number,
        ...(b.meta ? { meta: String(b.meta) } : {}), state: 'uploading', declared: new Map(), stored: new Map(), createdAt: new Date().toISOString(), opens: [], tickets: new Set(), returns: [],
      };
      shares.set(sh.id, sh);
      return send(201, { id: sh.id, revokeToken: sh.revokeToken, returnToken: sh.returnToken, state: sh.state, shareUrl: `${base}/${sh.id}`, uploadExpiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(), batch: 100 });
    }
    if (p[0] === 'api' && p[1] === 'shares' && p[2]) {
      const sh = shares.get(p[2]);
      if (!sh) return no(404, 'notFound');
      const rest = p.slice(3).join('/');
      if (req.method === 'PUT' && p[3] === 'put') {
        const name = p[4];
        if (req.headers['if-none-match'] !== '*') return no(400, 'badJson', { why: 'If-None-Match: * missing' });
        if (sh.stored.has(name)) return no(412, 'exists');
        if (sh.declared.get(name) !== raw.length) return no(400, 'sizeMismatch');
        sh.stored.set(name, raw);
        res.writeHead(200); res.end(); return;
      }
      if (req.method === 'POST' && rest === 'uploads') {
        if (bearer !== sh.revokeToken) return no(403, 'wrongToken');
        const list = (json().objects ?? []) as Array<{ name: string; bytes: number }>;
        for (const o of list) {
          if (sh.declared.has(o.name) && sh.declared.get(o.name) !== o.bytes) return no(409, 'sizeChanged');
          sh.declared.set(o.name, o.bytes);
        }
        if ([...sh.declared.values()].reduce((n, x) => n + x, 0) > sh.bytes || sh.declared.size > sh.objects) return no(400, 'overDeclared');
        return send(200, { targets: list.map((o) => ({ object: o.name, method: 'PUT', url: `${base}/api/shares/${sh.id}/put/${o.name}`, headers: { 'If-None-Match': '*' } })), expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      if (req.method === 'POST' && rest === 'complete') {
        if (bearer !== sh.revokeToken) return no(403, 'wrongToken');
        const missing = [...sh.declared.keys()].filter((n) => !sh.stored.has(n));
        if (missing.length) return no(409, 'missingObjects', { missing });
        if (sh.declared.size !== sh.objects) return no(400, 'undeclared');
        try { parseHeader(sh.stored.get('index')!, 'index'); } catch { return no(400, 'notAPackage'); }
        if (sh.kind === 'return') {
          const w = json().wrappedKey;
          if (typeof w !== 'string') return no(400, 'badWrappedKey');
          sh.wrappedKey = w;
        }
        sh.state = 'ready'; sh.readyAt = new Date().toISOString(); sh.expiresAt = new Date(Date.now() + 10 * 86400_000).toISOString();
        return send(200, status(sh));
      }
      if (req.method === 'GET' && rest === '') return send(200, { id: sh.id, kind: sh.kind, state: sh.state, expiresAt: sh.expiresAt ?? null, firstOpenedAt: sh.firstOpenedAt ?? null, opensLeft: 3 - sh.opens.length, hoursAfterFirstOpen: 5, meta: sh.meta ?? null, bytes: sh.bytes });
      if (req.method === 'POST' && rest === 'open') {
        if (sh.state === 'revoked' || sh.state === 'expired' || sh.state === 'spent') return no(410, sh.state);
        if (sh.state !== 'ready') return no(409, 'notReady');
        if (json().proof !== sh.proof) return no(403, 'wrongProof');
        if (sh.kind === 'return' && bearer !== shares.get(sh.parent!)!.revokeToken) return no(403, 'wrongToken');
        const ticket = token();
        sh.tickets.add(ticket);
        sh.opens.push(new Date().toISOString());
        if (!sh.firstOpenedAt) { sh.firstOpenedAt = sh.opens[0]; sh.expiresAt = new Date(Date.now() + 5 * 3600_000).toISOString(); }
        if (sh.opens.length >= 3) sh.state = 'spent';
        return send(200, { index: { object: 'index', method: 'GET', url: `/api/shares/${sh.id}/objects/index?ticket=${ticket}`, headers: {} }, ticket, wrappedKey: sh.wrappedKey ?? null, opensLeft: 3 - sh.opens.length, expiresAt: sh.expiresAt });
      }
      if (req.method === 'POST' && rest === 'urls') {
        const b = json();
        if (!sh.tickets.has(String(b.ticket))) return no(403, 'ticketExpired');
        if (b.proof !== sh.proof) return no(403, 'wrongProof');
        const objects = (b.objects ?? []) as string[];
        if (objects.includes('index') || objects.length > 100) return no(400, 'badObjects');
        return send(200, { targets: objects.map((o) => ({ object: o, method: 'GET', url: `/api/shares/${sh.id}/objects/${o}?ticket=${b.ticket}`, headers: {} })) });
      }
      if (req.method === 'GET' && p[3] === 'objects') {
        if (!sh.tickets.has(url.searchParams.get('ticket') ?? '')) return no(403, 'ticketExpired');
        const blob = sh.stored.get(p[4]);
        if (!blob) return no(404, 'notFound');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(blob); return;
      }
      if (req.method === 'GET' && rest === 'status') {
        if (bearer !== sh.revokeToken) return no(403, 'wrongToken');
        return send(200, status(sh));
      }
      if (req.method === 'DELETE' && rest === '') {
        if (bearer !== sh.revokeToken) return no(403, 'wrongToken');
        sh.state = 'revoked'; sh.endedAt = new Date().toISOString(); sh.stored.clear();
        return send(200, status(sh));
      }
      if (req.method === 'POST' && rest === 'returns') {
        if (bearer !== sh.returnToken) return no(403, 'wrongToken');
        if (sh.state === 'revoked') return no(410, 'revoked');
        if (sh.state === 'uploading') return no(409, 'notReady');
        if (sh.returns.length >= 5) return no(429, 'tooManyReturns', { limit: 5 });
        const b = json();
        const r: Share = {
          id: ID(), kind: 'return', parent: sh.id, proof: String(b.openProof), revokeToken: token(), bytes: b.bytes as number, objects: b.objects as number,
          ...(b.meta ? { meta: String(b.meta) } : {}), state: 'uploading', declared: new Map(), stored: new Map(), createdAt: new Date().toISOString(), opens: [], tickets: new Set(), returns: [],
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
    url: base, seen, shares,
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
