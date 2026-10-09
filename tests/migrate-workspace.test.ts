/**
 * npm run migrate-workspace moves a workspace's knowledge into knowledge/ without changing a
 * byte of it, sorts each business into the folder of its role, and converges on a rerun.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { appRoles, migrate, planMigration, roleOf } from '../src/workspace/migrate.js';
import { APP_ROOT } from '../src/workspace/workspace.js';

const OLD: Record<string, string> = {
  'counterparties/swiss-post.yaml': 'id: swiss-post\naccounts: ["6510"]\n',
  'counterparties/kunde.yaml': 'id: kunde\nname: Kunde AG\nmatch: { tx: [kunde ag] }\naccounts: ["3400"]\n',
  'counterparties/ausgleichskasse-muster.yaml': 'id: ausgleichskasse-muster\nname: Ausgleichskasse Muster\nmatch: { tx: [akmuster] }\naccounts: ["5700"]\n',
  'counterparties/raetsel.yaml': 'id: raetsel\nname: Rätsel GmbH\nmatch: { tx: [raetsel] }\n',
  'counterparties/.gitkeep': '',
  'policy/booking.guide.yaml': 'steps: { classify: { rules: [] } }\n',
};

function oldWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'vanilla-migrate-'));
  for (const [path, text] of Object.entries(OLD)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'old layout');
  return root;
}

test('each business goes to the folder of its role; one nothing tells apart is a supplier, flagged', () => {
  assert.deepEqual(roleOf({ id: 'fedex' }, 'supplier'), { role: 'supplier', why: 'the app files it under suppliers/' });
  assert.equal(roleOf({ name: 'Eidg. Steuerverwaltung ESTV', accounts: ['2200'] }, undefined).role, 'authority');
  assert.equal(roleOf({ name: 'Kunde AG', accounts: ['3400', '3200'] }, undefined).role, 'customer');
  assert.deepEqual(roleOf({ name: 'Both AG', accounts: ['3400', '4000'] }, undefined), { role: 'supplier', why: 'books to revenue and costs (3400, 4000)', unsure: true });
});

test('the migration moves files unchanged, with git history, and a rerun changes nothing', () => {
  const root = oldWorkspace();
  const plan = planMigration(root, appRoles(APP_ROOT));
  assert.deepEqual(plan.map((m) => [m.from, m.to, !!m.unsure]), [
    ['counterparties/ausgleichskasse-muster.yaml', 'knowledge/authorities/ausgleichskasse-muster.yaml', false],
    ['counterparties/kunde.yaml', 'knowledge/customers/kunde.yaml', false],
    ['counterparties/raetsel.yaml', 'knowledge/suppliers/raetsel.yaml', true],
    ['counterparties/swiss-post.yaml', 'knowledge/suppliers/swiss-post.yaml', false],
    ['policy/booking.guide.yaml', 'knowledge/rules/booking.guide.yaml', false],
  ]);
  const first = migrate(root, plan);
  assert.equal(first.moved.length, 5);
  assert.deepEqual(first.removed, ['counterparties/', 'policy/']);
  for (const m of plan) assert.equal(readFileSync(join(root, m.to), 'utf8'), OLD[m.from], `${m.to} is ${m.from} byte for byte`);
  assert.ok(!existsSync(join(root, 'counterparties')) && !existsSync(join(root, 'policy')));
  const status = execFileSync('git', ['-C', root, 'status', '--short'], { encoding: 'utf8' });
  assert.match(status, /^R {2}counterparties\/kunde\.yaml -> knowledge\/customers\/kunde\.yaml$/m, 'git sees a rename, so history follows');

  const again = migrate(root, planMigration(root, appRoles(APP_ROOT)));
  assert.deepEqual([again.moved, again.removed], [[], []]);

  const ids = loadKnowledge(APP_ROOT, root).counterparties.filter((c) => c.origin.binding).map((c) => [c.id, c.role]);
  assert.deepEqual(ids, [['ausgleichskasse-muster', 'authority'], ['kunde', 'customer'], ['raetsel', 'supplier'], ['swiss-post', 'supplier']]);
});

test('a file in both places stops the migration before anything moves', () => {
  const root = oldWorkspace();
  mkdirSync(join(root, 'knowledge/rules'), { recursive: true });
  writeFileSync(join(root, 'knowledge/rules/booking.guide.yaml'), 'steps: {}\n');
  assert.throws(() => migrate(root, planMigration(root, appRoles(APP_ROOT))), /in both places, keep one: policy\/booking\.guide\.yaml and knowledge\/rules\/booking\.guide\.yaml/);
  assert.ok(existsSync(join(root, 'counterparties/kunde.yaml')), 'nothing moved');
});
