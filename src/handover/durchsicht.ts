/**
 * «Durchsicht»: the recipient's side of a hand-over (docs/specs/e2e-and-fiduciary.md B4). Opening a
 * `full` package makes a copy of the books as a workspace of its own (like a demo copy: it never
 * mixes with books the recipient keeps himself); an `update` moves that copy forward and keeps what
 * he changed. The copy remembers what it got in data/durchsicht/: the index (marker.json) and the
 * books' own files as they came (base/), against which his changes are the change set of his
 * return (B5.1). Filed quarters stay sealed: the seals come along and the write door holds them.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadBooks, saveBooks, update, periodLock, type Actor } from '../books/store.js';
import { findFile, workspaceAt, type Workspace } from '../workspace/workspace.js';
import { appVersion } from '../version.js';
import { carriageOf, checksumOf, contentFiles, factOf, sha256, type FileFact } from './content.js';
import { PACKAGE_FORMAT, PackageError, packageName, readPackage, writePackage, type PackageContents, type PackageIndex, type Question, type ReturnChange } from './package.js';
import { applyToBooks, dateOf, diffRecords, recordsInFolder, refKey, type RecordChange } from './records.js';
import type { Party } from './versions.js';

/** Where the copies live: one folder per firm. A test run keeps its own; the Mac app names its folder (setDurchsichtHome). */
let home: string | undefined;
export const durchsichtHome = (): string => home ?? process.env.VANILLA_DURCHSICHT_DIR
  ?? (process.env.NODE_TEST_CONTEXT ? join(tmpdir(), `vanilla-durchsicht-${process.pid}`) : join(homedir(), '.vanilla-accounting', 'durchsicht'));
export const setDurchsichtHome = (dir: string): void => { home = dir; };

/** What a copy knows of its hand-over. */
export interface Marker {
  format: 1;
  firm: PackageIndex['firm'];
  /** The sharer: the one the return goes to, who files. */
  sharer: Party;
  /** The recipient: the person working on the copy. */
  me: Party & { role: 'fiduciary' };
  version: PackageIndex['version'];
  /** When the copy got this version. */
  receivedAt: string;
  /** Every file of the version: carried, held from before, or omitted (closed years at the sharer's). */
  files: FileFact[];
  omitted: FileFact[];
  message?: string;
  questions?: Question[];
  /** Records the sharer changed too while he had them changed, after the last update: his version stays, the row says so. */
  conflicts?: string[];
  /** Records he changed in a period the sharer filed meanwhile: they could not stay, the row says so. */
  dropped?: string[];
  /** The version's git commit, when the package carried its objects (data/durchsicht/git.json). */
  commit?: string;
  /** When he last sent a return, and on which version. */
  sent?: { at: string; version: number; changes: number };
}

const dirOf = (root: string) => join(root, 'data', 'durchsicht');
const markerFile = (root: string) => join(dirOf(root), 'marker.json');
const baseDir = (root: string) => join(dirOf(root), 'base');
const notesFile = (root: string) => join(dirOf(root), 'notes.json');

export function markerOf(root: string): Marker | undefined {
  const f = markerFile(root);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Marker) : undefined;
}
const writeMarker = (root: string, m: Marker) => { mkdirSync(dirOf(root), { recursive: true }); writeFileSync(markerFile(root), JSON.stringify(m, null, 2) + '\n'); };

/** Whether the books in `root` are a Durchsicht copy. */
export const isDurchsicht = (root: string): boolean => existsSync(markerFile(root));

/** The person working on a copy, as the write door knows him: a person, with his name and role (never written into the books). */
export const recipientActor = (m: Pick<Marker, 'me'>): Actor => ({ kind: 'person', name: m.me.name, ...(m.me.email ? { email: m.me.email } : {}), role: 'fiduciary' });

const slug = (index: Pick<PackageIndex, 'firm'>) => (index.firm.uid?.replace(/\D/g, '') || index.firm.name.toLowerCase().replace(/[^a-z0-9äöü]+/g, '-').replace(/^-|-$/g, '') || 'buchhaltung');

function writeFiles(root: string, files: Map<string, Uint8Array>, paths: (path: string) => boolean = () => true): void {
  for (const [path, data] of files) {
    if (!paths(path)) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  }
}

/** The base: the books' own files as the version brought them (every file that travels whole). */
function writeBase(root: string, files: Map<string, Uint8Array>): void {
  rmSync(baseDir(root), { recursive: true, force: true });
  writeFiles(baseDir(root), files, (p) => carriageOf(p) === 'whole');
}

function markerFrom(index: PackageIndex, now: Date): Marker {
  return {
    format: 1, firm: index.firm, sharer: index.from, me: { ...index.to, role: 'fiduciary' }, version: index.version, receivedAt: now.toISOString(),
    files: [...index.files, ...(index.held ?? [])], omitted: index.omitted ?? [],
    ...(index.message ? { message: index.message } : {}),
    ...(index.questions?.length ? { questions: index.questions } : {}),
    ...(index.git ? { commit: index.git.commit } : {}),
  };
}

