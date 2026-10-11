/**
 * Builds the desktop app's main process and preload (src/desktop) into out/desktop/. The bundle
 * holds the app's own code; packages stay in node_modules, and each one it imports must be a
 * dependency in package.json, since electron-builder packs only those.
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const common = { bundle: true, platform: 'node', target: 'node22', packages: 'external', sourcemap: 'linked', logLevel: 'warning', metafile: true };

const results = await Promise.all([
  build({ ...common, entryPoints: ['src/desktop/main.ts'], outfile: 'out/desktop/main.mjs', format: 'esm' }),
  build({ ...common, entryPoints: ['src/desktop/preload.ts'], outfile: 'out/desktop/preload.cjs', format: 'cjs' }),
]);

const builtin = new Set(builtinModules);
const packageOf = (spec) => spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
const imported = new Set(results.flatMap((r) => Object.values(r.metafile.inputs).flatMap((i) => i.imports))
  .filter((i) => i.external && !i.path.startsWith('node:') && !builtin.has(i.path)).map((i) => packageOf(i.path)));
const missing = [...imported].filter((p) => p !== 'electron' && !(p in (pkg.dependencies ?? {})));
if (missing.length) {
  console.error(`The desktop bundle imports ${missing.join(', ')}, which package.json lists not under dependencies: the packed app would not find it.`);
  process.exit(1);
}
console.log(`out/desktop: main.mjs, preload.cjs (packages: ${[...imported].sort().join(', ')})`);
