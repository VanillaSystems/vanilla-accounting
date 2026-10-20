/**
 * A folder dropped on the AI sidebar: its files, and those of its subfolders, go as attachments.
 * The browser hands a folder over as an entry to walk (webkitGetAsEntry), never as a file. What
 * cannot be attached (not a PDF or an image) is counted, not sent; hidden files are left out; at
 * most MAX_FOLDER_FILES go, so a dropped home folder does not upload a thousand files.
 */
import { attachmentType } from '../../types/attachment.js';

export const MAX_FOLDER_FILES = 50;

interface Entry { name: string; isFile: boolean; isDirectory: boolean }
interface FileEntry extends Entry { file(ok: (f: File) => void, fail: (e: unknown) => void): void }
interface DirEntry extends Entry { createReader(): { readEntries(ok: (es: Entry[]) => void, fail: (e: unknown) => void): void } }

/** What a drop brought: the files to attach, the folders they came from, and what stayed behind. */
export interface Dropped { files: File[]; folders: string[]; skipped: number; over: number }

const children = (dir: DirEntry): Promise<Entry[]> => new Promise((resolve, reject) => {
  const reader = dir.createReader();
  const all: Entry[] = [];
  const next = () => reader.readEntries((batch) => { if (batch.length) { all.push(...batch); next(); } else resolve(all); }, reject);
  next();
});
const fileOf = (e: FileEntry): Promise<File> => new Promise((ok, fail) => e.file(ok, fail));

/** `entries` as the drop event's items gave them, `plain` its files: without a folder among them, the files as they are. */
export async function droppedFiles(entries: readonly (Entry | null)[], plain: File[]): Promise<Dropped> {
  if (!entries.some((e) => e?.isDirectory)) return { files: plain, folders: [], skipped: 0, over: 0 };
  const out: Dropped = { files: [], folders: [], skipped: 0, over: 0 };
  const walk = async (e: Entry): Promise<void> => {
    if (e.name.startsWith('.')) return;
    if (e.isDirectory) { for (const c of await children(e as DirEntry)) await walk(c); return; }
    const f = await fileOf(e as FileEntry);
    if (!attachmentType(f)) out.skipped++;
    else if (out.files.length >= MAX_FOLDER_FILES) out.over++;
    else out.files.push(f);
  };
  for (const e of entries) {
    if (!e) continue;
    if (e.isDirectory) out.folders.push(e.name);
    await walk(e);
  }
  return out;
}
