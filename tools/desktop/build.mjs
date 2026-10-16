/**
 * Builds the desktop app's main process and preload (src/desktop) into out/desktop/. The bundle
 * holds the app's own code; packages stay in node_modules, and each one it imports must be a
 * dependency in package.json, since electron-builder packs only those. A package the app does not
 * pack (desktop/not-packed.cjs) may only be imported dynamically, on a path the app does not take.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { build } from 'esbuild';
import { describeBuild } from '../../src/version.ts';
import { iconProblems } from '../brand/icons.mjs';

const { NOT_PACKED } = createRequire(import.meta.url)('../../desktop/not-packed.cjs');

// The dmg carries the brand's icon or none: an old icon brought back by a merge stops the build here.
const icons = iconProblems();
if (icons.length) { console.error(`desktop:build refused, the icons are not the brand's:\n  ${icons.join('\n  ')}`); process.exit(1); }

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// The packed app has no git: its build is baked in, and electron-builder names the dmg after it.
const app = describeBuild(process.cwd());
mkdirSync('out/desktop', { recursive: true });
writeFileSync('out/desktop/build.json', JSON.stringify(app));
const common = { define: { 'process.env.VANILLA_BUILD': JSON.stringify(app.version), 'process.env.VANILLA_BUILT_AT': JSON.stringify(new Date().toISOString()) }, bundle: true, platform: 'node', target: 'node22', packages: 'external', sourcemap: 'linked', logLevel: 'warning', metafile: true };

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
const loadedAtStart = new Set(results.flatMap((r) => Object.values(r.metafile.inputs).flatMap((i) => i.imports))
  .filter((i) => i.external && i.kind !== 'dynamic-import').map((i) => packageOf(i.path)));
const unpacked = Object.keys(NOT_PACKED).filter((p) => loadedAtStart.has(p));
if (unpacked.length) {
  console.error(`The desktop bundle imports ${unpacked.join(', ')} at start, which desktop/not-packed.cjs leaves out of the app: import it dynamically where it is used.`);
  process.exit(1);
}
console.log(`out/desktop: main.mjs, preload.cjs, build ${app.version} (packages: ${[...imported].sort().join(', ')})`);
