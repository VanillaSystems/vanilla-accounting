/**
 * npm run export-public -- <dir>
 *
 * Writes the public app repo's tree into <dir>: the files of this repo that public-files.txt
 * lists, nothing else, then runs check-public on <dir> with the workspace's secrets and fails
 * on any finding. Idempotent: <dir> is emptied first (all but a .git a later publish may have
 * put there), so a rerun converges on the same tree. It never creates a git repo and never pushes.
 * <dir> must be empty, absent, or an earlier export (it holds public-files.txt).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { APP_ROOT } from '../workspace/workspace.js';
import { formatFindings, isAllowed } from '../publish/leak-guard.js';
import { ALLOWLIST_FILE, checkTree, filesOf, loadAllowlist, secretsOrWhyNot } from '../publish/sources.js';

const arg = process.argv[2];
if (!arg) { console.error('usage: npm run export-public -- <dir>'); process.exit(2); }
const out = resolve(arg);
const fail = (msg: string): never => { console.error(`export-public: ${msg}`); process.exit(2); };
const rel = relative(APP_ROOT, out);
if (!rel.startsWith('..') && !isAbsolute(rel)) fail(`${out} is inside the app repo; export outside it.`);

const got = secretsOrWhyNot();
if ('why' in got) fail(`no secrets to check against (${got.why}). Set BELEGE_WORKSPACE to the real workspace.`);

if (existsSync(out)) {
  const entries = readdirSync(out).filter((e) => e !== '.git');
  if (entries.length && !entries.includes(ALLOWLIST_FILE)) fail(`${out} is neither empty nor an earlier export; refusing to empty it.`);
  for (const e of entries) rmSync(join(out, e), { recursive: true, force: true });
}

const allowlist = loadAllowlist();
const files = filesOf(APP_ROOT).filter((p) => isAllowed(p, allowlist));
for (const p of files) {
  mkdirSync(dirname(join(out, p)), { recursive: true });
  copyFileSync(join(APP_ROOT, p), join(out, p));
}
console.log(`export-public: ${files.length} files → ${out}`);

const findings = checkTree(out, 'secrets' in got ? got.secrets : []);
console.log(formatFindings(findings));
process.exit(findings.length ? 1 : 0);
