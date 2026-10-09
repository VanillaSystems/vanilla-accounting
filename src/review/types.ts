/**
 * The Treuhänder's review file: what he changed in his copy of the books (one correction per
 * change, each with his reason), his comments and his sign-offs, and the snapshot he worked on.
 * The review package writes it in the browser; the owner's app imports it as a git branch
 * (src/review/git.ts). docs/accountant-review.md, docs/accountant-corrections.md.
 */
import type { RecordChange } from '../books/changes.js';
import type { QuarterKey } from '../types/index.js';

export const REVIEW_FORMAT = 'vanilla-accounting-review/1';

/** The kinds of correction (docs/accountant-corrections.md, column "Kind"). */
export const CORRECTION_KINDS = ['editEntry', 'splitEntry', 'addEntry', 'reverseEntry', 'linkReceipt', 'unlinkReceipt', 'editTransaction'] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];

export interface Correction {
  id: string;
  kind: CorrectionKind;
  /** The Treuhänder's reason: the commit message on the owner's side. */
  reason: string;
  at: string;
  /** The records before and after, in order, against the books as the earlier corrections left them. */
  changes: RecordChange[];
  /** Set when an edit of a filed quarter became correction entries declared on that quarter's 0535. */
  corrects?: QuarterKey;
}

export type Target =
  | { kind: 'entry'; id: string }
  | { kind: 'receipt'; id: string }
  | { kind: 'transaction'; ref: string }
  | { kind: 'review' };

export interface ReviewComment { id: string; target: Target; text: string; at: string }

/** "Reviewed": a quarter (YYYY-Qn) or a year (YYYY), with the Treuhänder's statement. */
export interface SignOff { id: string; scope: string; statement: string; at: string }

export interface Reviewer { name: string; email?: string }

/** The snapshot the review was made on. */
export interface ReviewBase {
  /** SHA-256 of the review package's manifest.json. */
  manifestSha256: string;
  /** The workspace's git commit the package was built from, when it was a repository. */
  commit?: string;
  createdAt: string;
  closedThrough?: string;
  /** The period the owner asked to review, e.g. 2026-Q3 or 2026. */
  period: string;
}

export interface ReviewFile {
  format: typeof REVIEW_FORMAT;
  /** Minted when the review starts; the same review exported twice keeps it. */
  id: string;
  reviewer: Reviewer;
  base: ReviewBase;
  createdAt: string;
  message?: string;
  corrections: Correction[];
  comments: ReviewComment[];
  signOffs: SignOff[];
}

/** What the owner decided on one correction (review/<branch>/decisions.json). */
export interface Decision {
  correctionId: string;
  decision: 'merged' | 'rejected';
  /** The correction's status against the books when decided (src/review/plan.ts). */
  status: string;
  reason?: string;
  by: string;
  at: string;
}

export interface Decisions { branch: string; reviewId: string; reviewer: Reviewer; decisions: Decision[] }

export class ReviewFileError extends Error {}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isString = (x: unknown): x is string => typeof x === 'string';

/** The review file as read from disk or a drop: checked field by field, or a ReviewFileError naming what is wrong. */
export function parseReviewFile(json: unknown): ReviewFile {
  const fail = (what: string): never => { throw new ReviewFileError(`Keine gültige Prüfungsdatei: ${what}.`); };
  if (!isObject(json)) fail('kein JSON-Objekt');
  const f = json as Record<string, unknown>;
  if (f.format !== REVIEW_FORMAT) fail(`format ist nicht ${REVIEW_FORMAT}`);
  if (!isString(f.id) || !/^[\w-]{6,64}$/.test(f.id)) fail('id fehlt');
  if (!isObject(f.reviewer) || !isString(f.reviewer.name) || !f.reviewer.name.trim()) fail('reviewer.name fehlt');
  const base = isObject(f.base) ? f.base : fail('base fehlt');
  if (!isString(base.manifestSha256) || !isString(base.createdAt) || !isString(base.period)) fail('base ist unvollständig');
  if (base.commit !== undefined && (!isString(base.commit) || !/^[0-9a-f]{7,64}$/.test(base.commit))) fail('base.commit ist kein Commit');
  if (!isString(f.createdAt)) fail('createdAt fehlt');
  const list = (key: string) => (Array.isArray(f[key]) ? (f[key] as unknown[]) : fail(`${key} fehlt`));
  const ids = new Set<string>();
  for (const c of list('corrections')) {
    if (!isObject(c) || !isString(c.id) || !isString(c.reason) || !isString(c.at)) fail('eine Korrektur ist unvollständig');
    const corr = c as Record<string, unknown>;
    if (ids.has(corr.id as string)) fail(`Korrektur ${corr.id} kommt zweimal vor`);
    ids.add(corr.id as string);
    if (!CORRECTION_KINDS.includes(corr.kind as CorrectionKind)) fail(`Korrektur ${corr.id}: unbekannte Art ${String(corr.kind)}`);
    if (!Array.isArray(corr.changes) || !corr.changes.length) fail(`Korrektur ${corr.id} ändert nichts`);
    for (const ch of corr.changes as unknown[]) {
      if (!isObject(ch) || !isString(ch.collection) || !isString(ch.key) || (ch.before === undefined && ch.after === undefined)) fail(`Korrektur ${corr.id}: eine Änderung ist unvollständig`);
      const collection = (ch as { collection: string }).collection;
      if (!['entries', 'transactions', 'mappings'].includes(collection)) fail(`Korrektur ${corr.id}: ändert ${collection}, was eine Prüfung nicht darf`);
    }
  }
  for (const c of list('comments')) if (!isObject(c) || !isString(c.id) || !isString(c.text) || !isObject(c.target)) fail('ein Kommentar ist unvollständig');
  for (const s of list('signOffs')) if (!isObject(s) || !isString(s.scope) || !isString(s.statement)) fail('eine Freigabe ist unvollständig');
  return json as unknown as ReviewFile;
}
