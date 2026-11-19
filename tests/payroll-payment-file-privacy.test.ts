/**
 * The month's payment files hold names, IBANs and net wages (docs/specs/payroll.md §11, §22 decision 69): they
 * follow the payslips' rules. The AI sidebar never reads them, a hand-over or a share carries them like
 * payroll/payslips.jsonl, the server and the dev proxy treat their URL as a file of the books, and the static audit
 * export (and so the public demo) carries none of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { NEVER_READ } from '../src/assistant/claude.js';
import { carriageOf } from '../src/handover/content.js';
import { isApiPath } from '../src/server/app-paths.js';
import { buildAuditExport } from '../src/audit/build.js';
import { keepPaymentFile } from '../src/payroll/service.js';
import { APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';

const LOG = 'transactional-data/2026/payroll/payment-files.jsonl';
const XML = 'transactional-data/2026/payroll/payment-files/L202610-20261119120000.xml';

test('the sidebar never reads a payment file or its log', () => {
  for (const p of [LOG, XML]) {
    const path = `/repo/vanilla-accounting/${p}`;
    assert.ok(NEVER_READ.some((g) => matchesGlob(path, g)), `${p} is denied to the sidebar`);
  }
});

test('a hand-over and a share carry them as they carry the payslips', () => {
  assert.equal(carriageOf(LOG), carriageOf('transactional-data/2026/payroll/payslips.jsonl'));
  assert.equal(carriageOf(XML), 'whole');
});

test('their URL is a file of the books: served by the API, proxied in development', () => {
  assert.ok(isApiPath('/payroll/payments/2026-10/payment-files/L202610-20261119120000.xml'));
  assert.ok(!isApiPath('/payroll/payments/2026-10'), 'the page of the month stays the app\'s');
});

test('the static audit export carries no payment file', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'payfile-export-'));
  try {
    cpSync(join(APP_ROOT, 'demo-schreinerei'), join(tmp, 'ws'), { recursive: true });
    const ws = workspaceAt(join(tmp, 'ws'));
    const iban = ['CH76', '0900', '0000', '1234', '5678', '9'].join('');
    keepPaymentFile(ws, { id: 'L202610-20261119120000', month: '2026-10', at: '2026-11-19T12:00:00.000Z', account: '1020', payslips: ['2026-10-nina'], total: 1694 }, `<Document><IBAN>${iban}</IBAN></Document>`);
    assert.ok(existsSync(join(ws.paths.root, XML)));
    const out = join(tmp, 'out');
    await buildAuditExport(ws, out, { createdAt: '2026-11-19T12:00:00.000Z' });
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
    walk(out);
    assert.ok(files.length > 0);
    assert.deepEqual(files.filter((f) => f.includes('payment-files')), []);
    assert.deepEqual(files.filter((f) => readFileSync(f).includes(iban)), [], 'no file of the export names the IBAN');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
