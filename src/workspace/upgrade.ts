/**
 * Writes a workspace's books and manifest at the schema of this app version
 * (src/workspace/schema.ts), after a backup of each in data/backups/. Books in the layout before
 * ADR 0013 move into vanilla-accounting/ first (src/workspace/layout.ts). The app reads old files
 * of the current layout as they are; this makes the change visible in the workspace's git
 * history. Idempotent: a file at the current schema is left alone, and a backup that exists is kept.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { loadBooks, saveBooks } from '../books/store.js';
import { BOOKS_SCHEMA, MANIFEST_MIGRATIONS, WORKSPACE_SCHEMA, climb, schemaOf } from './schema.js';
import { workspaceAt, type Workspace } from './workspace.js';
import { applyLayout, isOldLayout, planLayout } from './layout.js';

export interface Upgraded {
  file: string;
  /** The schema the file named; undefined: none, from before versioning. */
  from: number | undefined;
  to: number;
  backup: string;
  /** Files and folders the layout migration moved. */
  moved?: number;
}

function backup(ws: Workspace, file: string, from: number | undefined): string {
  const dir = join(ws.paths.data, 'backups');
  const copy = join(dir, `${basename(file)}.schema-${from ?? 'none'}`);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(copy)) copyFileSync(file, copy);
  return copy;
}

/** The upgraded files, and the workspace afterwards: its folder moved when the layout did. */
export async function upgradeWorkspace(opened: Workspace): Promise<{ ws: Workspace; done: Upgraded[] }> {
  const done: Upgraded[] = [];
  let ws = opened;
  if (isOldLayout(ws.paths.root)) {
    const plan = planLayout(ws.paths.root);
    const moved = await applyLayout(plan);
    ws = workspaceAt(plan.app);
    done.push({ file: join(plan.repository, 'books.json'), from: plan.books.schema, to: BOOKS_SCHEMA, backup: moved.backup, moved: moved.moved.length });
  }

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

  const { ledger } = ws.paths;
  if (existsSync(ledger)) {
    const found = (JSON.parse(readFileSync(ledger, 'utf8')) as { schema?: number }).schema;
    if (found !== BOOKS_SCHEMA) {
      const loaded = loadBooks(ws);
      const copy = backup(ws, ledger, found);
      saveBooks(ws, loaded);
      done.push({ file: ledger, from: found, to: BOOKS_SCHEMA, backup: copy });
    }
  }
  return { ws, done };
}
