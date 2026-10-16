/**
 * «Automatisch buchen» (a run of workflows/booking/) asks the owner about a customer payment it
 * booked as a sale without an invoice, as the intake run does (r9n-23): the booking's reason says
 * «die Frage dazu steht unter Aufgaben», so the question must exist once the run is done. A dry run
 * books nothing and asks nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks } from '../src/books/store.js';
import { readQuestions } from '../src/questions/store.js';
import { APP_ROOT, type Workspace } from '../src/workspace/workspace.js';
import { openEngine, type Ask } from '../src/workflows/engine.js';
import type { Run } from '../src/workflows/model.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import './support/jurisdiction.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'runs-'));

/** The sale fixture with S-CH unbooked, and a model that books it as revenue. */
function prepared(): { ws: Workspace; ask: Ask } {
  const ws = tempWorkspace('workflow-sale-');
  mkdirSync(ws.paths.history, { recursive: true });
  writeFileSync(join(ws.paths.history, 'prior-year.Konten.txt'), '1021\tBank\n3400\tDienstleistungsertrag\n6570\tInformatikaufwand\n');
  writeFileSync(join(ws.paths.history, 'prior-year.Buchungen-sample.tsv'), 'Datum\tBeschreibung\tKtSoll\tKtHaben\tBetrag\n');
  const index = JSON.parse(readFileSync(join(APP_ROOT, 'tests/fixtures/sale-vat-index.json'), 'utf8')) as { journalEntries: Array<{ transactionRef: string }> };
  index.journalEntries = index.journalEntries.filter((e) => e.transactionRef !== 'S-CH');
  writeIndex(ws, index);
  const ask: Ask = async (prompt) => {
    const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: [{ accountDebit: '1021', accountCredit: '3400', amount: 1081, vatCode: 'V0', description: 'Beratung' }] }])));
  };
  return { ws, ask };
}

async function runOnce(ws: Workspace, ask: Ask, mode: Run['mode']): Promise<Run> {
  const engine = openEngine(ws, { appRoot: APP_ROOT, ask: async () => ask });
  const started = await engine.start('booking', { kind: 'transaction', id: 'S-CH' }, { kind: 'manual' }, mode);
  assert.ok(started.ok, JSON.stringify(started));
  await engine.idle();
  return engine.run(started.ok ? started.run! : '')!;
}

test('a booking run that books a sale without an invoice asks the owner about it at once', async () => {
  const { ws, ask } = prepared();
  try {
    const run = await runOnce(ws, ask, 'live');
    assert.equal(run.state.status, 'done', JSON.stringify(run.steps));
    const [e] = loadBooks(ws).journalEntries.filter((x) => x.transactionRef === 'S-CH');
    assert.deepEqual([e.accountCredit, e.vatCode, e.by?.kind], ['3400', 'V81', 'code'], 'booked as the app proposes');
    assert.match(e.reason ?? '', /Frage dazu steht unter Aufgaben/);
    const q = readQuestions(ws).find((x) => x.topic === 'saleVat' && x.on.id === 'S-CH');
    assert.ok(q, 'the question the reason names exists');
    assert.deepEqual([q.status, q.origin, q.proposal?.choice], ['open', 'booking', 'saleDomestic']);
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true });
  }
});

test('a dry run books nothing and asks nothing', async () => {
  const { ws, ask } = prepared();
  try {
    const run = await runOnce(ws, ask, 'dry');
    assert.equal(run.state.status, 'done', JSON.stringify(run.steps));
    assert.equal(loadBooks(ws).journalEntries.some((x) => x.transactionRef === 'S-CH'), false);
    assert.equal(readQuestions(ws).some((x) => x.on.id === 'S-CH'), false);
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true });
  }
});
