/**
 * Which test files a change can break (npm run test:changed, tools/test/changed.ts).
 *
 * The graph: every code file of the repository and what it names, found by reading its text, no
 * compiler: its imports (`from '…'`, `import('…')`, `require('…')`, a `.js` specifier resolved to
 * its `.ts`/`.tsx`, `@/` to src/), every literal relative path (`new URL('./x', import.meta.url)`,
 * `import.meta.resolve`), every literal repository path (`'src/server/main.ts'`, `'demo'`), and
 * every `join(APP_ROOT, 'modules', …)` whose leading literal parts name a file or folder of the
 * repository. A test file is selected when a changed file is among what it reaches. What the graph
 * cannot see (a folder read by a name built at run time, the UI build) is data in
 * tools/test/inputs.json. A name that only looks like a path adds an edge too: the selection errs
 * towards more tests, never fewer.
 */
import { readFileSync } from 'node:fs';
import { join, matchesGlob, posix } from 'node:path';

export interface Rules {
  full: { paths: string[]; why: string }[];
  guards: { tests: string[]; why: string };
  golden: { paths: string[]; tests: string[]; why: string };
  inputs: { paths: string[]; via?: string[]; tests?: string[]; why: string }[];
  noTest: { paths: string[]; why: string };
  vm: { paths: string[]; why: string };
}

/** The rules beside this file (tools/test/inputs.json). */
export const loadRules = (): Rules => JSON.parse(readFileSync(join(import.meta.dirname, 'inputs.json'), 'utf8')) as Rules;

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|html|css)$/;
export const isCode = (f: string): boolean => CODE.test(f);
export const isTest = (f: string): boolean => /^tests\/.*\.test\.ts$/.test(f);
export const matches = (f: string, globs: string[]): boolean => globs.some((g) => f === g || matchesGlob(f, g));

/** Identifiers that hold the repository root (or a fixed folder of it) where a path is joined. */
const ROOTS: Record<string, string> = {
  APP_ROOT: '', APP_FILES: '', REPO: '', ROOT: '', appRoot: '', repoRoot: '', 'process.cwd()': '',
  DEMO_REPO: 'demo', DEMO_ROOT: 'demo/vanilla-accounting',
};
const HERE = new Set(['import.meta.dirname', '__dirname', 'HERE', 'here']);
const EXT = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.json'];

/** A file's edges: repository paths, a folder ending in `/`. */
export type Graph = Map<string, Set<string>>;

