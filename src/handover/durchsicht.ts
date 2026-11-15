/**
 * «Durchsicht»: the recipient's side of a hand-over (docs/specs/e2e-and-fiduciary.md B4). Opening a
 * package makes a copy of the books as a workspace of its own (like a demo copy: it never mixes with
 * books the recipient keeps himself) when there is none, and on an existing copy moves it forward and
 * keeps what he changed. Every package is whole, so a copy that is lost, older or missing a receipt
 * comes right with the next one, never refused for what it lacks. The copy remembers what it got in data/durchsicht/: the index (marker.json) and the
 * books' own files as they came (base/), against which his changes are the change set of his
 * return (B5.1). Filed quarters stay sealed: the seals come along and the write door holds them.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadBooks, saveBooks, update, periodLock, type Actor } from '../books/store.js';
import { findFile, workspacePaths, type Workspace } from '../workspace/workspace.js';
import { readManifest } from '../workspace/manifest.js';
import { filingLengthOf } from '../workspace/vat-setup.js';
import { appVersion } from '../version.js';
import { carriageOf, checksumOf, contentFiles, factOf, inside, sha256, DURCHSICHT_MARKER, type FileFact } from './content.js';
import { PACKAGE_FORMAT, PackageError, packageName, readPackage, writePackage, type PackageContents, type PackageIndex, type Question, type ReturnChange } from './package.js';
import { applyToBooks, dateOf, diffRecords, isRecordFile, recordsInFolder, refKey, type RecordChange } from './records.js';
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
const markerFile = (root: string) => join(root, DURCHSICHT_MARKER);
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

/** The folder a package of this firm opens into: the copy an update moves forward. */
export const copyRootOf = (index: Pick<PackageIndex, 'firm'>, at: string = durchsichtHome()): string => join(at, slug(index));
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

/** Where a package goes when a copy of its firm is here already but came from someone else (shareCopyOther): the person's answer. */
export type CopyChoice = 'new' | 'replace';

export interface OpenOptions {
  /** The link the package came by: a copy that came by this same share moves forward without a question («Aktualisieren»). */
  link?: { service: string; id: string };
  /** The person's answer to shareCopyOther: a new copy beside the one here, or that one moved to this package. */
  copy?: CopyChoice;
  /** A file's package (no link): instead of asking, it opens as a new copy beside one from someone else. */
  otherAsNew?: boolean;
  /** This copy and no other (a copy asking its own share, checkCopy): never a second copy beside it. */
  root?: string;
}

/** The link a copy came by, as src/share/sharing.ts keeps it there (data/durchsicht/link.json). */
const linkOfRoot = (root: string): { service?: string; id?: string } | undefined => {
  const f = join(dirname(markerFile(root)), 'link.json');
  if (!existsSync(f)) return undefined;
  try { return JSON.parse(readFileSync(f, 'utf8')) as { service?: string; id?: string }; } catch { return {}; }
};

/** The same person, as a package names its sender: by address when both have one, else by name. */
const fold = (s: string | undefined) => (s ?? '').normalize('NFC').trim().toLowerCase();
export const sameParty = (a: Party, b: Party): boolean => (a.email && b.email ? fold(a.email) === fold(b.email) : fold(a.name) === fold(b.name));

/** The folders of a firm's copies here: its own name, then `<name>-2`, `<name>-3` (a new copy beside another, shareCopyOther); only copies of that firm. */
function copiesOf(at: string, name: string): string[] {
  if (!existsSync(at)) return [];
  const numbered = (f: string): number | undefined => (f === name ? 1 : f.startsWith(`${name}-`) && /^\d+$/.test(f.slice(name.length + 1)) ? Number(f.slice(name.length + 1)) : undefined);
  return readdirSync(at).filter((f) => numbered(f) !== undefined).sort((a, b) => numbered(a)! - numbered(b)!).map((f) => join(at, f))
    .filter((root) => { recover(root); const m = markerOf(root); return !!m && slug(m) === name; });
}

/** A folder an update left beside a copy (`.next-<pid>`, `.old-<pid>`): never a copy to move. */
const aside = (f: string) => /\.(?:next|old)-\d+$/.test(f);

/** The first folder of the firm's name that is free (nothing there at all: a folder without a marker is never written over). */
function freeRoot(at: string, name: string): string {
  for (let n = 1; ; n++) {
    const root = join(at, n === 1 ? name : `${name}-${n}`);
    if (!existsSync(root) && !existsSync(`${root}.old-${process.pid}`)) return root;
  }
}

type Target = { root: string } | { other: string; had: Marker };

/**
 * Which copy a package moves, or where a new one goes. A copy that came by the same share, or from the
 * same sender with no link of another share, moves; a copy from someone else is never moved without the
 * person's answer (review of #551: a package names any firm and any sender its maker likes).
 */
