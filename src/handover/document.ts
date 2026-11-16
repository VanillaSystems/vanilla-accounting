/**
 * «The share file is the document» (the owner's decision of 2026-11-15): the Freigabe-Datei
 * (`.vanillashare`) a recipient opened is his copy. The app works on a copy of the books in its own
 * folder (src/handover/durchsicht.ts), but that copy is only a cache: his changes are saved into the
 * file he opened, as one more member (`return.vanillashare`, the return package «Zurückschicken»
 * would send), with every member of the hand-over as it came. Opened anywhere, on another Mac too,
 * the file brings his changes back. Mailed to the sharer, her app knows it by its version and shows
 * the changes for review (src/share/sharing.ts openShareFile).
 *
 * Saving writes beside the file and renames over it, so a crash half way leaves the file as it was.
 * A file that moved, went or cannot be written is said so; «Sichern unter…» writes another one.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { strFromU8 } from 'fflate';
import { canonical } from '../books/seal.js';
import type { Workspace } from '../workspace/workspace.js';
import { DURCHSICHT_MARKER } from './content.js';
import { applyChanges, changesOf, markerOf, returnPackage, type Marker } from './durchsicht.js';
import { isReturnFile, isShareFileName, PACKAGE_EXT, PackageError, readPackage, SAVED_MEMBER, type PackageIndex, type ReturnChange } from './package.js';
import { refKey } from './records.js';
import { readZipMember, rewriteZip } from './zip-file.js';

/** The file as the app last wrote or opened it: a file at that path that differs was put there by someone else. */
interface FileStamp { size: number; mtimeMs: number; ino: number }

/** What a copy keeps of its Freigabe-Datei: where it is, and what of his changes it holds (a hash of them). */
interface DocumentFacts {
  path: string; saved: string; savedAt?: string;
  /** The person saved into this file herself once: from then on the app saves by itself too (idle, closing). Before, macOS may ask for the file's folder, which the app does only when she asked (#373). */
  confirmed?: boolean;
  /** The file as the app last wrote or opened it, and the version's checksum it holds (a copy moved forward meanwhile holds a newer one). */
  file?: FileStamp;
  version?: string;
  /** A save found another file at the path (another state, another share): the app writes nothing there by itself; «Sichern unter…». */
  other?: boolean;
}

const factsFile = (root: string) => join(root, dirname(DURCHSICHT_MARKER), 'document.json');
/** The hand-over as it came in its file, kept beside the copy: what every save writes again, also when the file itself is gone («Sichern unter…»). */
const originalFile = (root: string) => join(root, dirname(DURCHSICHT_MARKER), 'handover.vanillashare');

export function documentOf(root: string): DocumentFacts | undefined {
  const f = factsFile(root);
  if (!existsSync(f)) return undefined;
  try { return JSON.parse(readFileSync(f, 'utf8')) as DocumentFacts; } catch { return undefined; }
}

function keepFacts(root: string, facts: DocumentFacts): void {
  mkdirSync(dirname(factsFile(root)), { recursive: true });
  writeFileSync(factsFile(root), JSON.stringify(facts, null, 2) + '\n', { mode: 0o600 });
}

const stampOf = (path: string): FileStamp | undefined => {
  try { const st = statSync(path); return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }; } catch { return undefined; }
};
const sameStamp = (a: FileStamp | undefined, b: FileStamp | undefined) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

