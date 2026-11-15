/**
 * The app's side of the share service's API (docs/share-protocol.md, version 3; the calls as the
 * service's docs/api.md names them). A share is one Freigabe-Datei (`.vanillashare`), the app's own
 * hand-over package: uploaded with one PUT straight to the storage, downloaded with one GET from
 * there, the browser's or the app's (owner decision 2026-11-15). The service keeps no key; the
 * storage encrypts at rest. A refusal keeps the service's stable code and its limit, so the person
 * reads it in words (src/app/lib/api.ts, `shareServiceRefused`).
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

export interface Created { id: string; revokeToken: string; returnToken?: string; state: string; shareUrl?: string; uploadExpiresAt?: string; generation?: number }

/** The envelope the share's page shows (who shares which books) and the download is named by: plain JSON, at most a few lines. */
export interface Envelope { v: 2; senderName: string; direction: 'send' | 'return'; company?: string; note?: string; asOf?: string }
/** What a share, its next state or a return declares: the file's exact size and its envelope. */
export interface Declared { bytes: number; meta: Envelope }

export interface ReturnStatus { id: string; state: string; bytes: number; createdAt: string; readyAt?: string | null; expiresAt?: string | null }
export interface ShareStatus {
  id: string; kind: 'share' | 'return'; state: string; bytes: number;
  createdAt: string; readyAt?: string | null; firstOpenedAt?: string | null; expiresAt?: string | null; endedAt?: string | null;
  opens: string[]; returns: ReturnStatus[]; pollAfterSeconds?: number;
  /** The share's state of the books: 1, then one more with every «Aktualisieren». */
  generation?: number; updatedAt?: string | null;
  invite?: { sentAt: string; count: number; updateSentAt?: string | null } | null;
}
/** What anyone with the link learns without a token: the state and, while ready, the envelope, the file's size and name. */
export interface ShareInfo { id: string; kind: 'share' | 'return'; state: string; expiresAt?: string | null; firstOpenedAt?: string | null; meta?: Envelope | null; bytes?: number | null; filename?: string | null; generation?: number; updatedAt?: string | null }
/** One opening: a short-lived download of the file, its name and size. */
export interface Opening { download: Target; filename: string; bytes: number; urlExpiresAt?: string; expiresAt: string; generation?: number; updatedAt?: string | null }
/** Where the file goes: one upload URL, valid a few minutes; asking again gives a new one. */
export interface Upload { target: Target; bytes: number; generation?: number; expiresAt: string }
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
/** The file's transfer may take long (1 GB on a slow line); one that stalls this long is cut off. */
const STALL_MS = 2 * 60_000;
/** Progress is told per this many bytes. */
const STEP = 256 * 1024;

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

  /**
   * A transfer that ends only when it stalls: each chunk resets the clock. A file of 1 GB on a slow
   * line may take an hour; one that sends nothing for STALL_MS is cut off.
   */
  const transfer = async (url: string, init: RequestInit): Promise<{ res: Response; alive(): void; done(): void }> => {
    const ctl = new AbortController();
    let timer = setTimeout(() => ctl.abort(), STALL_MS);
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), STALL_MS); };
    const done = () => clearTimeout(timer);
    try { return { res: await fetcher(url, { ...init, redirect: 'error', referrerPolicy: 'no-referrer', signal: ctl.signal }), alive, done }; } catch (e) { done(); throw new ShareUnreachable(base, (e as Error).message); }
  };

  return {
    service: base,
    registerSender: (email: string) => call<SenderRegistration>('POST', '/api/senders', { email }),
    sender: (token: string) => call<SenderState>('GET', '/api/senders/me', undefined, token),
    create: (token: string, body: Declared) => call<Created>('POST', '/api/shares', body, token),
    /** «Aktualisieren»: the whole books again into the same share, as its next generation (same id, link and tokens). */
    update: (id: string, token: string, body: Declared) => call<Created>('POST', `/api/shares/${id}/update`, body, token),
    createReturn: (id: string, returnToken: string, body: Declared) => call<Created>('POST', `/api/shares/${id}/returns`, body, returnToken),
    /** The service sends the invitation (or the note of an update) from «<name> über Vanilla Accounting», replies to the sender. */
    invite: (id: string, token: string, body: InviteRequest) => call<Invited>('POST', `/api/shares/${id}/invite`, body, token),
    /** Where the file goes now: one URL, a few minutes; asked again for a retry. */
    upload: (id: string, token: string) => call<Upload>('POST', `/api/shares/${id}/upload`, {}, token),
    /**
     * The file to its upload URL, in one PUT with its exact size: written once, never over a file
     * already there (`If-None-Match: *`). `progress` sees the bytes sent.
     */
    async put(target: Target, file: Uint8Array, progress?: (sent: number) => void): Promise<void> {
      let sent = 0;
      let t: Awaited<ReturnType<typeof transfer>> | undefined;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent >= file.byteLength) { c.close(); return; }
          const chunk = file.subarray(sent, sent + STEP);
          sent += chunk.byteLength;
          t?.alive();
          c.enqueue(chunk);
          progress?.(sent);
        },
      });
      t = await transfer(target.url, { method: target.method || 'PUT', headers: { 'If-None-Match': '*', ...(target.headers ?? {}), 'Content-Length': String(file.byteLength) }, body, duplex: 'half' } as RequestInit);
      t.done();
      await t.res.body?.cancel().catch(() => undefined);
      // 412: the file is there already (a retry after a lost answer); `complete` checks its size.
      if (!t.res.ok && t.res.status !== 412) throw new ShareServiceError(`Hochladen: HTTP ${t.res.status}`, t.res.status === 403 ? 'uploadExpired' : 'internal', t.res.status);
    },
    complete: (id: string, token: string) => call<ShareStatus>('POST', `/api/shares/${id}/complete`, {}, token),
    info: (id: string) => call<ShareInfo>('GET', `/api/shares/${id}`),
    /** One opening (counted for the sharer's card): the file's short-lived download. A return's needs the sharer's revoke token. */
    open: (id: string, token?: string) => call<Opening>('POST', `/api/shares/${id}/open`, {}, token),
    /**
     * The file from its download URL, at most `max` bytes (the size the opening named): a source that
     * sends more is cut off, by its Content-Length or while it streams. Each chunk goes to `sink`.
     */
    async download(target: Target, max: number, sink: (chunk: Uint8Array) => void | Promise<void>): Promise<number> {
      const t = await transfer(target.url, { method: 'GET', headers: target.headers ?? {} });
      try {
        const { res } = t;
        if (!res.ok) {
          let data: { error?: string; code?: string } = {};
          try { data = JSON.parse(new TextDecoder().decode(await capped(res, ANSWER_BYTES, 'download'))); } catch { /* no words */ }
          throw new ShareServiceError(data.error ?? `HTTP ${res.status}`, data.code ?? (res.status === 403 ? 'downloadExpired' : 'internal'), res.status);
        }
        const declared = Number(res.headers.get('content-length') ?? NaN);
        const oversized = () => new ShareServiceError(`Der Download ist grösser als die angekündigten ${max} Bytes.`, 'oversized', 502, { limit: max });
        if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => undefined); throw oversized(); }
        let total = 0;
        const reader = res.body!.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          t.alive();
          total += value.byteLength;
          if (total > max) { await reader.cancel().catch(() => undefined); throw oversized(); }
          await sink(value);
        }
        return total;
      } finally { t.done(); }
    },
    status: (id: string, token: string) => call<ShareStatus>('GET', `/api/shares/${id}/status`, undefined, token),
    revoke: (id: string, token: string) => call<ShareStatus>('DELETE', `/api/shares/${id}`, undefined, token),
  };
}
