/**
 * The app's side of the share service's API (docs/share-protocol.md, version 2; the calls as the
 * service's docs/api.md names them). Since the owner's decision of 2026-11-15 the service keeps each
 * share's key (wrapped, so R2 holds ciphertext only) and hands it to whoever has the link; it sends
 * the invitation itself. Paths, file names and figures still travel only sealed. A refusal keeps
 * the service's stable code and its limit, so the person reads it in words (src/app/lib/api.ts,
 * `shareServiceRefused`).
 */

/** A refusal of the service: its code (docs/api.md «Codes»), the HTTP status, and the limit it names. */
export class ShareServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly detail: { limit?: number; per?: string; used?: number; refusedReason?: string; missing?: string[] } = {},
  ) { super(message); }
}

/** The service could not be reached at all (no network, wrong address). */
export class ShareUnreachable extends Error {
  constructor(readonly service: string, why: string) { super(`Der Teil-Dienst ${service} ist nicht erreichbar: ${why}`); }
}

export interface Target { object: string; method: string; url: string; headers?: Record<string, string> }

export interface SenderRegistration {
  senderToken: string;
  confirmed: boolean;
  confirmation: { to: string; subject: string; text: string; expiresAt: string };
}
export interface SenderState { confirmed: boolean; confirmedAt?: string | null; refusedReason?: string | null; confirmationExpiresAt?: string | null }

export interface Created { id: string; revokeToken: string; returnToken?: string; state: string; shareUrl?: string; uploadExpiresAt?: string; batch?: number; generation?: number }

export interface ReturnStatus { id: string; state: string; bytes: number; createdAt: string; readyAt?: string | null; expiresAt?: string | null }
export interface ShareStatus {
  id: string; kind: 'share' | 'return'; state: string; bytes: number; objects: number;
  createdAt: string; readyAt?: string | null; firstOpenedAt?: string | null; expiresAt?: string | null; endedAt?: string | null;
  opens: string[]; returns: ReturnStatus[]; pollAfterSeconds?: number;
  /** The share's state of the books: 1, then one more with every «Aktualisieren». */
  generation?: number; updatedAt?: string | null;
  invite?: { sentAt: string; count: number; updateSentAt?: string | null } | null;
}
/** What anyone with the link learns without a token: the state, the envelope and, while ready, the key. */
export interface ShareInfo { id: string; kind: 'share' | 'return'; state: string; expiresAt?: string | null; firstOpenedAt?: string | null; meta?: string | null; bytes?: number | null; key?: string | null; generation?: number; updatedAt?: string | null }
export interface Opening { key: string; index: Target; ticket: string; expiresAt: string; generation?: number; updatedAt?: string | null }
/** The invitation the service sends (kind `invite`), or its short note after «Aktualisieren» (kind `update`). */
export interface InviteRequest {
  kind?: 'invite' | 'update';
  to?: { name: string; email: string };
  from?: { name: string; email: string };
  message?: string;
  company?: string;
  language?: string;
}
export interface Invited { sentAt: string; invites: number; limit: number }

export type ShareClient = ReturnType<typeof shareClient>;

/** The most an API answer may be, and how long a call and an object's transfer may take. */
const ANSWER_BYTES = 1024 * 1024;
const CALL_MS = 60_000;
const OBJECT_MS = 10 * 60_000;

/**
 * A body read up to `max` bytes: refused by its Content-Length, or cut off while it streams, never
 * read into memory past the limit (review of PR #538).
 */
