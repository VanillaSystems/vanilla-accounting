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
import { sha256, type FileFact } from './content.js';
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

export class PackageError extends Error {
  constructor(message: string, readonly code: 'shareTampered' | 'shareOtherCompany' | 'shareBaseMissing' | 'shareNotPackage' | 'shareWrongKind', readonly params: Record<string, string> = {}) { super(message); }
}

const safePath = (p: string) => !!p && !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '' || s === '.');

/** The `.vanilla` file's bytes. Receipts are already compressed: every member is stored, the JSON deflated. */
export function writePackage(p: PackageContents): Uint8Array {
  const zip: Zippable = { 'index.json': [strToU8(JSON.stringify(p.index, null, 1)), { level: 6 }] };
  if (p.changes) zip['changes.json'] = [strToU8(JSON.stringify(p.changes)), { level: 6 }];
  for (const [path, data] of p.files) zip[`files/${path}`] = [data, { level: path.endsWith('.jsonl') || path.endsWith('.json') ? 6 : 0 }];
  return zipSync(zip);
}

/** Reads a `.vanilla` file and checks every file against its index; a file missing, extra or changed is refused (shareTampered). */
export function readPackage(bytes: Uint8Array): PackageContents {
  let members: Record<string, Uint8Array>;
  try { members = unzipSync(bytes); } catch { throw new PackageError('Keine Übergabe-Datei (.vanilla).', 'shareNotPackage'); }
  const raw = members['index.json'];
  if (!raw) throw new PackageError('Keine Übergabe-Datei: das Verzeichnis index.json fehlt.', 'shareNotPackage');
  const index = JSON.parse(strFromU8(raw)) as PackageIndex;
  if (index.format !== PACKAGE_FORMAT || !['full', 'update', 'return'].includes(index.kind)) throw new PackageError(`Übergabe im Format ${index.format} (${index.kind}): diese App liest Format ${PACKAGE_FORMAT}.`, 'shareNotPackage');
  const files = new Map<string, Uint8Array>();
  const named = new Set(index.files.map((f) => f.path));
  for (const [name, data] of Object.entries(members)) {
    if (!name.startsWith('files/') || name.endsWith('/')) continue;
    const path = name.slice('files/'.length);
    if (!safePath(path) || !named.has(path)) throw new PackageError(`Die Übergabe enthält ${path}, das ihr Verzeichnis nicht nennt.`, 'shareTampered', { path });
    files.set(path, data);
  }
  for (const f of index.files) {
    const data = files.get(f.path);
    if (!data || sha256(data) !== f.sha256) throw new PackageError(`${f.path} fehlt in der Übergabe oder stimmt nicht mit ihrer Prüfsumme überein.`, 'shareTampered', { path: f.path });
  }
  const changes = members['changes.json'] ? (JSON.parse(strFromU8(members['changes.json'])) as ReturnChange[]) : undefined;
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
