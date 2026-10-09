/**
 * npm run verify-audit -- <dir>
 *
 * Checks a static audit export (npm run build:audit) against its manifest.json: every file
 * there with the same SHA-256, none missing, none added. Exit 1 on any difference.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { manifestHash, MANIFEST, verifyExport, type ExportManifest } from '../audit/manifest.js';

const [dir] = process.argv.slice(2);
if (!dir) {
  console.error('Usage: npm run verify-audit -- <dir>');
  process.exit(2);
}
const problems = verifyExport(dir);
if (problems.length) {
  console.error(`The export in ${dir} differs from its manifest:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as ExportManifest;
console.log(`ok: ${m.files.length} files as exported on ${m.snapshot.createdAt} (app v${m.snapshot.appVersion}, books schema ${m.snapshot.booksSchema}).`);
for (const s of m.seals) console.log(`  seal ${s.quarter}: ${s.status === 'intact' ? `intact through ${s.through} (${s.sha256})` : `BROKEN at export: ${s.problem}`}`);
console.log(`manifest.json sha256 ${manifestHash(dir)}: compare it with the hash sent with the export.`);
