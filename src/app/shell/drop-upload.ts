/**
 * One drop's files into the drop window's session, one after the other (#194). A file the server
 * refuses (an empty file, a lost connection) is counted with its reason and the next file goes on,
 * so a folder drop is never cut short silently. Without React or Vite, so tests run it as it is.
 */
import type { Key } from '../i18n/types.js';

export interface Failed { name: string; error: unknown }

/** `add` each file in turn, `added` each answer; returns the files that failed, each with its error. */
export async function addEach<S>(files: readonly File[], add: (f: File) => Promise<S>, added: (s: S) => void): Promise<Failed[]> {
  const failed: Failed[] = [];
  for (const f of files) {
    try {
      added(await add(f));
    } catch (error) {
      failed.push({ name: f.name, error });
    }
  }
  return failed;
}

/** The line that names how many files did not go and why; none when all went. */
export function failedLine(failed: readonly Failed[], why: (e: unknown) => string): { key: Key; vars: Record<string, string | number> } | undefined {
  if (!failed.length) return undefined;
  return { key: 'drop.failed', vars: { n: failed.length, list: failed.map((f) => `${f.name} (${why(f.error)})`).join(', ') } };
}

/** What a new drop sets: the dialog open, and its own note only, never the one of a drop before it. */
export const dropStart = (note?: string) => ({ open: true, error: undefined, note: note || undefined });
