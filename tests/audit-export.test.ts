/**
 * The static audit export (npm run build:audit) of the demo, served by a plain static file server
 * under a sub-path: every read the UI makes is a file there, and manifest.json catches a change.
 * The --demo export is the same machinery with the demo bar, and takes only the app's demos.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAuditExport } from '../src/audit/build.js';
import { verifyExport } from '../src/audit/manifest.js';
import { DOWNLOAD_URL } from '../src/app/brand/names.js';
import { EXPORT_SOURCES } from '../src/audit/sources.js';
import type { ApiStatus } from '../src/types/api-error.js';
import type { Index } from '../src/types/index.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { serveStatic, type StaticServer } from './support/static-server.js';

const tmp = mkdtempSync(join(tmpdir(), 'audit-export-'));
const dir = join(tmp, 'host', 'snapshot');
const demoDir = join(tmp, 'host', 'accounting', 'demo');
let server: StaticServer;
let base: string;

before(async () => {
  await buildAuditExport(workspaceAt(join(APP_ROOT, 'demo')), dir, { createdAt: '2026-10-09T12:00:00.000Z' });
  await buildAuditExport(workspaceAt(join(APP_ROOT, 'demo')), demoDir, { purpose: 'demo', createdAt: '2026-10-09T12:00:00.000Z' });
  server = await serveStatic(join(tmp, 'host'));
  base = `${server.url}/snapshot/`;
});
after(async () => {
  await server?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const get = (url: string) => fetch(new URL(url, base));
const json = async <T>(url: string) => (await get(url)).json() as Promise<T>;

test('every read the UI makes is a file of the export, under any base path', async () => {
  const books = await json<Index>(EXPORT_SOURCES.books());
  const years = new Set(books.transactions.map((t) => t.date.slice(0, 4)));
  const urls = [
    EXPORT_SOURCES.status(), EXPORT_SOURCES.accounts(), EXPORT_SOURCES.workspace(), EXPORT_SOURCES.fxRates(),
    ...[...years].map((y) => EXPORT_SOURCES.filedReturns(y)),
    ...books.receipts.map((r) => EXPORT_SOURCES.receipt(r.id)),
    ...books.bankStatements.map((s) => EXPORT_SOURCES.statement(s.bank, s.filename)),
  ];
  assert.ok(books.receipts.length > 10 && books.bankStatements.length > 5, 'the demo names receipts and statements');
  const failed: string[] = [];
  for (const url of urls) {
    const res = await get(url);
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || (url.endsWith('.pdf') && !body.subarray(0, 5).equals(Buffer.from('%PDF-')))) failed.push(`${res.status} ${url}`);
  }
  assert.deepEqual(failed, []);

  const html = await (await get('')).text();
  assert.match(html, /src="\.\/assets\/index-[\w-]+\.js"/, 'the app loads its script relative to index.html');
  assert.doesNotMatch(html, /(src|href)="\/(?!\/)/, 'no root-absolute URL in index.html');
});

test('the status is a read-only snapshot naming its date, schema and app version', async () => {
  const status = await json<ApiStatus>(EXPORT_SOURCES.status());
  const { version } = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.deepEqual(status, { ok: true, readonly: true, snapshot: { purpose: 'audit', createdAt: '2026-10-09T12:00:00.000Z', booksSchema: 1, appVersion: version } });
});

test('the filed returns of the demo are in the export', async () => {
  const filed = await json<Array<{ period: string }>>(EXPORT_SOURCES.filedReturns('2026'));
  assert.deepEqual(filed.map((f) => f.period), ['2026-Q1']);
});

test('the manifest verifies the export as made and names the seals', () => {
  assert.deepEqual(verifyExport(dir), []);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.seals.map((s: { quarter: string; status: string }) => `${s.quarter} ${s.status}`), ['2026-Q1 intact']);
  assert.deepEqual(manifest.missing, []);
  assert.ok(manifest.files.some((f: { path: string }) => f.path === 'books.json'));
});

test('verify-audit fails on a changed, an added and a removed file', () => {
  const copy = join(tmp, 'tampered');
  cpSync(dir, copy, { recursive: true });
  const books = JSON.parse(readFileSync(join(copy, 'books.json'), 'utf8')) as Index;
  const receipt = EXPORT_SOURCES.receipt(books.receipts[0].id);
  appendFileSync(join(copy, receipt), ' ');
  writeFileSync(join(copy, 'data', 'extra.json'), '{}');
  unlinkSync(join(copy, EXPORT_SOURCES.accounts()));

  const problems = verifyExport(copy);
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems.find((p) => p.startsWith(receipt)) ?? '', /changed/);
  assert.match(problems.find((p) => p.startsWith('data/extra.json')) ?? '', /not in the manifest/);
  assert.match(problems.find((p) => p.startsWith('data/accounts.json')) ?? '', /missing/);

  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/verify-audit.ts', copy], { cwd: APP_ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /differs from its manifest/);
});

test('a non-empty folder that holds no export is refused, not emptied', async () => {
  const other = join(tmp, 'someone-elses');
  mkdirSync(other);
  writeFileSync(join(other, 'keep.txt'), 'mine');
  await assert.rejects(buildAuditExport(workspaceAt(join(APP_ROOT, 'demo')), other), /not empty and holds no audit export/);
  assert.equal(readFileSync(join(other, 'keep.txt'), 'utf8'), 'mine');
});

const scriptsOf = (root: string) => readdirSync(join(root, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(root, 'assets', f), 'utf8')).join('\n');

test('--demo: the status says demo, the app links the download and loads from under its sub-path', async () => {
  const status = await (await fetch(new URL(EXPORT_SOURCES.status(), `${server.url}/accounting/demo/`))).json() as ApiStatus;
  assert.equal(status.snapshot?.purpose, 'demo');
  assert.deepEqual(verifyExport(demoDir), []);
  const html = readFileSync(join(demoDir, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /(src|href)="\/(?!\/)/, 'no root-absolute URL in index.html');
  assert.ok(scriptsOf(demoDir).includes(DOWNLOAD_URL), 'the demo bar links the download');
  assert.ok(!scriptsOf(dir).includes(DOWNLOAD_URL), 'the audit export has no download link');
});

test('--demo takes only the app\'s own demo workspaces', async () => {
  const copy = join(tmp, 'books');
  cpSync(join(APP_ROOT, 'demo'), copy, { recursive: true });
  const out = join(tmp, 'public');
  await assert.rejects(buildAuditExport(workspaceAt(copy), out, { purpose: 'demo' }), /not one of the app's demo workspaces/);
  assert.throws(() => readdirSync(out), 'nothing was written');
});
