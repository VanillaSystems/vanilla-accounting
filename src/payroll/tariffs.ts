/**
 * The tax at source's tariff files in the workspace (docs/specs/payroll.md §3f, phase B2): public files,
 * fetched on demand from where the jurisdiction's data says (payroll.yaml `taxAtSource.file`) and kept
 * under data/qst/<year>/, never in git. Every version stays, named by its checksum, beside an index that
 * says which one is current, when each was fetched and from where, and the date the region made it:
 *
 *   data/qst/<year>/<region>.json              { current, versions: [{ sha256, created, fetchedAt, url, records }] }
 *   data/qst/<year>/<region>-<sha256:12>.txt   the file as fetched
 *
 * A file corrected during the year is a new version; making it current goes through the comparison with
 * the closed payslips (src/server/routes/payroll-tariffs.ts), so a closed payslip never changes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import type { PayrollData } from '../core/modules/schema.js';
import { writeAtomic } from '../invoices/store.js';
import { parseTariffFile, TariffFileError } from '../providers/tax-at-source/tariff-file.js';
import type { Workspace } from '../workspace/workspace.js';
import type { LoadedTariff, TariffSource } from './tax-at-source.js';

type Paths = Pick<Workspace, 'paths'>;

export interface TariffVersion { sha256: string; created: string; fetchedAt: string; url?: string; records: number }
export interface TariffIndex { region: string; year: string; current: string; versions: TariffVersion[] }

export class TariffError extends Error {
  constructor(message: string, readonly why: 'notFound' | 'network' | 'badFile' | 'otherRegion' | 'otherYear' | 'noSource') { super(message); }
}

const dirOf = (ws: Paths, year: string) => join(ws.paths.data, 'qst', year);
const indexFile = (ws: Paths, region: string, year: string) => join(dirOf(ws, year), `${region.toLowerCase()}.json`);
const versionFile = (ws: Paths, region: string, year: string, sha: string) => join(dirOf(ws, year), `${region.toLowerCase()}-${sha.slice(0, 12)}.txt`);

export const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export function tariffIndex(ws: Paths, region: string, year: string): TariffIndex | undefined {
  const f = indexFile(ws, region, year);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as TariffIndex : undefined;
}

/** Every region and year the workspace has a tariff file of, the current version first in each. */
export function tariffIndexes(ws: Paths): TariffIndex[] {
  const root = join(ws.paths.data, 'qst');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((y) => /^\d{4}$/.test(y)).sort().flatMap((y) =>
    readdirSync(join(root, y)).filter((f) => /^[a-z]{2}\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(root, y, f), 'utf8')) as TariffIndex));
}

const parsed = new Map<string, LoadedTariff>();

/** One version of a region's file, read and checked once per process (by its checksum). */
export function tariffVersion(ws: Paths, region: string, year: string, sha: string): LoadedTariff | undefined {
  const hit = parsed.get(sha);
  if (hit) return hit;
  const f = versionFile(ws, region, year, sha);
  if (!existsSync(f)) return undefined;
  const bytes = readFileSync(f);
  if (sha256(bytes) !== sha) return undefined;
  const v = tariffIndex(ws, region, year)?.versions.find((x) => x.sha256 === sha);
  const loaded: LoadedTariff = { region, year, file: parseTariffFile(bytes.toString('latin1')), sha256: sha, fetchedAt: v?.fetchedAt ?? '', ...(v?.url ? { url: v.url } : {}) };
  parsed.set(sha, loaded);
  return loaded;
}

/** The current file of each region and year, as payroll computes with it; `override` puts another version in one's place. */
export function tariffSource(ws: Paths, override?: LoadedTariff): TariffSource {
  return (region, year) => {
    if (override && override.region === region && override.year === year) return override;
    const index = tariffIndex(ws, region, year);
    return index ? tariffVersion(ws, region, year, index.current) : undefined;
  };
}

/**
 * Checks and keeps one version of a region's file (not yet current): it must be a file of `region` with
 * tariffs of `year`. Answers the version as payroll reads it.
 */