export function buildGraph(root: string, files: string[]): Graph {
  const known = new Set(files);
  const dirs = new Set<string>();
  for (const f of files) for (let d = posix.dirname(f); d !== '.'; d = posix.dirname(d)) dirs.add(d);
  /** A repository path as a node: a known file, or a folder (`x/`); undefined when it is neither. */
  const node = (p: string): string | undefined => {
    const n = posix.normalize(p).replace(/^\.\//, '').replace(/\/$/, '');
    if (!n || n.startsWith('..') || n === '.') return undefined;
    if (known.has(n)) return n;
    if (dirs.has(n)) return `${n}/`;
    return undefined;
  };
  /** A module specifier from `from`: the file it loads, with .js standing for .ts the way tsx and Vite resolve it. */
  const resolveSpec = (from: string, spec: string): string | undefined => {
    const clean = spec.replace(/[?#].*$/, '');
    let base: string;
    if (clean.startsWith('@/')) base = `src/${clean.slice(2)}`;
    else if (clean.startsWith('./') || clean.startsWith('../')) base = posix.join(posix.dirname(from), clean);
    else return undefined;
    base = posix.normalize(base);
    const tries = [base];
    const js = /\.(m|c)?js$/.exec(base);
    if (js) for (const e of ['.ts', '.tsx', '.mts', '.cts']) tries.push(base.slice(0, -js[0].length) + e);
    if (/\.jsx$/.test(base)) tries.push(base.replace(/\.jsx$/, '.tsx'));
    for (const e of EXT) tries.push(base + e);
    for (const e of EXT) tries.push(`${base}/index${e}`);
    for (const t of tries) if (known.has(t)) return t;
    return node(base);
  };
  const graph: Graph = new Map();
  for (const f of files) {
    if (!isCode(f)) continue;
    let text: string;
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    // A type-only import is erased before the code runs (tsx, Vite): it cannot change what a test does.
    text = text
      .replace(/\b(?:import|export)\s+type\b[^;'"]*?\bfrom\s*(['"])[^'"\n]+\1/g, '')
      .replace(/\bimport\s*\{([^}]*)\}\s*from\s*(['"])[^'"\n]+\2/g, (all, names: string) =>
        names.split(',').map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith('type ')) ? '' : all);
    const out = new Set<string>();
    const add = (n: string | undefined) => { if (n && n !== f) out.add(n); };
    // Every quoted string without interpolation: a specifier, a relative path, a repository path.
    for (const m of text.matchAll(/(['"`])((?:(?!\1)[^\\\n$])+)\1/g)) {
      const s = m[2].trim();
      if (s.startsWith('./') || s.startsWith('../') || s.startsWith('@/')) { add(resolveSpec(f, s)); continue; }
      if (s.includes('/')) { add(node(s.replace(/^\/+/, ''))); continue; }
      // A single name: a top-level file with an extension, or a demo workspace's folder.
      if (/^[\w.-]+\.\w+$/.test(s) && known.has(s)) add(s);
      else if (/^demo(-[\w-]+)?$/.test(s)) add(node(s));
    }
    // join(APP_ROOT, 'a', 'b', x, …): the leading literal parts after a known root.
    for (const m of text.matchAll(/\b(?:join|resolve)\(\s*([A-Za-z_$][\w$.]*(?:\(\))?)\s*((?:,\s*(['"])[^'"\n]+\3\s*)+)/g)) {
      const parts = [...m[2].matchAll(/(['"])([^'"\n]+)\1/g)].map((p) => p[2]);
      const ident = m[1];
      const at = ident in ROOTS ? ROOTS[ident] : HERE.has(ident) ? posix.dirname(f) : undefined;
      if (at === undefined) continue;
      // The longest prefix that is a file or folder: a name built of literals that does not exist yet stops at its folder.
      for (let i = parts.length; i > 0; i--) {
        const n = node(posix.join(at || '.', ...parts.slice(0, i)));
        if (n) { add(n); break; }
      }
    }
    graph.set(f, out);
  }
  return graph;
}

/** Every file or folder edge reaching `file`: the file itself and each folder above it. */
const targetsOf = (file: string): string[] => {
  const t = [file];
  for (let d = posix.dirname(file); d !== '.'; d = posix.dirname(d)) t.push(`${d}/`);
  return t;
};

/** For each test file, every node it reaches; a folder node reaches every file in it, found by prefix. */
export function reverse(graph: Graph): Map<string, Set<string>> {
  const rev = new Map<string, Set<string>>();
  for (const [from, tos] of graph) for (const to of tos) {
    let s = rev.get(to);
    if (!s) rev.set(to, (s = new Set()));
    s.add(from);
  }
  return rev;
}

/** The test files that reach `file`, each with the chain of the first path found (`a ← b ← test`). */
export function testsReaching(rev: Map<string, Set<string>>, file: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue: { node: string; chain: string[] }[] = [];
  const push = (n: string, chain: string[]) => {
    for (const t of n.endsWith('/') ? [n] : targetsOf(n)) for (const by of rev.get(t) ?? []) {
      if (seen.has(by)) continue;
      seen.add(by);
      queue.push({ node: by, chain: [...chain, by] });
    }
  };
  seen.add(file);
  push(file, [file]);
  while (queue.length) {
    const { node, chain } = queue.shift()!;
    if (isTest(node)) found.set(node, chain);
    push(node, chain);
  }
  return found;
}

export interface Selection {
  /** Why the full suite runs instead, when it does. */
  full?: string;
  /** Selected test file → why. */
  tests: Map<string, string>;
  /** Whether the VAT golden master was added for a change of the books' figures. */
  golden: string[];
  /** Changed files no test reaches, with why that is fine. */
  untested: { file: string; why: string }[];
  /** Changed files that call for the VM tests before a release. */
  vm: string[];
}

/** The selection for `changed` (repository paths, deleted ones included) over the files that exist now. */
export function select(root: string, files: string[], changed: string[], rules: Rules = loadRules(), graph: Graph = buildGraph(root, files)): Selection {
  const tests = files.filter(isTest);
  const known = new Set(files);
  const sel: Selection = { tests: new Map(), golden: [], untested: [], vm: changed.filter((f) => matches(f, rules.vm.paths)) };
  const pick = (t: string, why: string) => { if (known.has(t) && !sel.tests.has(t)) sel.tests.set(t, why); };
  const glob = (g: string) => tests.filter((t) => t === g || matchesGlob(t, g));
  for (const f of changed) {
    const full = rules.full.find((r) => matches(f, r.paths));
    if (full) { sel.full = `${f}: ${full.why}`; break; }
  }
  if (sel.full) return sel;
  const rev = reverse(graph);
  for (const f of changed) {
    let reached = false;
    if (isTest(f)) { if (known.has(f)) pick(f, 'changed'); reached = true; }
    for (const [t, chain] of testsReaching(rev, f)) { pick(t, chain.length > 2 ? `reaches ${f} (via ${chain.slice(1, -1).join(' ← ')})` : `reaches ${f}`); reached = true; }
    for (const r of rules.inputs) {
      if (!matches(f, r.paths)) continue;
      for (const g of r.tests ?? []) for (const t of glob(g)) { pick(t, `${f}: ${r.why}`); reached = true; }
      for (const via of r.via ?? []) {
        if (isTest(via)) { pick(via, `${f}: ${r.why}`); reached = true; }
        for (const [t] of testsReaching(rev, via)) { pick(t, `${f}: ${r.why} (${via})`); reached = true; }
      }
    }
    if (matches(f, rules.golden.paths)) { sel.golden.push(f); reached = true; }
    if (reached) continue;
    if (!known.has(f)) sel.untested.push({ file: f, why: 'deleted; what imported it changed with it' });
    else if (matches(f, rules.noTest.paths)) sel.untested.push({ file: f, why: rules.noTest.why });
    else if (isCode(f)) sel.untested.push({ file: f, why: 'no test reaches it' });
    else { sel.full = `${f}: nothing maps this file to its tests (add it to tools/test/inputs.json)`; return sel; }
  }
  if (sel.golden.length) for (const g of rules.golden.tests) pick(g, `${rules.golden.why} (${sel.golden[0]}${sel.golden.length > 1 ? ` and ${sel.golden.length - 1} more` : ''})`);
  for (const g of rules.guards.tests) pick(g, rules.guards.why);
  return sel;
}
