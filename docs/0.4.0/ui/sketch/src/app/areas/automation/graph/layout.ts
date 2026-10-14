/**
 * The graph layout of the mockup (workflows.html `layout`), as a pure function: layers by
 * longest path from the start nodes, rows by first parent, back edges found by DFS and routed
 * below. Used for a workflow's graph (nodes = triggers + steps + the emit node) and for the
 * process map's event view (nodes = workflows + outside triggers). Tested on its own.
 */
export interface GNode { id: string; label: string; kindLabel?: string; cls: string; ai?: boolean }
export interface GEdge { from: string; to: string; label?: string }

export interface Placed {
  nodes: Array<GNode & { x: number; y: number }>;
  edges: Array<GEdge & { path: string; back: boolean; labelAt?: { x: number; y: number } }>;
  width: number;
  height: number;
}

export const SIZES = { W: 156, H: 62, CG: 64, RG: 30, PAD: 22 } as const;

export function layout(nodes: GNode[], edges: GEdge[], starts: string[], sizes = SIZES): Placed {
  throw new Error('not implemented');
}

/** A workflow as nodes and edges: one node per trigger that is on, per step, one `$end` node labelled with `emits`. */
export function graphOfWorkflow(w: import('../../../../types/automation.js').WorkflowView, lang: string): { nodes: GNode[]; edges: GEdge[]; starts: string[] } {
  throw new Error('not implemented');
}

/** The run's path over the graph: which nodes it visited, where it is, which edges are hot; a replay's path beside the original's. */
export function pathOfRun(run: import('../../../../types/automation.js').RunView): { visited: Set<string>; at?: string; hot: Set<string> } {
  throw new Error('not implemented');
}

/** The process map's event view: workflows as nodes, an edge per event one emits and another listens to (on), outside triggers as start nodes. */
export function graphOfCatalog(workflows: import('../../../../types/automation.js').WorkflowView[], lang: string): { nodes: GNode[]; edges: GEdge[]; starts: string[] } {
  throw new Error('not implemented');
}
