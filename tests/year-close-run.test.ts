/**
 * The workflow year-close (src/workflows/year-end.ts) on the year-close fixture: a run books the
 * exchange differences, waits for the person's review, gets stuck at the close while a guided
 * entry is open, goes on once it is decided, closes and opens the next year; its books are the
 * books of the Year-end page's own path. A dry run books, closes and opens nothing.
 */
import { test } from 'node:test';
import './support/jurisdiction.js';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBooks } from '../src/books/store.js';
import { yearEndTemplates } from '../src/accounting/year-close.js';
import { bookRevaluation, closeYear, markTemplate, openYear, stateFile } from '../src/books/year-close.js';
import { APP_ROOT, yearPaths, type Workspace } from '../src/workspace/workspace.js';
import { openEngine } from '../src/workflows/engine.js';
import { RATES, readyToClose } from './support/year-close.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'year-close-runs-'));
// The stand-in rates of the fixture, as a table on disk the actions read.
process.env.VANILLA_RATES_DIR = mkdtempSync(join(tmpdir(), 'year-close-rates-'));
writeFileSync(join(process.env.VANILLA_RATES_DIR, 'estv-daily-rates-2026.json'), JSON.stringify({ fetchedAt: '2027-01-05T08:00:00Z', rates: { '2026-12-31': { EUR: 0.93, src: 'stand-in' }, '2027-01-04': { EUR: 0.931, src: 'stand-in' } } }));

const decideAll = (ws: Workspace) => { for (const t of yearEndTemplates()) markTemplate(ws, '2026', t.id, 'na'); };
const year = { kind: 'year' as const, id: '2026' };

test('a year-close run: revaluation, review, stuck while an entry is open, then closed and opened as the Year-end page does', async () => {
  const ws = readyToClose();
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const r = await engine.start('year-close', year, { kind: 'manual' });
  assert.ok(r.ok, JSON.stringify(r));
  await engine.idle();
  const run = () => engine.run(r.run!)!;
  const at = () => { const s = run().state; return s.status === 'waiting' || s.status === 'stuck' ? `${s.status} ${s.at}` : s.status; };
  assert.equal(at(), 'waiting review');
  assert.equal(loadBooks(ws).journalEntries.filter((x) => x.origin === 'year-close').length, 1, 'the exchange difference is booked');

  await engine.command({ kind: 'answer', run: r.run!, outcome: 'approved' });
  await engine.idle();
  assert.equal(at(), 'stuck close');
  const stuck = run().state;
  assert.match(stuck.status === 'stuck' ? stuck.reason : '', /cannot close yet/);

  decideAll(ws);
  await engine.command({ kind: 'resume', run: r.run! });
  await engine.idle();
  assert.equal(at(), 'done');
  assert.equal(loadBooks(ws).config.closedThrough, '2026-12-31');
  assert.ok(existsSync(join(yearPaths(ws.paths, '2026').filings, 'seal-Q4.json')));

  const direct = readyToClose();
  bookRevaluation(direct, '2026', RATES);
  decideAll(direct);
  await closeYear(direct, '2026', RATES);
  await openYear(direct, '2026', RATES);
  assert.deepEqual(loadBooks(ws), loadBooks(direct), 'the books of the Year-end page\'s path');
  assert.deepEqual(JSON.parse(readFileSync(stateFile(ws, '2026'), 'utf8')), JSON.parse(readFileSync(stateFile(direct, '2026'), 'utf8')));
});

test('a dry run of the year close books, closes and opens nothing', async () => {
  const ws = readyToClose();
  decideAll(ws);
  const before = JSON.stringify(loadBooks(ws));
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const r = await engine.start('year-close', year, { kind: 'manual' }, 'dry');
  await engine.idle();
  await engine.command({ kind: 'answer', run: r.ok ? r.run! : '', outcome: 'approved' });
  await engine.idle();
  assert.equal(engine.run(r.ok ? r.run! : '')!.state.status, 'done');
  assert.equal(JSON.stringify(loadBooks(ws)), before);
});
