/**
 * The hand-over package (docs/specs/e2e-and-fiduciary.md B3.4, B3.7): an index and the files, each
 * a member of its own, so that the coming encryption wraps each file on its own and a viewer can
 * load a receipt when it is opened. On disk it is a `.vanilla` file: one zip holding `index.json`,
 * `files/<path>` for every file carried and, for a return, `changes.json`. The index names the firm,
 * the people, the version, the base, the kind and the SHA-256 of every file; reading a package
 * checks each file against it.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Party } from './versions.js';
import { carriageOf, checksumOf, sha256, type FileFact } from './content.js';
import type { RecordChange } from './records.js';

export const PACKAGE_FORMAT = 1;
export const PACKAGE_EXT = '.vanilla';

export type PackageKind = 'full' | 'update' | 'return';
export type Role = 'fiduciary';

export interface VersionRef { n: number; at: string; checksum: string }

/** A question the sharer sent back on a row of a return («Frage zurück»): it goes with the next hand-over. */
export interface Question { key: string; text: string; at: string; label?: string }

export interface PackageIndex {
  format: typeof PACKAGE_FORMAT;
  kind: PackageKind;
  firm: { name: string; uid?: string };
  /** Who made the package: the sharer, or for a return the recipient. */
  from: Party;
  /** Who it is for, with the role the copy opens in. */
  to: Party & { role?: Role };
  /** The version the package holds (full, update) or the one a return was made on. */
  version: VersionRef;
  /** An update's base: the version the recipient holds already. */
  base?: VersionRef;
  app: string;
  /** ISO time the package was made. */
  at: string;
  /** The files carried, each a member `files/<path>`. */
  files: FileFact[];
  /** Files of the version the recipient holds already (an update): not carried, checked on his copy. */
  held?: FileFact[];
  /** Files left out on purpose (a full package without a closed year's archive, B3.5): never carried, counted in the checksum. */
  omitted?: FileFact[];
  /** The version's git commit and tree objects (base64 by id), when the books were committed as they are: the recipient can rebuild the commit. */
  git?: { commit: string; objects: Record<string, string> };
  /** The sharer's short message, or the recipient's on a return. */
  message?: string;
  /** «Frage zurück» of earlier returns, for the recipient. */
  questions?: Question[];
  /** A return: how many records it changes. */
  changes?: number;
}

/** One record of a return's change set (B5.1): its kind and key, before and after, his «Warum?». */
export interface ReturnChange extends RecordChange { why?: string }

export interface PackageContents {
  index: PackageIndex;
  /** By path relative to the app's folder. */
  files: Map<string, Uint8Array>;
  /** A return's change set. */
  changes?: ReturnChange[];
}

export type PackageRefusal = 'shareTampered' | 'shareOtherCompany' | 'shareBaseMissing' | 'shareNotPackage' | 'shareWrongKind' | 'shareTooLarge' | 'shareUnknownBase';

export class PackageError extends Error {
  constructor(message: string, readonly code: PackageRefusal, readonly params: Record<string, string> = {}) { super(message); }
}

/**
 * A package comes from another person: everything in it is untrusted (review of PR #535). A path
 * is relative, of plain segments, in NFC, without a backslash, a control character or a segment
 * that leaves its folder; a file a full or update package carries lies where the books' content
 * lies (src/handover/content.ts carriageOf); a return carries only receipts, each in a year's
 * receipts/ under a plain name.
 */
export function safePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 400 || p !== p.normalize('NFC')) return false;
  if (/[\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufeff]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !s.startsWith('.') && s.trim() === s);
}

/** A receipt's file of a return: transactional-data/<year>/receipts/<plain name>. */
export const RETURN_FILE = /^transactional-data\/\d{4}\/receipts\/[^/]+$/;
export const isReturnFile = (p: string): boolean => safePath(p) && RETURN_FILE.test(p);

