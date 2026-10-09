/**
 * The review package's state in the browser: the snapshot's books, the Treuhänder's corrections
 * on them (src/review/session.ts), kept in localStorage under the snapshot's manifest hash, so a
 * closed tab loses nothing and a newer package starts empty. Every write the UI makes in review
 * mode lands here (src/app/lib/api.ts) instead of an API.
 */
import { useSyncExternalStore } from 'react';
import type { Books } from '../../books/lock.js';
import { ClosedPeriodError } from '../../books/lock.js';
import type { AuditSnapshot } from '../../audit/sources.js';
import { EXPORT_SOURCES } from '../../audit/sources.js';
import { planIntent, IntentError, type Intent, type Planned } from '../../review/corrections.js';
import { comment, record, removeComment, removeSignOff, replay, reviewFile, reviewFileName, signOff, startReview, undo, type ReviewState } from '../../review/session.js';
import { parseReviewFile, type Target } from '../../review/types.js';

type Review = NonNullable<AuditSnapshot['review']>;

/** A question the UI puts to the Treuhänder: the reason of a correction, or a comment's text. */
export interface Ask { kind: 'reason' | 'comment'; planned?: Planned; resolve(text: string | null): void }

export class ReviewSession {
  private listeners = new Set<() => void>();
  books: Books;
  broken: string[] = [];
  ask: Ask | null = null;
  version = 0;

  constructor(readonly base: Books, readonly key: string, readonly review: Review, public state: ReviewState) {
    ({ books: this.books, broken: this.broken } = replay(base, state.corrections));
  }

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };

  private set(state: ReviewState) {
    this.state = state;
    ({ books: this.books, broken: this.broken } = replay(this.base, state.corrections));
    try { localStorage.setItem(this.key, JSON.stringify(state)); } catch { /* private window: the session lives as long as the tab */ }
    this.changed();
  }

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private question(ask: Omit<Ask, 'resolve'>): Promise<string | null> {
    return new Promise((resolve) => {
      this.ask = { ...ask, resolve: (text) => { this.ask = null; this.changed(); resolve(text); } };
      this.changed();
    });
  }

  /** What an intent would do, or the refusal the owner's app would give. */
  plan(intent: Intent): Planned {
    return planIntent(this.books, intent);
  }

  /**
   * One correction: planned on the current books (a refusal throws), its reason asked, then
   * recorded. False when the Treuhänder cancels.
   */
  async write(intent: Intent): Promise<boolean> {
    const planned = this.plan(intent);
    const text = await this.question({ kind: 'reason', planned });
    if (!text?.trim()) return false;
    this.set(record(this.state, this.books, intent, text, new Date().toISOString()));
    return true;
  }

  async comment(target: Target): Promise<boolean> {
    const text = await this.question({ kind: 'comment' });
    if (!text?.trim()) return false;
    this.set(comment(this.state, target, text, new Date().toISOString()));
    return true;
  }

  undo(id: string) { this.set(undo(this.state, id)); }
  removeComment(id: string) { this.set(removeComment(this.state, id)); }
  signOff(scope: string, statement: string) { this.set(signOff(this.state, scope, statement, new Date().toISOString())); }
  removeSignOff(id: string) { this.set(removeSignOff(this.state, id)); }
  setMessage(message: string) { this.set({ ...this.state, message }); }

  /** "Review abschicken": the review file, downloaded as review-<period>-<name>.json. */
  download() {
    const file = reviewFile(this.state, this.broken, new Date().toISOString());
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = reviewFileName(this.state);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** A review file exported earlier, for this snapshot, continues where it was. */
  load(json: unknown) {
    const file = parseReviewFile(json);
    if (file.base.manifestSha256 !== this.state.base.manifestSha256) throw new IntentError('Diese Datei gehört zu einem anderen Stand der Bücher.');
    this.set({ id: file.id, reviewer: file.reviewer, base: file.base, message: file.message ?? '', corrections: file.corrections, comments: file.comments, signOffs: file.signOffs });
  }
}

let session: ReviewSession | undefined;

export const reviewSession = (): ReviewSession | undefined => session;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Opens the review of this package: the books from the export, the corrections from localStorage. */
export async function startReviewSession(snapshot: AuditSnapshot): Promise<ReviewSession> {
  const review = snapshot.review!;
  const [books, manifest] = await Promise.all([
    fetch(EXPORT_SOURCES.books()).then((r) => r.json() as Promise<Books>),
    fetch(EXPORT_SOURCES.manifest()).then((r) => r.text()),
  ]);
  books.journalEntries ??= [];
  books.config ??= {};
  const manifestSha256 = crypto.subtle ? await sha256(manifest) : `${snapshot.createdAt}-${review.commit ?? ''}`;
  const key = `review:${manifestSha256}`;
  let state: ReviewState | undefined;
  try { state = JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined; } catch { state = undefined; }
  state ??= startReview(review.reviewer, {
    manifestSha256,
    ...(review.commit ? { commit: review.commit } : {}),
    createdAt: snapshot.createdAt,
    ...(books.config.closedThrough ? { closedThrough: books.config.closedThrough } : {}),
    period: review.period,
  });
  session = new ReviewSession(books, key, review, state);
  return session;
}

/** Re-renders on every change of the review. */
export function useReview(): ReviewSession | undefined {
  useSyncExternalStore(session?.subscribe ?? (() => () => {}), () => session?.version ?? 0);
  return session;
}

export { ClosedPeriodError, IntentError };
