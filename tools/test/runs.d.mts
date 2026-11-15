/** Types of tools/test/runs.mjs, which run.sh runs with plain node. */
export interface GreenRun { commit: string; at: string; node: string; seconds?: number }
export function runsFile(root: string): string;
export function cleanTree(root: string): string | undefined;
export function treeOf(root: string, rev: string): string;
export function greenRuns(root: string): Record<string, GreenRun>;
export function record(root: string, tree: string, started?: string): boolean;
export function describeRun(tree: string, run: GreenRun): string;
