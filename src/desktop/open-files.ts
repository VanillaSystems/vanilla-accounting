/**
 * Freigabe-Dateien (`.vanillashare`, and the `.vanilla` of 0.6.x) handed to the app by macOS (#545): a double-click in Finder, «Öffnen mit», a drop
 * on the Dock icon. macOS sends them by `open-file`, also when the file starts the app, so they are
 * held until the server listens and then opened one after the other through the server's
 * POST /api/desktop/handover (src/desktop/server.ts), the same door as a drop on the start screen.
 * Nothing here needs Electron, so the tests run it in Node.
 */
import { readFile } from 'node:fs/promises';
import type { ApiErrorBody } from '../types/api-error.js';
import type { Key } from '../app/i18n/types.js';
import { formatLocation } from '../app/shell/route.js';

/** Whether a path is a Freigabe-Datei: `.vanillashare`, or `.vanilla` as 0.6.x wrote it (both known by their content when read). */
export const isVanillaPath = (path: string): boolean => /\.(vanillashare|vanilla)$/i.test(path);

/** The Freigabe-Dateien among a start's arguments (another platform than the Mac passes them so). */
export const vanillaPaths = (argv: readonly string[]): string[] => argv.filter((a) => !a.startsWith('-') && isVanillaPath(a));

/** Items that may arrive before the one who takes them is there: held, then given in their order. */
export function heldUntilReady<T>(): { add(item: T): void; ready(take: (item: T) => void): void; readonly held: number } {
  const held: T[] = [];
  let take: ((item: T) => void) | undefined;
  return {
    add(item) { if (take) take(item); else held.push(item); },
    ready(fn) { take = fn; for (const item of held.splice(0)) fn(item); },
    get held() { return held.length; },
  };
}

/** A file the server refused, with its answer. */
export class FileRefused extends Error {
  constructor(readonly body: ApiErrorBody) { super(body.error); }
}

/** What the server answered for an opened file. */
type Opened = { kind: 'return'; id: string } | { kind: 'full' | 'update' };

/**
 * Sends the file at `path` to the server and answers the page to show: a return's review in the
 * books open (also the sharer's own hand-over with his changes saved into it), the start page of a
 * hand-over's Durchsicht copy, whose document the file then is (its path in X-Vanilla-File: his
 * changes are saved into it). Throws FileRefused for a refusal.
 */
export async function openVanillaFile(path: string, base: string, send: typeof fetch = fetch): Promise<string> {
  const bytes = await readFile(path);
  const res = await send(`${base}/api/desktop/handover`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Vanilla-File': encodeURIComponent(path) }, body: new Uint8Array(bytes) });
  if (!res.ok) throw new FileRefused(((await res.json().catch(() => null)) as ApiErrorBody | null) ?? { error: `HTTP ${res.status}` });
  const opened = await res.json() as Opened;
  return opened.kind === 'return' ? formatLocation({ route: { area: 'changes', commit: 'return', file: opened.id }, query: {} }) : '/';
}

/** The refusals of a package (src/handover/package.ts PackageRefusal) the dialog says in the person's words. */
const PACKAGE_REFUSALS = new Set(['shareTampered', 'shareOtherCompany', 'shareBaseMissing', 'shareNotPackage', 'shareTooLarge', 'shareUnknownBase', 'shareUpdateFailed', 'shareOwnBooks']);

/** Why a file did not open, in the person's language; a return with no books to take it says where it belongs. */
export function refusedText(t: (key: Key, values?: Record<string, string>) => string, e: unknown): string {
  if (!(e instanceof FileRefused)) return e instanceof Error ? e.message : String(e);
  const { code, params } = e.body as { code?: string; params?: Record<string, string> };
  if (code === 'shareWrongKind') return t('desktop.fileIsReturn');
  if (code && PACKAGE_REFUSALS.has(code)) return t(`error.${code}` as Key, params ?? {});
  return e.body.error;
}
