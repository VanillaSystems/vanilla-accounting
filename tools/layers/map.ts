/**
 * Which layer each file of src/ belongs to (docs/0.4.0/layers.md), and the imports that point the
 * wrong way. tests/layers.test.ts enforces the direction; tools/layers/inventory.ts writes
 * docs/0.4.0/inventory.md from the same table.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export type Layer = 'core' | 'engine' | 'provider' | 'split' | 'infrastructure' | 'workflow' | 'view';

/** "split" holds generic logic and Swiss data together until migration step 10 takes it apart. */
export const LAYER_OF: [prefix: string, layer: Layer][] = [
  ['src/accounting/periods.ts', 'core'],
  ['src/accounting/rappen.ts', 'core'],
  ['src/accounting/ledger.ts', 'core'],
  ['src/accounting/validate.ts', 'core'],
  ['src/accounting/declarations.ts', 'core'],
  ['src/accounting/', 'split'],
  ['src/books/', 'core'],
  ['src/core/', 'core'],
  ['src/types/', 'core'],
  ['src/workspace/', 'core'],
  ['src/engines/', 'engine'],
  ['src/providers/', 'provider'],
  ['src/parsers/receipt-text.ts', 'split'],
  ['src/parsers/', 'infrastructure'],
  ['src/export/', 'provider'],
  ['src/booking/', 'split'],
  ['src/intake/', 'split'],
  ['src/invoices/', 'split'],
  ['src/knowledge/', 'split'],
  ['src/collect/', 'split'],
  ['src/workflows/', 'workflow'],
  ['src/assistant/', 'workflow'],
  ['src/llm/', 'infrastructure'],
  ['src/audit/', 'infrastructure'],
  ['src/secrets/', 'infrastructure'],
  ['src/publish/', 'infrastructure'],
  ['src/reconcile/', 'infrastructure'],
  ['src/saving/', 'infrastructure'],
  ['src/app/', 'view'],
  ['src/server/', 'view'],
  ['src/cli/', 'view'],
  ['src/desktop/', 'view'],
];

/** The layers a file of each layer may import. Views import everything; nothing imports a view. */
export const MAY_IMPORT: Record<Layer, Layer[]> = {
  core: ['core'],
  engine: ['engine', 'core'],
  provider: ['provider', 'infrastructure', 'core'],
  split: ['split', 'engine', 'provider', 'core', 'infrastructure'],
  infrastructure: ['infrastructure', 'split', 'engine', 'provider', 'core'],
  workflow: ['workflow', 'infrastructure', 'split', 'engine', 'provider', 'core'],
  view: ['view', 'workflow', 'infrastructure', 'split', 'engine', 'provider', 'core'],
};

export function layerOf(file: string): Layer {
  const hit = LAYER_OF.find(([prefix]) => file.startsWith(prefix));
  if (!hit) throw new Error(`${file} has no layer: add it to LAYER_OF in tools/layers/map.ts`);
  return hit[1];
}

export function sourceFiles(root: string, dir = 'src'): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const path = `${dir}/${d.name}`;
    if (d.isDirectory()) return sourceFiles(root, path);
    return /\.tsx?$/.test(d.name) && !d.name.endsWith('.d.ts') ? [path] : [];
  });
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Relative imports of a file, resolved to repo paths (`.js` → `.ts`/`.tsx`), plus `node:` modules. */
export function importsOf(root: string, file: string): string[] {
  const out: string[] = [];
  for (const m of readFileSync(join(root, file), 'utf8').matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec.startsWith('node:')) out.push(spec);
    else if (spec.startsWith('.')) {
      const base = relative(root, resolve(root, dirname(file), spec)).replace(/\.js$/, '');
      const hit = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => existsIn(root, p));
      if (hit) out.push(hit);
    }
  }
  return out;
}

const existsIn = (root: string, path: string) => { try { readFileSync(join(root, path)); return true; } catch { return false; } };

/** Every import that points the wrong way, as `from -> to`. Engines also may not touch node: (they run in the browser). */
export function violations(root: string): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(root)) {
    const from = layerOf(file);
    for (const to of importsOf(root, file)) {
      const bad = to.startsWith('node:') ? from === 'engine' : to.startsWith('src/') && !MAY_IMPORT[from].includes(layerOf(to));
      if (bad) out.push(`${file} -> ${to}`);
    }
  }
  return [...new Set(out)].sort();
}
