/**
 * manifest.json of a static audit export: the SHA-256 of every file in it and the seals of the
 * filed quarters as they stood when it was made. `npm run verify-audit` checks a handed-over
 * export against it later (docs/audit-export.md).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { QuarterKey } from '../types/index.js';
import { EXPORT_FILES, type AuditSnapshot } from './sources.js';
import { APP_ROOT } from '../workspace/workspace.js';

export const MANIFEST = 'manifest.json';
export const MANIFEST_FORMAT = 'vanilla-accounting-audit-export/1';

export interface ExportedFile { path: string; sha256: string; bytes: number }

export type ExportedSeal =
  | { quarter: QuarterKey; status: 'intact'; through: string; sha256: string; sealedAt: string }
  | { quarter: QuarterKey; status: 'broken'; problem: string };

export interface ExportManifest {
  format: typeof MANIFEST_FORMAT;
  snapshot: AuditSnapshot;
  seals: ExportedSeal[];
  /** Closed quarters with records but no seal (npm run seal). */
  unsealed: QuarterKey[];
  /** Receipts, statements and invoice documents the books name whose file was not in the workspace (an invoice's PDF also when it no longer matched its checksum). */
  missing: string[];
  files: ExportedFile[];
}

/** Every file under `dir` but the manifest (and Finder's .DS_Store), with '/' separators, sorted. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join('/'))
    .filter((p) => p !== MANIFEST && !p.endsWith('.DS_Store'))
    .sort();
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export function hashFiles(dir: string): ExportedFile[] {
  return filesUnder(dir).map((path) => {
    const data = readFileSync(join(dir, path));
    return { path, sha256: sha256(data), bytes: data.length };
  });
}

/** What differs between the export in `dir` and its manifest; empty when it is as it was made. */
export function verifyExport(dir: string): string[] {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) return [`${MANIFEST} not found in ${dir}`];
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as ExportManifest;
  if (manifest.format !== MANIFEST_FORMAT) return [`${MANIFEST} is not an audit export manifest (format ${manifest.format})`];
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  const problems: string[] = [];
  for (const path of filesUnder(dir)) {
    const want = listed.get(path);
    listed.delete(path);
    if (!want) { problems.push(`${path}: not in the manifest (added after the export)`); continue; }
    const got = sha256(readFileSync(join(dir, path)));
    if (got !== want.sha256) problems.push(`${path}: changed (sha256 ${got}, manifest ${want.sha256})`);
  }
  for (const path of listed.keys()) problems.push(`${path}: missing (in the manifest, not in the folder)`);
  return [...problems, ...invoiceProblems(dir, manifest)];
}

/**
 * Each invoice document's PDF in the export is the one its record names: the SHA-256 the manifest lists
 * for it is the checksum invoices.json kept when it was issued or sent (#516). One the export lacks is
 * named by the manifest's `missing`, or above as removed.
 */
function invoiceProblems(dir: string, manifest: ExportManifest): string[] {
  const file = join(dir, EXPORT_FILES.invoices());
  if (!existsSync(file)) return [];
  const { invoices, sent } = JSON.parse(readFileSync(file, 'utf8')) as {
    invoices: Array<{ status: string; number?: string; pdf?: { sha256: string } }>;
    sent: Array<{ id: string; sha256: string }>;
  };
  const hashes = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  const docs = [
    ...invoices.flatMap((i) => (i.status === 'issued' && i.number && i.pdf ? [{ path: EXPORT_FILES.invoicePdf(i.number), sha256: i.pdf.sha256 }] : [])),
    ...sent.map((d) => ({ path: EXPORT_FILES.sentPdf(d.id), sha256: d.sha256 })),
  ];
  return docs.flatMap(({ path, sha256: want }) => {
    const got = hashes.get(path);
    return !got || got === want ? [] : [`${path}: not the PDF as issued (sha256 ${got}, ${EXPORT_FILES.invoices()} ${want})`];
  });
}

/** The manifest's own hash: sent apart from the export, it proves the manifest itself was not replaced. */
export const manifestHash = (dir: string) => sha256(readFileSync(join(dir, MANIFEST)));

/** The app's version (package.json), written into every export. */
export const appVersion = (): string => (JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
