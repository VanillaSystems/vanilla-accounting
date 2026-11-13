/**
 * npm run workflow -- <id> <item-ref> | --open      start one run per item (the manual trigger)
 * npm run workflow -- <id> --replay <run-id>        replay a recorded run on today's workflow, writing nothing
 * npm run workflow -- <id> --runs                   list the stored runs
 *
 * With the app's server up the command goes to its engine, so runs never have two writers; without
 * it, an engine runs here, holding the workspace's lock for each step that writes, and only on a
 * workspace the app has opened on this computer (its switch-on record): only the app takes the baseline.
 */
import 'dotenv/config';
import { loadBooks, periodLock } from '../books/store.js';
import { askIfReady } from '../intake/run.js';
import { lockIntake } from '../intake/pipeline.js';
import { APP_ROOT, openWorkspace } from '../workspace/workspace.js';
import { openEngine } from '../workflows/engine.js';
import { openSwitch } from '../workflows/switch-on.js';
import { switchOnSeen } from '../workflows/booking-waits.js';
import { summaryOf, type AutomationCommand, type CommandResult, type Run } from '../workflows/model.js';
import { listRuns, runsDir } from '../workflows/store.js';

const [id, arg, value] = process.argv.slice(2);
if (!id || !arg) {
  console.error('Usage: npm run workflow -- <id> <ref> | --open | --replay <run-id> | --runs');
  process.exit(1);
}
const ws = openWorkspace();
const line = (r: Run) => { const s = summaryOf(r); return `${s.id}  ${s.mode.padEnd(6)}  ${s.status.padEnd(8)}  ${s.item.id}  ${r.steps.map((x) => `${x.step}:${x.outcome ?? x.error ?? '?'}`).join(' → ')}`; };
const API = `http://127.0.0.1:${process.env.PORT ?? 3456}`;

/** The server's engine, when the app runs; else undefined. */
async function server(): Promise<((cmd: AutomationCommand) => Promise<CommandResult>) | undefined> {
  try {
    const up = await fetch(`${API}/api/status`, { signal: AbortSignal.timeout(800) });
    if (!up.ok) return undefined;
    return async (cmd) => (await fetch(`${API}/api/automation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) })).json() as Promise<CommandResult>;
  } catch {
    return undefined;
  }
}

if (arg === '--runs') {
  for (const r of listRuns(ws).filter((r) => r.workflow === id)) console.log(line(r));
  console.log(`\n${runsDir(ws)}`);
} else {
  const books = loadBooks(ws);
  const lock = periodLock(books);
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const commands: AutomationCommand[] = arg === '--replay' ? [{ kind: 'replay', run: value }]
    : (arg === '--open' ? books.transactions.filter((t) => !booked.has(t.ref) && !lock.isClosed(t.date)).map((t) => t.ref) : [arg])
      .map((ref): AutomationCommand => ({ kind: 'start', workflow: id, item: { kind: 'transaction', id: ref } }));
  if (!commands.length) console.log('Nothing open to book.');
  const remote = await server();
  if (remote) {
    for (const c of commands) console.log(JSON.stringify(await remote(c)));
    console.log(`Sent to the app's engine (${API}); see Automatisierung.`);
  } else {
    // Only the app takes a workspace's first baseline (#413): without a switch-on record on this computer nothing runs here.
    if (!switchOnSeen(ws)) {
      console.error('⛔ Nothing run: the app has not opened this workspace on this computer yet, so no rule of it is switched on. Open it in the app once (Automatisierung › Buchen shows what is switched on), then run this again.');
      process.exit(1);
    }
    const sw = openSwitch(ws);
    const engine = openEngine(() => ws, { appRoot: APP_ROOT, ask: askIfReady, lock: () => lockIntake(ws), isApproved: sw.isApproved, pending: sw.pending, approve: sw.approve });
    const started: string[] = [];
    for (const c of commands) {
      const result = await engine.command(c);
      if (!result.ok) console.error(`⛔ ${result.refusal}${result.detail ? `: ${result.detail}` : ''}`);
      else if (result.run) started.push(result.run);
    }
    await engine.idle();
    for (const r of started) console.log(line(engine.run(r)!));
  }
}
