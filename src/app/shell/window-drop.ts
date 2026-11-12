/**
 * Files dragged over the window (#361): the listeners are there from the app's first moment, before
 * the books are loaded and before the API has answered, and a file drag never falls through to the
 * browser (which would open the file in place of the app). What is dropped is read while the event
 * lasts and goes to the shell's handler; while the app does not know yet whether it may write, it
 * waits for that answer; offline or read-only, the person is told that nothing was taken. Without
 * React, so tests run it as it is.
 */

export type DropTarget = 'page' | 'chat';
/** Whether a drop can be taken now: `unknown` until the API's first answer. */
export type DropState = 'unknown' | 'ready' | 'offline' | 'readonly';

export interface Dropped { files: File[]; target: DropTarget; entries: (FileSystemEntry | null)[] }

export interface DropHandler {
  state: DropState;
  /** Where a drag at this point would go. */
  targetAt(x: number): DropTarget;
  /** The zone under a drag, null when it left the window. */
  shown(on: DropTarget | null): void;
  take(d: Dropped): void;
  /** A drop the app cannot take: it says so, nothing is taken. */
  refuse(state: 'offline' | 'readonly', d: Dropped): void;
}

let handler: DropHandler | undefined;
let held: Dropped[] = [];

/** What becomes of a drop with the handler as it is: taken, held until the app knows, or refused. */
export function route(d: Dropped, h: DropHandler | undefined): 'take' | 'hold' | 'refuse' {
  if (!h || h.state === 'unknown') return 'hold';
  return h.state === 'ready' ? 'take' : 'refuse';
}

function deliver(d: Dropped): void {
  const how = route(d, handler);
  if (how === 'hold') held.push(d);
  else if (how === 'take') handler!.take(d);
  else handler!.refuse(handler!.state as 'offline' | 'readonly', d);
}

/** The shell's handler, set again whenever its state changes; held drops go out once the state is known. */
export function setDropHandler(h: DropHandler | undefined): void {
  handler = h;
  if (!h || h.state === 'unknown' || !held.length) return;
  const out = held;
  held = [];
  for (const d of out) deliver(d);
}

/** The drops held so far (for tests). */
export const heldDrops = (): readonly Dropped[] => held;

const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');

/** Puts the window's listeners in place, once. */
export function installWindowDrop(win: Window): void {
  const w = win as Window & { __vanillaDrop?: true };
  if (w.__vanillaDrop) return;
  w.__vanillaDrop = true;
  let depth = 0;
  const ready = () => handler?.state === 'ready';
  win.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; if (ready()) handler!.shown(handler!.targetAt(e.clientX)); });
  win.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (ready()) handler!.shown(handler!.targetAt(e.clientX)); });
  win.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; handler?.shown(null); } });
  win.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    handler?.shown(null);
    // Read while the event lasts: its items are gone once it is over.
    const entries = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.() ?? null);
    deliver({ files: [...(e.dataTransfer?.files ?? [])], target: handler?.targetAt(e.clientX) ?? 'page', entries });
  });
}
