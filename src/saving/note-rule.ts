/**
 * «Als Regel vorschlagen» on a sentence of a partner's notes, and «Regel anpassen» after the person
 * changed that sentence (docs/0.4.0/knowledge.md "When the AI offers one", "The sentence is marked"):
 * the rule the person (or the AI) made of the sentence is drafted into the partner's file, quoting
 * the sentence (`note:`) with `source: notes <date>`, for the same card every drafted rule gets. The
 * card's checks (src/knowledge/note-rules.ts) decide whether it is offered; nothing is kept until
 * the person clicks «Behalten».
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { parseRule, RULE_STEP, type RuleRefusal } from '../booking/rules.js';
import { homeOf, loadKnowledge } from '../knowledge/layers.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { draftDir } from './changes.js';
import { ruleFactsOf } from './rules.js';

/** POST /api/rules/note. */
export interface NoteRuleCommand {
  /** The partner whose notes hold the sentence: its file holds the rule. */
  partner: string;
  /** The sentence as it stands in the notes. */
  sentence: string;
  /** What the rule does: book on `account` with `vat` (null: no code), a private share, or ask first with that question. */
  then: { account: string; vat: string | null; private?: number; ask?: string };
  /** «Regel anpassen»: the id of the partner's rule this sentence's rule replaces; it keeps its id and its condition. */
  replaces?: string;
}

export type NoteRuleDraft = { ok: true; path: string } | { ok: false; refusal: RuleRefusal | { code: 'sentence' } | { code: 'replaces'; params: { id: string } } };

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'regel';

/** The rule's parts the command writes: its outcome, the sentence quoted, where it came from. */
function written(c: NoteRuleCommand, today: string): Record<string, unknown> {
  const { account, vat, private: share, ask } = c.then;
  return {
    then: { ...(ask ? { ask } : {}), account, vat: vat ?? 'none', ...(share ? { private: share } : {}) },
    note: c.sentence.trim(),
    source: `notes ${today}`,
  };
}

/** Pure. The partner's file with the sentence's rule added at the end of its rules, or put in place of rule `replaces`; undefined when that rule is not there. */
export function withNoteRule(text: string, c: NoteRuleCommand, today: string): string | undefined {
  const doc = parseDocument(text || `id: ${c.partner}\n`);
  const rules = doc.getIn(['steps', RULE_STEP, 'rules']);
  const seq = rules instanceof YAMLSeq ? rules : doc.createNode([]) as YAMLSeq;
  if (!(rules instanceof YAMLSeq)) doc.setIn(['steps', RULE_STEP, 'rules'], seq);
  const parts = written(c, today);
  let item: YAMLMap;
  if (c.replaces) {
    const found = seq.items.find((i): i is YAMLMap => i instanceof YAMLMap && i.get('id') === c.replaces);
    if (!found) return undefined;
    item = found;
    for (const [k, v] of Object.entries(parts)) item.set(k, doc.createNode(v));
  } else {
    const taken = new Set(seq.items.map((i) => (i instanceof YAMLMap ? String(i.get('id')) : '')));
    const base = `${slug(c.partner)}-${c.then.ask ? 'frage' : c.then.account}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    seq.add(doc.createNode({ id, ...parts }, { flow: false }));
    item = seq.items.at(-1) as YAMLMap;
  }
  const then = item.get('then', true);
  if (then instanceof YAMLMap) then.flow = true;
  const note = item.get('note', true);
  if (note instanceof Scalar) note.type = Scalar.QUOTE_DOUBLE;
  return doc.toString({ lineWidth: 0 });
}

/**
 * POST /api/rules/note: the rule checked as the app would carry it out, then drafted into the
 * partner's file (into the draft waiting for it, if one does). A rule the app cannot carry out is
 * refused with its reason, and nothing is written.
 */
export function draftNoteRule(ws: Workspace, c: NoteRuleCommand, today = new Date().toISOString().slice(0, 10)): NoteRuleDraft {
  if (!c.sentence.trim()) return { ok: false, refusal: { code: 'sentence' } };
  const business = loadKnowledge(APP_ROOT, ws.paths.root).counterparties.find((x) => x.id === c.partner);
  if (!business) return { ok: false, refusal: { code: 'counterparty', params: { counterparty: c.partner } } };
  const parsed = parseRule({ id: 'note', ...written(c, today) }, ruleFactsOf(ws), true);
  if (!parsed.ok) return { ok: false, refusal: parsed.refusal };
  const path = homeOf('workspace', business.role, business.id);
  const draft = join(draftDir(ws), path);
  const real = join(ws.paths.root, path);
  const text = existsSync(draft) ? readFileSync(draft, 'utf8') : existsSync(real) ? readFileSync(real, 'utf8') : '';
  const next = withNoteRule(text, c, today);
  if (next === undefined) return { ok: false, refusal: { code: 'replaces', params: { id: c.replaces! } } };
  mkdirSync(dirname(draft), { recursive: true });
  writeFileSync(draft, next);
  return { ok: true, path };
}
