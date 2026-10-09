/**
 * npm run check-public [-- <dir>] [--structural]
 *
 * The leak guard (src/publish/leak-guard.ts) over a tree, the app repo by default. A tree with a
 * workspace manifest at its root is a private repo: only the files public-files.txt lists are
 * scanned, as an export would publish them. Any other tree (an export, the public repo) must
 * list every file it has. The secrets come from the workspace (BELEGE_WORKSPACE); --structural,
 * or no real workspace, runs only the half that needs none. Exit 1 on any finding.
 */
import { resolve } from 'node:path';
import { APP_ROOT } from '../workspace/workspace.js';
import { formatFindings } from '../publish/leak-guard.js';
import { checkTree, secretsOrWhyNot } from '../publish/sources.js';

const args = process.argv.slice(2);
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? APP_ROOT);
const got = args.includes('--structural') ? { why: '--structural' } : secretsOrWhyNot();
if ('why' in got) console.error(`check-public: structural half only (${got.why}).`);
const findings = checkTree(dir, 'secrets' in got ? got.secrets : []);
console.log(formatFindings(findings));
process.exit(findings.length ? 1 : 0);
