/**
 * The providers this computer can use now: the subscriptions first (the `claude` and `codex` CLIs
 * found here, the one Firma › KI chose first, Claude Code when none is chosen or none is found),
 * then each provider whose API key is kept in the secret store. A key is read from the store, never
 * from the workspace, and is held in memory only for a minute.
 */
import { secrets, type AiKeyName } from '../../secrets/secrets.js';
import { basename, dirname } from 'node:path';
import { programOn } from '../../platform/login-path.js';
import type { TerminalCli } from '../../platform/terminal.js';
import type { Provider } from '../provider.js';
import { readSettings } from '../settings.js';
import { claudeCli } from './claude-cli.js';
import { codexCli, codexCommand } from './codex-cli.js';
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

const claudeFound = (): boolean => {
  const named = process.env.CLAUDE_BIN;
  return Boolean(named ? programOn(dirname(named), basename(named)) : programOn(process.env.PATH ?? '', 'claude'));
};

/** Each CLI the app asks as a subscription, and whether its program is on this computer. */
export const SUBSCRIPTIONS: Record<TerminalCli, { provider: Provider; found: () => boolean }> = {
  claude: { provider: claudeCli, found: claudeFound },
  codex: { provider: codexCli, found: () => codexCommand() !== undefined },
};

/** The CLIs found here, `preferred` first, else Claude Code first; none found: Claude Code, whose call then says what to install. */
export function subscriptions(preferred: TerminalCli | undefined): [Provider, ...Provider[]] {
  const order: TerminalCli[] = preferred === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
  const found = order.filter((cli) => SUBSCRIPTIONS[cli].found()).map((cli) => SUBSCRIPTIONS[cli].provider);
  return found.length ? [found[0], ...found.slice(1)] : [claudeCli];
}

/** The subscriptions first: the resolver falls back to them, and never from them to a key that costs money. */
export async function usableProviders(): Promise<[Provider, ...Provider[]]> {
  const keyed = (await keyedStates()).flatMap((s) => (s.provider ? [s.provider] : []));
  return [...subscriptions(readSettings().cli), ...keyed];
}
