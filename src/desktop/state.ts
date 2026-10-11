/**
 * What the desktop app remembers between starts, in desktop.json of its user data folder: the
 * books opened last and before, the books that open at every start (if the person marked one), the
 * window's place, and the port, which keeps the page's origin, and with it the theme, zoom and
 * language the page stores, the same from one start to the next.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Bounds { x: number; y: number; width: number; height: number; maximized?: boolean }

export interface DesktopState {
  /** Most recent first. */
  recent: string[];
  /** "Immer diese Buchhaltung öffnen": opened at every start instead of the start screen. Absent in files from before it (they show the start screen). */
  autoOpen?: string;
  bounds?: Bounds;
  port?: number;
}

const RECENT = 8;

export function readState(file: string): DesktopState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopState>;
    return {
      recent: Array.isArray(raw.recent) ? raw.recent.filter((r): r is string => typeof r === 'string') : [],
      ...(raw.bounds && typeof raw.bounds.width === 'number' ? { bounds: raw.bounds } : {}),
      ...(Number.isInteger(raw.port) ? { port: raw.port } : {}),
      ...(typeof raw.autoOpen === 'string' && raw.autoOpen ? { autoOpen: raw.autoOpen } : {}),
    };
  } catch {
    return { recent: [] };
  }
}

export function writeState(file: string, state: DesktopState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
}

/** `root` first, once; the marked books stay on the list, so their mark can be seen and removed. */
export function opened(state: DesktopState, root: string): DesktopState {
  const recent = [root, ...state.recent.filter((r) => r !== root)].slice(0, RECENT);
  if (state.autoOpen && !recent.includes(state.autoOpen)) recent.splice(RECENT - 1, 1, state.autoOpen);
  return { ...state, recent };
}

/** What a start shows: the marked books, or the start screen (with a notice when the marked books are gone). */
export type Launch = { kind: 'open'; root: string } | { kind: 'start'; missing?: string };

/** ⌥ held at the start shows the start screen once, whatever is marked; `holdsBooks` says whether a folder still holds its books. */
export function launchDecision(state: DesktopState, optionHeld: boolean, holdsBooks: (root: string) => boolean): Launch {
  if (!state.autoOpen || optionHeld) return { kind: 'start' };
  return holdsBooks(state.autoOpen) ? { kind: 'open', root: state.autoOpen } : { kind: 'start', missing: state.autoOpen };
}