/** His changes as one hash: the records he changed with their new content and his «Warum?», and the receipt files. Two saves of the same changes are the same. */
export function changesHash(changes: readonly ReturnChange[], files: ReadonlyMap<string, Uint8Array>): string {
  const c = changes.map((x) => [refKey(x), x.after ?? null, x.why ?? null] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const f = [...files].map(([path, data]) => [path, createHash('sha256').update(data).digest('hex')] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return createHash('sha256').update(canonical({ c, f })).digest('hex');
}

const NOTHING = changesHash([], new Map());

/** The hash of the changes a saved member holds (none: the empty hash). */
export function savedHash(saved: Uint8Array | undefined): string {
  if (!saved) return NOTHING;
  const p = readPackage(saved);
  return changesHash(p.changes ?? [], p.files);
}

export interface DocumentState {
  /** The file and its name, as the window's title shows it. */
  path: string;
  name: string;
  /** His changes are not all in the file yet, or the file holds an older state than the copy. */
  dirty: boolean;
  savedAt?: string;
  /** The file is no longer where it was: «Sichern unter…». */
  missing: boolean;
  /** The app saves by itself (idle, closing): she saved into this file once herself. */
  auto: boolean;
  /** Another file lies at the path now (another state, another share): written over by nobody; «Sichern unter…». */
  other?: boolean;
}

/** The copy's Freigabe-Datei and whether his changes are in it. None for a copy that came without a file (opened in the browser, say). */
export function documentState(ws: Workspace): DocumentState | undefined {
  const facts = documentOf(ws.paths.root);
  if (!facts) return undefined;
  const made = returnPackage(ws, undefined);
  const marker = markerOf(ws.paths.root);
  const behind = !!facts.version && !!marker && facts.version !== marker.version.checksum;
  return {
    path: facts.path, name: basename(facts.path), dirty: behind || changesHash(made.changes, made.files) !== facts.saved,
    ...(facts.savedAt ? { savedAt: facts.savedAt } : {}), missing: !existsSync(facts.path), auto: !!facts.confirmed,
    ...(facts.other ? { other: true } : {}),
  };
}

/** A save that broke off (the app ended half way) leaves `.<name>.saving-<pid>` beside the file: gone the next time the file is opened or saved. */
function dropStaleSaves(path: string): void {
  const dir = dirname(path), mine = `.${basename(path)}.saving-${process.pid}`, prefix = `.${basename(path)}.saving-`;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const f of names) if (f.startsWith(prefix) && f !== mine) rmSync(join(dir, f), { force: true });
}

/**
 * Makes `path` the copy's Freigabe-Datei; `bytes` are the file as it was opened (kept beside the
 * copy, for every later save), `version` the checksum of the state it holds. Its saved changes (if
 * any) count as saved, so the copy is «ungespeichert» exactly when its changes differ from those.
 */
export function attachDocument(root: string, path: string, bytes: Uint8Array, saved: Uint8Array | undefined, version: string, now = new Date()): void {
  mkdirSync(dirname(originalFile(root)), { recursive: true });
  writeAtomically(originalFile(root), bytes);
  dropStaleSaves(path);
  const had = documentOf(root);
  const stamp = stampOf(path);
  keepFacts(root, {
    path, saved: savedHash(saved), savedAt: now.toISOString(), ...(had?.path === path && had.confirmed ? { confirmed: true } : {}),
    ...(stamp ? { file: stamp } : {}), version,
  });
}

/**
 * The copy moved forward by a hand-over that came without its file (a drop in the browser, its
 * share's newer state, checkCopy): the hand-over kept beside the copy becomes that one, so «Sichern»
 * and «Sichern unter…» write the copy's state. His file still holds the older state until he saves
 * (documentState `dirty`).
 */
export function keepHandOver(root: string, bytes: Uint8Array): void {
  if (!documentOf(root)) return;
  writeAtomically(originalFile(root), bytes);
}

/**
 * Brings the changes a Freigabe-Datei holds into the copy it opened as: the receipt files they need,
 * then the records through the write door, as him. A change dated in a period filed meanwhile cannot
 * stay (`dropped`, said by the caller). Changes of another version than the copy's are not applied
 * (`stale`): the file was saved on an older state, and the copy holds its own. A record he changed in
 * the copy since (a newer change not yet saved, say) keeps the copy's version (`kept`): an older file
 * never takes back what he did after saving it (review of PR #559).
 */
export function restoreSaved(root: string, saved: Uint8Array): { applied: number; dropped: number; stale: boolean; kept?: number } {
  const marker = markerOf(root);
  if (!marker) throw new PackageError('Diese Bücher sind keine Durchsicht.', 'shareWrongKind');
  const p = readPackage(saved);
  if (p.index.kind !== 'return') throw new PackageError(`Die Datei enthält unter ${'return.vanillashare'} keine Rücksendung.`, 'shareTampered', { path: 'return.vanillashare' });
  if (p.index.version.checksum !== marker.version.checksum) return { applied: 0, dropped: 0, stale: true };
  const mine = new Set(changesOf(root).map(refKey));
  const all = (p.changes ?? []).filter((c) => ['journalEntries', 'transactions', 'mappings', 'receipts', 'file'].includes(c.kind));
  const changes = all.filter((c) => !mine.has(refKey(c)));
  const kept = all.length - changes.length;
  for (const [path, data] of p.files) {
    if (!isReturnFile(path)) continue;
    // A receipt file of his own in the copy stays as it is when he changed its receipt since.
    if (existsSync(join(root, path)) && kept) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), data);
  }
  const { dropped } = applyChanges(root, marker, changes);
  // His «Warum?» comes back with the change it belongs to.
  const notes = Object.fromEntries(changes.filter((c) => c.why).map((c) => [refKey(c), c.why!]));
  if (Object.keys(notes).length) {
    const f = join(root, dirname(DURCHSICHT_MARKER), 'notes.json');
    const had = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>) : {};
    writeFileSync(f, JSON.stringify({ ...had, ...notes }, null, 2) + '\n');
  }
  return { applied: changes.length - dropped.length, dropped: dropped.length, stale: false, ...(kept ? { kept } : {}) };
}

