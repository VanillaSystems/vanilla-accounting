/**
 * Grafted from candidate A (D6 a, workflows.md:176-178). Live runs gate on approval, not on git HEAD:
 * the engine runs a company workflow version live only when it is approved here; drafts (the
 * working tree, unapproved versions) run as 'dry' or 'replay' only (DeclarationSource stays for that).
 *
 * D6 chosen: approvals are app-local state OUTSIDE the workspace (next to the runs, per
 * workspace hash). An AI that edits workflows/ in the workspace cannot write here: the
 * allowedTools of src/assistant/assistant.ts name only workspace globs, and this file is not under them.
 *
 * Model: version-pinned. A workspace workflows/<id>/ folder overlays the app's by id. Its
 * `version` (sha16 of the folder) runs LIVE only if listed here; otherwise it is a draft and only
 * runs as mode 'dry'/'replay'. Folders shipped by the app are approved by definition.
 */
import type { Workspace } from '../workspace/workspace.js';
import type { WorkflowId } from './model.js';

/** What a change to a workflow's files needs before it runs live (workflows.md "Changing a workflow"). */
export type DraftKind = 'applies-now' | 'needs-switch-on' | 'needs-maintainer';

export interface Approvals { approved: Record<string /* workflow id */, string[] /* versions */> }
export function readApprovals(ws: Workspace): Approvals { throw new Error('not implemented'); }
export function approve(ws: Workspace, workflow: WorkflowId, version: string): void { throw new Error('not implemented'); }

/**
 * Route by KIND of change (workflows.md "Changing a workflow"). Pure over the changed paths and,
 * for yaml, the changed keys: label/schedule/cadence/desc -> applies-now; guide rules, rates,
 * accounts, step outcomes, effects -> needs-switch-on; any .ts file -> needs-maintainer.
 */
export function classifyDraft(changedPaths: string[], keyDiff: (path: string) => string[]): DraftKind { throw new Error('not implemented'); }
