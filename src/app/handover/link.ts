/**
 * The link through the share service as the page knows it (src/server/routes/share.ts): the service
 * in use, this computer's sender, the shares and their facts, and the jobs that seal, upload and
 * fetch, with their progress. Nothing polls on its own: the dialog asks while it waits for a
 * confirmation or a job, and the books ask the service once when they open (Shell).
 */
import { ApiError, request } from '../lib/api.js';
import type { ApiErrorBody } from '../../types/api-error.js';
import type { ShareRecord, SenderView, Registered, Arrived } from '../../share/sharing.js';
import type { Invitation } from '../../share/invitation.js';
import { reloadHandover } from './store.js';

export type { ShareRecord, SenderView, Registered, Arrived };

export interface ShareSettings {
  service: { url?: string; source: 'env' | 'setting' | 'build' | 'none' };
  /** Whether this computer keeps a link's key (a secret store that the app writes). */
  keeps: boolean;
  /** This computer's sender as kept (its confirmation is asked of the service separately). */
  sender?: string;
  /** The address the books' mailbox sends from, when one is set up. */
  mailFrom?: string;
  shares: ShareRecord[];
}

export interface Shared { record: ShareRecord; link: string; invitation: Invitation; mailed: boolean; mailError?: string }

export type JobPhase = 'pack' | 'encrypt' | 'upload' | 'download' | 'decrypt' | 'done' | 'failed';
export interface Job<T> { id: string; phase: JobPhase; done: number; total: number; result?: T; error?: ApiErrorBody }

/** Starts a job and follows it until it ends; `onProgress` sees each step. A refused job rejects with its refusal. */
export async function runJob<T>(path: string, body: unknown, onProgress?: (j: Job<T>) => void): Promise<T> {
  let job = await request<Job<T>>('POST', path, body);
  for (;;) {
    onProgress?.(job);
    if (job.phase === 'done') return job.result as T;
    if (job.phase === 'failed') throw new ApiError(job.error ?? { error: 'failed' });
    await new Promise((r) => setTimeout(r, 300));
    job = await request<Job<T>>('GET', `/api/share/jobs/${job.id}`);
  }
}

export const shareSettings = (): Promise<ShareSettings> => request<ShareSettings>('GET', '/api/share');

/** Asks the service about the running shares; returns that arrived are kept for review. */
export async function refreshShares(): Promise<{ shares: ShareRecord[]; arrived: Arrived[] }> {
  const r = await request<{ shares: ShareRecord[]; arrived: Arrived[] }>('POST', '/api/share/refresh');
  if (r.arrived.length) await reloadHandover();
  return r;
}

/** A share still running at the service: worth asking about. */
export const running = (s: ShareRecord): boolean => !s.revokedAt && s.state !== 'gone' && Date.now() - Date.parse(s.at) < 31 * 86400_000;

/** `mailto:` with the subject and the text, for the person's own mail program. */
export const mailto = (to: string, subject: string, body: string): string =>
  `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

/** Whether a pasted text looks like a share link (the server decides). */
export const looksLikeLink = (text: string): boolean => /^(https?:\/\/[^\s#]+\/[a-z2-7]{26}|vanilla-accounting:\/\/open\?)\S*#\S{20,}$/.test(text.trim());