function targetOf(p: PackageContents, at: string, opts: OpenOptions): Target {
  const name = slug(p.index);
  if (opts.link) {
    // By the share it came from, wherever its folder is (the firm's name may have changed since).
    for (const f of existsSync(at) ? readdirSync(at).filter((x) => !aside(x)) : []) {
      const l = linkOfRoot(join(at, f));
      if (l?.service === opts.link.service && l.id === opts.link.id && markerOf(join(at, f))) return { root: join(at, f) };
    }
  }
  const copies = copiesOf(at, name);
  const same = copies.find((root) => {
    const l = linkOfRoot(root);
    return sameParty(markerOf(root)!.sharer, p.index.from) && (!opts.link || !l || (l.service === opts.link.service && l.id === opts.link.id));
  });
  if (same) return { root: same };
  if (copies.length) return { other: copies[0]!, had: markerOf(copies[0]!)! };
  return { root: freeRoot(at, name) };
}

const copyOther = (had: Marker, index: PackageIndex, otherLink: boolean) => new PackageError(
  `Hier liegt schon eine Kopie von ${had.firm.name}, die von ${had.sharer.name} kam. Diese Übergabe ist laut eigenen Angaben von ${index.from.name}${otherLink ? ' und kam über einen anderen Link' : ''}; wer sie gemacht hat, kann die App nicht prüfen.`,
  'shareCopyOther', { firm: had.firm.name, was: had.sharer.name, now: index.from.name.slice(0, 120), version: String(had.version.n) },
);

/**
 * Opens a hand-over package as a copy (B4): on a firm the recipient has no copy of it makes a new
 * one; on an existing copy of the same share or sender it moves the copy forward and keeps his
 * changes. A copy that came from someone else (another sender, another link) is moved only on the
 * person's answer (`copy`: «Als neue Kopie öffnen» beside it, or «Bestehende Kopie ersetzen»);
 * without one the package is refused (shareCopyOther) and nothing is written. Forward only: a
 * package older than the copy changes nothing (shareCopyNewer), unless the person chose to replace
 * a copy from another sender by it. An `update` (written by 0.6.0 only, which left out what the person was thought to hold)
 * opens where the copy holds every file it names; otherwise it is refused (shareBaseMissing) and
 * the next hand-over, always whole, brings everything.
 */
export function openPackage(bytes: Uint8Array | PackageContents, now = new Date(), at: string = durchsichtHome(), opts: OpenOptions = {}): Opened {
  // A link's files come checked and decrypted already (src/share/transport.ts, checkPackage); a file is read here.
  const p = bytes instanceof Uint8Array ? readPackage(bytes) : bytes;
  if (p.index.kind === 'return') throw new PackageError('Das ist eine Rücksendung: sie gehört in die Bücher, aus denen geteilt wurde.', 'shareWrongKind');
  let root: string;
  let replace = false;
  if (opts.root) root = opts.root;
  else {
    const target = targetOf(p, at, opts);
    if ('root' in target) root = target.root;
    else if (opts.copy === 'replace') { root = target.other; replace = true; }
    else if (opts.copy === 'new' || opts.otherAsNew) root = freeRoot(at, slug(p.index));
    else throw copyOther(target.had, p.index, !!opts.link && !!linkOfRoot(target.other));
  }
  recover(root);
  const had = markerOf(root);
  if (had && had.firm.uid && p.index.firm.uid && had.firm.uid !== p.index.firm.uid) throw new PackageError(`Diese Übergabe ist von ${p.index.firm.name}, die Kopie hier von ${had.firm.name}.`, 'shareOtherCompany', { firm: p.index.firm.name });
  // Versions compare within one sender's books only: a copy the person chose to replace by someone else's has no order to keep.
  if (had && !(replace && !sameParty(had.sharer, p.index.from)) && p.index.version.n < had.version.n) {
    throw new PackageError(`Die Kopie von ${had.firm.name} hier ist neuer als diese Übergabe: sie bleibt, wie sie ist.`, 'shareCopyNewer', { firm: had.firm.name, name: p.index.from.name });
  }
  if (!had) {
    if (p.index.kind === 'update') throw legacyUpdate(p.index);
    // Never over a folder that is not a copy: only into one that is not there (freeRoot), built beside it and moved in whole.
    if (existsSync(root)) throw new PackageError(`Im Ordner ${basename(root)} liegt etwas, das keine Kopie ist; die App schreibt nicht darüber.`, 'shareUpdateFailed', { why: basename(root) });
    const next = `${root}.next-${process.pid}`;
    rmSync(next, { recursive: true, force: true });
    try {
      writeFiles(next, p.files);
      // The copy proves the version: its files plus the omitted ones make the version's checksum (B3.5, B7).
      const got = checksumOf([...contentFiles(next).map((f) => factOf(next, f.path)), ...(p.index.omitted ?? [])]);
      if (got !== p.index.version.checksum) throw new PackageError('Die Übergabe ergibt nicht die Prüfsumme ihrer Version.', 'shareTampered', { path: 'checksum' });
      writeBase(next, p.files);
      keepGit(next, p.index);
      writeMarker(next, markerFrom(p.index, now));
      renameSync(next, root);
    } catch (e) {
      rmSync(next, { recursive: true, force: true });
      throw e;
    }
    return { root, kind: 'full', marker: markerOf(root)!, conflicts: 0, dropped: 0 };
  }
  return moveForward(root, had, p, now);
}

