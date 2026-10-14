/** Workspaces for tests: the demos, a temp copy of a manifest, and the company's own when this checkout has one. */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { APP_FOLDER, APP_ROOT, DEMO_NAME, MANIFEST_FILE, appFolderIn, workspaceAt, yearPaths, yearsOf, type Workspace } from '../../src/workspace/workspace.js';
import { writeBooks } from '../../src/books/store.js';
import type { Index } from '../../src/types/index.js';

/** The synthetic demo company's repository (tools/demo/generate.ts). Tests read no other company's data. */
export const DEMO_REPO = join(APP_ROOT, 'demo');
/** Its books: the workspace, demo/vanilla-accounting/. */
export const DEMO_ROOT = join(DEMO_REPO, APP_FOLDER);

/** The workspace of every synthetic demo the app ships: demo/vanilla-accounting/ and each demo-<name>/vanilla-accounting/. */
export const DEMO_ROOTS: readonly string[] = readdirSync(APP_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && DEMO_NAME.test(d.name) && existsSync(join(APP_ROOT, d.name, APP_FOLDER, MANIFEST_FILE)))
  .map((d) => join(APP_ROOT, d.name, APP_FOLDER));

/** A temp workspace holding a copy of the manifest in `manifestOf` (the demo's by default). */
export function tempWorkspace(prefix = 'belege-ws-', manifestOf: string = DEMO_ROOT): Workspace {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  copyFileSync(join(appFolderIn(manifestOf) ?? manifestOf, MANIFEST_FILE), join(dir, MANIFEST_FILE));
  return workspaceAt(dir);
}

/** Writes `index` (books.json's content before ADR 0013) as the workspace's books, by year. */
export const writeIndex = (ws: Pick<Workspace, 'paths'>, index: object): void =>
  writeBooks(ws.paths, { receipts: [], transactions: [], mappings: [], bankStatements: [], ...index } as Index);

/** Every file of the workspace's books, by path: to prove a step wrote nothing. */
export function booksOnDisk(ws: Pick<Workspace, 'paths'>): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(ws.paths.ledger)) out['ledger.json'] = readFileSync(ws.paths.ledger, 'utf8');
  for (const year of yearsOf(ws.paths)) {
    const dir = yearPaths(ws.paths, year).books;
    if (existsSync(dir)) for (const f of readdirSync(dir).sort()) out[`${year}/${f}`] = readFileSync(join(dir, f), 'utf8');
  }
  return out;
}

/**
 * The real company workspace this checkout is set up for, if any: VANILLA_WORKSPACE, else the
 * one .env names, else the app root's own manifest. A demo never counts. In the public repo
 * there is none.
 */
export function companyWorkspace(): Workspace | undefined {
  const envFile = join(APP_ROOT, '.env');
  const fromEnvFile = existsSync(envFile) ? parseEnv(readFileSync(envFile)).VANILLA_WORKSPACE : undefined;
  const demos = new Set(DEMO_ROOTS.map((d) => realpathSync(d)));
  for (const candidate of [process.env.VANILLA_WORKSPACE, fromEnvFile, APP_ROOT]) {
    if (!candidate || DEMO_NAME.test(candidate)) continue;
    const root = resolve(candidate.replace(/^~(?=$|\/)/, homedir()));
    if (appFolderIn(root) && !demos.has(realpathSync(root))) return workspaceAt(root);
  }
  return undefined;
}
