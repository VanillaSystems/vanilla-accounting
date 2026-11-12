/**
 * The bundled demos (demo/, demo-consulting/, … under the app) are the app's sample books, in the
 * public repository. An app a person clicks in never writes into them: a mailbox connected there
 * fetched real receipts into the repository. The server opens a copy instead, made on first use in
 * ~/.vanilla-accounting/demo/<name>/ and kept until `npm run demo:reset`; the Mac app keeps its own
 * (src/desktop/server.ts openDemo). Only tools/demo/generate.ts writes the originals.
 */
import { cpSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { APP_FOLDER, APP_ROOT, appFolderIn, DEMO_NAME } from './workspace.js';
import { isOldLayout } from './layout.js';

/** Where the copies live; a test run (node --test marks its processes) keeps its own, never the person's play copy. */
export const demoHome = (): string => process.env.VANILLA_DEMO_DIR
  ?? (process.env.NODE_TEST_CONTEXT ? join(tmpdir(), `vanilla-demo-${process.pid}`) : join(homedir(), '.vanilla-accounting', 'demo'));

/** The demo's name when `root` (a workspace or its repository) lies in a bundled demo. */
export function bundledDemo(root: string): string | undefined {
  let rel: string;
  try { rel = relative(realpathSync(APP_ROOT), realpathSync(root)); } catch { return undefined; }
  const name = rel.split(sep)[0];
  return rel && !rel.startsWith('..') && DEMO_NAME.test(name) ? name : undefined;
}

/**
 * The workspace to open for `root`: `root` itself, or for a bundled demo its copy, made on first
 * use without the original's local data/. A copy an app before 0.4.0 made (books.json at its top)
 * is thrown away for a fresh one: it is a copy, and this version does not read that layout.
 */
export function demoCopy(root: string): string {
  const name = bundledDemo(root);
  if (!name) return root;
  const from = join(APP_ROOT, name);
  const dir = join(demoHome(), name);
  if (isOldLayout(dir)) rmSync(dir, { recursive: true, force: true });
  if (!appFolderIn(dir)) cpSync(from, dir, { recursive: true, filter: (src) => relative(from, src) !== join(APP_FOLDER, 'data') });
  return appFolderIn(dir)!;
}

const named = new Set<string>();

/** The Mac app keeps its copy in its own user data folder (src/desktop/server.ts `demoRoot`) and names it here. */
export function nameDemoCopy(dir: string): void {
  named.add(resolve(dir));
}

/**
 * Whether `root` (a workspace or its repository) is a demo: a copy made here, the Mac app's copy,
 * or a bundled original. What the app knows from where the books lie, never from the company's
 * name: the books say so on screen (src/app/shell/Demo.tsx).
 */
export function isDemo(root: string): boolean {
  const at = resolve(root);
  const within = (dir: string) => at.startsWith(dir + sep);
  return within(resolve(demoHome())) || [...named].some((dir) => at === dir || within(dir)) || !!bundledDemo(root);
}

/** Throws the copy away; the next start copies the demo afresh. */
export function resetDemoCopy(name: string): string {
  const dir = join(demoHome(), name);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
