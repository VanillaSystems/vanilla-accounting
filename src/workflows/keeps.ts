/**
 * The record of each rule kept (#392, #396): which rules file it wrote and how that file was before,
 * the rules it kept, the entries it booked, the payments that wait for their receipt, the tasks
 * it closed, and the deletion marks its payments had before it. «Rückgängig» and the result line name
 * only the keep's id; the server reads everything else from here, so a page can never mix two keeps.
 * Local state of this computer beside the runs (src/workflows/store.ts), outside the workspace and its
 * git: no part of the books' format. Every change of a record is one synchronous read and write
 * (updateKeep), so two requests of this process never write over each other.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runsDir } from './store.js';
import type { BankTransaction } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';

export interface KeepRecord {
  id: string;
  /** When it was kept (ISO); the order of keeps of one file. */
  at: string;
  /** The rules file, as `undo.file`. */
  file: string;
  /** The file's text before the keep ('' when the keep wrote the first). */
  before: string;
  /** The hash of the file as the keep left it. */
  after: string;
  rules: string[];
  /** The payments the keep booked at once (at most KEEP_BOOK_MAX of those its rules decide). */
  book: string[];
  /** The entries the keep wrote: the undo takes back only these. */
  entries: string[];
  /** The entries by the kept rules that were in the books before the keep (a changed rule's): no sign of a booking since. */
  prior: string[];
  /** The payments the kept rules decide that wait for their receipt. */
  waits: string[];
  /** Payments decided but not started at the keep (more than the keep starts). */
  later: number;
  /** The tasks the keep closed (the payment and its workflow): the undo starts exactly these again. */
  tasks: Array<{ ref: string; workflow: string }>;
  /** A payment's wait for the person (a booking she deleted) as it was before the keep, by ref: the undo puts it back. */
  marks: Record<string, NonNullable<BankTransaction['waitsForPerson']>>;
  /** The keep is still booking its payments: its undo waits. */
  booking?: boolean;
  /** The person closed its result line. */
  closed?: boolean;
}

const dirOf = (ws: Pick<Workspace, 'paths'>): string => join(runsDir(ws), 'keeps');

/** The shape of a keep's id (newKeepId): anything else is no keep's and never names a file. */
export const KEEP_ID = /^[a-z0-9]{6,12}-\d{3}-[0-9a-f]{6}$/;

let seq = 0;
/** A new keep's id, in the order keeps are made. */
export function newKeepId(): string {
  seq = (seq + 1) % 1000;
  return `${Date.now().toString(36)}-${String(seq).padStart(3, '0')}-${randomBytes(3).toString('hex')}`;
}

export function saveKeep(ws: Pick<Workspace, 'paths'>, k: KeepRecord): void {
  const dir = dirOf(ws);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${k.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(k, null, 2));
  renameSync(`${path}.tmp`, path);
}

const parse = (path: string): KeepRecord | undefined => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as KeepRecord; } catch { return undefined; }
};

/** The record, or undefined when there is none or it cannot be read. */
export function loadKeep(ws: Pick<Workspace, 'paths'>, id: string): KeepRecord | undefined {
  if (!KEEP_ID.test(id)) return undefined;
  const path = join(dirOf(ws), `${id}.json`);
  return existsSync(path) ? parse(path) : undefined;
}

/** One change of a record, read and written at once; undefined when the record is gone. */
export function updateKeep(ws: Pick<Workspace, 'paths'>, id: string, change: (k: KeepRecord) => void): KeepRecord | undefined {
  const k = loadKeep(ws, id);
  if (!k) return undefined;
  change(k);
  saveKeep(ws, k);
  return k;
}

export function forgetKeep(ws: Pick<Workspace, 'paths'>, id: string): void {
  if (KEEP_ID.test(id)) rmSync(join(dirOf(ws), `${id}.json`), { force: true });
}

/** Every recorded keep, oldest first; a record that cannot be read is left out. */
export function listKeeps(ws: Pick<Workspace, 'paths'>): KeepRecord[] {
  const dir = dirOf(ws);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => { const k = parse(join(dir, f)); return k ? [k] : []; })
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** The keeps of the same file made after this one: its undo waits until they are taken back. */
export const laterOf = (all: readonly KeepRecord[], k: KeepRecord): KeepRecord[] =>
  all.filter((x) => x.id !== k.id && x.file === k.file && (x.at > k.at || (x.at === k.at && x.id > k.id)));
