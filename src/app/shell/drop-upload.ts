/**
 * One drop's files into the drop window's session, one after the other (#194). A file the server
 * refuses (an empty file, a lost connection) is counted with its reason and the next file goes on,
 * so a folder drop is never cut short silently. The window's state lives here too (`dropStore`).
 * Without React or Vite, so tests run it as it is.
 */
import type { Key } from '../i18n/types.js';
import type { DropSession } from '../../types/drop.js';

/** A file that did not go, kept whole so it can be dropped again. */
export interface Failed { file: File; error: unknown }

/** `add` each file in turn, `added` each answer; returns the files that failed, each with its error. */
export async function addEach<S>(files: readonly File[], add: (f: File) => Promise<S>, added: (s: S) => void): Promise<Failed[]> {
  const failed: Failed[] = [];
  for (const f of files) {
    try {
      added(await add(f));
    } catch (error) {
      failed.push({ file: f, error });
    }
  }
  return failed;
}

/** The line that names how many files did not go and why; none when all went. */
export function failedLine(failed: readonly Failed[], why: (e: unknown) => string): { key: Key; vars: Record<string, string | number> } | undefined {
  if (!failed.length) return undefined;
  return { key: 'drop.failed', vars: { n: failed.length, list: failed.map((f) => `${f.file.name} (${why(f.error)})`).join(', ') } };
}

/** What a new drop sets: the dialog open, and its own note only, never the one of a drop before it. */
export const dropStart = (note?: string) => ({ open: true, error: undefined, note: note || undefined });

/**
 * What the drop window shows. `note`: what a drop left out, a limit it hit named (a limit is never hit
 * silently). `lost`: the files of a closed window that did not go (#279); they stay, named, until the
 * person drops them again or lets them go, since no window was open to tell them.
 */
export interface DropState { open: boolean; session?: DropSession; adding: number; note?: string; error?: string; lost: Failed[] }

/** The server's drop session (src/server/routes/drop.ts), as the window calls it. */
export interface DropServer {
  open(): Promise<DropSession>;
  add(session: string, file: File): Promise<DropSession>;
  close(session: string): Promise<unknown>;
}

/**
 * One opening of the window, from its first drop to its close (#195). Its session is a promise, so
 * two drops before the server answers share one session. A closed visit writes nothing into the
 * window any more: its files still uploading go on into its session («Im Hintergrund weiter»), and
 * the session is closed on the server once the last of them is in, which takes or quarantines what
 * waits, so no file is lost and the next drop opens a session of its own. A file of it that fails
 * goes to `lost`.
 */
interface Visit { session?: Promise<DropSession>; uploads: number; closed: boolean }

/** The drop window's state with its drops and close; `why` names an error, `failed` the line of files a drop could not upload. */
export function dropStore(server: DropServer, why: (e: unknown) => string, failed: (f: Failed[]) => string | undefined) {
  let state: DropState = { open: false, adding: 0, lost: [] };
  let visit: Visit | undefined;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<DropState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
  const lose = (more: Failed[]) => { if (more.length) set({ lost: [...state.lost, ...more] }); };
  const settle = (v: Visit) => {
    if (v.closed && !v.uploads && v.session) v.session.then((s) => server.close(s.id)).catch(() => undefined);
  };

  async function drop(files: readonly File[], note?: string): Promise<void> {
    const v = (visit ??= { uploads: 0, closed: false });
    const live = () => v === visit;
    set(dropStart(note));
    v.uploads++;
    try {
      const opening = (v.session ??= server.open());
      let session: DropSession;
      try {
        session = await opening;
      } catch (e) {
        if (v.session === opening) v.session = undefined;
        if (live()) set({ error: why(e) });
        else lose(files.map((file) => ({ file, error: e })));
        return;
      }
      if (live()) set({ session, adding: state.adding + files.length });
      const add = async (f: File) => {
        try {
          return await server.add(session.id, f);
        } finally {
          if (live()) set({ adding: Math.max(0, state.adding - 1) });
        }
      };
      const lost = await addEach(files, add, (next) => { if (live()) set({ session: next }); });
      if (!live()) lose(lost);
      else if (lost.length) set({ error: failed(lost) });
    } finally {
      v.uploads--;
      settle(v);
    }
  }

  function close(): void {
    const v = visit;
    visit = undefined;
    set({ open: false, session: undefined, adding: 0, note: undefined, error: undefined });
    if (v) { v.closed = true; settle(v); }
  }

  /** Drops the lost files again, into a window of their own; or lets them go. */
  function retry(): Promise<void> {
    const files = state.lost.map((f) => f.file);
    set({ lost: [] });
    return drop(files);
  }
  const dismiss = () => set({ lost: [] });

  /** A row's answer: shown only while the window still shows its session. */
  const answered = (next: DropSession) => { if (state.session?.id === next.id) set({ session: next }); };

  return {
    get: () => state,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    set,
    drop,
    close,
    answered,
    retry,
    dismiss,
  };
}
