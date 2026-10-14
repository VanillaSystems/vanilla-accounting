/** The four steps in their order, and how a CLI runs one of them. */
import { ask, modelReady } from '../llm/ask.js';
import { openWorkspace } from '../workspace/workspace.js';
import { classifyStep } from './classify.js';
import { matchStep } from './match.js';
import { IntakeBusyError, noteLines, runIntake, storePort, type Ask, type BooksPort, type IntakeJob, type IntakeStepId, type StepRun } from './pipeline.js';
import { readStep } from './read.js';
import { vatStep } from './vat.js';
import { moduleActor } from '../books/store.js';

export const PIPELINE: ReadonlyArray<readonly [IntakeStepId, StepRun]> = [
  ['read', readStep],
  ['vat', vatStep()],
  ['match', matchStep],
  ['classify', classifyStep()],
];

/** The model, if a working `claude` CLI answers; otherwise the steps run without it. */
export async function askIfReady(): Promise<Ask | undefined> {
  return (await modelReady()) ? ask : undefined;
}

/** `npm run <step>`: one step on the workspace's books, its log on the terminal; exit 1 when it stopped. */
export async function runStepCli(id: IntakeStepId, step: StepRun, after?: (books: BooksPort) => void): Promise<void> {
  const ws = openWorkspace();
  const books = storePort(ws, moduleActor('intake'));
  let job: IntakeJob;
  try {
    job = await runIntake({ ws, books, ask: await askIfReady(), steps: [[id, step]], log: (line) => console.log(line) });
  } catch (e) {
    if (!(e instanceof IntakeBusyError)) throw e;
    console.error(`⛔ ${e.message}`);
    process.exit(1);
  }
  const [done] = job.steps;
  for (const line of noteLines(done.notes)) console.error(line);
  if (done.state === 'stopped') process.exit(1);
  after?.(books);
  console.log(`\nWrote ${ws.paths.books}`);
}
