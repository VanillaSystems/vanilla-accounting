/**
 * npm run release:github [-- --publish]: the GitHub release of the version in package.json, with
 * the Mac app's .dmg files (and the update feed's files when they were built) as its downloads.
 * Without --publish it prints the release and changes nothing.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from './notes.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const publish = process.argv.includes('--publish');
const run = (cmd: string, args: string[]): string => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = (msg: string): never => { console.error(`release:github: ${msg}`); process.exit(1); };

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;

const repo = process.env.VANILLA_RELEASES
  ?? run('git', ['remote', 'get-url', 'origin']).match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1]
  ?? fail('no GitHub repository: set VANILLA_RELEASES=owner/repo');

/** What stops a publish; a dry run lists it and goes on. */
function blockers(): string[] {
  if (run('git', ['status', '--porcelain'])) return ['the working tree is not clean'];
  let tagged: string;
  try { tagged = run('git', ['rev-list', '-n', '1', tag]); } catch { return [`no tag ${tag}: tag the release commit first (docs/releasing.md)`]; }
  const found = [];
  if (tagged !== run('git', ['rev-parse', 'HEAD'])) found.push(`${tag} is not the checked-out commit`);
  if (!run('git', ['ls-remote', '--tags', 'origin', tag])) found.push(`${tag} is not pushed: git push --follow-tags`);
  if (!run('git', ['branch', '-r', '--contains', tag]).split('\n').some((b) => b.trim() === 'origin/main')) {
    found.push(`${tag} is not on origin/main: merge and push main first`);
  }
  return found;
}
const blocked = blockers();
if (publish && blocked.length) fail(blocked.join('; '));
for (const b of blocked) console.log(`would refuse to publish: ${b}`);

const dir = join(root, 'release');
const wanted = (f: string) => f.includes(`-${version}-`) && /\.(dmg|zip)$/.test(f);
const files = existsSync(dir) ? readdirSync(dir).filter(wanted) : [];
for (const arch of ['arm64', 'x64']) {
  if (!files.includes(`Vanilla Accounting-${version}-${arch}.dmg`)) fail(`release/Vanilla Accounting-${version}-${arch}.dmg missing: npm run desktop:build`);
}
if (files.some((f) => f.endsWith('.zip')) && existsSync(join(dir, 'latest-mac.yml'))) files.push('latest-mac.yml');
const assets = files.map((name) => ({ name, path: join(dir, name), sha256: createHash('sha256').update(readFileSync(join(dir, name))).digest('hex') }));

const app = join(dir, 'mac-arm64', 'Vanilla Accounting.app');
const codesign = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' });
const signed = /Authority=Developer ID Application/.test(`${codesign.stdout}${codesign.stderr}`);

const notes = releaseNotes({ changelog: readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version, assets, signed });

console.log(`${publish ? 'Publishing' : 'Dry run (add --publish to create it)'}: ${repo} ${tag}, ${signed ? 'signed' : 'unsigned'}`);
for (const a of assets) console.log(`  ${a.name}  ${a.sha256}`);
console.log(`\n${notes}`);
if (!publish) process.exit(0);

let exists = true;
try { run('gh', ['release', 'view', tag, '-R', repo]); } catch { exists = false; }
if (exists) fail(`the release ${tag} exists already on ${repo}; edit or delete it on GitHub first`);

const notesFile = join(mkdtempSync(join(tmpdir(), 'release-')), 'notes.md');
writeFileSync(notesFile, notes);
execFileSync('gh', ['release', 'create', tag, '-R', repo, '--verify-tag', '--title', `Vanilla Accounting ${version}`, '--notes-file', notesFile, ...assets.map((a) => a.path)], { cwd: root, stdio: 'inherit' });
