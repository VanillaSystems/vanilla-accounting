/**
 * src/workspace: the manifest is the boundary, so a malformed one fails at open naming the field,
 * and openWorkspace finds the workspace by env or by walking up from the cwd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, MANIFEST_FILE, WorkspaceError, identityIn, workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT, tempWorkspace } from './support/workspace.js';

const manifest = readFileSync(join(DEMO_ROOT, MANIFEST_FILE), 'utf8');

test('the demo manifest opens: bank accounts in file order, paths on the fixed layout', () => {
  const ws = workspaceAt(DEMO_ROOT);
  assert.equal(ws.company.uid, 'CHE-123.456.789');
  assert.deepEqual(ws.bankAccounts.map((a) => `${a.bank} ${a.currency} ${a.account}`), [
    'Raiffeisen CHF 1021', 'Wise EUR 1023', 'manual CHF 2451',
  ]);
  assert.equal(ws.paths.books, join(DEMO_ROOT, 'books.json'));
  assert.equal(ws.paths.inbox, join(DEMO_ROOT, 'beleg-import'));
});

test('a malformed manifest fails at open, naming the field', () => {
  const ws = tempWorkspace();
  const bad = (from: string, to: string, msg: RegExp) => {
    writeFileSync(ws.paths.manifest, manifest.replace(from, to));
    assert.throws(() => workspaceAt(ws.paths.root), (e: Error) => e instanceof WorkspaceError && msg.test(e.message), msg.source);
  };
  bad('schema: 1', 'schema: 2', /schema must be 1/);
  bad(/uid: .*/.exec(manifest)![0], 'uid: "123456789"', /company\.uid "123456789"/);
  bad('method: effective', 'method: flat', /company\.vat/);
  bad('account: "1023"', 'account: "10x"', /bankAccounts\[1\]\.account/);
  bad('{ bank: Wise, currency: EUR,', '{ bank: Raiffeisen, currency: CHF,', /Raiffeisen CHF is listed twice/);
  rmSync(ws.paths.root, { recursive: true, force: true });
});

test('openWorkspace: BELEGE_WORKSPACE first, else the nearest manifest above the cwd, else an error', () => {
  const ws = tempWorkspace();
  const deep = join(ws.paths.root, 'receipts', 'deep');
  mkdirSync(deep, { recursive: true });
  const nowhere = mkdtempSync(join(tmpdir(), 'no-ws-'));
  const script = `import(${JSON.stringify(pathToFileURL(join(APP_ROOT, 'src/workspace/workspace.ts')).href)})`
    + '.then((m) => console.log(m.openWorkspace().paths.root)).catch((e) => console.log(e.constructor.name))';
  const open = (cwd: string, env: Record<string, string> = {}) => {
    const { BELEGE_WORKSPACE: _, ...rest } = process.env;
    // An empty BELEGE_WORKSPACE also skips the app's .env, so a developer's own .env can't leak in.
    return execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '-e', script], { cwd, env: { ...rest, BELEGE_WORKSPACE: '', ...env }, encoding: 'utf8' }).trim();
  };
  const root = realpathSync(ws.paths.root);
  assert.equal(open(nowhere, { BELEGE_WORKSPACE: ws.paths.root }), root);
  assert.equal(open(nowhere, { BELEGE_WORKSPACE: 'demo' }), realpathSync(DEMO_ROOT), 'demo is the shipped demo');
  assert.equal(open(nowhere, { BELEGE_WORKSPACE: 'demo-consulting' }), realpathSync(join(APP_ROOT, 'demo-consulting')), 'demo-<name> is another shipped demo');
  assert.equal(open(nowhere, { BELEGE_WORKSPACE: 'demo-nonesuch' }), 'WorkspaceError', 'a demo name with no demo behind it');
  assert.equal(open(deep), root, 'walks up from a subdirectory');
  assert.equal(open(nowhere, { BELEGE_WORKSPACE: deep }), 'WorkspaceError', 'the env names the workspace root itself');
  assert.equal(open(nowhere), 'WorkspaceError', 'no workspace above the cwd');
  rmSync(ws.paths.root, { recursive: true, force: true });
  rmSync(nowhere, { recursive: true, force: true });
});

test('identityIn: the check-processes lint finds the company name, UID or UID digits in code', () => {
  const { company } = workspaceAt(DEMO_ROOT);
  const digits = company.uid.replace(/\D/g, '');
  assert.deepEqual(identityIn(`const MWST_NR = '${company.uid} MWST';`, company), [company.uid]);
  assert.deepEqual(identityIn(`// accounting assistant for ${company.name.toUpperCase()}`, company), [company.name]);
  assert.deepEqual(identityIn(`<uid>CHE${digits}</uid>`, company), [digits]);
  assert.deepEqual(identityIn(`const n = 1${digits}0; const who = ws.company.name;`, company), [], 'a longer number and the manifest read are fine');
});
