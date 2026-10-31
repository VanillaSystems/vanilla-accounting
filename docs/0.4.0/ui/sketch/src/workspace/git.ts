/**
 * Additions to src/workspace/git.ts (isomorphic-git). Only src/saving/ calls the new ones; the
 * migration keeps moveTracked/removeTracked.
 *
 * commitPaths is REPLACED by commitExactly in unit 0: today it stages `paths` and commits the
 * whole index, so anything a migration left staged rides along. commitExactly builds the commit
 * tree from HEAD's tree with only `paths` replaced, and leaves the index's other entries alone.
 */
export interface StatusRow { path: string; head: boolean; workdir: 'same' | 'changed' | 'absent'; hash: string }

export async function statusOf(repository: string, under?: string): Promise<StatusRow[]> {
  throw new Error('not implemented');
}

/** The content of `path` at HEAD (or `commit`), undefined when absent. */
export async function blobAt(repository: string, path: string, commit?: string): Promise<string | undefined> {
  throw new Error('not implemented');
}

export async function logOf(repository: string, limit: number): Promise<Array<{ oid: string; message: string; author: string; at: string; trailers: Record<string, string>; paths: string[] }>> {
  throw new Error('not implemented');
}

/**
 * A commit on top of HEAD that changes exactly `files`: each with its working-tree content, or
 * with the given `content` (a books jsonl file committed record by record, saving.ts), or deleted.
 * The index's other entries and the working tree are left alone.
 */
export async function commitExactly(repository: string, message: string, files: Array<{ path: string; content?: string | null }>, trailers: Record<string, string>): Promise<string> {
  throw new Error('not implemented');
}

/** ahead/behind against the upstream of the current branch, from the last fetch. */
export async function syncState(repository: string): Promise<{ remote: boolean; ahead: number; behind: number }> {
  throw new Error('not implemented');
}
