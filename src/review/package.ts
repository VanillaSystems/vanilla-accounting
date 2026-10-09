/**
 * What the review package adds to the audit export (src/audit/build.ts): the accounts of the SME
 * chart the entry form offers beside the workspace's own, and the owner's decisions on earlier
 * reviews, so the Treuhänder sees what was merged or rejected and why.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chartFor, loadChart, type WorkspaceAccount } from '../workspace/chart.js';
import type { Workspace } from '../workspace/workspace.js';
import type { CorrectionKind, Decisions, ReviewFile } from './types.js';

export function chartAccountsOf(ws: Workspace): WorkspaceAccount[] {
  return chartFor(loadChart(), 'both', ws.company.legalForm ?? 'GmbH');
}

export interface DecidedReview {
  branch: string;
  reviewer: string;
  createdAt: string;
  period: string;
  corrections: Array<{ id: string; kind: CorrectionKind; reason: string; decision?: 'merged' | 'rejected'; status?: string; ownerReason?: string; by?: string; at?: string }>;
}

/** Every review the owner has decided on, from review/<dir>/ in the workspace, newest first. */
export function decidedReviews(ws: Workspace): DecidedReview[] {
  const dir = join(ws.paths.root, 'review');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'review.json')) && existsSync(join(dir, d.name, 'decisions.json')))
    .map((d) => {
      const file = JSON.parse(readFileSync(join(dir, d.name, 'review.json'), 'utf8')) as ReviewFile;
      const { branch, decisions } = JSON.parse(readFileSync(join(dir, d.name, 'decisions.json'), 'utf8')) as Decisions;
      const byId = new Map(decisions.map((x) => [x.correctionId, x]));
      return {
        branch,
        reviewer: file.reviewer.name,
        createdAt: file.createdAt,
        period: file.base.period,
        corrections: file.corrections.map((c) => {
          const d = byId.get(c.id);
          return { id: c.id, kind: c.kind, reason: c.reason, ...(d ? { decision: d.decision, status: d.status, ownerReason: d.reason, by: d.by, at: d.at } : {}) };
        }),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
