/**
 * The app's side of the share service's API (docs/share-protocol.md; the calls as the service's
 * docs/api.md names them). Only ciphertext, sizes, object ids, open proofs and tokens pass here:
 * never a key, a path or a name. A refusal keeps the service's stable code and its limit, so the
 * person reads it in words (src/app/lib/api.ts, `shareServiceRefused`).
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

export interface Created { id: string; revokeToken: string; returnToken?: string; state: string; shareUrl?: string; uploadExpiresAt?: string; batch?: number }

export interface ReturnStatus { id: string; state: string; bytes: number; createdAt: string; readyAt?: string | null; expiresAt?: string | null; wrappedKey?: string | null }
export interface ShareStatus {
  id: string; kind: 'share' | 'return'; state: string; bytes: number; objects: number;
  createdAt: string; readyAt?: string | null; firstOpenedAt?: string | null; expiresAt?: string | null; endedAt?: string | null;
  maxOpens: number; opens: string[]; returns: ReturnStatus[]; pollAfterSeconds?: number;
}
export interface ShareInfo { id: string; kind: 'share' | 'return'; state: string; expiresAt?: string | null; firstOpenedAt?: string | null; opensLeft?: number; meta?: string | null; bytes?: number }
export interface Opening { index: Target; ticket: string; wrappedKey?: string | null; opensLeft: number; expiresAt: string }

export type ShareClient = ReturnType<typeof shareClient>;

/** A client of the service at `service` (its origin). `fetcher` is the test's seam. */
export function shareClient(service: string, fetcher: typeof fetch = fetch) {
  const base = service.replace(/\/+$/, '');
  const reach = async (url: string, init: RequestInit): Promise<Response> => {
    try { return await fetcher(url, { ...init, redirect: 'error', referrerPolicy: 'no-referrer' }); } catch (e) { throw new ShareUnreachable(base, (e as Error).message); }
  };

  async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const res = await reach(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string; limit?: number; per?: string; used?: number; refusedReason?: string; missing?: string[] };
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
    create: (token: string, body: { bytes: number; objects: number; openProof: string; meta?: string }) => call<Created>('POST', '/api/shares', body, token),
    createReturn: (id: string, returnToken: string, body: { bytes: number; objects: number; openProof: string; meta?: string }) =>
      call<Created>('POST', `/api/shares/${id}/returns`, body, returnToken),
    uploads: (id: string, token: string, objects: Array<{ name: string; bytes: number }>) =>
      call<{ targets: Target[]; expiresAt: string }>('POST', `/api/shares/${id}/uploads`, { objects }, token),
    /** One blob to its upload URL: written once, never over an object already there (`If-None-Match: *`). */
    async put(target: Target, blob: Uint8Array): Promise<void> {
      const res = await reach(target.url, { method: target.method || 'PUT', headers: { 'If-None-Match': '*', ...(target.headers ?? {}) }, body: blob as BodyInit });
      // 412: the object is there already (a retry after a lost answer); its size was checked when it was declared.
      if (!res.ok && res.status !== 412) throw new ShareServiceError(`Hochladen von ${target.object}: HTTP ${res.status}`, res.status === 403 ? 'ticketExpired' : 'internal', res.status);
    },
    complete: (id: string, token: string, body: Record<string, unknown> = {}) => call<ShareStatus>('POST', `/api/shares/${id}/complete`, body, token),
    info: (id: string) => call<ShareInfo>('GET', `/api/shares/${id}`),
    open: (id: string, proof: string, token?: string) => call<Opening>('POST', `/api/shares/${id}/open`, { proof }, token),
    urls: (id: string, ticket: string, objects: string[], proof: string) => call<{ targets: Target[] }>('POST', `/api/shares/${id}/urls`, { ticket, objects, proof }),
    async get(target: Target): Promise<Uint8Array> {
      const res = await reach(readUrl(target.url), { method: 'GET', headers: target.headers ?? {} });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        throw new ShareServiceError(data.error ?? `HTTP ${res.status}`, data.code ?? 'internal', res.status);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    status: (id: string, token: string) => call<ShareStatus>('GET', `/api/shares/${id}/status`, undefined, token),
    revoke: (id: string, token: string) => call<ShareStatus>('DELETE', `/api/shares/${id}`, undefined, token),
  };
}
