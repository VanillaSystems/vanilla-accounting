/**
 * #482: a payment the classifier refuses never sticks the run that tried it. The inbox run of a
 * drop finishes and the payment carries its refusal on the run log (#470); an «Automatisch buchen»
 * run on the payment goes on to the hand step with it. Every key a step's action hands on is one its
 * step.yaml emits, or the engine sticks the run. The painter persona's statement
 * (.claude/skills/verify/persona-files/huber.mjs), a stub model.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAnswers } from '../src/workspace/create.js';
import { PRESETS, type Answers } from '../src/workspace/setup.js';
import { applyPlan, planWorkspace } from '../src/workspace/scaffold.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_FOLDER, APP_ROOT, workspaceAt, yearPaths, type Uid, type Workspace } from '../src/workspace/workspace.js';
import type { Iban } from '../src/workspace/banks.js';
import { openEngine, type Ask } from '../src/workflows/engine.js';
import { lineFor, readLog } from '../src/workflows/runlog.js';
import { historyOf } from '../src/workflows/history.js';
import type { Run } from '../src/workflows/model.js';
import { paymentRefusals } from '../src/server/refusals.js';
import { loadBooks } from '../src/books/store.js';
import './support/jurisdiction.js';

// @ts-expect-error a plain ES module of the verify skill, without types
import huber from '../.claude/skills/verify/persona-files/huber.mjs';

const CAMT = 'camt053_Raiffeisen_Q3-2026.xml';
const XML = (huber as () => { files: Record<string, string> })().files[CAMT];
const IBAN = /<Acct>\s*<Id>\s*<IBAN>([A-Z0-9]+)</.exec(XML)![1] as Iban;

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'refused-run-482-runs-'));
const roots: string[] = [process.env.VANILLA_RUNS_DIR];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** The employer's contribution accounts, left out of her chart: the classifier then has nowhere to put what 2270 does not hold, and refuses (#470). */
const EMPLOYER = ['5700', '5710', '5720'];

/** The painter's new books as `npm run init` makes them, her statement filed as a drop files it. */
function painter(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'refused-run-482-'));
  roots.push(root);
  const { answers, vat } = checkAnswers({ ...PRESETS.trades.answers } as Answers, []);
  const chart = loadChart();
  applyPlan(root, planWorkspace({ name: 'Malerei Beispiel GmbH', uid: 'CHE-153.004.184' as Uid, owner: 'Sandra Beispiel', preset: 'trades', answers, vat, banks: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', iban: IBAN }] }, chart, '2026'));
  const ws = workspaceAt(join(root, APP_FOLDER));
  writeFileSync(ws.paths.accounts, JSON.stringify(chart.accounts.filter((a) => !EMPLOYER.includes(a.number)).map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  const dir = join(yearPaths(ws.paths, '2026').statements, 'Raiffeisen');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CAMT), XML);
  return ws;
}

/** The walk's answer for the SVA payment: half on the deductions' account 2270, which holds nothing yet, so the classifier refuses it. The model says nothing of the others. */
const halfOn2270: Ask = async (prompt) => {
  const out: Record<string, unknown> = {};
  for (const part of prompt.split(/^### Transaction \d+: /m).slice(1)) {
    if (!/SVA St\. Gallen/.test(part)) continue;
    out[part.split(/\s/)[0]] = { entries: [{ accountDebit: '2270', accountCredit: '', amount: 945.18, vat: 'none', description: 'AHV AN' }, { accountDebit: '6700', accountCredit: '', amount: 945.17, vat: 'none', description: 'AHV AG' }] };
  }
  return JSON.stringify(out);
};

const engineOn = (ws: Workspace) => openEngine(() => ws, { appRoot: APP_ROOT, ask: async () => halfOn2270 });
const svaOf = (ws: Workspace) => loadBooks(ws).transactions.find((t) => t.counterparty === 'SVA St. Gallen')!.ref;

test('the inbox run of a drop with one refused payment finishes; the payment carries its refusal', async () => {
  const ws = painter();
  const engine = engineOn(ws);
  const r = await engine.start('receipt-intake', { kind: 'company', id: 'inbox' }, { kind: 'manual' });
  assert.ok(r.ok, JSON.stringify(r));
  await engine.idle();
  const run = engine.run(r.run!)!;
  assert.equal(run.state.status, 'done', `no stuck run: ${JSON.stringify(run.state)}`);
  const sva = svaOf(ws);
  assert.equal(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === sva).length, 0, 'nothing booked of the refused payment');
  const line = readLog(ws).find((l) => l.run === run.id);
  assert.deepEqual(line?.refused?.filter((x) => x.ref === sva).map((x) => x.refusal?.code), ['classifyWithheldOver'], 'the run log keeps the refusal');
  assert.deepEqual(paymentRefusals(ws, loadBooks(ws)).filter((x) => x.ref === sva).map((x) => [x.run, x.refusal?.code]), [[run.id, 'classifyWithheldOver']], 'the payment says why it waits');
});

test('«Automatisch buchen» on the refused payment goes on to the hand step, with the refusal', async () => {
  const ws = painter();
  const engine = engineOn(ws);
  const intake = await engine.start('receipt-intake', { kind: 'company', id: 'inbox' }, { kind: 'manual' });
  await engine.idle();
  assert.ok(intake.ok);
  const sva = svaOf(ws);
  const r = await engine.start('booking', { kind: 'transaction', id: sva }, { kind: 'manual' });
  assert.ok(r.ok, JSON.stringify(r));
  await engine.idle();
  const run = engine.run(r.run!)!;
  assert.deepEqual(run.state.status === 'waiting' ? run.state.at : run.state, 'manual', 'it waits for her at the hand step, not stuck');
  const classify = run.steps.find((s) => s.step === 'classify');
  assert.deepEqual((classify?.output?.refused as Array<{ ref: string; refusal?: { code: string } }> | undefined)?.map((x) => [x.ref, x.refusal?.code]), [[sva, 'classifyWithheldOver']]);
});

test('a stuck run\'s line keeps its refusal, so the payment\'s and the balance sheet\'s «Verlauf» say it in her words', () => {
  const why = { code: 'emitsExtra', params: { step: 'book', keys: 'refused' } } as const;
  const stuck = {
    id: 'run-stuck', workflow: 'receipt-intake', version: 'v1', mode: 'live', item: { kind: 'transaction', id: 'SVA' },
    state: { status: 'stuck', at: 'book', since: '2026-11-13T10:00:00Z', reason: 'returned refused, which book/step.yaml does not emit', why }, steps: [],
  } as unknown as Run;
  const line = lineFor(stuck, 0)!;
  assert.deepEqual(line.why, why);
  const h = historyOf([line], { kind: 'payment', id: 'SVA', entries: [], receipts: [] }, () => true);
  assert.deepEqual(h.runs.map((r) => [r.event, r.why?.code]), [['stuck', 'emitsExtra']]);
});
