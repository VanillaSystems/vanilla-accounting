/**
 * Writes a workspace's books.json and manifest at the schema of this app version
 * (src/workspace/schema.ts), after a backup of each in data/backups/. The app reads old files as
 * they are; this makes the change visible in the workspace's git history. Idempotent: a file at
 * the current schema is left alone, and a backup that exists is kept.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { loadBooks, saveBooks } from '../books/store.js';
import { BOOKS_SCHEMA, MANIFEST_MIGRATIONS, WORKSPACE_SCHEMA, climb, schemaOf } from './schema.js';
import type { Workspace } from './workspace.js';

export interface Upgraded {
  file: string;
  /** The schema the file named; undefined: none, from before versioning. */
  from: number | undefined;
  to: number;
  backup: string;
}

function backup(ws: Workspace, file: string, from: number | undefined): string {
  const dir = join(ws.paths.data, 'backups');
  const copy = join(dir, `${basename(file)}.schema-${from ?? 'none'}`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(copy)) copyFileSync(file, copy);
  return copy;
}

export function upgradeWorkspace(ws: Workspace): Upgraded[] {
  const done: Upgraded[] = [];

  const { manifest } = ws.paths;
  const doc = parseDocument(readFileSync(manifest, 'utf8'));
  const named = doc.get('schema') as number | undefined;
  if (named !== WORKSPACE_SCHEMA) {
    const copy = backup(ws, manifest, named);
    const next = climb(doc, schemaOf(named, manifest), WORKSPACE_SCHEMA, MANIFEST_MIGRATIONS, manifest, (d) => d.clone());
    if (!isMap(next.contents)) throw new Error(`${manifest}: not a YAML mapping`);
    next.contents.items = next.contents.items.filter((p) => String(p.key) !== 'schema');
    next.contents.items.unshift(next.createPair('schema', WORKSPACE_SCHEMA));
    writeFileSync(manifest, next.toString());
    done.push({ file: manifest, from: named, to: WORKSPACE_SCHEMA, backup: copy });
  }

  const { books } = ws.paths;
  if (existsSync(books)) {
    const found = (JSON.parse(readFileSync(books, 'utf8')) as { schema?: number }).schema;
    if (found !== BOOKS_SCHEMA) {
      const loaded = loadBooks(ws);
      const copy = backup(ws, books, found);
      saveBooks(ws, loaded);
      done.push({ file: books, from: found, to: BOOKS_SCHEMA, backup: copy });
    }
  }
  return done;
}
