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
  /**
   * The company's name of each recent folder as it was when last opened: the menu names them
   * without reading the folders, which macOS may hold while it asks the person (#373).
   */
  names?: Record<string, string>;
  /** How macOS answered the app's first read of the Documents folder (GET /api/desktop/folders). */
  homeAccess?: 'allowed' | 'refused';
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
      ...(raw.names && typeof raw.names === 'object' ? { names: Object.fromEntries(Object.entries(raw.names).filter((e): e is [string, string] => typeof e[1] === 'string')) } : {}),
      ...(raw.homeAccess === 'allowed' || raw.homeAccess === 'refused' ? { homeAccess: raw.homeAccess } : {}),
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

/** `root` first, once, with the name it holds now (none: the name kept so far goes). */
export function opened(state: DesktopState, root: string, name?: string): DesktopState {
  const recent = [root, ...state.recent.filter((r) => r !== root)].slice(0, RECENT);
  const names = Object.fromEntries(recent.flatMap((r) => {
    const n = r === root ? name : state.names?.[r];
    return n ? [[r, n] as const] : [];
  }));
  const { names: _was, ...rest } = state;
  return { ...rest, recent, ...(Object.keys(names).length ? { names } : {}) };
}
