/**
 * npm run build:audit -- <out-dir> [--workspace <dir|demo|demo-consulting>] [--demo [--download <url>]]
 *
 * Writes the static audit export of a workspace's books into <out-dir>: the app in read-only
 * mode plus books.json, every receipt and statement PDF the books name, the filed returns and
 * manifest.json. It runs from any static file server; docs/audit-export.md says how to hand it
 * over. Real books on a public URL publish them.
 *
 * --demo writes the public demo instead: the same export of one of the app's made-up companies
 * (demo/ unless --workspace names another), with the demo bar in place of the audit bar; --download
 * <url> gives the bar its «App herunterladen» link (docs/audit-export.md, «Publish the demo»).
 */
import { buildAuditExport, ExportError } from '../audit/build.js';
import { manifestHash } from '../audit/manifest.js';
import { openWorkspace } from '../workspace/workspace.js';

const args = process.argv.slice(2);
const demoFlag = args.indexOf('--demo');
const purpose = demoFlag >= 0 ? 'demo' : 'audit';
if (demoFlag >= 0) args.splice(demoFlag, 1);
const downloadFlag = args.indexOf('--download');
const download = downloadFlag >= 0 ? args.splice(downloadFlag, 2)[1] ?? '' : undefined;
const flag = args.indexOf('--workspace');
if (flag >= 0) process.env.VANILLA_WORKSPACE = args.splice(flag, 2)[1] ?? '';
else if (purpose === 'demo') process.env.VANILLA_WORKSPACE = 'demo';
const [outDir] = args;
if (!outDir || args.length > 1) {
  console.error('Usage: npm run build:audit -- <out-dir> [--workspace <dir|demo|demo-consulting>] [--demo [--download <url>]]');
  process.exit(2);
}

const ws = openWorkspace();
try {
  const m = await buildAuditExport(ws, outDir, { purpose, ...(download !== undefined ? { download } : {}) });
  const mb = (m.files.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(1);
  console.log(`${purpose === 'demo' ? 'Demo' : 'Audit export'} of ${ws.company.name} written to ${outDir}: ${m.files.length} files, ${mb} MB.`);
  if (m.missing.length) console.log(`  ${m.missing.length} file(s) the books name are not in the export (not found, a changed invoice PDF, or a logo the app would not show):\n    ${m.missing.join('\n    ')}`);
  if (purpose === 'audit') {
    for (const s of m.seals) console.log(`  seal ${s.quarter}: ${s.status === 'intact' ? `intact through ${s.through}` : `BROKEN: ${s.problem}`}`);
    if (m.unsealed.length) console.log(`  filed quarters without a seal: ${m.unsealed.join(', ')}`);
    console.log(`manifest.json sha256 ${manifestHash(outDir)}\nSend this hash apart from the export; npm run verify-audit -- <dir> checks the files against the manifest.`);
    console.log('Real books on a public URL publish them: serve this folder only behind access protection (docs/audit-export.md).');
  }
} catch (e) {
  if (!(e instanceof ExportError)) throw e;
  console.error(e.message);
  process.exit(1);
}
