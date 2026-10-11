/**
 * What this process wrote into the workspace, so the API's watcher (src/server/watch.ts) does not
 * announce the echo of its own writes as a change from outside. A CLI process records the same
 * and nobody asks.
 */
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';

const versions = new Map<string, string>();
const touched = new Set<string>();

/** The version of a file's content: what the UI loaded, what it sends back with a write. */
export const versionOf = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex');

/** A file this process wrote (with the content's `version`), renamed or deleted (no version). */
export function wrote(path: string, version?: string): void {
  const full = resolve(path);
  touched.add(full);
  if (version) versions.set(full, version);
}

/** The version this process last wrote to `path`. */
export const ownVersion = (path: string): string | undefined => versions.get(resolve(path));

/** Whether this process changed anything in `dir` since the last ask; forgets it. */
export function takeTouched(dir: string): boolean {
  const prefix = resolve(dir) + sep;
  let hit = false;
  for (const p of touched) {
    if (!p.startsWith(prefix)) continue;
    touched.delete(p);
    hit = true;
  }
  return hit;
}
