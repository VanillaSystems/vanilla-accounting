/**
 * Keeping, switching off and deleting the company's rules with one click (MISSION: «the person
 * keeps it with one click»; docs/0.4.0/saving.md, "One click for a rule"). A draft of a rules file
 * the AI wrote is shown in plain words and kept at once, without the AI step «Speichern
 * vorbereiten»: the app renders a rule from its structure itself. Every rule a save adds or changes
 * must be one the app carries out (src/booking/rules.ts); a rule in sentences is refused when it is
 * kept, never stored as prose nothing acts on. Firma › Regeln switches a rule off or deletes it in
 * place, each with an undo that puts the file back as it was.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { parse, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { chartNames, companyRules, factsOf, holdsRules, rulesIn, type RuleRow } from '../booking/rule-book.js';
import { chartOf, loadClassifyContext, ruleLine } from '../booking/classify.js';
import { loadKnowledge, KNOWLEDGE_DIR } from '../knowledge/layers.js';
import { loneWords, type BookingRule, type RuleFacts } from '../booking/rules.js';
import { previewRules, ruleKey, type PlacedRow, type RulePreview } from '../booking/rule-preview.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { hasBooks, loadBooks } from '../books/store.js';
import type { Counterparty } from '../knowledge/counterparties.js';
import { commitExactly, repositoryAt } from '../workspace/git.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { draftDir } from './changes.js';

type Ws = Pick<Workspace, 'paths'>;

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);
const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/** What the rules of a workspace may name: its chart, the VAT codes, its businesses (and `alsoBusiness`, a business a draft adds). */
export function ruleFactsOf(ws: Ws, alsoBusiness?: string): RuleFacts {
  const ids = new Set(loadKnowledge(APP_ROOT, ws.paths.root).counterparties.map((c) => c.id));
  if (alsoBusiness) ids.add(alsoBusiness);
  return factsOf(chartNames(chartOf(ws)), ids);
}

/** How a rules file changes: its rules added, changed and removed, whether anything else changed, and what cannot be kept. */
export interface RuleDiff {
  path: string;
  added: RuleRow[];
  changed: RuleRow[];
  /** Each changed rule as it stands now, in the order of `changed`: the card says what it was. */
  before: RuleRow[];
  removed: RuleRow[];
  /** Parts of the file other than its rules changed (a business's name or how it is recognised). */
  others: boolean;
  /** Added or changed rules the app cannot carry out: keeping refuses them. */
  refused: RuleRow[];
  /** Added or changed rules that rest on single words alone (loneWords): keeping them asks for confirmation. */
  wide: RuleRow[];
  /** The knowledge would not load with this file (it names the reason). */
  broken?: string;
}

/** The file's body with every rule list emptied: what is not a rule. */
function withoutRules(text: string): string {
  const body = (parse(text) ?? {}) as { steps?: Record<string, { rules?: unknown[] }> };
  for (const s of Object.values(body.steps ?? {})) if (s && typeof s === 'object') delete s.rules;
  return JSON.stringify(body);
}

