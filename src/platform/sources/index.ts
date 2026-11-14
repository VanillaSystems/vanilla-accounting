/**
 * Sources (ADR 0014), the one door: `sources()` for the Quellen page and the engine. A company's
 * source runs live only in a version a person switched on; the switch lies outside the workspace,
 * beside the workflows' (src/workflows/switch-on.ts), so an AI editing the workspace cannot approve
 * its own source. The app's sources are switched on by definition; a bindable one is only bound.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import type { Workspace } from '../../workspace/workspace.js';
import { folders, readDecl } from './load.js';
import { reachDiff, reachLines } from './reach.js';
import type { Reach, SourceDecl, SourceVerdict } from './model.js';

type Ws = Pick<Workspace, 'paths'>;

const approvalsFile = (ws: Ws): string => {
  let root = ws.paths.root;
  try { root = realpathSync(root); } catch { /* as given */ }
  const dir = process.env.VANILLA_APPROVALS_DIR ?? join(homedir(), '.vanilla-accounting', 'approvals');
  return join(dir, `${createHash('sha256').update(root).digest('hex').slice(0, 16)}.sources.json`);
};

interface Approved { version: string; reach: Array<{ channel: string; what: string }>; at: string }
const readApprovals = (ws: Ws): Record<string, Approved> => { try { return JSON.parse(readFileSync(approvalsFile(ws), 'utf8')) as Record<string, Approved>; } catch { return {}; } };

/** Switches a source's version on: from now on it runs live. */
export function approveSource(ws: Ws, decl: SourceDecl, now = () => new Date()): void {
  const all = readApprovals(ws);
  all[decl.id] = { version: decl.version, reach: reachLines(decl.reach), at: now().toISOString() };
  mkdirSync(dirname(approvalsFile(ws)), { recursive: true });
  writeFileSync(approvalsFile(ws), JSON.stringify(all, null, 2) + '\n');
}

/** Takes a source's switch back: a source made again under the same id waits to be switched on anew. */
export function withdrawApproval(ws: Ws, id: string): void {
  const all = readApprovals(ws);
  if (!(id in all)) return;
  delete all[id];
  writeFileSync(approvalsFile(ws), JSON.stringify(all, null, 2) + '\n');
}

/** Whether the app's source folder is meant to be bound only (`bindable: true`), never run itself. */
const bindable = (folder: string) => { try { return (parse(readFileSync(join(folder, 'source.yaml'), 'utf8')) as { bindable?: unknown })?.bindable === true; } catch { return false; } };

/** Every source of the app and the workspace with its verdict: ready, waiting to be switched on (with what its reach adds), or invalid with file and line. */
export function sources(ws: Ws, appRoot: string): SourceVerdict[] {
  const appDir = join(appRoot, 'sources');
  const own = join(ws.paths.root, 'sources');
  const approvals = readApprovals(ws);
  const out: SourceVerdict[] = [];
  for (const [dir, origin] of [[appDir, 'app'], [own, 'company']] as const) {
    for (const id of folders(dir)) {
      const folder = join(dir, id);
      if (origin === 'app' && bindable(folder)) continue;
      const r = readDecl(folder, origin, appDir);
      if ('problems' in r) { out.push({ kind: 'invalid', id, origin, problems: r.problems }); continue; }
      const on = approvals[id];
      if (origin === 'app' || on?.version === r.decl.version) { out.push({ kind: 'ready', decl: r.decl }); continue; }
      out.push({ kind: 'pending', decl: r.decl, reachDiff: on ? diffFromLines(on.reach, r.decl.reach) : reachDiff(undefined, r.decl.reach) });
    }
  }
  return out;
}

function diffFromLines(was: Approved['reach'], next: Reach) {
  const key = (l: { channel: string; what: string }) => `${l.channel} ${l.what}`;
  const now = reachLines(next);
  const had = new Set(was.map(key)), has = new Set(now.map(key));
  return { added: now.filter((l) => !had.has(key(l))), removed: was.filter((l) => !has.has(key(l))) as ReturnType<typeof reachLines> };
}

/**
 * A change the person's click makes to a source's source.yaml (a sender skipped, a group kept aside
 * or switched off): it only narrows what the source delivers, so a source that ran live keeps
 * running live: its new version is switched on with the same click, and left waiting if the change
 * would reach anything new or the source waited to be switched on before.
 *
 * `change` gets the text of source.yaml this check read, and writes only if the file still holds it
 * (src/platform/sources/aside.ts editSourceYaml): the version switched on is exactly the one checked
 * plus the click's change. `version`: the version the person saw; another refuses (as approve does).
 */
export function changeKeepingOn(ws: Ws, appRoot: string, id: string, change: (expect: string) => void, version?: string): void {
  const file = join(ws.paths.root, 'sources', id, 'source.yaml');
  const expect = readFileSync(file, 'utf8');
  const before = sources(ws, appRoot).find((x) => x.kind !== 'invalid' && x.decl.id === id);
  if (version !== undefined && (before?.kind === 'invalid' || before?.decl.version !== version)) throw new SourceVersionChanged(`sources/${id} changed since it was shown`);
  if (readFileSync(file, 'utf8') !== expect) throw new SourceVersionChanged(`sources/${id}/source.yaml changed meanwhile`);
  change(expect);
  const after = sources(ws, appRoot).find((x) => x.kind !== 'invalid' && x.decl.id === id);
  if (!before || before.kind !== 'ready' || !after || after.kind === 'invalid') return;
  if (reachDiff(before.decl.reach, after.decl.reach).added.some((l) => !l.what.startsWith('not from '))) return;
  approveSource(ws, after.decl);
}

/** The source changed since the person saw it, or while the app changed it: nothing is written. */
export class SourceVersionChanged extends Error {}

export const sourceFolder = (ws: Ws, id: string): string => join(ws.paths.root, 'sources', id);
export const hasSources = (ws: Ws): boolean => existsSync(join(ws.paths.root, 'sources'));
