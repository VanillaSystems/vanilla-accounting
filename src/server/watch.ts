/**
 * Notices when the workspace changes outside the API (Claude Code, a CLI, git pull) and says what
 * changed. Watches the workspace folder, not single files: every save is a write to a temp file
 * and a rename over the old one, which a watch on the file itself would lose.
 *
 * After the last event of a burst it compares each touched target with what it last saw: a file's
 * content checksum, a folder's listing. Only a real change counts. A file the API wrote itself
 * (src/workspace/own-writes.ts) is not announced: the page that asked for the write has it. A
 * folder change is, with `external: false` when the API made it (the intake moving receipts).
 */
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ChangeKind, WorkspaceChange } from '../types/api-error.js';
import type { Workspace } from '../workspace/workspace.js';
import { ownVersion, takeTouched, versionOf } from '../workspace/own-writes.js';

interface Target { kind: ChangeKind; path: string; folder: boolean }

function targetsOf(ws: Workspace): Target[] {
  const p = ws.paths;
  const file = (kind: ChangeKind, path: string): Target => ({ kind, path, folder: false });
  const folder = (kind: ChangeKind, path: string): Target => ({ kind, path, folder: true });
  return [
    file('books', p.books),
    file('invoices', p.invoices),
    file('manifest', p.manifest),
    file('accounts', p.accounts),
    // The year-end close record (filings/<year>/year-close.json) is read with the books.
    folder('books', p.filings),
    folder('receipts', p.receipts),
    folder('inbox', p.inbox),
    folder('statements', p.statements),
    folder('invoices', p.invoiceFiles),
  ];
}

/** Temp files of an atomic write and the Finder's own files are no change. */
const IGNORED = /(^|[\\/])\.|\.tmp$/;

function listing(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => !IGNORED.test(relative(dir, f)))
    .map((f) => { const s = statSync(f); return `${relative(dir, f)}\t${s.size}\t${s.mtimeMs}`; })
    .sort();
}

function signature(t: Target): string {
  if (t.folder) return versionOf(listing(t.path).join('\n'));
  return existsSync(t.path) ? versionOf(readFileSync(t.path)) : '';
}

export interface Watcher { close(): void }

/** Calls `onChange` once per kind that really changed, `debounceMs` after the last event of a burst. */
export function watchWorkspace(ws: Workspace, onChange: (change: WorkspaceChange) => void, debounceMs = 300): Watcher {
  const root = ws.paths.root;
  const targets = targetsOf(ws);
  const seen = new Map(targets.map((t) => [t, signature(t)]));
  for (const t of targets) if (t.folder) takeTouched(t.path);
  const dirty = new Set<Target>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const targetOf = (name: string): Target | undefined => {
    const path = join(root, name);
    return targets.find((t) => path === t.path || (t.folder && path.startsWith(t.path + sep)));
  };

  function flush(): void {
    const changes = new Map<ChangeKind, boolean>();
    for (const t of dirty) {
      const now = signature(t);
      const touched = t.folder && takeTouched(t.path);
      if (now === seen.get(t)) continue;
      seen.set(t, now);
      const external = t.folder ? !touched : now !== ownVersion(t.path);
      if (!t.folder && !external) continue;
      changes.set(t.kind, (changes.get(t.kind) ?? false) || external);
    }
    dirty.clear();
    for (const [kind, external] of changes) onChange({ kind, external });
  }

  const watcher: FSWatcher = watch(root, { recursive: true }, (_event, name) => {
    const hit = name ? [targetOf(name)].filter((t) => t !== undefined) : targets;
    if (!hit.length) return;
    hit.forEach((t) => dirty.add(t));
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });
  watcher.on('error', (e) => console.error(`watch ${root}: ${e.message}`));

  return { close: () => { clearTimeout(timer); watcher.close(); } };
}
