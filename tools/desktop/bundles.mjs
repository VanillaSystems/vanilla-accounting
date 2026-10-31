/**
 * The desktop app's two bundles (main process and preload) into out/desktop/: built once by
 * build.mjs, rebuilt on change by dev.mjs. `app` is the build that names itself (src/version.ts).
 */
export function bundles(app) {
  const common = { define: { 'process.env.VANILLA_BUILD': JSON.stringify(app.version), 'process.env.VANILLA_BUILT_AT': JSON.stringify(new Date().toISOString()) }, bundle: true, platform: 'node', target: 'node22', packages: 'external', sourcemap: 'linked', logLevel: 'warning', metafile: true };
  return [
    { ...common, entryPoints: ['src/desktop/main.ts'], outfile: 'out/desktop/main.mjs', format: 'esm' },
    { ...common, entryPoints: ['src/desktop/preload.ts'], outfile: 'out/desktop/preload.cjs', format: 'cjs' },
  ];
}
