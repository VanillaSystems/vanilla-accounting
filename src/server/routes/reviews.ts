/**
 * The books' change log (git) and the Treuhänder's reviews: import a review file as a branch,
 * show each review as a pull request against today's books, merge or reject its corrections.
 * The merge writes the books only through src/review/git.ts (mutateJournal, saveBooks).
 */
import { Router, type Response } from 'express';
import { history } from '../../books/history.js';
import { decideReview, importReview, listReviews, ReviewGitError } from '../../review/git.js';
import { IntentError } from '../../review/corrections.js';
import { chartAccountsOf, decidedReviews } from '../../review/package.js';
import { ReviewFileError } from '../../review/types.js';
import { RequestError, WS } from '../books.js';

export const router = Router();

router.get('/api/log', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 300, 2000);
  res.json(history(WS, { limit }));
});

router.get('/api/chart', (_req, res) => {
  res.json(chartAccountsOf(WS));
});

router.get('/api/reviews/decisions', (_req, res) => {
  res.json(decidedReviews(WS));
});

router.get('/api/reviews', (_req, res) => {
  res.json(listReviews(WS));
});

/** A file that is no review, or a review that does not fit this workspace, is the sender's error. */
function asRequest<T>(res: Response, fn: () => T): void {
  try {
    res.json(fn());
  } catch (e) {
    if (e instanceof ReviewGitError || e instanceof ReviewFileError || e instanceof IntentError) throw new RequestError(400, e.message);
    throw e;
  }
}

router.post('/api/reviews/import', (req, res) => asRequest(res, () => importReview(WS, req.body)));

router.post('/api/reviews/decide', (req, res) => asRequest(res, () => {
  const { branch, accept, reject } = (req.body ?? {}) as { branch?: unknown; accept?: unknown; reject?: unknown };
  if (typeof branch !== 'string') throw new RequestError(400, 'branch fehlt.');
  if (accept !== 'all' && !(Array.isArray(accept) && accept.every((x) => typeof x === 'string'))) throw new RequestError(400, 'accept: "all" oder eine Liste von Korrekturen.');
  if (reject !== undefined && (typeof reject !== 'object' || reject === null || Object.values(reject).some((x) => typeof x !== 'string' || !x.trim()))) {
    throw new RequestError(400, 'reject: Korrektur → Begründung.');
  }
  return decideReview(WS, branch, { accept: accept as string[] | 'all', reject: reject as Record<string, string> | undefined });
}));
