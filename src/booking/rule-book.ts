/**
 * The company's rules as files hold them (src/booking/rules.ts says what a rule is): every rule
 * of the workspace's knowledge/, executable or a note, with where it stands and where it came
 * from. The classifier carries out the executable ones of the booking step; Firma › Regeln lists
 * them all; keeping a draft compares a file's rules before and after (src/saving/rules.ts).
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { loadKnowledge, RULES_DIR, ROLE_DIRS, KNOWLEDGE_DIR, type Rule } from '../knowledge/layers.js';
import { formTakes, lookupVatCode } from '../accounting/vat-codes.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { isExecutable, parseRule, RULE_STEP, type BookingRule, type PlacedRule, type RuleFacts, type RuleRefusal } from './rules.js';

type Ws = Pick<Workspace, 'paths'>;

/** Where a rule came from: a wish in the sidebar, a person's correction, the form of Firma › Regeln, a sentence of the notes, the app, or something else (its `source` says what). */
export type RuleOrigin = 'wish' | 'correction' | 'hand' | 'notes' | 'app' | 'other';

/** One rule of the workspace as the rules page and a draft card show it. */
export interface RuleRow {
  id: string;
  /** The file it stands in, relative to the app's folder. */
  file: string;
  /** The step it belongs to, e.g. booking.guide.yaml#classify. */
  step: string;
  /** The business whose file holds it. */
  business?: string;
  /** `rule`: the app carries it out; `note`: sentences for the AI and people; `broken`: meant to be carried out, but cannot. */
  kind: 'rule' | 'note' | 'broken';
  rule?: BookingRule;
  note?: { when: string; then: string };
  refusal?: RuleRefusal;
  origin: RuleOrigin;
  source?: string;
  off: boolean;
}

export const originOf = (source: string | undefined): RuleOrigin =>
  /^wish\b/i.test(source ?? '') ? 'wish' : /^correction\b/i.test(source ?? '') ? 'correction' : /^hand\b/i.test(source ?? '') ? 'hand' : /^notes\b/i.test(source ?? '') ? 'notes' : /^app\b/i.test(source ?? '') ? 'app' : 'other';

/** Whether a path of the app's folder is a file that holds rules: a company guide or a business's file. */
export function holdsRules(path: string): boolean {
  if (path.startsWith(`${RULES_DIR}/`)) return path.endsWith('.guide.yaml') && !basename(path).startsWith('_');
  return Object.values(ROLE_DIRS).some((d) => path.startsWith(`${KNOWLEDGE_DIR}/${d}/`) && path.endsWith('.yaml') && !basename(path).startsWith('_'));
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));

/** The step reference of a section of a company guide: classify of booking.guide.yaml is booking.guide.yaml#classify. */
const stepRef = (path: string, section: string) => `${basename(path)}#${section}`;

/**
 * Every rule a file's text holds, in file order. `facts` checks what an executable rule names.
 * A file that does not parse holds no rules (the caller says why it cannot be kept).
 */
export function rulesIn(path: string, text: string, facts: RuleFacts): RuleRow[] {
  const body = (parse(text) ?? {}) as { steps?: Record<string, { rules?: Rule[] }>; id?: string };
  const business = path.startsWith(`${RULES_DIR}/`) ? undefined : basename(path, '.yaml');
  const out: RuleRow[] = [];
  for (const [section, s] of Object.entries(body.steps ?? {})) {
    const step = business ? section : stepRef(path, section);
    for (const raw of s?.rules ?? []) {
      const r = raw as unknown as Record<string, unknown>;
      const id = typeof r.id === 'string' ? r.id : '';
      const base = { id, file: path, step, ...(business ? { business } : {}), origin: originOf(r.source as string | undefined), ...(typeof r.source === 'string' ? { source: r.source } : {}), off: r.off === true };
      if (!isExecutable(r)) { out.push({ ...base, kind: 'note', note: { when: asText(r.when), then: asText(r.then) } }); continue; }
      const parsed = step === RULE_STEP ? parseRule(r, facts, !!business) : { ok: false as const, refusal: { code: 'field', params: { field: 'steps' } } as RuleRefusal };
      out.push(parsed.ok ? { ...base, kind: 'rule', rule: parsed.rule } : { ...base, kind: 'broken', refusal: parsed.refusal });
    }
  }
  return out;
}

/** The chart's accounts by number, from the classifier's chart text (a prior-year export or accounts.json). */
export function chartNames(chartText: string): Map<string, string> {
  return new Map(chartText.split('\n').map((l) => l.split('\t')).filter((c) => /^\d/.test(c[0]?.trim() ?? '') && c[1]).map((c) => [c[0].trim(), c[1].trim()]));
}

/** What a rule may name in this workspace: its chart, the VAT codes the app knows and this firm's form takes, its businesses, its reporting dimensions. */
export function factsOf(accounts: ReadonlyMap<string, string>, businesses: ReadonlySet<string>, dimensions: readonly { id: string }[] = []): RuleFacts {
  return {
    account: (n) => accounts.has(n),
    vat: (code) => (!lookupVatCode(code) ? 'unknown' : formTakes(code) ? 'taken' : 'notTaken'),
    counterparty: (id) => businesses.has(id),
    dimension: (id) => dimensions.some((d) => d.id === id),
  };
}

/** The ids of the workspace's businesses, both layers. */
export function businessesOf(ws: Ws): Map<string, string> {
  return new Map(loadKnowledge(APP_ROOT, ws.paths.root).counterparties.map((c) => [c.id, c.name]));
}

/** Every rule file of the workspace layer, relative to the app's folder. */
export function ruleFiles(ws: Ws): string[] {
  const k = loadKnowledge(APP_ROOT, ws.paths.root);
  return [...k.guides, ...k.counterpartyFiles].filter((f) => f.layer === 'workspace').map((f) => f.path);
}

/** All rules of the workspace, in file order. */
export function companyRules(ws: Ws, facts: RuleFacts): RuleRow[] {
  return ruleFiles(ws).flatMap((path) => {
    const full = join(ws.paths.root, path);
    return existsSync(full) ? rulesIn(path, readFileSync(full, 'utf8'), facts) : [];
  });
}

/** The rules the classifier carries out: executable, of the booking step, switched on or off (ruleFor skips those off). */
export function placedRules(rows: readonly RuleRow[]): PlacedRule[] {
  return rows.filter((r): r is RuleRow & { rule: BookingRule } => r.kind === 'rule' && !!r.rule).map((r) => ({ rule: r.rule, ...(r.business ? { business: r.business } : {}) }));
}