/** Why a save did not go: the file is gone or moved (`shareDocMissing`), cannot be written (`shareDocReadOnly`), or holds another state now (`shareDocOther`). */
const refusal = (code: 'shareDocMissing' | 'shareDocReadOnly' | 'shareDocOther', path: string, why: string) =>
  new PackageError(why, code, { file: basename(path) });

/**
 * Writes `bytes` to `path` so that the file there is either the old one or the new one, never half:
 * written beside it, flushed to the disk, then renamed over it. `afterWrite` is the tests' seam for a
 * crash between the write and the rename.
 */
export function writeAtomically(path: string, bytes: Uint8Array, afterWrite?: (temp: string) => void): void {
  const temp = join(dirname(path), `.${basename(path)}.saving-${process.pid}`);
  const fd = openSync(temp, 'w', 0o644);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    afterWrite?.(temp);
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/** One version of the books: its number and its checksum (two versions may hold the same books). */
const sameVersion = (a: { n?: number; checksum?: string } | undefined, b: { n: number; checksum: string }) => a?.n === b.n && a.checksum === b.checksum;

/** The hand-over's index as a file holds it; none when it is no Freigabe-Datei. */
async function indexIn(path: string): Promise<PackageIndex | undefined> {
  try {
    const raw = await readZipMember(path, 'index.json');
    return raw ? (JSON.parse(strFromU8(raw)) as PackageIndex) : undefined;
  } catch { return undefined; }
}

/** The hand-over kept beside the copy, checked to be the copy's state: never a file of an older state with his newer changes in it. */
async function handOverOf(root: string, marker: Marker, path: string | undefined): Promise<{ source: string; index: PackageIndex }> {
  const source = existsSync(originalFile(root)) ? originalFile(root) : path;
  if (!source || !existsSync(source)) throw refusal('shareDocMissing', path ?? 'buchhaltung.vanillashare', 'Die Übergabe dieser Kopie ist nicht mehr da: öffne die Freigabe-Datei nochmals.');
  const index = await indexIn(source);
  if (!index || index.kind === 'return' || !sameVersion(index.version, marker.version)) {
    throw refusal('shareDocOther', path ?? source, `Die Übergabe dieser Kopie ist nicht auf ihrem Stand (Version ${marker.version.n}): öffne die neueste Freigabe-Datei nochmals.`);
  }
  return { source, index };
}

/**
 * The file at the document's path may be written over: it is the file the app last wrote or opened
 * there, untouched since; or a hand-over of the copy's state and share (synced back, say). Anything
 * else (a newer state put there, another share's file, something else) stays as it is (review of
 * PR #559): `other` is kept, the app writes there by itself no more, and the person is told.
 */
async function mayWriteOver(root: string, target: string, facts: DocumentFacts, marker: Marker, own: PackageIndex): Promise<void> {
  if (!existsSync(target) || sameStamp(stampOf(target), facts.file)) return;
  const there = await indexIn(target);
  const sameShare = (a: PackageIndex['share'], b: PackageIndex['share']) => (!a && !b) || (!!a && !!b && a.service === b.service && a.id === b.id);
  if (there && there.kind !== 'return' && sameVersion(there.version, marker.version) && sameShare(there.share, own.share)) return;
  keepFacts(root, { ...facts, other: true });
  throw refusal('shareDocOther', target, `${basename(target)} hält jetzt einen anderen Stand als diese Kopie (eine andere oder neuere Freigabe-Datei): die App schreibt nicht darüber. «Sichern unter…» legt eine neue Datei an.`);
}

/** The Freigabe-Datei of the copy's state with his changes, written into `out` chunk by chunk: the hand-over's members as they are, his changes as `return.vanillashare`. */
const writeDocument = (source: string, saved: Uint8Array | undefined, out: (chunk: Uint8Array) => Promise<void>) =>
  rewriteZip(source, out, { drop: (name) => name === SAVED_MEMBER, add: saved ? [{ name: SAVED_MEMBER, data: saved }] : [] });

/** One save of a copy at a time: an idle save and ⌘S never write the same file together. */
const saving = new Map<string, Promise<unknown>>();

export interface SaveOptions { to?: string; now?: Date; afterWrite?: (temp: string) => void; auto?: boolean }

/**
 * «Sichern» (⌘S, and by itself when the app is idle or closes): his changes into his Freigabe-Datei,
 * the hand-over's members as they came. `to`: «Sichern unter…», a new file that becomes the copy's.
 * Nothing changed since the last save: nothing is written. Asynchronous and in chunks: a large copy
 * saves without holding the app.
 */
export function saveDocument(ws: Workspace, opts: SaveOptions = {}): Promise<DocumentState> {
  const key = ws.paths.root;
  const next = (saving.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => saveNow(ws, opts));
  saving.set(key, next.catch(() => undefined));
  return next;
}

async function saveNow(ws: Workspace, opts: SaveOptions): Promise<DocumentState> {
  const root = ws.paths.root;
  const facts = documentOf(root);
  // By itself only into a file she saved into before (documentState `auto`), and never over another file found there: until then the copy keeps his changes, the file waits for her.
  if (opts.auto && (!facts?.confirmed || facts.other || opts.to)) return documentState(ws) ?? { path: '', name: '', dirty: false, missing: true, auto: false };
  const marker = markerOf(root);
  if (!marker) throw new PackageError('Diese Bücher sind keine Durchsicht.', 'shareWrongKind');
  const from = facts?.path;
  const to = opts.to ?? from;
  if (!to) throw refusal('shareDocMissing', 'buchhaltung.vanillashare', 'Diese Kopie hat keine Freigabe-Datei: «Sichern unter…» legt eine an.');
  const target = isShareFileName(to) ? to : `${to}${PACKAGE_EXT}`;
  const made = returnPackage(ws, undefined, opts.now);
  const hash = changesHash(made.changes, made.files);
  const current = !facts?.version || facts.version === marker.version.checksum;
  if (!opts.to && facts && facts.saved === hash && current && !facts.other && existsSync(target)) return documentState(ws)!;
  // A file that moved or went is not written anew in its old place by itself: the person chooses where («Sichern unter…»).
  if (!opts.to && (!from || !existsSync(from))) throw refusal('shareDocMissing', from ?? target, `Die Freigabe-Datei ${basename(from ?? target)} ist nicht mehr da, wo sie war: «Sichern unter…» legt sie neu an.`);
  const { source, index } = await handOverOf(root, marker, from);
  if (!opts.to) {
    if (facts?.other) throw refusal('shareDocOther', target, `${basename(target)} hält einen anderen Stand als diese Kopie: «Sichern unter…» legt eine neue Datei an.`);
    await mayWriteOver(root, target, facts!, marker, index);
  }
  const saved = made.changes.length || made.files.size ? made.bytes : undefined;
  try {
    if (existsSync(target) && !opts.to && (statSync(target).mode & 0o200) === 0) throw Object.assign(new Error('read-only'), { code: 'EACCES' });
    dropStaleSaves(target);
    const temp = join(dirname(target), `.${basename(target)}.saving-${process.pid}`);
    const fh = await openFile(temp, 'w', 0o644);
    try {
      try {
        await writeDocument(source, saved, async (chunk) => { await fh.write(chunk); });
        await fh.sync();
      } finally { await fh.close(); }
      opts.afterWrite?.(temp);
      renameSync(temp, target);
    } catch (e) {
      rmSync(temp, { force: true });
      throw e;
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw refusal('shareDocReadOnly', target, `${basename(target)} lässt sich nicht schreiben (schreibgeschützt): «Sichern unter…» legt eine Kopie an.`);
    if (code === 'ENOENT') throw refusal('shareDocMissing', target, `Der Ordner von ${basename(target)} ist nicht mehr da: «Sichern unter…».`);
    throw e;
  }
  const now = (opts.now ?? new Date()).toISOString();
  const stamp = stampOf(target);
  keepFacts(root, { path: target, saved: hash, savedAt: now, confirmed: true, ...(stamp ? { file: stamp } : {}), version: marker.version.checksum });
  return { path: target, name: basename(target), dirty: false, savedAt: now, missing: false, auto: true };
}

/** The Freigabe-Datei as «Sichern» would write it, for the browser's «Sichern unter…» (a download): the hand-over of the copy's state, his changes in it. */
export async function documentBytes(ws: Workspace, now = new Date()): Promise<{ name: string; bytes: Uint8Array }> {
  const root = ws.paths.root;
  const marker = markerOf(root);
  if (!marker) throw refusal('shareDocMissing', 'buchhaltung.vanillashare', 'Diese Kopie hat keine Freigabe-Datei mehr: öffne sie nochmals.');
  const { source } = await handOverOf(root, marker, documentOf(root)?.path);
  const made = returnPackage(ws, undefined, now);
  const parts: Uint8Array[] = [];
  await writeDocument(source, made.changes.length || made.files.size ? made.bytes : undefined, async (chunk) => { parts.push(Buffer.from(chunk)); });
  const name = documentOf(root)?.path ? basename(documentOf(root)!.path) : `${marker.firm.name.replace(/[/\\:*?"<>|]/g, '-')} – Buchhaltung (${marker.version.at.slice(0, 10)})${PACKAGE_EXT}`;
  return { name, bytes: Buffer.concat(parts) };
}

/**
 * The file the Mac app opened, as its path (header X-Vanilla-File): it becomes the copy's document
 * only when it is a Freigabe-Datei on this computer holding exactly the bytes sent.
 */
export function fileOf(header: string | undefined, bytes: Uint8Array): string | undefined {
  if (!header) return undefined;
  let path: string;
  try { path = decodeURIComponent(header); } catch { return undefined; }
  if (!isAbsolute(path) || !isShareFileName(path) || !existsSync(path)) return undefined;
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  try { return sha(readFileSync(path)) === sha(bytes) ? path : undefined; } catch { return undefined; }
}

