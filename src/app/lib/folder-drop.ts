/**
 * A folder dropped on the window: its files, and those of its subfolders, go where the drop went.
 * The browser hands a folder over as an entry to walk (webkitGetAsEntry), never as a file (#188).
 * Hidden files are left out. Each target says which files it takes and how many: the AI sidebar
 * only PDFs and images, at most 50, so a dropped home folder does not upload a thousand files; the
 * page every file but an empty one, at most 2000, since the drop window sorts and refuses them itself.
 */
import { attachmentType } from '../../types/attachment.js';
import type { Key } from '../i18n/types.js';

/**
 * What a target takes from a walked folder: `take` says whether a file goes, `max` how many go at
 * most, `words` the texts that tell the person what stayed behind (a limit is never hit silently).
 */
export interface Take { take(f: File): boolean; max: number; words: { skipped?: Key; over: Key } }
export const CHAT_TAKES: Take = { take: (f) => !!attachmentType(f), max: 50, words: { skipped: 'assistant.folderSkipped', over: 'assistant.folderOver' } };
/** The page takes every file but an empty one, which the server refuses (#194): that one is counted and said. */
export const PAGE_TAKES: Take = { take: (f) => f.size > 0, max: 2000, words: { skipped: 'drop.folderEmpty', over: 'drop.folderOver' } };

interface Entry { name: string; isFile: boolean; isDirectory: boolean }
interface FileEntry extends Entry { file(ok: (f: File) => void, fail: (e: unknown) => void): void }
interface DirEntry extends Entry { createReader(): { readEntries(ok: (es: Entry[]) => void, fail: (e: unknown) => void): void } }

/** What a drop brought: the files to hand on, the folders they came from, and what stayed behind (not taken, or over `max`). */
export interface Dropped { files: File[]; folders: string[]; skipped: number; over: number }

const children = (dir: DirEntry): Promise<Entry[]> => new Promise((resolve, reject) => {
  const reader = dir.createReader();
  const all: Entry[] = [];
  const next = () => reader.readEntries((batch) => { if (batch.length) { all.push(...batch); next(); } else resolve(all); }, reject);
  next();
});
const fileOf = (e: FileEntry): Promise<File> => new Promise((ok, fail) => e.file(ok, fail));

/** `entries` as the drop event's items gave them, `plain` its files: without a folder among them, the files as they are. */
export async function droppedFiles(entries: readonly (Entry | null)[], plain: File[], { take, max }: Take): Promise<Dropped> {
  if (!entries.some((e) => e?.isDirectory)) return { files: plain, folders: [], skipped: 0, over: 0 };
  const out: Dropped = { files: [], folders: [], skipped: 0, over: 0 };
  const walk = async (e: Entry): Promise<void> => {
    if (e.name.startsWith('.')) return;
    if (e.isDirectory) { for (const c of await children(e as DirEntry)) await walk(c); return; }
    const f = await fileOf(e as FileEntry);
    if (!take(f)) out.skipped++;
    else if (out.files.length >= max) out.over++;
    else out.files.push(f);
  };
  for (const e of entries) {
    if (!e || e.name.startsWith('.')) continue;
    if (e.isDirectory) out.folders.push(e.name);
    await walk(e);
  }
  return out;
}

/** The texts that say what of a walked drop stayed behind: the files not taken, and those over the limit with the limit named. */
export function leftOut(d: Dropped, { max, words }: Take): { key: Key; vars: Record<string, string | number> }[] {
  const folder = d.folders.join(', ');
  return [
    ...(d.skipped && words.skipped ? [{ key: words.skipped, vars: { folder, n: d.skipped } }] : []),
    ...(d.over ? [{ key: words.over, vars: { folder, max, n: d.over } }] : []),
  ];
}
