/**
 * What the desktop app remembers between starts, in desktop.json of its user data folder: the
 * books opened last and before, the window's place, and the port, which keeps the page's origin,
 * and with it the theme, zoom and language the page stores, the same from one start to the next;
 * and the phone's pairing (Firma › Handy): whether it is on, its token and its port.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Bounds { x: number; y: number; width: number; height: number; maximized?: boolean }

export interface DesktopState {
  /** Most recent first; the first one opens at the next start. */
  recent: string[];
  bounds?: Bounds;
  port?: number;
  phone?: PhonePairing;
}

/** The token stays when the phone is switched off, so a paired phone works again once it is on; a new code replaces it. */
export interface PhonePairing { on: boolean; token: string; port?: number }

const RECENT = 8;

export function readState(file: string): DesktopState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopState>;
    return {
      recent: Array.isArray(raw.recent) ? raw.recent.filter((r): r is string => typeof r === 'string') : [],
      ...(raw.bounds && typeof raw.bounds.width === 'number' ? { bounds: raw.bounds } : {}),
      ...(Number.isInteger(raw.port) ? { port: raw.port } : {}),
      ...(raw.phone && typeof raw.phone.token === 'string' && raw.phone.token
        ? { phone: { on: raw.phone.on === true, token: raw.phone.token, ...(Number.isInteger(raw.phone.port) ? { port: raw.phone.port } : {}) } }
        : {}),
    };
  } catch {
    return { recent: [] };
  }
}

export function writeState(file: string, state: DesktopState): void {
  mkdirSync(dirname(file), { recursive: true });
  // It holds the phone's token: readable by this user only.
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** `root` first, once. */
export const opened = (state: DesktopState, root: string): DesktopState =>
  ({ ...state, recent: [root, ...state.recent.filter((r) => r !== root)].slice(0, RECENT) });
