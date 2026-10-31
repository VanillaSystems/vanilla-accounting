/**
 * The API channel `io.api` (ADR 0014): a source's code reads a provider's interface over HTTPS
 * with the token the person put into the secret store, and the host checks every request against
 * `reach.api` (GET only, the paths `allow` names) before it leaves. The code never sees the token.
 *
 *   io.api.get(path, query?) → { status, contentType, json?, text?, file? }
 *
 * A JSON answer comes back parsed, a text answer as text, anything else (a PDF) as a file
 * reference to bytes the host holds, which the code yields as a document.
 */
import type { Held } from './mail-channel.js';
import type { ApiReach } from './model.js';
import { matches, ReachError } from './reach.js';

export type ApiFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

const TEXT_MAX = 2_000_000;

/** The provider refused the token (401): the person puts in a new one (the task «Passwort für {source} hinterlegen»). */
export class ApiRefused extends Error {}

export function apiChannel(reach: ApiReach, token: string, held: Map<string, Held>, fetcher: ApiFetch = (url, init) => fetch(url, init)) {
  return {
    async get(path: unknown, query?: unknown) {
      const p = String(path).replace(/^\//, '');
      const url = new URL(p, reach.base);
      if (query && typeof query === 'object') for (const [k, v] of Object.entries(query as Record<string, unknown>)) url.searchParams.set(k, String(v));
      if (!reach.allow.some((a) => matches(a.path, url.href))) throw new ReachError('api', `GET ${url.origin}${url.pathname}`);
      const headers: Record<string, string> = 'header' in reach.auth ? { [reach.auth.header]: token } : { authorization: `Bearer ${token}` };
      const r = await fetcher(url.href, { headers });
      if (r.status === 401) throw new ApiRefused(`GET ${url.pathname}: 401`);
      const contentType = (r.headers.get('content-type') ?? '').split(';')[0].trim();
      const body = Buffer.from(await r.arrayBuffer());
      if (/json/i.test(contentType)) return { status: r.status, contentType, json: JSON.parse(body.toString('utf8') || 'null') as unknown };
      if (/^text\//i.test(contentType)) return { status: r.status, contentType, text: body.toString('utf8').slice(0, TEXT_MAX) };
      const file = `api:${held.size + 1}`;
      const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? url.pathname.split('/').filter(Boolean).pop() ?? 'download';
      held.set(file, { name, content: body, from: `${url.origin}${url.pathname}` });
      return { status: r.status, contentType, file, filename: name, size: body.length };
    },
  };
}
