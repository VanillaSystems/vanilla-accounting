/**
 * The export dialog's side effects: the viewer's own presets (kept in this browser) and the
 * request sent to POST /api/export.
 */
import { localToday, parsePeriod, type Period } from '../../../accounting/periods.js';
import type { ExportRequest } from '../../../export/model.js';
import type { OwnPreset } from './config.js';
import { ApiError, apiFetch } from '../../lib/api.js';
import { language } from '../../i18n/index.js';

const KEY = 'export.presets';

/** Per viewer, in this browser: presets are a habit of one person, not part of the books. */
export function ownPresets(): OwnPreset[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as OwnPreset[]; } catch { return []; }
}

export function saveOwnPresets(list: OwnPreset[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* per viewer only */ }
}

export const periodOf = (token: string): Period => parsePeriod(token, localToday())!;

/** Sends the request and hands what comes back to the browser under the name the server gives it; returns that name. The browser (or its Save dialog) finishes the file later, unseen by the page. */
export const download = (req: Omit<ExportRequest, 'language'>): Promise<string> => postDownload('/api/export', { ...req, language: language() }, 'export.zip');

/** A POST whose answer is a file: saved by the browser under the server's name, which it returns. */
export async function postDownload(path: string, body: unknown, fallback: string): Promise<string> {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => null) as ConstructorParameters<typeof ApiError>[0] | null;
    throw new ApiError(err?.error ? err : { error: `HTTP ${res.status}` });
  }
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallback);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  return name;
}