/** A 0.6.0 update whose files the copy lacks: the person reads what happened and what to do, in plain words. */
const legacyUpdate = (index: PackageIndex) => new PackageError(
  `Diese Datei kommt von einer älteren App-Version und enthält nur, was damals neu war; der Rest fehlt auf diesem Computer. Teilt ${index.from.name} die Buchhaltung noch einmal, kommt alles mit.`,
  'shareBaseMissing', { name: index.from.name },
);

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
    if (index.base?.n !== had.version.n || missing.length) throw legacyUpdate(index);
  }
  const oldBase = recordsInFolder(baseDir(root));
  const mine = diffRecords(oldBase, recordsInFolder(root));
  // The new state is built beside the copy and takes its place in one rename: a failure half way leaves the copy as it was.
  const next = `${root}.next-${process.pid}`;
  const old = `${root}.old-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  try {
    cpSync(root, next, { recursive: true });
    const opened = moveForwardIn(next, had, p, now, oldBase, mine);
    renameSync(root, old);
    try { renameSync(next, root); } catch (e) { renameSync(old, root); throw e; }
    rmSync(old, { recursive: true, force: true });
    return { ...opened, root };
  } catch (e) {
    rmSync(next, { recursive: true, force: true });
    if (e instanceof PackageError) throw e;
    throw new PackageError(`Die Übergabe wurde nicht eingespielt (${(e as Error).message.slice(0, 200)}). Die Kopie und deine Änderungen sind, wie sie waren.`, 'shareUpdateFailed', { why: (e as Error).message.slice(0, 200) });
  }
}

/**
 * A copy that a crash left between the two renames of an update: the copy itself was moved aside
 * (`.old-<pid>`) and the new one not yet put in its place (`.next-<pid>`). The copy as it was, his
 * changes in it, comes back; the half-made new one goes. Nothing happens to a copy in its place.
 */
export function recover(root: string): void {
  const dir = dirname(root), name = basename(root);
  if (!existsSync(dir)) return;
  const beside = (kind: 'old' | 'next') => readdirSync(dir).filter((f) => f.startsWith(`${name}.${kind}-`)).map((f) => join(dir, f)).sort();
  if (!existsSync(root)) {
    const old = beside('old').at(-1);
    if (old) renameSync(old, root);
  }
  if (existsSync(root)) for (const f of [...beside('next'), ...beside('old')]) rmSync(f, { recursive: true, force: true });
  // A new copy half made (built beside, never moved in): nothing of the person's is in it.
  else for (const f of beside('next')) rmSync(f, { recursive: true, force: true });
}

/** moveForward's work on the folder `root` (the copy's sibling), with his change set read from the copy before. */
function moveForwardIn(root: string, had: Marker, p: PackageContents, now: Date, oldBase: ReturnType<typeof recordsInFolder>, mine: RecordChange[]): Opened {
  const index = p.index;
  writeFiles(root, p.files);
  // The copy proves the version from its disk: the files as written, the ones held from before, the omitted ones' checksums.
  const listed = [...index.files, ...(index.held ?? [])].map((f) => f.path);
  if (checksumOf([...listed.map((path) => factOf(root, path)), ...(index.omitted ?? [])]) !== index.version.checksum) {
    throw new PackageError('Die Kopie ergibt nach dem Schreiben nicht die Prüfsumme der Version.', 'shareTampered', { path: 'checksum' });
  }
  // Files of the old version the new one no longer names (the sharer removed them) go; his own new files stay.
  // Compared as a case-insensitive file system does: a file renamed only in case is the same file, never removed.
  const fold = (path: string) => path.normalize('NFC').toLowerCase();
  const named = new Set([...index.files, ...(index.held ?? []), ...(index.omitted ?? [])].map((f) => fold(f.path)));
  // Only a content file of the copy itself, never a path that leaves it (review of #535).
  for (const f of had.files) if (!named.has(fold(f.path)) && carriageOf(f.path) && inside(root, f.path)) rmSync(join(root, f.path), { force: true });
  writeBase(root, p.files);
  keepGit(root, index);
  const newBase = recordsInFolder(baseDir(root));
  const conflicts: string[] = [];
  const dropped: string[] = [];
  // The copy's books, read without making them the books the app has open (no switch of the engines).
  const paths = workspacePaths(root);
  const manifest = readManifest(paths.manifest);
  const ws: Workspace = { ...manifest, filingLength: filingLengthOf(manifest.company.vat, 'quarter'), paths };
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
    for (const c of keep.filter((x) => x.kind === 'file' && isRecordFile(x.key) && inside(root, x.key))) {
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
const TRAVELS: ReadonlySet<string> = new Set(['journalEntries', 'transactions', 'mappings', 'receipts', 'file']);

export function changesOf(root: string): ReturnChange[] {
  const notes = readNotes(root);
  // Only what a return may carry: entries, payments, links, receipts, knowledge and the chart (src/handover/returns.ts RETURN_KINDS).
  return diffRecords(recordsInFolder(baseDir(root)), recordsInFolder(root)).filter((c) => TRAVELS.has(c.kind)).map((c) => {
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

