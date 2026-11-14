/**
 * Which share service the books go through (docs/share-protocol.md), and the link a person gets.
 * The service is configuration, never a constant of the app (ADR 0015: no provider wired in): the
 * environment (VANILLA_SHARE_SERVICE), then this computer's setting («Dienst» in the dialog), then
 * the build's default (package.json `share.service`, which the release build writes from
 * VANILLA_SHARE_SERVICE, as it writes the update feed from VANILLA_RELEASES). Without one, the
 * link is not offered and the `.vanilla` file does every step.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { APP_ROOT } from '../workspace/workspace.js';
import { decodeKey } from './crypto/index.js';

/** The service's limits (docs/api.md of the service): the dialog names them before the service refuses. */
export const SHARE_LIMITS = { bytes: 1024 * 1024 * 1024, objects: 5000, sharesPerDay: 10, returnsPerShare: 5, opens: 3, hoursAfterOpen: 5, days: 10 } as const;

/** A share's id as the service makes it: 26 characters a–z and 2–7. */
export const SHARE_ID = /^[a-z2-7]{26}$/;
/** The scheme the Mac app answers to: `vanilla-accounting://open?share=<id>#<key>`. */
export const APP_SCHEME = 'vanilla-accounting';

let settingsFile: string | undefined;
/** This computer's share settings; the Mac app names a file in its own folder (src/desktop/main.ts). */
export const shareSettingsFile = (): string => settingsFile ?? process.env.VANILLA_SHARE_SETTINGS ?? join(homedir(), '.vanilla-accounting', 'share.json');
export const setShareSettingsFile = (file: string): void => { settingsFile = file; };

interface Settings { service?: string }

function readSettings(): Settings {
  try { return JSON.parse(readFileSync(shareSettingsFile(), 'utf8')) as Settings; } catch { return {}; }
}

/** The person's own service address; null goes back to the default. */
export function setService(text: string | null): void {
  const file = shareSettingsFile();
  const next: Settings = { ...readSettings() };
  if (text === null || !text.trim()) delete next.service; else next.service = serviceOf(text);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function buildDefault(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { share?: { service?: unknown } };
    return typeof pkg.share?.service === 'string' && pkg.share.service ? pkg.share.service : undefined;
  } catch { return undefined; }
}

export type ServiceSource = 'env' | 'setting' | 'build' | 'none';

/** The service in use and where it was named. */
export function shareService(): { url?: string; source: ServiceSource } {
  const env = process.env.VANILLA_SHARE_SERVICE?.trim();
  if (env) return { url: serviceOf(env), source: 'env' };
  const own = readSettings().service;
  if (own) return { url: own, source: 'setting' };
  const built = buildDefault();
  if (built) return { url: serviceOf(built), source: 'build' };
  return { source: 'none' };
}

const isLocal = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/** A service address as the app keeps it: its origin, https (http only on this computer, for the service's own development server). */
export function serviceOf(text: string): string {
  let url: URL;
  try { url = new URL(text.trim().includes('://') ? text.trim() : `https://${text.trim()}`); } catch { throw new Error(`Keine Adresse: ${text}`); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal(url.hostname))) throw new Error(`Der Dienst braucht https: ${text}`);
  return url.origin;
}

/**
 * A share link: the service, the share's id, and its key from the fragment. `foreign`: the link
 * names another service than the one this app uses, which the person must confirm before it opens
 * (src/share/sharing.ts openLink; review of PR #538).
 */
export interface ShareLink { service: string; id: string; key: string; foreign: boolean }

/**
 * Reads a link a person pasted or the system handed over: `https://<service>/<id>#<key>`, or the Mac
 * app's `vanilla-accounting://open?share=<id>#<key>` (with `&service=` when the page names it, else
 * the service in use). Undefined for anything else.
 */
export function parseLink(text: string, service = shareService().url): ShareLink | undefined {
  let url: URL;
  try { url = new URL(text.trim()); } catch { return undefined; }
  const key = url.hash.slice(1);
  try { decodeKey(key); } catch { return undefined; }
  if (url.protocol === `${APP_SCHEME}:`) {
    const id = url.searchParams.get('share') ?? '';
    let from = service;
    const named = url.searchParams.get('service');
    if (named) { try { from = serviceOf(named); } catch { return undefined; } }
    return SHARE_ID.test(id) && from ? { service: from, id, key, foreign: from !== service } : undefined;
  }
  let origin: string;
  try { origin = serviceOf(url.origin); } catch { return undefined; }
  const id = url.pathname.replace(/^\/+|\/+$/g, '');
  return SHARE_ID.test(id) ? { service: origin, id, key, foreign: origin !== service } : undefined;
}

/** The link the invitation carries: the key only after the #, which a browser never sends. */
export const linkOf = (shareUrl: string, key: string): string => `${shareUrl.split('#')[0]}#${key}`;
