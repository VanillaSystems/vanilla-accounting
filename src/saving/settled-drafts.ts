/**
 * How each drafted rule ended, kept on this computer (data/draft-settled.json, outside git): the
 * card's «Behalten» or «Verwerfen», by rule (`<file>#<section>#<id>`), with when. Rules without a
 * business share one file (knowledge/rules/booking.guide.yaml), so a file's draft says nothing about
 * one rule: the AI sidebar reads this, rule by rule, to tell the model what became of a rule it
 * drafted earlier in a conversation (src/assistant/proposals.ts, #362).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Workspace } from '../workspace/workspace.js';

/** One card's outcome for a rule: which change of it the card held (absent in records from before it was kept). */
export type DraftOutcome = { state: 'kept' | 'discarded'; at: string; change?: RuleChange['change'] };

/** At most this many outcomes are kept per rule, the newest. */
const OUTCOMES_KEPT = 20;

/** What a draft does to one rule of its file. */
export interface RuleChange { section: string; id: string; change: 'added' | 'changed' | 'removed' }

const fileOf = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.data, 'draft-settled.json');

/** The key of one rule of a file. */
export const ruleKey = (path: string, section: string, id: string): string => `${path}#${section}#${id}`;

/** The rules a file's text holds, by `<section>#<id>`: whether each is switched off, and its whole text to compare. A text that does not parse holds none. */
export function rulesOf(text: string): Map<string, { off: boolean; body: string }> {
  const out = new Map<string, { off: boolean; body: string }>();
  let doc: { steps?: Record<string, { rules?: Array<Record<string, unknown>> } | null> } | null;
  try { doc = parse(text) as typeof doc; } catch { return out; }
  for (const [section, s] of Object.entries(doc?.steps ?? {})) {
    for (const r of s?.rules ?? []) if (r && typeof r.id === 'string') out.set(`${section}#${r.id}`, { off: r.off === true, body: JSON.stringify(r) });
  }
  return out;
}

/** The rules `after` adds, changes or removes against `before`. */
export function ruleChanges(before: string, after: string): RuleChange[] {
  const b = rulesOf(before);
  const a = rulesOf(after);
  const split = (key: string) => { const i = key.lastIndexOf('#'); return { section: key.slice(0, i), id: key.slice(i + 1) }; };
  return [
    ...[...a].flatMap(([k, r]): RuleChange[] => (!b.has(k) ? [{ ...split(k), change: 'added' }] : b.get(k)!.body !== r.body ? [{ ...split(k), change: 'changed' }] : [])),
    ...[...b.keys()].filter((k) => !a.has(k)).map((k) => ({ ...split(k), change: 'removed' as const })),
  ];
}

/** Every outcome of each rule, oldest first: a later card's (a change of the rule discarded) never hides an earlier keep. */
export function settledDrafts(ws: Pick<Workspace, 'paths'>): Record<string, DraftOutcome[]> {
  let raw: Record<string, DraftOutcome | DraftOutcome[]>;
  try { raw = JSON.parse(readFileSync(fileOf(ws), 'utf8')) as typeof raw; } catch { return {}; }
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
}

/**
 * Records how the rules a draft of `path` changed ended. Written whole to a temporary file and moved
 * in place; a failure is swallowed: the record only informs the AI, it never fails a keep.
 */
export function recordSettled(ws: Pick<Workspace, 'paths'>, path: string, changes: readonly RuleChange[], state: DraftOutcome['state'], at = new Date().toISOString()): void {
  if (!changes.length) return;
  try {
    const all = settledDrafts(ws);
    for (const c of changes) {
      const key = ruleKey(path, c.section, c.id);
      all[key] = [...(all[key] ?? []), { state, at, change: c.change }].slice(-OUTCOMES_KEPT);
    }
    mkdirSync(ws.paths.data, { recursive: true });
    const tmp = `${fileOf(ws)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    renameSync(tmp, fileOf(ws));
  } catch { /* the record is a hint for the AI; the keep or discard stands */ }
}
