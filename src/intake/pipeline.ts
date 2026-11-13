/**
 * The inbox processing: read the files and statements, the VAT facts, the receipt matching and
 * the booking, one step after the other (processes/receipt-intake.flow.yaml, evidence.flow.yaml,
 * booking.flow.yaml). `npm run extract|extract-vat|match|classify` run one step each, the app
 * (POST /api/intake) all four as a job. Every step only takes up what is still to do, so a second
 * run changes nothing; one runs at a time per workspace (data/intake.lock), CLI and app alike.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AskOptions } from '../llm/ask.js';
import { aiOff } from '../llm/off.js';
import { emptyBooks, hasBooks, loadBooks, updateSaved, type Actor, type Books } from '../books/store.js';
import type { Workspace } from '../workspace/workspace.js';

export const INTAKE_STEPS = ['read', 'vat', 'match', 'classify'] as const;
export type IntakeStepId = (typeof INTAKE_STEPS)[number];

/** What a step could not do. The UI words each code (`intake.note.<code>`). */
export type IntakeNote =
  /** No working `claude` CLI: `waiting` items need the model and wait for the next run. */
  | { code: 'noModel'; waiting: number }
  /** The model was asked and failed for `count` items; `detail` is the first error. */
  | { code: 'failed'; count: number; detail: string }
  /** Bank statements that belong to no bank account: nothing was read, the job stopped. */
  | { code: 'unmatched'; files: string[] }
  /** A receipt link or bank payment of a filed quarter is gone; kept as it was, a person must look. */
  | { code: 'filedKept'; count: number }
  /** Receipts whose text is too poor to read: flagged for a vision read, out of the runs until then. */
  | { code: 'poorScan'; files: string[] }
  /** Inbox files with the bytes of a file the books or the inbox hold (`of`): removed from the inbox. */
  | { code: 'sameBytes'; files: Array<{ file: string; of: string }> }
  /** Files of receipts/ whose bytes changed under their name (#405): read again; `check` links a person should look at, `kept` the old record stayed beside the new read. */
  | { code: 'rewritten'; files: Array<{ file: string; check: number; kept: boolean }> }
  /** Payments a company rule holds for the person (src/booking/rules.ts): not booked, each a question in Automatisierung. */
  | { code: 'asked'; count: number }
  /** Customer payments without an invoice booked without VAT: each a question to the owner (src/intake/sale-questions.ts). */
  | { code: 'saleAsked'; count: number }
  /** Payments that need a receipt and have none yet (src/booking/receipt-wait.ts): not booked, booked once it is linked. */
  | { code: 'waitingReceipt'; count: number }
  /** Payments whose receipt's VAT could not be read (issue #57): not booked, each a question under Aufgaben. */
  | { code: 'receiptUnread'; count: number }
  /** The workflow `booking` waits for «Einschalten» (#413): `files` changed since it was switched on, so nothing was booked by rule or model; `waiting` payments are open. */
  | { code: 'bookingWaits'; files: string[]; waiting: number }
  /** The step threw. */
  | { code: 'error'; detail: string };

export interface IntakeStep {
  id: IntakeStepId;
  state: 'waiting' | 'running' | 'done' | 'stopped';
  done: number;
  total: number;
  notes: IntakeNote[];
}

export interface IntakeJob {
  id: string;
  startedAt: string;
  finishedAt?: string;
  steps: IntakeStep[];
}

/** GET and POST /api/intake. */
export interface IntakeStatus {
  running: boolean;
  /** The job running now, else the last one since the server started. */
  job?: IntakeJob;
  /** Another process (a CLI) holds the workspace's lock. */
  busy?: boolean;
  /** Ids of the inbox files the books do not hold yet. */
  inbox: string[];
}

/**
 * The books as a step sees them. `update` loads, changes and saves in one synchronous call inside
 * the write door (src/books/store.ts update), so a filed quarter never changes and an edit made while a model was thinking is
 * not saved over: a step asks the model on what it `read`, then applies the answer in `update`.
 * When another process saved in between, `update` runs its `fn` once more on books loaded afresh
 * (updateSaved, #132): `fn` decides from the books it is given and changes nothing else.
 */
export interface BooksPort {
  read(): Books;
  update<T>(fn: (books: Books) => T): T;
}

export type Ask = (prompt: string, opts: AskOptions) => Promise<string>;

export interface StepContext {
  ws: Workspace;
  books: BooksPort;
  /** Absent: no working `claude` CLI, the step does what it can without a model. */
  ask?: Ask;
  progress(done: number, total: number): void;
  log(line: string): void;
  /** Payments left for the person (a company rule asks, or no model to book them): a run of the engine asks each (src/workflows/actions.ts); the CLI only says so. */
  hold?(refs: string[]): void;
  /** Payments booked now: a question that held one of them (its report was missing, a rule asked) is closed (r7h-21). */
  release?(refs: string[]): void;
  /** Stems of inbox files a run waiting behind this one came in with: left for it (src/workflows/actions.ts). */
  later?: () => ReadonlySet<string>;
  /**
   * The files that came in with the run (the drop dialog's rows, src/workflows/model.ts Arrival),
   * told by their inbox name when the read step turns a photo into a PDF (`renamed`: the name and
   * id it has now) or sets a file aside (`refused`), so a row ends as what its file became (r8k-9).
   */
  arrived?: { renamed(inbox: string, next: { inbox: string; id: string }): void; refused(inbox: string, reason: string): void };
}

