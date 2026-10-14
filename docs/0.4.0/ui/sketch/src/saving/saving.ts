/**
 * Änderungen on the server: the one module that reads and writes the workspace's git.
 *
 *   const saving = openSaving(ws, { automation, ask });
 *   await saving.view()                          // screen 7, free and instant (no model)
 *   await saving.command({ kind: 'prepare' })    // one model call
 *   await saving.command({ kind: 'save', sync: true })
 *   saving.sources                               // { saved, draft } FileSources for the engine
 *
 * Also the place D11's "saved by the action itself" goes through: filing, seal and year close
 * call `saveAction()` instead of committing on their own (year-close.ts's commit() moves here and
 * its repositoryAt(ws.paths.root) defect goes with it).
 */
import type { Workspace } from '../workspace/workspace.js';
import type { Automation } from '../workflows/index.js';
import type { FileSource } from '../workflows/load.js';
import type { AskOptions } from '../llm/ask.js';
import type { ChangesView, CommitId, RepoPath, SavingCommand, SavingResult } from './model.js';

export interface Saving {
  view(): Promise<ChangesView>;
  command(cmd: SavingCommand): Promise<SavingResult>;
  /**
   * A deliberate action that saves itself (filing, seal, year close): refuses while other changes
   * are unsaved ("before one of them, the app asks to save everything else"), then commits exactly
   * `paths` with a Vanilla-Lock trailer.
   */
  saveAction(message: string, paths: RepoPath[], lock: 'filing' | 'seal' | 'year-close'): Promise<CommitId>;
  /** The workspace's declarations and guides as saved (HEAD) and as drafted (working tree). */
  readonly sources: { saved: FileSource; draft: FileSource };
}

/** `automation` is a getter: the engine is built after saving (it needs `sources`), saving reads its writers lazily. */
export function openSaving(ws: Workspace, deps: { automation: () => Pick<Automation, 'writers' | 'command'>; ask?: (p: string, o: AskOptions) => Promise<string> }): Saving {
  // TODO repository = ws.paths.repository (ADR 0013), not ws.paths.root
  // TODO view(): statusMatrix over the repository → ChangedFile[]; jsonl files: diff HEAD blob vs worktree by record id;
  //      join ids with automation writers() → byRun; rest → direct; non-books → files; LAYOUT decides kind
  // TODO proposal: read data/saving/proposal.json; compare basis hashes with current → ready | stale
  // TODO prepare/talk/refresh: ask(model 'sonnet') with RawChanges SUMMARIES (never 500 diffs) + the text diffs of
  //      non-books files + the talk; parse JSON into PreparedSave[]; reject any save whose paths are not exactly a
  //      partition of the changed paths and, for shared books jsonl files, of their changed record ids (every changed record in exactly one save)
  // TODO save: for each save not held, in order: commitExactly(paths, message + trailers); refuse if any basis hash moved
  // TODO sync: git binary `pull --ff-only` then `push` when a remote exists (isomorphic-git has no credential helper); a
  //      non-fast-forward → refusal 'two-versions' (the merge dialog is a later unit)
  // TODO undo: books jsonl → inverse records through update(books, PERSON, …) (closed period → refusal 'locked', the
  //      correction workflow is the way); other files → write the parent's blob iff the worktree still equals the commit's
  throw new Error('not implemented');
}
