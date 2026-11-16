/**
 * npx tsx tools/release/zones.ts [<base>] [<head>] [--all]: what a release has to walk by hand, scoped
 * to its threat zone, as npm run test:changed scopes the unit tests.
 *
 * The change is the diff of <head> (HEAD unless named) against <base> (the newest release tag
 * unless named, by version). Each changed file selects the zones of tools/release/zones.json whose
 * paths match it; the zones name the VM scenarios (a fresh Mac, .claude/skills/verify/vm.sh) and the
 * persona walks and feature recipes (.claude/skills/verify/personas, features) that exercise them. A
 * file of no zone is quiet (no person walks it) or app code that falls back to the install scenario;
 * a file the map does not place at all selects everything. package.json and package-lock.json whose
 * only change is the version are quiet. --all prints the full set.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Scenario { title: string; how: string }
export interface Zone { id: string; title: string; paths: string[]; vm: string[]; personas: string[]; features: string[] }
export interface ZoneMap {
  scenarios: Record<string, Scenario>;
  zones: Zone[];
  quiet: { paths: string[]; why: string };
  fallback: { paths: string[]; vm: string[]; why: string };
  onRequest: { personas: string[]; why: string };
}

export const loadZones = (): ZoneMap => JSON.parse(readFileSync(join(import.meta.dirname, 'zones.json'), 'utf8')) as ZoneMap;

export const matches = (f: string, globs: string[]): boolean => globs.some((g) => f === g || matchesGlob(f, g));

/** What a change selects: each pick with the zones (or the reason) that chose it. */
export interface Scope {
  /** Zone id → the changed files in it. */
  zones: Map<string, string[]>;
  /** Changed files no person walks, with why. */
  quiet: { file: string; why: string }[];
  /** Changed app files of no zone: the fallback's scenarios. */
  fallback: string[];
  /** Changed files the map does not place: everything is selected. */
  unmapped: string[];
  /** Scenario id → why (zone ids, `fallback`, `unmapped`, `--all`). */
  vm: Map<string, string[]>;
  personas: Map<string, string[]>;
  features: Map<string, string[]>;
}

/** The scope of `changed`; `quietToo` names files to treat as quiet whatever their path (a version bump). */
export function scope(changed: string[], map: ZoneMap = loadZones(), quietToo: Map<string, string> = new Map(), all = false): Scope {
  const s: Scope = { zones: new Map(), quiet: [], fallback: [], unmapped: [], vm: new Map(), personas: new Map(), features: new Map() };
  const add = (m: Map<string, string[]>, key: string, why: string) => {
    const w = m.get(key) ?? [];
    if (!w.includes(why)) w.push(why);
    m.set(key, w);
  };
  for (const f of changed) {
    const q = quietToo.get(f);
    if (q) { s.quiet.push({ file: f, why: q }); continue; }
    const zones = map.zones.filter((z) => matches(f, z.paths));
    for (const z of zones) s.zones.set(z.id, [...(s.zones.get(z.id) ?? []), f]);
    if (zones.length) continue;
    if (matches(f, map.quiet.paths)) s.quiet.push({ file: f, why: map.quiet.why });
    else if (matches(f, map.fallback.paths)) s.fallback.push(f);
    else s.unmapped.push(f);
  }
  for (const z of map.zones) {
    if (!s.zones.has(z.id)) continue;
    for (const v of z.vm) add(s.vm, v, z.id);
    for (const p of z.personas) add(s.personas, p, z.id);
    for (const p of z.features) add(s.features, p, z.id);
  }
  if (s.fallback.length) for (const v of map.fallback.vm) add(s.vm, v, 'fallback');
  if (s.unmapped.length || all) {
    const why = all ? '--all' : 'unmapped';
    for (const v of Object.keys(map.scenarios)) add(s.vm, v, why);
    for (const z of map.zones) {
      for (const p of z.personas) add(s.personas, p, why);
      for (const p of z.features) add(s.features, p, why);
    }
    for (const p of map.onRequest.personas) add(s.personas, p, why);
  }
  return s;
}