async function capped(res: Response, max: number, what: string): Promise<Uint8Array> {
  const oversized = () => new ShareServiceError(`${what}: der Dienst liefert mehr als ${max} Bytes.`, 'oversized', 502, { limit: max });
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => undefined); throw oversized(); }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); throw oversized(); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** A client of the service at `service` (its origin). `fetcher` is the test's seam. */
export function shareClient(service: string, fetcher: typeof fetch = fetch) {
  const base = service.replace(/\/+$/, '');
  /** Every request ends: an API call within a minute, an object's upload or download within ten (a service that trickles is cut off). */
  const reach = async (url: string, init: RequestInit, ms = CALL_MS): Promise<Response> => {
    try { return await fetcher(url, { ...init, redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(ms) }); } catch (e) { throw new ShareUnreachable(base, (e as Error).message); }
  };

  async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const res = await reach(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // An API answer is small: read up to ANSWER_BYTES, never more.
    let data: T & { error?: string; code?: string; limit?: number; per?: string; used?: number; refusedReason?: string; missing?: string[] };
    try { data = JSON.parse(new TextDecoder().decode(await capped(res, ANSWER_BYTES, path))); } catch (e) {
      if (e instanceof ShareServiceError) throw e;
      data = {} as typeof data;
    }
    if (!res.ok) {
      throw new ShareServiceError(data.error ?? `HTTP ${res.status}`, data.code ?? (res.status >= 500 ? 'internal' : 'notFound'), res.status, {
        ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
        ...(typeof data.per === 'string' ? { per: data.per } : {}),
        ...(typeof data.used === 'number' ? { used: data.used } : {}),
        ...(typeof data.refusedReason === 'string' ? { refusedReason: data.refusedReason } : {}),
        ...(Array.isArray(data.missing) ? { missing: data.missing } : {}),
      });
    }
    return data;
  }

  /** A read goes only to a URL of the service itself (protocol §4.5): a relative one is resolved against it, another host is refused. */
  const readUrl = (url: string): string => {
    const full = new URL(url, base + '/');
    if (full.origin !== new URL(base).origin) throw new ShareServiceError(`Lese-Adresse ausserhalb des Dienstes: ${full.origin}`, 'internal', 500);
    return full.toString();
  };

  return {
    service: base,
    registerSender: (email: string) => call<SenderRegistration>('POST', '/api/senders', { email }),
    sender: (token: string) => call<SenderState>('GET', '/api/senders/me', undefined, token),
    create: (token: string, body: { bytes: number; objects: number; key: string; meta?: string }) => call<Created>('POST', '/api/shares', body, token),
    /** «Aktualisieren»: the whole books again into the same share, as its next generation (same id, link and tokens). */
    update: (id: string, token: string, body: { bytes: number; objects: number; key: string; meta?: string }) => call<Created>('POST', `/api/shares/${id}/update`, body, token),
    createReturn: (id: string, returnToken: string, body: { bytes: number; objects: number; key: string; meta?: string }) =>
      call<Created>('POST', `/api/shares/${id}/returns`, body, returnToken),
    /** The service sends the invitation (or the note of an update) from «<name> über Vanilla Accounting», replies to the sender. */
    invite: (id: string, token: string, body: InviteRequest) => call<Invited>('POST', `/api/shares/${id}/invite`, body, token),
    uploads: (id: string, token: string, objects: Array<{ name: string; bytes: number }>) =>
      call<{ targets: Target[]; expiresAt: string }>('POST', `/api/shares/${id}/uploads`, { objects }, token),
    /** One blob to its upload URL: written once, never over an object already there (`If-None-Match: *`). */
    async put(target: Target, blob: Uint8Array): Promise<void> {
      const res = await reach(target.url, { method: target.method || 'PUT', headers: { 'If-None-Match': '*', ...(target.headers ?? {}) }, body: blob as BodyInit }, OBJECT_MS);
      await res.body?.cancel().catch(() => undefined);
      // 412: the object is there already (a retry after a lost answer); its size was checked when it was declared.
      if (!res.ok && res.status !== 412) throw new ShareServiceError(`Hochladen von ${target.object}: HTTP ${res.status}`, res.status === 403 ? 'ticketExpired' : 'internal', res.status);
    },
    complete: (id: string, token: string, body: Record<string, unknown> = {}) => call<ShareStatus>('POST', `/api/shares/${id}/complete`, body, token),
    info: (id: string) => call<ShareInfo>('GET', `/api/shares/${id}`),
    open: (id: string, token?: string) => call<Opening>('POST', `/api/shares/${id}/open`, {}, token),
    urls: (id: string, ticket: string, objects: string[]) => call<{ targets: Target[] }>('POST', `/api/shares/${id}/urls`, { ticket, objects }),
    /**
     * One object's ciphertext, at most `max` bytes (its size as the index names it): a service that
     * sends more is cut off at once, by its Content-Length or while it streams, never read into memory.
     */
    async get(target: Target, max: number): Promise<Uint8Array> {
      const res = await reach(readUrl(target.url), { method: 'GET', headers: target.headers ?? {} }, OBJECT_MS);
      if (!res.ok) {
        let data: { error?: string; code?: string } = {};
        try { data = JSON.parse(new TextDecoder().decode(await capped(res, ANSWER_BYTES, target.object))); } catch { /* no words */ }
        throw new ShareServiceError(data.error ?? `HTTP ${res.status}`, data.code ?? 'internal', res.status);
      }
      return capped(res, max, target.object);
    },
    status: (id: string, token: string) => call<ShareStatus>('GET', `/api/shares/${id}/status`, undefined, token),
    revoke: (id: string, token: string) => call<ShareStatus>('DELETE', `/api/shares/${id}`, undefined, token),
  };
}
