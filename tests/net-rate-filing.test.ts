/**
 * The filing of a firm on the net tax rate method without the tax authority's activity code
 * (persona round 6, r6f-22): the review task names the missing code and withholds «Freigegeben»,
 * the XML step refuses with a coded reason the screens have words for, and «Weiter» goes on once
 * the code is entered under Firma › MWST. On a temp copy of demo-schreinerei (H1 filed), with the
 * engine's clock in 2027 so that the second half-year has ended.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_FOLDER, APP_ROOT, workspaceAt } from '../src/workspace/workspace.js';
import { patchManifest } from '../src/workspace/manifest-write.js';
import { ratesWithoutActivityId } from '../src/engines/index.js';
import { openEngine } from '../src/workflows/engine.js';
import { loadWorkflows } from '../src/workflows/load.js';
import { taskOf } from '../src/workflows/model.js';
import { filingXml, type PeriodReturn } from '../src/workflows/filing.js';
import { approvalWithheld } from '../src/app/areas/automation/filing-summary.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'net-rate-filing-runs-'));

const SOURCE = join(APP_ROOT, 'demo-schreinerei', APP_FOLDER);
const RATE = { rate: 4.5, label: 'Schreinerei' };
const SETUP = { registered: true as const, method: 'net-rate' as const, reporting: 'received' as const, period: 'half-yearly' as const };

test('without the activity code: the review names it and withholds the approval; approved anyway, the XML step refuses in a code with words; the code entered, the run goes on (r6f-22)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'net-rate-filing-'));
  cpSync(SOURCE, dir, { recursive: true });
  const manifest = join(dir, 'belege.workspace.yaml');
  patchManifest(manifest, { vat: { ...SETUP, rates: [RATE] } });
  const ws = workspaceAt(dir);
  const w = loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((x) => x.id === 'vat-filing')!;
  const engine = openEngine(ws, { appRoot: APP_ROOT, now: () => '2027-01-10T08:00:00.000Z' });
  const r = await engine.start('vat-filing', { kind: 'period', id: '2026-H2' }, { kind: 'manual' });
  assert.ok(r.ok, JSON.stringify(r));
  await engine.idle();
  const run = () => engine.run(r.run!)!;
  const where = () => { const st = run().state; return [st.status, 'at' in st ? st.at : ''] as const; };
  assert.deepEqual(where(), ['waiting', 'review']);

  const review = taskOf(w, run())!;
  const ret = review.reads!.return as PeriodReturn;
  const name = '1. Saldosteuersatz (Schreinerei)';
  assert.deepEqual(ratesWithoutActivityId(ret.figures), [name], 'the rate with turnover and no code, named as the MWST page names it');
  assert.deepEqual(approvalWithheld(review), { rates: [name], outcome: 'approved' }, 'the task withholds «Freigegeben» and says why');

  await engine.command({ kind: 'answer', run: r.run!, outcome: 'approved' });
  await engine.idle();
  const stuck = run().state;
  assert.equal(stuck.status, 'stuck');
  assert.deepEqual(stuck.status === 'stuck' ? stuck.why : undefined, { code: 'activityIdMissing', params: { rates: name } });
  assert.equal(filingXml(ws, '2026-H2'), undefined, 'no XML without the code');

  patchManifest(manifest, { vat: { ...SETUP, rates: [{ ...RATE, activityId: '41050' }] } });
  workspaceAt(dir);
  assert.deepEqual(ratesWithoutActivityId(ret.figures), []);
  const resumed = await engine.command({ kind: 'resume', run: r.run! });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  await engine.idle();
  assert.deepEqual(where(), ['waiting', 'submit'], JSON.stringify(run().state));
  const xml = filingXml(ws, '2026-H2');
  assert.ok(xml && existsSync(xml));
  assert.match(readFileSync(xml!, 'utf8'), /<eCH-0217:activityId>41050<\/eCH-0217:activityId>/);
  assert.equal(approvalWithheld(taskOf(w, run())!), undefined, 'the filing task withholds nothing');
});
