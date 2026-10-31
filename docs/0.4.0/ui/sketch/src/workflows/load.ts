/**
 * Reads the declarations: the app's workflows/ (APP_ROOT) and the company's workflows/ in the
 * workspace (LAYOUT.top.workflows, reserved today and never read). A company folder with the same
 * id overlays the app's workflow file by file (a step.yaml replaces that step's; workflow.yaml
 * replaces the header); a new id is the company's own workflow.
 *
 * Replaces today's loadWorkflow(root, id) and its narrow Workflow type in the same change: the
 * runner, the CLI and check-processes move to WorkflowDecl, the old type is deleted.
 */
import type { DeclarationSource, StepDecl, WorkflowDecl, WorkflowId } from './model.js';

/** A file reader over one state of the workspace: the working tree, or git HEAD (saving.ts). */
export interface FileSource {
  kind: DeclarationSource;
  /** Relative to the app folder (vanilla-accounting/); undefined when the file is not there. */
  read(path: string): string | undefined;
  list(dir: string): string[];
}

export class DeclarationError extends Error {
  constructor(readonly workflow: string, readonly problems: string[]) { super(`workflows/${workflow}: ${problems.join('; ')}`); }
}

/**
 * Every workflow, app and company, from `company` (the workspace in the given state). Throws
 * DeclarationError for the FIRST broken workflow only when `strict` (CLI, lint); the server loads
 * non-strict and shows a broken company workflow as an item with its problems instead of failing
 * the whole area.
 */
export function loadDeclarations(company: FileSource, opts: { strict: boolean }): {
  workflows: WorkflowDecl[];
  broken: Array<{ id: string; problems: string[] }>;
} {
  // TODO
  // 1. ids = app folders ∪ company folders; reject RESERVED_WORKFLOW_IDS and bad names
  // 2. per id: header = company workflow.yaml ?? app workflow.yaml; each step = company step.yaml ?? app step.yaml
  // 3. parseStep: exactly one body (uses | run.ts beside it | by: person + task | calls | wait); derive kind (stepKind)
  // 4. outcomes: 'done' / '$end' → { to: 'end' }; else { to: 'step' } and the step must exist
  // 5. version = sha16 of the sources in order; origin
  // 6. checkDeclaration (below); runnable = derived from ACTIONS (implemented?) and called workflows, to a fixed point
  throw new Error('not implemented');
}

/** The rules of workflows.md the declarations alone can break; check-processes runs this over every workflow. */
export function checkDeclaration(w: WorkflowDecl, all: ReadonlyMap<WorkflowId, WorkflowDecl>): string[] {
  // TODO (today's checkWorkflow, grown):
  // - start is a step; ≤ 9 steps
  // - each action outcome mapped, each mapped outcome returned by the action; person/wait steps: free outcomes
  // - each effect the action needs is declared; a step declares no effect its action does not use
  // - a step reads only names the trigger item, an earlier step's emits or the workflow's `for` provides (dataflow over the graph)
  // - a `call` names an existing workflow, no call cycle
  // - an `event` trigger names an event some workflow emits (or a core event: transaction.imported, receipt.archived)
  // - forEach names a list some earlier step emits
  // - every Text of an app workflow has de, en, fr, it (company workflows: en or de enough)
  // - a `run.ts` exists only in a `code` step, and only in app workflows unless the company opted in (D7)
  throw new Error('not implemented');
}

/** The kind the graph colours a step with, from its body and its action. */
export function stepKind(body: StepDecl['body'], action: { ai: boolean; effects: string[]; pure: boolean } | undefined): StepDecl['kind'] {
  throw new Error('not implemented');
}
