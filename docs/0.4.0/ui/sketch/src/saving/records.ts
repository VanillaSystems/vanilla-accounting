/**
 * The records path of git (owner decision 2026-10-14, the G6 direction of the architecture
 * research): the books are committed by the app, not saved by a person. Customizing (rules,
 * workflows, knowledge, settings written by the AI) takes the other path, the draft branch
 * (saving.ts).
 *
 * - A run commits once when it comes to rest (done, or every part done, waiting or stuck):
 *   the records it wrote since its last commit plus its run-log lines (workflows/runlog.ts).
 *   An import of 500 receipts is one commit, not 500. A stuck item wrote nothing, so it adds
 *   only its log line.
 * - A person's direct edit in the UI commits at once, one commit per edit.
 * - Commits go to the main line only, never to a branch, and carry trailers
 *   (Vanilla-Kind: books, Vanilla-Run or Vanilla-Person). Verlauf groups them by day and run.
 * - Crash safety: the write door writes the files, then this commits. A crash between the two
 *   leaves records whose `run` field names a run that has no commit yet; recovery commits them
 *   under that run (idempotent: nothing to commit is no commit).
 * - One writer per records line at a time: the process holding engine.lock commits; a cloud
 *   instance and the Mac take turns through sync (pull before taking the lock, push after).
 */
import type { Workspace } from '../workspace/workspace.js';
import type { RunId } from '../workflows/model.js';
import type { RunLogLine } from '../workflows/runlog.js';
import type { CommitId } from './model.js';

export interface RecordsCommitter {
  /** Commits what the run wrote since its last commit, with its new log lines. Null when there is nothing. */
  commitRun(run: RunId, lines: RunLogLine[]): Promise<CommitId | null>;
  /** Commits a person's direct edit of records (the files `update(PERSON)` changed). */
  commitEdit(summary: string, paths: string[]): Promise<CommitId | null>;
  /** At startup: commits records left uncommitted by a crash, under the run their `run` field names. */
  recover(): Promise<CommitId[]>;
}

export function openRecordsCommitter(ws: Workspace): RecordsCommitter {
  throw new Error('not implemented');
  // TODO: all through commitExactly(ws.paths.repository, message + trailers, paths), so a staged
  //       customizing file is never swept into a books commit.
}
