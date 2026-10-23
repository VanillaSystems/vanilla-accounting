/**
 * The providers this computer can use now: the Claude subscription (the `claude` CLI, the default,
 * always first) and each provider whose API key is kept in the secret store. A key is read from the
 * store, never from the workspace, and is held in memory only for a minute.
 */
import { secrets, type AiKeyName } from '../../secrets/secrets.js';
import type { Provider } from '../provider.js';
import { claudeCli } from './claude-cli.js';
import { catalogOf, KEYED, keyedProvider, type KeyedId, type KeyedSpec } from './keyed.js';

const KEY_TTL = 60_000;
const LIST_TTL = 60 * 60_000;
const LIST_RETRY = 5 * 60_000;

export const keyName = (id: KeyedId): AiKeyName => `ai:${id}`;

const keys = new Map<KeyedId, { at: number; key: string | undefined }>();
const listed = new Map<KeyedId, { at: number; key: string; ids: string[]; error?: string }>();

export async function keyOf(id: KeyedId): Promise<string | undefined> {
  const kept = keys.get(id);
  if (kept && Date.now() - kept.at < KEY_TTL) return kept.key;
  const key = (await secrets.get(keyName(id)).catch(() => undefined)) || undefined;
  keys.set(id, { at: Date.now(), key });
  return key;
}

/** After a key is set or removed: read it again, and list its models again. */
export function forgetKey(id: KeyedId): void {
  keys.delete(id);
  listed.delete(id);
}

/** The provider's listed models, asked once an hour; a failed list is tried again after five minutes and leaves the shipped models. */
async function listOf(spec: KeyedSpec, key: string): Promise<{ ids: string[]; error?: string }> {
  if (!spec.list) return { ids: [] };
  const kept = listed.get(spec.id);
  if (kept && kept.key === key && Date.now() - kept.at < (kept.error ? LIST_RETRY : LIST_TTL)) return kept;
  const fresh = await spec.list(key).then((ids) => ({ ids }), (e: Error) => ({ ids: [], error: e.message }));
  listed.set(spec.id, { at: Date.now(), key, ...fresh });
  return fresh;
}

export interface KeyedState { spec: KeyedSpec; provider?: Provider; listError?: string }

export async function keyedStates(): Promise<KeyedState[]> {
  return Promise.all(KEYED.map(async (spec) => {
    const key = await keyOf(spec.id);
    if (!key) return { spec };
    const { ids, error } = await listOf(spec, key);
    return { spec, provider: keyedProvider(spec, key, catalogOf(spec, ids)), ...(error ? { listError: error } : {}) };
  }));
}

/** The default first: the resolver falls back to it, and never from it to a key that costs money. */
export async function usableProviders(): Promise<[Provider, ...Provider[]]> {
  const keyed = (await keyedStates()).flatMap((s) => (s.provider ? [s.provider] : []));
  return [claudeCli, ...keyed];
}
