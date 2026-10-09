/** Workspaces for tests: the demos, a temp copy of a manifest, and the company's own when this checkout has one. */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { APP_ROOT, DEMO_NAME, MANIFEST_FILE, workspaceAt, type Workspace } from '../../src/workspace/workspace.js';

/** The synthetic demo company (tools/demo/generate.ts). Tests read no other company's data. */
export const DEMO_ROOT = join(APP_ROOT, 'demo');

/** Every synthetic demo workspace the app ships: demo/ and each demo-<name>/. */
export const DEMO_ROOTS: readonly string[] = readdirSync(APP_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && DEMO_NAME.test(d.name) && existsSync(join(APP_ROOT, d.name, MANIFEST_FILE)))
  .map((d) => join(APP_ROOT, d.name));

/** A temp workspace holding a copy of the manifest in `manifestOf` (the demo's by default). */
export function tempWorkspace(prefix = 'belege-ws-', manifestOf: string = DEMO_ROOT): Workspace {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  copyFileSync(join(manifestOf, MANIFEST_FILE), join(dir, MANIFEST_FILE));
  return workspaceAt(dir);
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
    if (existsSync(join(root, MANIFEST_FILE)) && !demos.has(realpathSync(root))) return workspaceAt(root);
  }
  return undefined;
}
