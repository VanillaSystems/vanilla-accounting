/**
 * npm run workflow -- <id> <item-ref> | --open      start one run per item (the manual trigger)
 * npm run workflow -- <id> --replay <run-id>        replay a recorded run on today's workflow, writing nothing
 * npm run workflow -- <id> --runs                   list the stored runs
 *
 * The pilot of migration step 9 (docs/0.4.0/workflows.md); workflows/booking/ is the only one.
 */
import 'dotenv/config';
import { loadBooks, periodLock } from '../books/store.js';
import { askIfReady } from '../intake/run.js';
import { IntakeBusyError, lockIntake } from '../intake/pipeline.js';
import { APP_ROOT, openWorkspace } from '../workspace/workspace.js';
import { loadWorkflow } from '../workflows/load.js';
import { replayRun, runWorkflow, type Run } from '../workflows/runner.js';
import { listRuns, loadRun, runsDir, saveRun } from '../workflows/store.js';

const [id, arg, value] = process.argv.slice(2);
if (!id || !arg) {
  console.error('Usage: npm run workflow -- <id> <ref> | --open | --replay <run-id> | --runs');
  process.exit(1);
}
const ws = openWorkspace();
const workflow = loadWorkflow(APP_ROOT, id);
const line = (r: Run) => `${r.id}  ${r.mode.padEnd(6)}  ${r.status.padEnd(7)}  ${r.item.ref}  ${r.steps.map((s) => `${s.step}:${s.outcome ?? s.error ?? '?'}`).join(' → ')}`;

if (arg === '--runs') {
  for (const r of listRuns(ws).filter((r) => r.workflow === id)) console.log(line(r));
  console.log(`\n${runsDir(ws)}`);
} else if (arg === '--replay') {
  const replay = await replayRun(workflow, loadRun(ws, value), { ws });
  saveRun(ws, replay);
  console.log(line(replay));
  for (const s of replay.steps) for (const e of s.effects) console.log(`  ${s.step}: would ${e.effect} ${JSON.stringify(e.value)}`);
} else {
  let release: () => void;
  try {
    release = lockIntake(ws);
  } catch (e) {
    if (!(e instanceof IntakeBusyError)) throw e;
    console.error(`⛔ ${e.message}`);
    process.exit(1);
  }
  try {
    const books = loadBooks(ws);
    const lock = periodLock(books);
    const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
    const refs = arg === '--open' ? books.transactions.filter((t) => !booked.has(t.ref) && !lock.isClosed(t.date)).map((t) => t.ref) : [arg];
    const ask = await askIfReady();
    for (const ref of refs) {
      const run = await runWorkflow(workflow, ref, { ws, ask });
      saveRun(ws, run);
      console.log(line(run));
    }
    if (!refs.length) console.log('Nothing open to book.');
  } finally {
    release!();
  }
}
