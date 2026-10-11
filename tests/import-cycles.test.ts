/**
 * The UI's modules import each other without a cycle. Vite's HMR cannot swap a module that
 * imports itself back (an area importing the registry that imports it), and the page then dies
 * with a createRoot error until it is reloaded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve('src/app');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);
}

/** The local modules a file needs at run time: type-only imports are erased and don't count. */
function runtimeImports(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const out: string[] = [];
  for (const s of src.statements) {
    if (!ts.isImportDeclaration(s) && !ts.isExportDeclaration(s)) continue;
    if (!s.moduleSpecifier || !ts.isStringLiteral(s.moduleSpecifier) || !s.moduleSpecifier.text.startsWith('.')) continue;
    if (ts.isImportDeclaration(s)) {
      const c = s.importClause;
      if (c?.isTypeOnly) continue;
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : undefined;
      if (c && !c.name && named && named.every((e) => e.isTypeOnly)) continue;
    } else if (s.isTypeOnly) continue;
    const base = resolve(dirname(file), s.moduleSpecifier.text).replace(/\.js$/, '');
    const hit = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((x) => base + x).find(existsSync);
    if (hit) out.push(hit);
  }
  return out;
}

test('the UI has no runtime import cycle', () => {
  const graph = new Map(sources(ROOT).map((f) => [f, runtimeImports(f)]));
  const cycles: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const visit = (f: string) => {
    state.set(f, 'open');
    stack.push(f);
    for (const d of graph.get(f) ?? []) {
      if (state.get(d) === 'open') cycles.push([...stack.slice(stack.indexOf(d)), d].map((x) => relative(ROOT, x)).join(' → '));
      else if (!state.has(d)) visit(d);
    }
    stack.pop();
    state.set(f, 'done');
  };
  for (const f of graph.keys()) if (!state.has(f)) visit(f);
  assert.deepEqual(cycles, []);
});