/** The workspace's businesses with `text` at `path` (a copy of knowledge/ with the file in it), or why they would not load. */
function knowledgeWith(ws: Ws, path: string, text: string): { counterparties: Counterparty[] } | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rules-check-'));
  try {
    const own = join(ws.paths.root, KNOWLEDGE_DIR);
    if (existsSync(own)) cpSync(own, join(dir, KNOWLEDGE_DIR), { recursive: true });
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    return { counterparties: loadKnowledge(APP_ROOT, dir).counterparties };
  } catch (e) {
    return { error: (e as Error).message.replace(dir + '/', '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function ruleDiff(ws: Ws, path: string, before: string, after: string): RuleDiff {
  const business = path.startsWith(`${KNOWLEDGE_DIR}/rules/`) ? undefined : basename(path, '.yaml');
  const facts = ruleFactsOf(ws, business);
  let broken: string | undefined;
  let a: RuleRow[] = [];
  try { a = after ? rulesIn(path, after, facts) : []; } catch (e) { broken = (e as Error).message; }
  const b = before ? rulesIn(path, before, facts) : [];
  const key = (r: RuleRow) => `${r.step}#${r.id}`;
  const same = (x: RuleRow, y: RuleRow) => JSON.stringify([x.kind, x.rule, x.note, x.off, x.source]) === JSON.stringify([y.kind, y.rule, y.note, y.off, y.source]);
  const added = a.filter((r) => !b.some((x) => key(x) === key(r)));
  const changed = a.filter((r) => b.some((x) => key(x) === key(r) && !same(x, r)));
  const removed = b.filter((r) => !a.some((x) => key(x) === key(r)));
  const was = changed.map((r) => b.find((x) => key(x) === key(r))!);
  const wide = [...added, ...changed].filter((r) => r.kind === 'rule' && loneWords(placedOf(r)).length > 0);
  let others = false;
  if (!broken) {
    try { others = withoutRules(before) !== withoutRules(after); } catch (e) { broken = (e as Error).message; }
  }
  if (!broken && after) { const k = knowledgeWith(ws, path, after); if ('error' in k) broken = k.error; }
  return { path, added, changed, before: was, removed, others, refused: [...added, ...changed].filter((r) => r.kind !== 'rule'), wide, ...(broken ? { broken } : {}) };
}

const placedOf = (r: RuleRow) => ({ rule: r.rule as BookingRule, ...(r.business ? { business: r.business } : {}) });

/**
 * Why a set of changed files cannot be kept: a rule the app cannot carry out, knowledge that would
 * not load, or (unless the person `confirmed` it on the card, having seen its payments) a rule that
 * rests on single words alone.
 */
export function rulesRefusal(diffs: RuleDiff[], confirmed = false): string | undefined {
  const lines = diffs.flatMap((d) => [
    ...(d.broken ? [`${d.path}: ${d.broken}`] : []),
    ...d.refused.map((r) => `${d.path}: Regel «${r.id || '?'}» kann die App nicht ausführen (${r.kind === 'note' ? 'in Sätzen geschrieben' : r.refusal?.code ?? '?'})`),
    ...(confirmed ? [] : d.wide.map((r) => `${d.path}: Regel «${r.id}» erkennt Zahlungen nur an einzelnen Wörtern (${loneWords(placedOf(r)).join(', ')}): auf ihrer Karte die passenden Zahlungen ansehen und bestätigen`)),
  ]);
  return lines.length ? lines.join('; ') : undefined;
}

/** The draft of one rules file against the file as it is: what the sidebar's card and Änderungen show. */
export interface DraftRules extends RuleDiff {
  /** The draft's content hash: «Behalten» keeps exactly what was shown. */
  basis: string;
  /** One click keeps it: the file loads, every rule in it is one the app carries out, and a rule changes. */
  keepable: boolean;
  /** Keeping it needs the person's confirmation (`wide` is not empty): the button says «Trotzdem behalten». */
  confirm: boolean;
  /** What each added or changed rule would do on this year's payments, in the order of `added` then `changed`. */
  preview: RulePreview[];
}

/** Every rule of the workspace with `rows` standing for the file at `path`, each as the classifier places it. */
function rulesWith(ws: Ws, path: string, rows: readonly RuleRow[]): PlacedRow[] {
  return [...companyRules(ws, ruleFactsOf(ws)).filter((r) => r.file !== path), ...rows]
    .filter((r) => r.kind === 'rule' && r.rule).map((row) => ({ row, placed: placedOf(row) }));
}

export function draftRules(ws: Workspace, path: string): DraftRules | undefined {
  if (!holdsRules(path) || path.includes('..')) return undefined;
  const draft = join(draftDir(ws), path);
  if (!existsSync(draft)) return undefined;
  const after = read(draft);
  const d = ruleDiff(ws, path, read(join(ws.paths.root, path)), after);
  const keepable = !d.broken && !d.refused.length && (d.added.length + d.changed.length + d.removed.length > 0);
  return { ...d, basis: hashOf(after), keepable, confirm: keepable && d.wide.length > 0, preview: d.broken ? [] : preview(ws, path, after, [...d.added, ...d.changed]) };
}

/** The preview of `targets` (rules of the draft at `path`) on the books, with the draft's businesses routing the payments. */
function preview(ws: Workspace, path: string, after: string, targets: RuleRow[]): RulePreview[] {
  const rules = targets.filter((r) => r.kind === 'rule');
  if (!rules.length || !hasBooks(ws)) return [];
  const k = knowledgeWith(ws, path, after);
  if ('error' in k) return [];
  const all = rulesWith(ws, path, rulesIn(path, after, ruleFactsOf(ws, path.startsWith(`${KNOWLEDGE_DIR}/rules/`) ? undefined : basename(path, '.yaml'))));
  const context = { ...loadClassifyContext(ws), counterparties: k.counterparties, rules: all.map((r) => r.placed) };
  const keys = new Set(rules.map(ruleKey));
  return previewRules(all.filter((r) => keys.has(ruleKey(r.row))), all, loadBooks(ws), context, loadFxResolver());
}

export type KeepResult =
  | { ok: true; committed: boolean }
  | { ok: false; refusal: 'gone' | 'stale' | 'rules' | 'wide' | 'not-rules' | 'changed'; message: string };

const CUSTOMIZING = ['Vanilla-Kind: customizing', "Vanilla-Person: the app's user"];

/** The subject of a save that keeps rules, in plain German. */
function subjectOf(ws: Workspace, d: RuleDiff): string {
  const ctx = { chartOfAccounts: chartOf(ws), counterparties: loadKnowledge(APP_ROOT, ws.paths.root).counterparties };
  const say = (r: RuleRow) => (r.rule ? ruleLine({ rule: r.rule, ...(r.business ? { business: r.business } : {}) }, ctx) : r.id);
  const parts = [
    ...d.added.map((r) => `Neue Regel: ${say(r)}`),
    ...d.changed.map((r) => `Regel geändert: ${say(r)}`),
    ...d.removed.map((r) => `Regel entfernt: ${r.rule ? say(r) : r.id}`),
  ];
  return (parts.join('; ') || `Regeln: ${d.path}`).slice(0, 200);
}

async function commit(ws: Ws, message: string, path: string): Promise<boolean> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return false;
  return commitExactly(repo, `${message}\n\n${CUSTOMIZING.join('\n')}`, [relative(repo, join(ws.paths.root, path))]);
}

/**
 * «Behalten»: the one draft file goes into the books folder as the person saw it (`basis`) and is
 * saved at once. Refused when it changed since, when it is not a rules file, or when a rule in it
 * cannot be carried out.
 */
export async function keepDraft(ws: Workspace, path: string, basis: string, confirmed = false): Promise<KeepResult> {
  if (!holdsRules(path) || path.includes('..')) return { ok: false, refusal: 'not-rules', message: `${path} hält keine Regeln.` };
  const draft = join(draftDir(ws), path);
  if (!existsSync(draft)) return { ok: false, refusal: 'gone', message: 'Diesen Entwurf gibt es nicht mehr.' };
  const after = read(draft);
  if (hashOf(after) !== basis) return { ok: false, refusal: 'stale', message: 'Der Entwurf hat sich seit der Anzeige geändert.' };
  const d = ruleDiff(ws, path, read(join(ws.paths.root, path)), after);
  const why = rulesRefusal([d], confirmed);
  if (why) return { ok: false, refusal: d.wide.length && !rulesRefusal([d], true) ? 'wide' : 'rules', message: why };
  const to = join(ws.paths.root, path);
  mkdirSync(dirname(to), { recursive: true });
  if (after.trim()) writeFileSync(to, after); else rmSync(to, { force: true });
  rmSync(draft);
  return { ok: true, committed: await commit(ws, subjectOf(ws, d), path) };
}

/** «Verwerfen»: the draft of one file is gone; the file stays as it is. */
export function discardDraft(ws: Ws, path: string): boolean {
  if (path.includes('..')) return false;
  const draft = join(draftDir(ws), path);
  if (!existsSync(draft)) return false;
  rmSync(draft);
  return true;
}

// ─── Firma › Regeln ─────────────────────────────────────────────────────────

/** A rule with how often it applied: the payments booked by it, the day of the last, and the payments it held to ask about. */
export interface RuleListed extends RuleRow { applied: number; last?: string; asked: number }

/** GET /api/rules. */
export interface RulesView {
  rules: RuleListed[];
  /** What a rule's plain words name: accounts, businesses and payers (by the key `when.payer` holds) by their names. */
  names: { accounts: Record<string, string>; businesses: Record<string, string>; payers: Record<string, string> };
  currency: string;
}

/** GET /api/rules/draft: the draft with the names its rules' words use, and the payments each ask rule holds open, by rule id. */
export type DraftView = DraftRules & Pick<RulesView, 'names' | 'currency'> & { held: Record<string, number> };

/** POST /api/rules/draft. */
export type DraftCommand = { kind: 'keep'; path: string; basis: string; confirm?: boolean } | { kind: 'discard'; path: string };

export type RuleCommand =
  | { kind: 'off' | 'on' | 'delete'; file: string; step: string; id: string }
  /** Undo: the file as it was before, when it is still as the command left it (`after`, its hash). */
  | { kind: 'restore'; file: string; before: string; after: string };

export type RuleCommandResult =
  | { ok: true; undo?: { file: string; before: string; after: string }; committed: boolean }
  | { ok: false; refusal: 'not-found' | 'draft-waiting' | 'changed' | 'not-rules'; message: string };

/** The key of a step inside a file: a company guide keys its sections by step id, a business's file by the full step reference. */
const sectionOf = (file: string, step: string) => (file.startsWith(`${KNOWLEDGE_DIR}/rules/`) ? step.split('#')[1] ?? step : step);

/** The file's text with one rule switched off or on, or deleted; comments and the rest stay as written. */
export function editRule(text: string, file: string, step: string, id: string, kind: 'off' | 'on' | 'delete'): string | undefined {
  const doc = parseDocument(text);
  const seq = doc.getIn(['steps', sectionOf(file, step), 'rules']);
  if (!(seq instanceof YAMLSeq)) return undefined;
  const i = seq.items.findIndex((item) => item instanceof YAMLMap && item.get('id') === id);
  if (i < 0) return undefined;
  const item = seq.items[i] as YAMLMap;
  if (kind === 'delete') seq.delete(i);
  else if (kind === 'off') item.set('off', true);
  else item.delete('off');
  return String(doc);
}

const WORDS: Record<'off' | 'on' | 'delete', string> = { off: 'Regel ausgeschaltet', on: 'Regel eingeschaltet', delete: 'Regel gelöscht' };

export async function ruleCommand(ws: Ws, c: RuleCommand): Promise<RuleCommandResult> {
  if (!holdsRules(c.file) || c.file.includes('..')) return { ok: false, refusal: 'not-rules', message: `${c.file} hält keine Regeln.` };
  if (existsSync(join(draftDir(ws), c.file))) return { ok: false, refusal: 'draft-waiting', message: 'Für diese Datei wartet ein Entwurf: erst behalten oder verwerfen.' };
  const path = join(ws.paths.root, c.file);
  const now = read(path);
  if (c.kind === 'restore') {
    if (hashOf(now) !== c.after) return { ok: false, refusal: 'changed', message: 'Die Regeln haben sich seither geändert.' };
    writeFileSync(path, c.before);
    return { ok: true, committed: await commit(ws, 'Regel wiederhergestellt', c.file) };
  }
  const next = editRule(now, c.file, c.step, c.id, c.kind);
  if (next === undefined) return { ok: false, refusal: 'not-found', message: `Regel ${c.id} gibt es in ${c.file} nicht.` };
  writeFileSync(path, next);
  return { ok: true, undo: { file: c.file, before: now, after: hashOf(next) }, committed: await commit(ws, `${WORDS[c.kind]}: ${c.id}`, c.file) };
}
