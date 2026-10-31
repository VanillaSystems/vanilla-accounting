/**
 * The layout of ADR 0013 and the migration into it (src/workspace/layout.ts): each demo, written
 * back in the layout of 0.3, migrates to exactly the files the app ships, with its seals intact;
 * a rerun and a run cut short end the same; the workspace check names what the app does not know.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { loadBooks, sealsOf } from '../src/books/store.js';
import { layoutChecks } from '../src/workspace/checks.js';
import { applyLayout, isOldLayout, planLayout } from '../src/workspace/layout.js';
import { upgradeWorkspace } from '../src/workspace/upgrade.js';
import { APP_FOLDER, workspaceAt, yearPaths } from '../src/workspace/workspace.js';
import { DEMO_ROOTS } from './support/workspace.js';
import { writeOldLayout } from './support/old-layout.js';

/** Every file under `dir` with its bytes, by path relative to it; data/ is the app's scratch and left out. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) { if (relative(dir, full) !== 'data') walk(full); } else out.set(relative(dir, full), readFileSync(full).toString('base64'));
    }
  };
  walk(dir);
  return out;
}

const oldCopy = (app: string): string => {
  const repo = mkdtempSync(join(tmpdir(), 'layout-'));
  writeOldLayout(app, repo);
  return repo;
};

for (const app of DEMO_ROOTS) {
  const name = app.split('/').at(-2)!;

  test(`${name} in the layout of 0.3 migrates to the files the app ships, every seal intact`, async () => {
    const repo = oldCopy(app);
    assert.ok(isOldLayout(repo));
    const { ws, done } = await upgradeWorkspace(workspaceAt(repo));
    assert.equal(ws.paths.root, join(repo, APP_FOLDER));
    assert.deepEqual(readdirSync(repo).sort(), [APP_FOLDER]);
    assert.deepEqual([...tree(ws.paths.root).keys()].sort(), [...tree(app).keys()].sort());
    for (const [file, bytes] of tree(app)) assert.equal(tree(ws.paths.root).get(file), bytes, file);
    assert.ok(done[0].backup.endsWith('data/backups/books.json.schema-none'));
    assert.ok(sealsOf(loadBooks(ws)).checks.every((c) => c.status === 'intact'));
    assert.equal(isOldLayout(repo), false);
    rmSync(repo, { recursive: true, force: true });
  });

  test(`${name}: a migration cut short finishes on the next run, to the same files`, async () => {
    const repo = oldCopy(app);
    const plan = planLayout(repo);
    for (const m of plan.moves.filter((x) => !x.from.endsWith('.yaml') && statSync(join(repo, x.from)).isFile()).slice(0, 15)) {
      mkdirSync(dirname(join(repo, m.to)), { recursive: true });
      renameSync(join(repo, m.from), join(repo, m.to));
    }
    assert.ok(isOldLayout(repo), 'the manifest moves last, so the books still open as the old layout');
    await applyLayout(planLayout(repo));
    for (const [file, bytes] of tree(app)) assert.equal(tree(join(repo, APP_FOLDER)).get(file), bytes, file);
    rmSync(repo, { recursive: true, force: true });
  });
}

test('the workspace check names every file the layout does not know, and a name in two year folders', () => {
  const repo = oldCopy(DEMO_ROOTS[0]);
  return upgradeWorkspace(workspaceAt(repo)).then(({ ws }) => {
    assert.deepEqual(layoutChecks(ws.paths).map((r) => r.status), ['ok']);
    writeFileSync(join(repo, 'notes.md'), '');
    mkdirSync(join(repo, 'own'));
    writeFileSync(join(ws.paths.root, 'scratch.txt'), '');
    writeFileSync(join(yearPaths(ws.paths, '2026').root, 'old-export.tsv'), '');
    mkdirSync(yearPaths(ws.paths, '2025').receipts, { recursive: true });
    const name = readdirSync(yearPaths(ws.paths, '2026').receipts)[0];
    writeFileSync(join(yearPaths(ws.paths, '2025').receipts, name), '');
    const results = layoutChecks(ws.paths);
    assert.deepEqual(results.map((r) => `${r.status} ${r.label}`), [
      'warn notes.md is not part of the workspace',
      `warn ${APP_FOLDER}/scratch.txt is not part of the workspace`,
      `warn ${APP_FOLDER}/transactional-data/2026/old-export.tsv is not part of the workspace`,
      `fail receipts/${name} lies in two year folders`,
    ]);
    assert.ok(results.every((r) => r.status !== 'warn' || r.note === 'move it to own/ or delete it'));
    rmSync(repo, { recursive: true, force: true });
  });
});
