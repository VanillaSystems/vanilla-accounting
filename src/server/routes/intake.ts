/**
 * The inbox processing as a job (src/intake/): POST /api/intake starts it, GET /api/intake tells
 * how far it is. One job at a time: a start while one runs asks for one more run after it, so a
 * file dropped meanwhile is read too. The UI starts it after every intake and on its button.
 */
import { Router } from 'express';
import { IntakeBusyError, runIntake, storePort, type IntakeJob, type IntakeStatus } from '../../intake/pipeline.js';
import { PIPELINE, askIfReady } from '../../intake/run.js';
import { WS } from '../books.js';
import { inboxFiles } from './scan.js';

export const router = Router();

let last: IntakeJob | undefined;
let running: Promise<void> | undefined;
let again = false;
let busy = false;

function start(): void {
  if (running) { again = true; return; }
  running = (async () => {
    do {
      again = false;
      try {
        await runIntake({
          ws: WS, books: storePort(WS), ask: await askIfReady(), steps: PIPELINE,
          log: (line) => { if (line.trim()) console.log(`  intake: ${line}`); },
          onChange: (job) => { last = structuredClone(job); },
        });
        busy = false;
      } catch (e) {
        if (!(e instanceof IntakeBusyError)) throw e;
        busy = true;
      }
    } while (again);
  })().catch((e) => console.error('intake:', e)).finally(() => { running = undefined; });
}

const status = (): IntakeStatus => ({ running: !!running, job: last, ...(busy ? { busy } : {}), inbox: inboxFiles().map((f) => f.id) });

router.get('/api/intake', (_req, res) => {
  res.json(status());
});

router.post('/api/intake', (_req, res) => {
  start();
  res.json(status());
});
