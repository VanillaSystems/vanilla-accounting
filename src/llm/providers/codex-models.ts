/**
 * Which Codex model serves each tier (issue #180). The models a ChatGPT account may use differ by
 * plan, so the app asks the signed-in Codex (`codex debug models`, no model call) and takes per
 * tier the first model of `PREFERENCE` the account offers. A tier with none of its own borrows the
 * next lower tier's model (strong from standard, standard from fast), and says so in Firma › KI.
 *
 * The list is kept per Mac beside the app's CODEX_HOME, with when it was read and a stamp of the
 * sign-in, so a new sign-in or a day's age reads it again. A model the account refuses in a call
 * (`model_not_found`) is kept as refused for that sign-in, though the list still names it.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TIERS, type Tier } from '../steps.js';
import { appCodexHome } from './codex-home.js';

/** Per tier, the Codex models the app takes, best first. A new model name is a new entry here. */
export const PREFERENCE: Record<Tier, readonly string[]> = {
  strong: ['gpt-6-astra'],
  standard: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra'],
  fast: ['gpt-6-luna', 'gpt-5.6-luna'],
};

/** Where a tier looks when the account has none of its own models: the lower tiers first, then the higher ones. */
const BORROW: Record<Tier, readonly Tier[]> = {
  strong: ['standard', 'fast'],
  standard: ['fast', 'strong'],
  fast: ['standard', 'strong'],
};

/** A model the account lists, in Codex's own order. */
export interface CodexModel {
  slug: string;
  /** Takes images (and so a PDF's drawn pages). */
  image: boolean;
}

export interface CodexCatalog {
  /** When the list was read (ISO). */
  at: string;
  /** The sign-in it was read for: the modification time of the linked auth.json, never its content. */
  signIn: number;
  models: CodexModel[];
  /** Listed but refused in a call (`model_not_found`) under this sign-in. */
  refused: string[];
}

/** The tier's model; `from` is the tier whose model it borrowed, absent when it is its own. */
export interface TierChoice {
  model: string;
  from?: Tier;
}

/** The visible models of `codex debug models` (codex-cli 0.163: `{ models: [{ slug, visibility, priority, input_modalities }] }`). */
export function parseCatalog(json: string): CodexModel[] {
  const raw = (JSON.parse(json) as { models?: unknown }).models;
  if (!Array.isArray(raw)) throw new Error('codex debug models: no models list');
  return raw
    .filter((m): m is { slug: string; visibility?: unknown; priority?: unknown; input_modalities?: unknown } => typeof m?.slug === 'string' && m.slug !== '')
    .filter((m) => m.visibility === undefined || m.visibility === 'list')
    .map((m, i) => ({ m, i, priority: typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.priority - b.priority || a.i - b.i)
    .map(({ m }) => ({ slug: m.slug, image: !Array.isArray(m.input_modalities) || m.input_modalities.includes('image') }));
}

/** The models a call may name: the listed ones not refused; undefined before the list was read. */
export const usable = (c: CodexCatalog | undefined): CodexModel[] | undefined => c && c.models.filter((m) => !c.refused.includes(m.slug));

/**
 * The tier's model among `available` (undefined: not read yet, the tier's first preference). With
 * none of the table's models there, the account's first listed model: a name the table does not
 * know yet still answers.
 */
export function chooseTier(tier: Tier, available: readonly string[] | undefined): TierChoice {
  if (!available) return { model: PREFERENCE[tier][0] };
  const own = PREFERENCE[tier].find((m) => available.includes(m));
  if (own) return { model: own };
  for (const other of BORROW[tier]) {
    const model = PREFERENCE[other].find((m) => available.includes(m));
    if (model) return { model, from: other };
  }
  return { model: available[0] ?? PREFERENCE[tier][0] };
}

export const tierModels = (available: readonly string[] | undefined): Record<Tier, TierChoice> =>
  Object.fromEntries(TIERS.map((t) => [t, chooseTier(t, available)])) as Record<Tier, TierChoice>;

/** The tier whose table names `model`, the highest first. */
export const tierOf = (model: string): Tier | undefined => (['strong', 'standard', 'fast'] as const).find((t) => PREFERENCE[t].includes(model));

const DAY = 24 * 60 * 60_000;

/** Beside the app's CODEX_HOME (~/.vanilla-accounting/codex-models.json), never in it: that folder holds only what Codex keeps. */
export const catalogPath = (): string => join(dirname(appCodexHome()), 'codex-models.json');

/** The stamp of the sign-in the app's CODEX_HOME links to (0: none). */
export function signInStamp(): number {
  try { return statSync(join(appCodexHome(), 'auth.json')).mtimeMs; } catch { return 0; }
}

let kept: { path: string; catalog: CodexCatalog | undefined } | undefined;

export function readCatalog(): CodexCatalog | undefined {
  const path = catalogPath();
  if (kept?.path === path) return kept.catalog;
  let catalog: CodexCatalog | undefined;
  try {
    const raw = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<CodexCatalog>) : undefined;
    if (raw && typeof raw.at === 'string' && typeof raw.signIn === 'number' && Array.isArray(raw.models)) {
      catalog = { at: raw.at, signIn: raw.signIn, models: raw.models, refused: Array.isArray(raw.refused) ? raw.refused : [] };
    }
  } catch { /* an unreadable file is read again from Codex */ }
  kept = { path, catalog };
  return catalog;
}

export function writeCatalog(catalog: CodexCatalog): void {
  const path = catalogPath();
  writeFileSync(`${path}.tmp`, JSON.stringify(catalog, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  kept = { path, catalog };
}

/** Read again: never read, a day old, or read for another sign-in. */
export const stale = (c: CodexCatalog | undefined, now = Date.now()): boolean =>
  !c || now - Date.parse(c.at) > DAY || c.signIn !== signInStamp();

/** A model the account refused: kept out of every tier until the sign-in changes. */
export function markRefused(model: string): void {
  const c = readCatalog();
  if (c && !c.refused.includes(model)) writeCatalog({ ...c, refused: [...c.refused, model] });
}
