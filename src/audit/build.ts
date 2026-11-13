/**
 * The static audit export: the UI built in audit mode plus every file it reads (EXPORT_FILES in
 * ./sources.ts), so it runs from any static file server without the API. docs/audit-export.md.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'vite';
import { loadBooks, sealsOf } from '../books/store.js';
import { readEstvRateTable } from '../accounting/fx-rates.js';
import type { ApiStatus } from '../types/api-error.js';
import { accountsOf, filedReturnsOf, receiptPathOf } from '../workspace/reads.js';
import { orderPagesIn, providerIssuesIn, vatCorrectionsIn } from '../intake/pair-chain.js';
import { companyInfo } from '../books/company.js';
import { APP_ROOT, findFile, yearPaths, yearsOf as yearsWithFolders, type Workspace } from '../workspace/workspace.js';
import { schemaOf } from '../workspace/schema.js';
import { EXPORT_FILES, type AuditSnapshot } from './sources.js';
import { workspaceModules } from '../core/modules/load.js';
import { appVersion, hashFiles, MANIFEST, MANIFEST_FORMAT, type ExportedSeal, type ExportManifest } from './manifest.js';

export class ExportError extends Error {}

/**
 * Builds the export into `outDir`. An earlier export there is replaced; any other non-empty
 * folder is refused, so a wrong path never deletes someone's files.
 */
export async function buildAuditExport(ws: Workspace, outDir: string, createdAt = new Date().toISOString()): Promise<ExportManifest> {
  const out = resolve(outDir);
  if (existsSync(out) && readdirSync(out).length && !existsSync(join(out, MANIFEST))) {
    throw new ExportError(`${out} is not empty and holds no audit export: choose an empty or new folder.`);
  }
  if (out === ws.paths.root || out.startsWith(ws.paths.root + '/')) throw new ExportError(`${out} is inside the workspace: choose a folder outside it.`);
  rmSync(out, { recursive: true, force: true });

  await build({ root: APP_ROOT, mode: 'audit', logLevel: 'warn', build: { outDir: out, emptyOutDir: true } });

  const books = loadBooks(ws);
  const write = (path: string, data: unknown) => writeOut(out, path, JSON.stringify(data));
  const raw = JSON.parse(readFileSync(ws.paths.ledger, 'utf8')) as { schema?: unknown };
  const snapshot: AuditSnapshot = { createdAt, booksSchema: schemaOf(raw.schema, ws.paths.ledger), appVersion: appVersion() };

  write(EXPORT_FILES.books(), books);
  write(EXPORT_FILES.modules(), workspaceModules(APP_ROOT, ws.paths.root, ws.company.vat));
  write(EXPORT_FILES.status(), { ok: true, readonly: true, snapshot } satisfies ApiStatus);
  write(EXPORT_FILES.accounts(), accountsOf(ws));
  write(EXPORT_FILES.workspace(), companyInfo(ws, books));
  for (const year of yearsOf(ws, books)) write(EXPORT_FILES.filedReturns(year), filedReturnsOf(ws, year));
  write(EXPORT_FILES.fxRates(), readEstvRateTable());
  write(EXPORT_FILES.orderPages(), orderPagesIn(ws, books));
  write(EXPORT_FILES.vatCorrections(), vatCorrectionsIn(ws, books));
  write(EXPORT_FILES.providerIssues(), providerIssuesIn(ws, books));

  const missing: string[] = [];
  for (const r of books.receipts) {
    const src = receiptPathOf(ws, r);
    if (src) copyOut(out, EXPORT_FILES.receipt(r.id), src);
    else missing.push(`receipt ${r.id} (${r.filename})`);
  }
  for (const s of books.bankStatements) {
    const src = findFile(ws.paths, 'statements', `${s.bank}/${s.filename}`);
    if (src) copyOut(out, EXPORT_FILES.statement(s.bank, s.filename), src);
    else missing.push(`statement ${s.bank}/${s.filename}`);
  }

  const { checks, unsealed } = sealsOf(books);
  const seals = checks.map((c): ExportedSeal => {
    if (c.status === 'broken') return { quarter: c.quarter, status: 'broken', problem: c.problem };
    const seal = JSON.parse(readFileSync(c.file, 'utf8')) as { through: string; sha256: string; sealedAt: string };
    return { quarter: c.quarter, status: 'intact', through: seal.through, sha256: seal.sha256, sealedAt: seal.sealedAt };
  });
  const manifest: ExportManifest = { format: MANIFEST_FORMAT, snapshot, seals, unsealed, missing, files: hashFiles(out) };
  writeFileSync(join(out, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Every year the period picker can show, and every year with a filing. */
function yearsOf(ws: Workspace, books: ReturnType<typeof loadBooks>): string[] {
  const dated = [...books.transactions, ...books.journalEntries].map((x) => x.date?.slice(0, 4));
  const filed = yearsWithFolders(ws.paths).filter((y) => existsSync(yearPaths(ws.paths, y).filings));
  return [...new Set([...dated, ...filed])].filter((y): y is string => !!y && /^\d{4}$/.test(y)).sort();
}

/** `path` comes from the books: a name that would land outside the export is refused. */
function target(out: string, path: string): string {
  const file = resolve(out, path);
  if (relative(out, file).startsWith('..')) throw new ExportError(`${path} would be written outside the export`);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

const writeOut = (out: string, path: string, data: string) => writeFileSync(target(out, path), data);
const copyOut = (out: string, path: string, src: string) => copyFileSync(src, target(out, path));

