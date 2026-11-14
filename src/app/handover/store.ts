/**
 * The hand-over as the page knows it (GET /api/handover): the books' content version, the facts of a
 * Durchsicht copy, the returns kept. Loaded once and again after every change of it; nothing polls.
 */
import { useEffect, useState } from 'react';
import { STATIC_EXPORT, apiFetch, request, ApiError } from '../lib/api.js';
import type { Version } from '../../handover/versions.js';
import type { Marker } from '../../handover/durchsicht.js';
import type { ReturnSummary } from '../../handover/returns.js';
import type { ApiErrorBody } from '../../types/api-error.js';

export interface DurchsichtFacts extends Pick<Marker, 'firm' | 'sharer' | 'me' | 'version' | 'receivedAt' | 'message' | 'sent'> {
  questions: NonNullable<Marker['questions']>;
  conflicts: string[];
  dropped: string[];
  /** Records he changed since the version he got. */
  changes: number;
  notes: Record<string, string>;
  /** Whether the server can go back to the books opened before (not in the Mac app, which lists them under «Zuletzt»). */
  back: boolean;
}

export interface HandoverView {
  version?: Version;
  versions: Version[];
  durchsicht?: DurchsichtFacts;
  returns: ReturnSummary[];
}

let view: HandoverView | undefined;
const listeners = new Set<(v: HandoverView | undefined) => void>();

export function reloadHandover(): Promise<HandoverView | undefined> {
  if (STATIC_EXPORT) return Promise.resolve(undefined);
  return request<HandoverView>('GET', '/api/handover').then((v) => { view = v; for (const l of listeners) l(v); return v; }, () => undefined);
}

export function useHandover(): HandoverView | undefined {
  const [v, setV] = useState(view);
  useEffect(() => {
    listeners.add(setV);
    if (!view) void reloadHandover();
    return () => { listeners.delete(setV); };
  }, []);
  return v;
}

export const handoverNow = (): HandoverView | undefined => view;

/** The version's checksum as a person reads it: «a3f9 c21e 07bd». */
export const shortSum = (checksum: string): string => (checksum.replace(/^sha256:/, '').slice(0, 12).match(/.{4}/g) ?? []).join(' ');

/** What «Öffnen…» of a `.vanilla` file did. */
export type Opened =
  | { kind: 'return'; id: string; from: { name: string }; changes: number; basedOn: number }
  | { kind: 'full' | 'update'; firm: string; version: number; conflicts: number; dropped: number };

/** Sends a `.vanilla` file to the server: a return is kept for review, a hand-over opens as a Durchsicht copy. */
export async function openVanilla(file: Blob): Promise<Opened> {
  const res = await apiFetch('/api/handover/open', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
  if (!res.ok) {
    const err = await res.json().catch(() => null) as ApiErrorBody | null;
    throw new ApiError(err?.error ? err : { error: `HTTP ${res.status}` });
  }
  const out = await res.json() as Opened;
  await reloadHandover();
  return out;
}

/** Whether a dropped or chosen file is a hand-over file. */
export const isVanillaFile = (name: string): boolean => name.toLowerCase().endsWith('.vanilla');

/** «8.4 MB», «48 KB»: the size the dialogs tell. */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
