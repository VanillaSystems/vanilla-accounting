/**
 * What the HTTP providers share: a JSON request with a timeout, an error that never carries the
 * key, and an attachment read into base64 with its media type.
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { CallFailed, NO_USAGE } from '../provider.js';

const MEDIA: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

export interface Attachment { name: string; mediaType: string; base64: string }

export function readAttachment(path: string): Attachment {
  const mediaType = MEDIA[extname(path).toLowerCase()];
  if (!mediaType) throw new CallFailed(`${basename(path)}: only PDF and images can be sent to the model`, NO_USAGE);
  return { name: basename(path), mediaType, base64: readFileSync(path).toString('base64') };
}

/** Sends JSON, answers JSON. A refusal names the provider, the status and the provider's own message, never the request's headers. */
export async function requestJson(provider: string, url: string, init: { headers: Record<string, string>; body?: unknown; form?: FormData; timeoutMs: number }): Promise<unknown> {
  let res: Response;
  try {
    // A form sets its own content type, with its boundary.
    res = await fetch(url, {
      method: init.body === undefined && !init.form ? 'GET' : 'POST',
      headers: init.form ? init.headers : { 'content-type': 'application/json', ...init.headers },
      body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (e) {
    const why = e instanceof Error && e.name === 'TimeoutError' ? `timed out after ${init.timeoutMs} ms` : 'not reachable';
    throw new CallFailed(`${provider} ${why}`, NO_USAGE);
  }
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (!res.ok) {
    const message = (json as { error?: { message?: unknown } } | undefined)?.error?.message;
    throw new HttpRefused(provider, res.status, typeof message === 'string' ? message.slice(0, 300) : '');
  }
  return json;
}

export class HttpRefused extends CallFailed {
  constructor(provider: string, readonly status: number, message: string) {
    super(`${provider} answered ${status}${message ? `: ${message}` : ''}`, NO_USAGE);
  }
}
