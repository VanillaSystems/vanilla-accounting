/**
 * A review in progress: the snapshot's books, the corrections made on them in order, and the
 * comments and sign-offs. Pure; the review package's UI keeps one in localStorage
 * (src/app/lib/review.ts), and the tests drive the same functions.
 */
import { applyChange } from '../books/changes.js';
import type { Books } from '../books/lock.js';
import { planIntent, randomIds, type Ids, type Intent } from './corrections.js';
import { REVIEW_FORMAT, type Correction, type ReviewBase, type ReviewComment, type ReviewFile, type Reviewer, type SignOff, type Target } from './types.js';

export interface ReviewState {
  id: string;
  reviewer: Reviewer;
  base: ReviewBase;
  message: string;
  corrections: Correction[];
  comments: ReviewComment[];
  signOffs: SignOff[];
}

export function startReview(reviewer: Reviewer, base: ReviewBase, id: string = randomIds.entryId()): ReviewState {
  return { id, reviewer, base, message: '', corrections: [], comments: [], signOffs: [] };
}

/**
 * The books with every correction applied in order. A correction that no longer applies (an
 * earlier one it built on was undone) is left out and listed in `broken`.
 */
export function replay(base: Books, corrections: Correction[]): { books: Books; broken: string[] } {
  const books = structuredClone(base);
  const broken: string[] = [];
  for (const c of corrections) {
    const probe = structuredClone(books);
    if (c.changes.every((ch) => applyChange(probe, ch) !== 'conflict')) for (const ch of c.changes) applyChange(books, ch);
    else broken.push(c.id);
  }
  return { books, broken };
}

const nextId = (prefix: string, taken: { id: string }[]) => {
  const n = Math.max(0, ...taken.map((x) => Number(x.id.slice(prefix.length)) || 0)) + 1;
  return `${prefix}${n}`;
};

/** The state with one more correction, planned on `books` (the replayed state). Throws what planIntent throws. */
export function record(state: ReviewState, books: Books, intent: Intent, reason: string, at: string, ids: Ids = randomIds): ReviewState {
  const planned = planIntent(books, intent, ids);
  const correction: Correction = { id: nextId('k', state.corrections), kind: planned.kind, reason: reason.trim(), at, changes: planned.changes };
  if (planned.corrects) correction.corrects = planned.corrects;
  return { ...state, corrections: [...state.corrections, correction] };
}

export const undo = (state: ReviewState, id: string): ReviewState => ({ ...state, corrections: state.corrections.filter((c) => c.id !== id) });

export const comment = (state: ReviewState, target: Target, text: string, at: string): ReviewState =>
  ({ ...state, comments: [...state.comments, { id: nextId('c', state.comments), target, text: text.trim(), at }] });

export const removeComment = (state: ReviewState, id: string): ReviewState => ({ ...state, comments: state.comments.filter((c) => c.id !== id) });

export const signOff = (state: ReviewState, scope: string, statement: string, at: string): ReviewState =>
  ({ ...state, signOffs: [...state.signOffs.filter((s) => s.scope !== scope), { id: nextId('f', state.signOffs), scope, statement: statement.trim(), at }] });

export const removeSignOff = (state: ReviewState, id: string): ReviewState => ({ ...state, signOffs: state.signOffs.filter((s) => s.id !== id) });

/** The file the Treuhänder sends back. Corrections that no longer apply are left out. */
export function reviewFile(state: ReviewState, broken: readonly string[], createdAt: string): ReviewFile {
  return {
    format: REVIEW_FORMAT,
    id: state.id,
    reviewer: state.reviewer,
    base: state.base,
    createdAt,
    ...(state.message.trim() ? { message: state.message.trim() } : {}),
    corrections: state.corrections.filter((c) => !broken.includes(c.id)),
    comments: state.comments,
    signOffs: state.signOffs,
  };
}

/** The file name the download gets: review-<period>-<name>.json. */
export const reviewFileName = (state: Pick<ReviewState, 'base' | 'reviewer'>) =>
  `review-${state.base.period}-${slug(state.reviewer.name)}.json`;

export const slug = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'treuhand';

export type { Intent };