/** A file's name without its extension: a photo converted to PDF in the inbox keeps it. */
export const stemOf = (name: string): string => name.replace(/\.[^.]*$/, '');

export interface StepResult {
  notes: IntakeNote[];
  /** The later steps would work on books this step could not bring up to date. */
  stop?: boolean;
}

export type StepRun = (ctx: StepContext) => Promise<StepResult>;

/** The books of `ws` through src/books/store.ts, written as `actor`. */
export function storePort(ws: Workspace, actor: Actor): BooksPort {
  // Before the first run there are no books: they start empty.
  const load = () => (hasBooks(ws) ? loadBooks(ws) : emptyBooks());
  return {
    read: load,
    update: (fn) => updateSaved(ws, actor, fn, load),
  };
}

export class IntakeBusyError extends Error {
  constructor(readonly pid: number) { super(`Der Eingang wird schon verarbeitet (Prozess ${pid}).`); }
}

/** One process at a time per workspace: a lock file holding the pid, taken over when that process is gone. */
export function lockIntake(ws: Workspace): () => void {
  const path = join(ws.paths.data, 'intake.lock');
  mkdirSync(ws.paths.data, { recursive: true });
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(existsSync(path) ? readFileSync(path, 'utf8') : 0);
      if (pid && pid !== process.pid && alive(pid)) throw new IntakeBusyError(pid);
      rmSync(path, { force: true });
    }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface RunOptions {
  ws: Workspace;
  books: BooksPort;
  ask?: Ask;
  steps: ReadonlyArray<readonly [IntakeStepId, StepRun]>;
  log?: (line: string) => void;
  /** Called on every change of the job, with the job itself (not a copy). */
  onChange?: (job: IntakeJob) => void;
}

/** Runs the steps in order under the workspace's lock. A step that stops, or throws, ends the job. */
export async function runIntake({ ws, books, ask, steps, log = () => {}, onChange = () => {} }: RunOptions): Promise<IntakeJob> {
  const job: IntakeJob = {
    id: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    steps: steps.map(([id]) => ({ id, state: 'waiting', done: 0, total: 0, notes: [] })),
  };
  const unlock = lockIntake(ws);
  try {
    for (const [i, [, run]] of steps.entries()) {
      const step = job.steps[i];
      step.state = 'running';
      onChange(job);
      let result: StepResult;
      try {
        result = await run({ ws, books, ask, log, progress: (done, total) => { Object.assign(step, { done, total }); onChange(job); } });
      } catch (e) {
        result = { notes: [{ code: 'error', detail: e instanceof Error ? e.message : String(e) }], stop: true };
      }
      step.notes = result.notes;
      step.state = result.stop ? 'stopped' : 'done';
      onChange(job);
      if (result.stop) break;
    }
  } finally {
    unlock();
  }
  job.finishedAt = new Date().toISOString();
  onChange(job);
  return job;
}

/** The notes of a finished step as lines for a terminal. */
export function noteLines(notes: IntakeNote[]): string[] {
  return notes.map((n) => {
    switch (n.code) {
      case 'noModel': return aiOff()
        ? `⚠ the AI is switched off on this Mac (Firma › KI): ${n.waiting} item(s) wait for it until it is on again`
        : `⚠ no working claude CLI: ${n.waiting} item(s) wait for the model (install Claude Code and log in, then run again)`;
      case 'failed': return `⚠ ${n.count} item(s) failed: ${n.detail}`;
      case 'unmatched': return `⛔ ${n.files.length} bank statement(s) belong to no bank account; nothing was written:\n${n.files.map((f) => `  ${f}`).join('\n')}`;
      case 'filedKept': return `⛔ ${n.count} link(s) or payment(s) of a FILED quarter lost their file; kept as they were (see above)`;
      case 'poorScan': return `⚠ ${n.files.length} receipt(s) too poorly scanned to read; flagged for a vision read (Belege › Neu lesen):\n${n.files.map((f) => `  ${f}`).join('\n')}`;
      case 'sameBytes': return `${n.files.length} file(s) in beleg-import/ had the bytes of one already there; removed:\n${n.files.map((f) => `  ${f.file} = ${f.of}`).join('\n')}`;
      case 'rewritten': return `⚠ ${n.files.length} receipt file(s) changed under their name and were read again; links to check:\n${n.files.map((f) => `  ${f.file}: ${f.check}${f.kept ? ' (old record kept)' : ''}`).join('\n')}`;
      case 'asked': return `? ${n.count} payment(s) wait for the person: a company rule says to ask first`;
      case 'saleAsked': return `? ${n.count} customer payment(s) without an invoice wait for the owner: with VAT, abroad, or no sale?`;
      case 'waitingReceipt': return `${n.count} payment(s) wait for their receipt: booked once it is linked`;
      case 'receiptUnread': return `? ${n.count} payment(s) have a receipt whose VAT could not be read: each waits for the person under Aufgaben`;
      case 'bookingWaits': return `${n.waiting} payment(s) not booked: «Buchen» waits for «Einschalten» since ${n.files.join(', ')} changed`;
      case 'error': return `⛔ ${n.detail}`;
    }
  });
}