/** Limits a package must keep: told to the person when hit (shareTooLarge). */
export const LIMITS = { files: 20000, fileBytes: 300 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024, jsonBytes: 64 * 1024 * 1024 };
const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** The `.vanilla` file's bytes. Receipts are already compressed: every member is stored, the JSON deflated. */
export function writePackage(p: PackageContents): Uint8Array {
  const zip: Zippable = { 'index.json': [strToU8(JSON.stringify(p.index, null, 1)), { level: 6 }] };
  if (p.changes) zip['changes.json'] = [strToU8(JSON.stringify(p.changes)), { level: 6 }];
  for (const [path, data] of p.files) zip[`files/${path}`] = [data, { level: path.endsWith('.jsonl') || path.endsWith('.json') ? 6 : 0 }];
  return zipSync(zip);
}

const notPackage = (why: string) => new PackageError(`Keine Übergabe-Datei (.vanilla): ${why}.`, 'shareNotPackage', {});
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isFact = (x: unknown): x is FileFact => isObj(x) && typeof x.path === 'string' && typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256) && typeof x.bytes === 'number';
const isParty = (x: unknown) => isObj(x) && typeof x.name === 'string' && !!x.name.trim() && (x.email === undefined || typeof x.email === 'string');
const isVersion = (x: unknown) => isObj(x) && Number.isInteger(x.n) && (x.n as number) > 0 && typeof x.at === 'string' && typeof x.checksum === 'string';

/** The index as it must be, or shareNotPackage. */
function checkedIndex(raw: unknown): PackageIndex {
  if (!isObj(raw)) throw notPackage('ihr Verzeichnis ist kein Objekt');
  if (raw.format !== PACKAGE_FORMAT) throw new PackageError(`Übergabe im Format ${String(raw.format)}: diese App liest Format ${PACKAGE_FORMAT}.`, 'shareNotPackage', {});
  if (!['full', 'update', 'return'].includes(raw.kind as string)) throw notPackage('unbekannte Art');
  if (!isObj(raw.firm) || typeof raw.firm.name !== 'string' || (raw.firm.uid !== undefined && typeof raw.firm.uid !== 'string')) throw notPackage('die Firma fehlt');
  if (!isParty(raw.from) || !isParty(raw.to) || !isVersion(raw.version) || (raw.base !== undefined && !isVersion(raw.base))) throw notPackage('Personen oder Version fehlen');
  for (const k of ['files', 'held', 'omitted'] as const) {
    if (raw[k] !== undefined && !(Array.isArray(raw[k]) && (raw[k] as unknown[]).every(isFact))) throw notPackage(`${k} ist keine Liste von Dateien`);
  }
  if (!Array.isArray(raw.files)) throw notPackage('die Liste der Dateien fehlt');
  if (raw.kind !== 'update' && (raw.held as unknown[] | undefined)?.length) throw new PackageError('Eine vollständige Übergabe oder Rücksendung nennt keine Dateien, die schon da sein sollen.', 'shareTampered', { path: 'held' });
  if (raw.kind === 'update' && !raw.base) throw notPackage('der Übergabe fehlt ihre Basis');
  return raw as unknown as PackageIndex;
}

/**
 * Reads a `.vanilla` file and checks it whole before anything is written: the index's shape, every
 * path (safePath; where its kind may put a file), the sizes (LIMITS), every file against its
 * SHA-256, and for a hand-over that the files make the version's checksum. A file missing, extra or
 * changed is refused (shareTampered); a damaged file is shareNotPackage, a too large one shareTooLarge.
 */
