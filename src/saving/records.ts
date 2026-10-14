/**
 * The records path of git (docs/0.4.0/ui/design.md, "Two paths into git"): the app commits the
 * books itself, on the line the repository is on, never on a branch. A run commits once when it
 * comes to rest, with its run-log line; a person's direct edit in the app is one commit; at start,
 * records left uncommitted by a crash are committed. Customizing (rules, workflows, settings) is
 * not committed here: it is saved in Änderungen.
 *
 * What a commit holds is every records file that changed: ledger.json and transactional-data/.
 * Direct edits commit at once and runs commit at rest, so the working tree holds no one else's
 * records changes in the normal case; a commit per record line is a later refinement.
 */
import { repositoryAt, commitExactly } from '../workspace/git.js';
import type { Workspace } from '../workspace/workspace.js';

export interface RecordsCommitter {
  /** Commits what a run wrote and its log line; false when there is nothing to commit or no repository. */
  commitRun(run: { id: string; workflow: string; label: string; item: string }): Promise<boolean>;
  /** Commits a person's direct edit of the books. */
  commitEdit(summary: string): Promise<boolean>;
  /** At start: commits records a crash left uncommitted. */
  recover(): Promise<boolean>;
}

export function openRecordsCommitter(ws: Pick<Workspace, 'paths'>): RecordsCommitter {
  const paths = [ws.paths.ledger, ws.paths.transactional];
  const commit = async (message: string): Promise<boolean> => {
    const repo = await repositoryAt(ws.paths.repository);
    return repo ? commitExactly(repo, message, paths) : false;
  };
  return {
    commitRun: (r) => commit(`${r.label}: ${r.item}\n\nVanilla-Kind: books\nVanilla-Run: ${r.id}\nVanilla-Workflow: ${r.workflow}`),
    commitEdit: (summary) => commit(`${summary}\n\nVanilla-Kind: books\nVanilla-Person: the app's user`),
    recover: () => commit('Bücher: nach einem Neustart nicht gespeicherte Änderungen\n\nVanilla-Kind: books\nVanilla-Recovered: true'),
  };
}
