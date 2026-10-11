/**
 * npm run migrate-workspace [-- --dry-run]
 *
 * Moves the open workspace's knowledge into knowledge/ (src/workspace/migrate.ts):
 * counterparties/<id>.yaml into knowledge/suppliers/, customers/ or authorities/, and
 * policy/<process>.guide.yaml into knowledge/rules/. Uses git mv in a git workspace, so the
 * history follows the files; commit the result. Safe to rerun. --dry-run prints the plan only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appRoles, migrate, planMigration } from '../workspace/migrate.js';
import { APP_ROOT, openWorkspace } from '../workspace/workspace.js';

const dryRun = process.argv.includes('--dry-run');
const { root } = openWorkspace().paths;
const plan = planMigration(root, appRoles(APP_ROOT));

const line = (m: { from: string; to: string; why: string; unsure?: boolean }) =>
  `  ${m.unsure ? 'unsure' : '      '}  ${m.from.padEnd(44)} → ${m.to}  (${m.why})`;

if (dryRun) {
  console.log(`Plan for ${root} (nothing moved):`);
  for (const m of plan) console.log(line(m));
  process.exit(0);
}

const result = await migrate(root, plan);
console.log(`Workspace ${root}:`);
for (const m of result.moved) console.log(line(m));
if (result.done.length) console.log(`  ${result.done.length} file(s) already in knowledge/`);
if (result.removed.length) console.log(`  removed ${result.removed.join(', ')}`);
for (const f of result.leftover) console.log(`  left    ${f}: not a knowledge file — move or delete it, the app refuses the old folders`);
const unsure = result.moved.filter((m) => m.unsure);
if (unsure.length) console.log(`\n${unsure.length} file(s) went to suppliers/ for want of a sign; move any that is a customer or an authority.`);

// Prose of the company that still names the old folders: a person rewrites it.
const SKIP = new Set(['.git', 'node_modules', 'receipts', 'beleg-import', 'bank-statements', 'filings', 'history', 'data', 'golden']);
const texts = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = dir ? `${dir}/${e.name}` : e.name;
  if (e.isDirectory()) return SKIP.has(e.name) ? [] : texts(rel);
  return /\.(md|ya?ml)$/.test(e.name) ? [rel] : [];
});
const stale = texts('').filter((f) => /\b(counterparties|policy)\//.test(readFileSync(join(root, f), 'utf8')));
if (stale.length) console.log(`\nStill naming counterparties/ or policy/ (rewrite to knowledge/…): ${stale.join(', ')}`);
console.log(result.moved.length ? '\nReview with git status, then commit.' : '\nNothing to move.');
