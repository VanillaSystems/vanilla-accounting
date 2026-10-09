/** Workspaces for tests: the demo, a temp copy of a manifest, and the company's own when this checkout has one. */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { APP_ROOT, MANIFEST_FILE, workspaceAt, type Workspace } from '../../src/workspace/workspace.js';

/** The synthetic demo company (tools/demo/generate.ts). Tests read no other company's data. */
export const DEMO_ROOT = join(APP_ROOT, 'demo');

/** A temp workspace holding a copy of the manifest in `manifestOf` (the demo's by default). */
export function tempWorkspace(prefix = 'belege-ws-', manifestOf: string = DEMO_ROOT): Workspace {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  copyFileSync(join(manifestOf, MANIFEST_FILE), join(dir, MANIFEST_FILE));
  return workspaceAt(dir);
}

/**
 * The real company workspace this checkout is set up for, if any: BELEGE_WORKSPACE, else the
 * one .env names, else the app root's own manifest. The demo never counts. In the public repo
 * there is none.
 */
export function companyWorkspace(): Workspace | undefined {
  const envFile = join(APP_ROOT, '.env');
  const fromEnvFile = existsSync(envFile) ? parseEnv(readFileSync(envFile)).BELEGE_WORKSPACE : undefined;
  const demo = realpathSync(DEMO_ROOT);
  for (const candidate of [process.env.BELEGE_WORKSPACE, fromEnvFile, APP_ROOT]) {
    if (!candidate || candidate === 'demo') continue;
    const root = resolve(candidate.replace(/^~(?=$|\/)/, homedir()));
    if (existsSync(join(root, MANIFEST_FILE)) && realpathSync(root) !== demo) return workspaceAt(root);
  }
  return undefined;
}