/** Whether a package file's change between two texts is its version alone (a release bump ships nothing new). */
export function versionOnly(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  const strip = (text: string): string => {
    const j = JSON.parse(text) as { version?: string; packages?: Record<string, { version?: string }> };
    delete j.version;
    if (j.packages?.['']) delete j.packages[''].version;
    return JSON.stringify(j);
  };
  try { return strip(before) === strip(after); } catch { return false; }
}

function main(): void {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const [named, headArg] = args.filter((a) => !a.startsWith('--'));
  const git = (...a: string[]): string => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
  const show = (ref: string, f: string): string | undefined => { try { return git('show', `${ref}:${f}`); } catch { return undefined; } };
  const head = headArg ?? 'HEAD';
  // The newest release by version (no rc), not the nearest ancestor: next does not hold main's release merges.
  const headCommit = git('rev-parse', `${head}^{commit}`);
  const base = named ?? git('tag', '-l', 'v[0-9]*', '--sort=-v:refname').split('\n')
    .find((t) => t && !t.includes('-') && git('rev-parse', `${t}^{commit}`) !== headCommit);
  if (!base) throw new Error('no release tag to compare with: name the base');
  const changed = git('diff', '--name-only', '--no-renames', base, head).split('\n').filter(Boolean);
  const quietToo = new Map<string, string>();
  for (const f of ['package.json', 'package-lock.json']) {
    if (changed.includes(f) && versionOnly(show(base, f), show(head, f))) quietToo.set(f, 'the version only');
  }
  const map = loadZones();
  const s = scope(changed, map, quietToo, all);

  console.log(`test:zones: ${changed.length} file${changed.length === 1 ? '' : 's'} changed from ${base} to ${head}`);
  console.log(s.zones.size ? '\nzones touched:' : '\nzones touched: none');
  for (const z of map.zones) {
    const files = s.zones.get(z.id);
    if (!files) continue;
    console.log(`  ${z.id}: ${z.title} (${files.length})`);
    for (const f of files) console.log(`    ${f}`);
  }
  if (s.fallback.length) {
    console.log(`  no zone, app code (${s.fallback.length}): ${map.fallback.why}`);
    for (const f of s.fallback) console.log(`    ${f}`);
  }
  if (s.unmapped.length) {
    console.log(`  not placed by tools/release/zones.json (${s.unmapped.length}): everything is selected until it is`);
    for (const f of s.unmapped) console.log(`    ${f}`);
  }
  if (s.quiet.length) {
    const byWhy = new Map<string, number>();
    for (const q of s.quiet) byWhy.set(q.why, (byWhy.get(q.why) ?? 0) + 1);
    for (const [why, n] of byWhy) console.log(`  quiet (${n}): ${why}`);
  }
  const list = (head: string, m: Map<string, string[]>, title: (k: string) => string) => {
    console.log(m.size ? `\n${head}:` : `\n${head}: none`);
    const w = Math.max(...[...m.keys()].map((k) => k.length));
    for (const [k, why] of m) console.log(`  ${k.padEnd(w)}  ${title(k)} (${why.join(', ')})`);
  };
  list('VM: these scenarios', s.vm, (k) => map.scenarios[k].title);
  const verify = join(import.meta.dirname, '../../.claude/skills/verify');
  const headline = (dir: string) => (file: string): string => {
    try { return readFileSync(join(verify, dir, file), 'utf8').split('\n')[0].replace(/^#\s*/, ''); } catch { return 'missing'; }
  };
  list('Personas: these walks (.claude/skills/verify/personas)', s.personas, headline('personas'));
  list('Feature recipes, web sandbox (.claude/skills/verify/features)', s.features, headline('features'));
  console.log(s.vm.size ? '\nEach scenario\'s steps: .claude/skills/verify/vm.sh scenario <id>' : '');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