export function keepTariffVersion(ws: Paths, region: string, year: string, bytes: Uint8Array, url: string | undefined, now: string): { loaded: LoadedTariff; version: TariffVersion } {
  let file;
  try { file = parseTariffFile(Buffer.from(bytes).toString('latin1')); } catch (e) {
    if (e instanceof TariffFileError) throw new TariffError(e.message, 'badFile');
    throw e;
  }
  if (file.canton !== region) throw new TariffError(`Die Datei ist der Tarif von ${file.canton}, nicht von ${region}.`, 'otherRegion');
  const first = [...file.tariffs.values()][0]?.[0]?.validFrom ?? '';
  if (!first.startsWith(year)) throw new TariffError(`Die Datei gilt ab ${first || 'keinem Tag'}, nicht für ${year}.`, 'otherYear');
  const sha = sha256(bytes);
  mkdirSync(dirOf(ws, year), { recursive: true });
  const path = versionFile(ws, region, year, sha);
  if (!existsSync(path)) writeAtomic(path, Buffer.from(bytes));
  const index = tariffIndex(ws, region, year);
  const known = index?.versions.find((v) => v.sha256 === sha);
  const version: TariffVersion = known ?? { sha256: sha, created: file.created, fetchedAt: now, ...(url ? { url } : {}), records: file.records };
  if (!known) writeAtomic(indexFile(ws, region, year), JSON.stringify({ region, year, current: index?.current ?? '', versions: [...(index?.versions ?? []), version] }, null, 2) + '\n');
  const loaded: LoadedTariff = { region, year, file, sha256: sha, fetchedAt: version.fetchedAt, ...(url ? { url } : {}) };
  parsed.set(sha, loaded);
  return { loaded, version };
}

/** Makes a kept version the one payroll computes with. */
export function makeCurrent(ws: Paths, region: string, year: string, sha: string): void {
  const index = tariffIndex(ws, region, year);
  if (!index?.versions.some((v) => v.sha256 === sha)) throw new TariffError(`Version ${sha.slice(0, 12)} von ${region} ${year} ist nicht da.`, 'notFound');
  writeAtomic(indexFile(ws, region, year), JSON.stringify({ ...index, current: sha }, null, 2) + '\n');
}

// ─── fetching ──────────────────────────────────────────────────────────────────

const fill = (template: string, region: string, year: string) =>
  template.replace(/\{year\}/g, year).replace(/\{yy\}/g, year.slice(2)).replace(/\{canton\}/g, region.toLowerCase());

/** The text file of a region and year inside a zip, also inside a zip of every region (an archived year). */
function fromZip(zip: Uint8Array, region: string, year: string): Uint8Array | undefined {
  const name = new RegExp(`(^|/)tar${year.slice(2)}${region.toLowerCase()}\\.(txt|zip)$`, 'i');
  const files = unzipSync(zip);
  const entries = Object.entries(files);
  const txt = entries.find(([n]) => name.test(n) && /\.txt$/i.test(n)) ?? (entries.length === 1 && /\.txt$/i.test(entries[0][0]) ? entries[0] : undefined);
  if (txt) return txt[1];
  const inner = entries.find(([n]) => name.test(n) && /\.zip$/i.test(n));
  return inner ? fromZip(inner[1], region, year) : undefined;
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; bytes: Uint8Array }>;

export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  return { ok: res.ok, status: res.status, bytes: new Uint8Array(res.ok ? await res.arrayBuffer() : new ArrayBuffer(0)) };
};

/** Fetches the file of `region` and `year` from where the data says: the year's own file, else the archive of every region. */
export async function fetchTariff(data: PayrollData, region: string, year: string, fetcher: Fetcher = httpFetcher): Promise<{ bytes: Uint8Array; url: string }> {
  const t = data.taxAtSource;
  if (!t) throw new TariffError('Diese Rechtsordnung hat keine Tarifdateien.', 'noSource');
  if (!t.regions[region]) throw new TariffError(`${region} ist kein Kanton der Tarifdateien.`, 'otherRegion');
  const urls = [fill(t.file.url, region, year), ...(t.file.archive ? [fill(t.file.archive, region, year)] : [])];
  let last = '';
  for (const url of urls) {
    let res;
    try { res = await fetcher(url); } catch (e) { throw new TariffError(`${url} ist nicht erreichbar: ${(e as Error).message}`, 'network'); }
    if (!res.ok) { last = `${url}: HTTP ${res.status}`; continue; }
    const bytes = /\.zip$/i.test(url) ? fromZip(res.bytes, region, year) : res.bytes;
    if (!bytes) { last = `${url}: keine Datei von ${region} ${year} darin`; continue; }
    return { bytes, url };
  }
  throw new TariffError(`Kein Tarif ${region} ${year} gefunden (${last}).`, 'notFound');
}