export interface Opened { root: string; kind: 'full' | 'update'; marker: Marker; conflicts: number; dropped: number }

/**
 * Opens a `full` or `update` package as a copy (B4). A `full` package on a firm the recipient has no
 * copy of makes a new one; on an existing copy, like an `update`, it moves the copy forward and keeps
 * his changes. An update on a version his copy lacks is refused (shareBaseMissing), changing nothing.
 */
export function openPackage(bytes: Uint8Array, now = new Date(), at: string = durchsichtHome()): Opened {
  const p = readPackage(bytes);
  if (p.index.kind === 'return') throw new PackageError('Das ist eine Rücksendung: sie gehört in die Bücher, aus denen geteilt wurde.', 'shareWrongKind');
  const root = join(at, slug(p.index));
  const had = markerOf(root);
  if (had && had.firm.uid && p.index.firm.uid && had.firm.uid !== p.index.firm.uid) throw new PackageError(`Diese Übergabe ist von ${p.index.firm.name}, die Kopie hier von ${had.firm.name}.`, 'shareOtherCompany', { firm: p.index.firm.name });
  if (!had) {
    if (p.index.kind === 'update') throw new PackageError(`Diese Übergabe baut auf Version ${p.index.base?.n} auf, die auf diesem Computer fehlt. Bitte ${p.index.from.name} um eine vollständige Übergabe.`, 'shareBaseMissing', { version: String(p.index.base?.n ?? ''), name: p.index.from.name });
    rmSync(root, { recursive: true, force: true });
    writeFiles(root, p.files);
    // The copy proves the version: its files plus the omitted ones make the version's checksum (B3.5, B7).
    const got = checksumOf([...contentFiles(root).map((f) => factOf(root, f.path)), ...(p.index.omitted ?? [])]);
    if (got !== p.index.version.checksum) { rmSync(root, { recursive: true, force: true }); throw new PackageError('Die Übergabe ergibt nicht die Prüfsumme ihrer Version.', 'shareTampered', { path: 'checksum' }); }
    writeBase(root, p.files);
    keepGit(root, p.index);
    const marker = markerFrom(p.index, now);
    writeMarker(root, marker);
    return { root, kind: 'full', marker, conflicts: 0, dropped: 0 };
  }
  return moveForward(root, had, p, now);
}

function keepGit(root: string, index: PackageIndex): void {
  if (index.git) writeFileSync(join(dirOf(root), 'git.json'), JSON.stringify(index.git) + '\n');
}

/**
 * Moves an existing copy to the package's version: the books' files and new receipts as they came,
 * then his own changes again on top. A record the sharer changed too keeps his version (a conflict
 * his return shows); a change dated in a period filed meanwhile cannot stay (dropped).
 */
function moveForward(root: string, had: Marker, p: PackageContents, now: Date): Opened {
  const index = p.index;
  if (index.kind === 'update') {
    const missing = (index.held ?? []).filter((f) => !existsSync(join(root, f.path)) || sha256(readFileSync(join(root, f.path))) !== f.sha256);
    if (index.base?.n !== had.version.n || missing.length) {
      throw new PackageError(`Diese Übergabe baut auf Version ${index.base?.n} auf, die auf diesem Computer fehlt. Bitte ${index.from.name} um eine vollständige Übergabe.`, 'shareBaseMissing', { version: String(index.base?.n ?? ''), name: index.from.name });
    }
  }
  const oldBase = recordsInFolder(baseDir(root));
  const mine = diffRecords(oldBase, recordsInFolder(root));
  writeFiles(root, p.files);
  // Files of the old version the new one no longer names (the sharer removed them) go; his own new files stay.
  const named = new Set([...index.files, ...(index.held ?? []), ...(index.omitted ?? [])].map((f) => f.path));
  for (const f of had.files) if (!named.has(f.path)) rmSync(join(root, f.path), { force: true });
  writeBase(root, p.files);
  keepGit(root, index);
  const newBase = recordsInFolder(baseDir(root));
  const conflicts: string[] = [];
  const dropped: string[] = [];
  const ws = workspaceAt(root);
  const marker: Marker = { ...markerFrom(index, now), ...(had.sent ? { sent: had.sent } : {}) };
  if (mine.length) {
    const books = loadBooks(ws);
    const lock = periodLock(books);
    const keep = mine.filter((c) => {
      const closed = [dateOf(c, c.before, books), dateOf(c, c.after, books)].some((d) => lock.isClosed(d));
      if (closed) { dropped.push(refKey(c)); return false; }
      const theirsBefore = oldBase.get(refKey(c)), theirsNow = newBase.get(refKey(c));
      if (JSON.stringify(theirsBefore) !== JSON.stringify(theirsNow)) conflicts.push(refKey(c));
      return true;
    });
    update(books, recipientActor(had), (b) => applyToBooks(b, keep.filter((c) => c.kind !== 'file')));
    saveBooks(ws, books);
    for (const c of keep.filter((x) => x.kind === 'file')) {
      if (c.after === undefined) rmSync(join(root, c.key), { force: true });
      else { mkdirSync(dirname(join(root, c.key)), { recursive: true }); writeFileSync(join(root, c.key), String(c.after)); }
    }
  }
  if (conflicts.length) marker.conflicts = conflicts;
  if (dropped.length) marker.dropped = dropped;
  writeMarker(root, marker);
  return { root, kind: index.kind as 'full' | 'update', marker, conflicts: conflicts.length, dropped: dropped.length };
}

