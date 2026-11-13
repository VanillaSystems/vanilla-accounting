/**
 * One drop's files into the drop window's session, one after the other (#194). A file the server
 * refuses (an empty file, a lost connection) is counted with its reason and the next file goes on,
 * so a folder drop is never cut short silently. The window's state lives here too (`dropStore`).
 * Without React or Vite, so tests run it as it is.
 */
import type { Key } from '../i18n/types.js';
import type { DropRow, DropSession } from '../../types/drop.js';

/** What a row did to the books, as the server reports it: a statement read in or kept, a report booked, payouts booked by an answer; none for a row that wrote nothing (a receipt goes to the inbox, whose run writes and says so). */
const booksPart = (r: DropRow): string | undefined =>
  (r.statement || r.report || r.keep || r.asked || r.payouts ? JSON.stringify([r.state, r.statement, r.report, r.keep, r.asked, r.payouts]) : undefined);

/**
 * Whether the server's answer `after` reports a write to the books the session `before` did not
 * (#424): a row that read, kept or booked something new, or a taken row taken back. The drop
 * window's every answer passes here, so no booking it reports leaves the pages on the books of before.
 */
export function booksMoved(before: DropSession | undefined, after: DropSession): boolean {
  const was = new Map((before?.rows ?? []).map((r) => [r.key, r]));
  const now = new Map(after.rows.map((r) => [r.key, r]));
  if ([...was.values()].some((r) => r.state === 'taken' && now.get(r.key)?.state !== 'taken')) return true;
  return after.rows.some((r) => {
    const part = booksPart(r);
    const old = was.get(r.key);
    return part !== undefined && part !== (old && booksPart(old));
  });
}

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
interface Visit { session?: Promise<DropSession>; uploads: number; closed: boolean; last?: DropSession }

/**
 * The drop window's state with its drops and close; `why` names an error, `failed` the line of files a
 * drop could not upload; `moved` is told whenever an answer of the server wrote the books (`booksMoved`,
 * also for a closed window's files going on in the background, and after the close, which takes what waits).
 */
export function dropStore(server: DropServer, why: (e: unknown) => string, failed: (f: Failed[]) => string | undefined, moved: () => void = () => undefined) {
  let state: DropState = { open: false, adding: 0, lost: [] };
  let visit: Visit | undefined;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<DropState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
  const lose = (more: Failed[]) => { if (more.length) set({ lost: [...state.lost, ...more] }); };
  /** A new answer of the visit's session: the books moved when it says so. */
  const seen = (v: Visit, next: DropSession) => {
    const before = v.last;
    v.last = next;
    if (booksMoved(before, next)) moved();
  };
  const settle = (v: Visit) => {
    if (v.closed && !v.uploads && v.session) v.session.then((s) => server.close(s.id)).then(moved, () => undefined);
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
      v.last ??= session;
      if (live()) set({ session, adding: state.adding + files.length });
      const add = async (f: File) => {
        try {
          return await server.add(session.id, f);
        } finally {
          if (live()) set({ adding: Math.max(0, state.adding - 1) });
        }
      };
      const lost = await addEach(files, add, (next) => { seen(v, next); if (live()) set({ session: next }); });
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
  const answered = (next: DropSession) => {
    if (visit?.last?.id === next.id) seen(visit, next);
    else if (booksMoved(undefined, next)) moved();
    if (state.session?.id === next.id) set({ session: next });
  };

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