export function readPackage(bytes: Uint8Array): PackageContents {
  let members: Record<string, Uint8Array>;
  let count = 0, total = 0;
  let tooLarge: PackageError | undefined;
  try {
    members = unzipSync(bytes, {
      filter: (f) => {
        count++; total += f.originalSize;
        const json = f.name === 'index.json' || f.name === 'changes.json';
        if (count > LIMITS.files) tooLarge ??= new PackageError(`Mehr als ${LIMITS.files} Dateien in der Übergabe: höchstens ${LIMITS.files}.`, 'shareTooLarge', { limit: String(LIMITS.files) });
        else if (f.originalSize > (json ? LIMITS.jsonBytes : LIMITS.fileBytes)) tooLarge ??= new PackageError(`${f.name} ist ${mb(f.originalSize)} gross: höchstens ${mb(json ? LIMITS.jsonBytes : LIMITS.fileBytes)} pro Datei.`, 'shareTooLarge', { limit: mb(json ? LIMITS.jsonBytes : LIMITS.fileBytes) });
        else if (total > LIMITS.totalBytes) tooLarge ??= new PackageError(`Die Übergabe ist entpackt grösser als ${mb(LIMITS.totalBytes)}.`, 'shareTooLarge', { limit: mb(LIMITS.totalBytes) });
        return !tooLarge;
      },
    });
  } catch { throw notPackage('kein lesbares Zip'); }
  if (tooLarge) throw tooLarge;
  const raw = members['index.json'];
  if (!raw) throw notPackage('das Verzeichnis index.json fehlt');
  let parsed: unknown;
  try { parsed = JSON.parse(strFromU8(raw)); } catch { throw notPackage('das Verzeichnis ist kein JSON'); }
  const index = checkedIndex(parsed);
  const allowed = (p: string) => (index.kind === 'return' ? isReturnFile(p) : safePath(p) && carriageOf(p) !== undefined);
  for (const f of [...index.files, ...(index.held ?? []), ...(index.omitted ?? [])]) {
    if (!allowed(f.path)) throw new PackageError(`Die Übergabe nennt ${f.path}: diese Datei nimmt die App nicht an.`, 'shareTampered', { path: f.path.slice(0, 200) });
  }
  const named = new Set(index.files.map((f) => f.path));
  if (named.size !== index.files.length) throw new PackageError('Die Übergabe nennt eine Datei zweimal.', 'shareTampered', { path: 'files' });
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(members)) {
    if (name === 'index.json' || name === 'changes.json' || name.endsWith('/')) continue;
    const path = name.startsWith('files/') ? name.slice('files/'.length) : name;
    if (!name.startsWith('files/') || !named.has(path)) throw new PackageError(`Die Übergabe enthält ${path}, das ihr Verzeichnis nicht nennt.`, 'shareTampered', { path: path.slice(0, 200) });
    files.set(path, data);
  }
  for (const f of index.files) {
    const data = files.get(f.path);
    if (!data || sha256(data) !== f.sha256) throw new PackageError(`${f.path} fehlt in der Übergabe oder stimmt nicht mit ihrer Prüfsumme überein.`, 'shareTampered', { path: f.path });
  }
  if (index.kind !== 'return' && checksumOf([...index.files, ...(index.held ?? []), ...(index.omitted ?? [])]) !== index.version.checksum) {
    throw new PackageError('Die Dateien der Übergabe ergeben nicht die Prüfsumme ihrer Version.', 'shareTampered', { path: 'checksum' });
  }
  let changes: ReturnChange[] | undefined;
  if (members['changes.json']) {
    try { changes = JSON.parse(strFromU8(members['changes.json'])) as ReturnChange[]; } catch { throw notPackage('die Änderungen sind kein JSON'); }
    if (!Array.isArray(changes)) throw notPackage('die Änderungen sind keine Liste');
  }
  if (index.kind === 'return' && !changes) throw new PackageError('Der Rücksendung fehlen ihre Änderungen (changes.json).', 'shareTampered', { path: 'changes.json' });
  return { index, files, changes };
}

/** The file name a person sees: `<Firma> – Buchhaltung v12 (2026-11-14).vanilla`, or for a return `… – Änderungen von <Name> (…)`. */
export function packageName(index: Pick<PackageIndex, 'kind' | 'firm' | 'version' | 'from' | 'at'>): string {
  const clean = (s: string) => s.replace(/[/\\:*?"<>|]/g, '-').trim();
  const day = index.at.slice(0, 10);
  return index.kind === 'return'
    ? `${clean(index.firm.name)} – Änderungen von ${clean(index.from.name)} (${day})${PACKAGE_EXT}`
    : `${clean(index.firm.name)} – Buchhaltung v${index.version.n} (${day})${PACKAGE_EXT}`;
}