// ─── His notes and his return ───────────────────────────────────────────────

/** His «Warum?» per record (refKey): the notes his return carries. Kept beside the copy, never in the books. */
export function readNotes(root: string): Record<string, string> {
  const f = notesFile(root);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>) : {};
}

export function setNote(root: string, key: string, text: string): Record<string, string> {
  const notes = readNotes(root);
  const clean = text.trim().slice(0, 500);
  if (clean) notes[key] = clean; else delete notes[key];
  mkdirSync(dirOf(root), { recursive: true });
  writeFileSync(notesFile(root), JSON.stringify(notes, null, 2) + '\n');
  return notes;
}

/** What he changed since the version he got (B5.1), each with his «Warum?». */
export function changesOf(root: string): ReturnChange[] {
  const notes = readNotes(root);
  return diffRecords(recordsInFolder(baseDir(root)), recordsInFolder(root)).map((c) => {
    const why = notes[refKey(c)] ?? (c.kind === 'journalEntries' ? entryKey(c, notes) : undefined);
    return { ...c, ...(why ? { why } : {}) };
  });
}

/** A note kept on an entry's id (the journal's «Warum?» field) belongs to the entry's record. */
const entryKey = (c: RecordChange, notes: Record<string, string>) => notes[`entry:${c.key}`];

/** The receipt files a return carries: those of receipts he added or changed that the version did not hold as they are. */
function newReceiptFiles(ws: Workspace, marker: Marker, changes: readonly RecordChange[]): Map<string, Uint8Array> {
  const got = new Map(marker.files.map((f) => [f.path, f.sha256]));
  const out = new Map<string, Uint8Array>();
  for (const c of changes) {
    const name = c.kind === 'receipts' ? (c.after as { filename?: string } | undefined)?.filename : undefined;
    const full = name ? findFile(ws.paths, 'receipts', name) : undefined;
    if (!full) continue;
    const path = full.slice(ws.paths.root.length + 1);
    const data = readFileSync(full);
    if (got.get(path) !== sha256(data)) out.set(path, data);
  }
  return out;
}

export interface ReturnPlan { changes: ReturnChange[]; files: FileFact[]; bytes: number }

export function planReturn(ws: Workspace): ReturnPlan {
  const marker = markerOf(ws.paths.root);
  if (!marker) throw new PackageError('Diese Bücher sind keine Durchsicht.', 'shareWrongKind');
  const changes = changesOf(ws.paths.root);
  const files = [...newReceiptFiles(ws, marker, changes)].map(([path, data]) => ({ path, sha256: sha256(data), blob: '', bytes: data.byteLength }));
  return { changes, files, bytes: files.reduce((n, f) => n + f.bytes, 0) + Buffer.byteLength(JSON.stringify(changes)) };
}

/** «An <Name> zurücksenden» (B4): the return package, based on the version he got. */
export function buildReturn(ws: Workspace, message: string | undefined, now = new Date()): { name: string; bytes: Uint8Array; index: PackageIndex } {
  const marker = markerOf(ws.paths.root);
  if (!marker) throw new PackageError('Diese Bücher sind keine Durchsicht.', 'shareWrongKind');
  const changes = changesOf(ws.paths.root);
  const files = newReceiptFiles(ws, marker, changes);
  const facts = [...files].map(([path]) => factOf(ws.paths.root, path));
  const index: PackageIndex = {
    format: PACKAGE_FORMAT, kind: 'return', firm: marker.firm,
    from: { name: marker.me.name, ...(marker.me.email ? { email: marker.me.email } : {}) },
    to: marker.sharer,
    version: marker.version, app: appVersion(), at: now.toISOString(),
    files: facts, changes: changes.length,
    ...(message?.trim() ? { message: message.trim().slice(0, 2000) } : {}),
  };
  writeMarker(ws.paths.root, { ...marker, sent: { at: now.toISOString(), version: marker.version.n, changes: changes.length } });
  return { name: packageName(index), bytes: writePackage({ index, files, changes }), index };
}

