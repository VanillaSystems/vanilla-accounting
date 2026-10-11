/**
 * Moves a workspace's knowledge from the layout before knowledge/ into it:
 *
 *   counterparties/<id>.yaml       → knowledge/<suppliers|customers|authorities>/<id>.yaml
 *   policy/<process>.guide.yaml    → knowledge/rules/<process>.guide.yaml
 *
 * Only files move; no file's content changes, so routing and every step's knowledge stay the same.
 * A file whose app twin exists goes to the twin's folder; otherwise its role is read from its
 * accounts and name, and a file nothing tells apart goes to suppliers/ and is reported as unsure.
 * Idempotent: a file already in place is skipped, and a run after a crash finishes the rest.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';
import { ROLES, type RawCounterparty, type Role } from '../knowledge/counterparties.js';
import { GUIDE_DIR, LEGACY_DIRS, RULES_DIR, ROLE_DIRS, homeOf } from '../knowledge/layers.js';
import { isTracked, moveTracked, removeTracked, repositoryAt } from './git.js';

export interface Move {
  from: string;
  to: string;
  why: string;
  /** Nothing in the file told its role: it went to suppliers/ and a person should check. */
  unsure?: boolean;
}

/** Names of the bodies a company reports to or pays by law (VAT, customs, taxes, social insurance). */
const AUTHORITY = /\b(ESTV|BAZG|Zoll\w*|Steuerverwaltung|Steueramt|Ausgleichskasse|SVA|AHV|Suva|BVG|Pensionskasse|Vorsorgestiftung)\b/i;

/** Pure. The main role of a business file in the old layout, and why. */
export function roleOf(raw: RawCounterparty, appRole: Role | undefined): Omit<Move, 'from' | 'to'> & { role: Role } {
  if (appRole) return { role: appRole, why: `the app files it under ${ROLE_DIRS[appRole]}/` };
  if (AUTHORITY.test(`${raw.name ?? ''} ${raw.id ?? ''}`)) return { role: 'authority', why: `"${raw.name}" names an authority` };
  const accounts = raw.accounts ?? [];
  if (accounts.length && accounts.every((a) => a.startsWith('3'))) return { role: 'customer', why: `books to revenue (${accounts.join(', ')})` };
  if (accounts.length && accounts.every((a) => !a.startsWith('3'))) return { role: 'supplier', why: `books to ${accounts.join(', ')}` };
  return { role: 'supplier', why: accounts.length ? `books to revenue and costs (${accounts.join(', ')})` : 'no accounts tell its role', unsure: true };
}

const yamlIn = (dir: string, suffix: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(suffix)).sort() : [];

/** The main role of every business file the app ships, by id. */
export function appRoles(appRoot: string): Map<string, Role> {
  return new Map(ROLES.flatMap((role) => yamlIn(join(appRoot, GUIDE_DIR, ROLE_DIRS[role]), '.yaml').map((f) => [basename(f, '.yaml'), role] as const)));
}

/** What a migration of `root` would move. Reads, never writes. */
export function planMigration(root: string, roles: Map<string, Role>): Move[] {
  const businesses = yamlIn(join(root, 'counterparties'), '.yaml').map((f): Move => {
    const raw = (parse(readFileSync(join(root, 'counterparties', f), 'utf8')) ?? {}) as RawCounterparty;
    const id = basename(f, '.yaml');
    const { role, ...why } = roleOf(raw, roles.get(id));
    return { from: `counterparties/${f}`, to: homeOf('workspace', role, id), ...why };
  });
  const rules = yamlIn(join(root, 'policy'), '.guide.yaml').map((f): Move => ({
    from: `policy/${f}`, to: `${RULES_DIR}/${f}`, why: "the company's rules for a process",
  }));
  return [...businesses, ...rules];
}

export interface Migration {
  moved: Move[];
  /** Already at their new place: a rerun. */
  done: string[];
  /** The old directories that are gone now. */
  removed: string[];
  /** Files left in an old directory: not knowledge, so a person decides. */
  leftover: string[];
}

/**
 * Apply the plan: `git mv` for a tracked file, a rename otherwise; then delete the old
 * directories once they hold nothing but a .gitkeep. Throws before moving anything if a file
 * exists at both its old and its new place.
 */
export async function migrate(root: string, plan: Move[]): Promise<Migration> {
  const both = plan.filter((m) => existsSync(join(root, m.from)) && existsSync(join(root, m.to)));
  if (both.length) throw new Error(`in both places, keep one: ${both.map((m) => `${m.from} and ${m.to}`).join('; ')}`);
  const inGit = (await repositoryAt(root)) !== null;
  const out: Migration = { moved: [], done: [], removed: [], leftover: [] };
  for (const m of plan) {
    if (!existsSync(join(root, m.from))) { out.done.push(m.to); continue; }
    mkdirSync(dirname(join(root, m.to)), { recursive: true });
    if (inGit && await isTracked(root, m.from)) await moveTracked(root, m.from, m.to);
    else renameSync(join(root, m.from), join(root, m.to));
    out.moved.push(m);
  }
  for (const dir of LEGACY_DIRS) {
    const full = join(root, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    const rest = readdirSync(full);
    if (rest.every((f) => f === '.gitkeep')) {
      if (rest.length && inGit && await isTracked(root, `${dir}/.gitkeep`)) await removeTracked(root, `${dir}/.gitkeep`);
      rmSync(full, { recursive: true, force: true });
      out.removed.push(`${dir}/`);
    } else {
      out.leftover.push(...rest.filter((f) => f !== '.gitkeep').map((f) => `${dir}/${f}`));
    }
  }
  return out;
}
