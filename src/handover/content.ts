/**
 * What a hand-over carries and what the content version's checksum counts (docs/specs/e2e-and-fiduciary.md
 * B3.4, B7): the files of the books, by path relative to the app's folder. The books' own files (ledger.json,
 * the year's books/*.jsonl, filings and seals, master-data, knowledge, the settings) go whole in every
 * package; receipts, statements and invoice PDFs only when they are new to the recipient. Local data
 * (data/, output/), the collectors and mailboxes, the AI's instructions and the version log stay home.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { YEAR_FOLDER, type WorkspacePaths } from '../workspace/workspace.js';

/** How a file travels: whole in every package, or only when new (B3.4). */
export type Carriage = 'whole' | 'new';

/** The top-level names that hold content, and how each travels. */
const TOP: Record<string, Carriage> = {
  'ledger.json': 'whole', 'belege.workspace.yaml': 'whole', 'invoices.json': 'whole',
  'master-data': 'whole', knowledge: 'whole', modules: 'whole', logos: 'whole',
};
/** The folders of a year that hold content, and how each travels. */
const YEAR: Record<string, Carriage> = { books: 'whole', filings: 'whole', receipts: 'new', 'bank-statements': 'new', invoices: 'new' };

export interface ContentFile {
  /** Relative to the app's folder, with forward slashes. */
  path: string;
  carriage: Carriage;
  /** Its year, for a file of transactional-data/<year>/. */
  year?: string;
}

function walk(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) return [prefix];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.'))
    .flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name), `${prefix}/${d.name}`) : d.isFile() ? [`${prefix}/${d.name}`] : []));
}

/** Every content file in the folder `root` (a workspace or a package's unpacked copy), sorted by path. */
export function contentFiles(root: string): ContentFile[] {
  const out: ContentFile[] = [];
  for (const [name, carriage] of Object.entries(TOP)) for (const path of walk(join(root, name), name)) out.push({ path, carriage });
  const td = join(root, 'transactional-data');
  if (existsSync(td)) {
    for (const year of readdirSync(td).filter((y) => YEAR_FOLDER.test(y)).sort()) {
      for (const [name, carriage] of Object.entries(YEAR)) {
        for (const path of walk(join(td, year, name), `transactional-data/${year}/${name}`)) out.push({ path, carriage, year });
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Where a content path's carriage is decided, for a path that is not on disk (yet). */
export function carriageOf(path: string): Carriage | undefined {
  const parts = path.split('/');
  if (parts[0] === 'transactional-data') return YEAR_FOLDER.test(parts[1] ?? '') ? YEAR[parts[2] ?? ''] : undefined;
  return TOP[parts[0]];
}

export const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

/** The id git gives the file's content as a blob: the same file is the same blob in the sharer's repository. */
export const gitBlobId = (data: Uint8Array): string => createHash('sha1').update(`blob ${data.byteLength}\0`).update(data).digest('hex');

export interface FileFact { path: string; sha256: string; blob: string; bytes: number }

export function factOf(root: string, path: string): FileFact {
  const data = readFileSync(join(root, path));
  return { path, sha256: sha256(data), blob: gitBlobId(data), bytes: data.byteLength };
}

/**
 * The checksum of a version (B7): SHA-256 over the sorted list of `path`, NUL, the file's SHA-256,
 * newline, for every content file. Its form is `sha256:<hex>`.
 */
export function checksumOf(files: ReadonlyArray<Pick<FileFact, 'path' | 'sha256'>>): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}\0${f.sha256}\n`).join('');
  return `sha256:${sha256(lines)}`;
}

/** The checksum of the content in `paths.root` now. */
export function contentChecksum(paths: Pick<WorkspacePaths, 'root'>): { checksum: string; files: FileFact[] } {
  const files = contentFiles(paths.root).map((f) => factOf(paths.root, f.path));
  return { checksum: checksumOf(files), files };
}

/** The checksum as a person reads it: its first 12 hex digits in three groups («a3f9 c21e 07bd»). */
export const shortChecksum = (checksum: string): string => (checksum.replace(/^sha256:/, '').slice(0, 12).match(/.{4}/g) ?? []).join(' ');
