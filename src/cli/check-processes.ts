/**
 * npm run check-processes [-- --unknown]
 *
 * Enforces the contract in processes/README.md over every *.flow.yaml, its
 * *.guide.yaml and both knowledge layers (src/knowledge/layers.ts): the graph is wired, every
 * judgment step has knowledge, every AI decision can say "new case", every
 * rule says where it came from, every fact about one counterparty lives in
 * that counterparty's file, and routing is unambiguous on the current index.
 * Exit 1 on any error; warnings do not fail. --unknown lists the bank
 * merchants no counterparty file claims, most frequent first.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parse } from 'yaml';
import { loadBooks } from '../books/store.js';
import {
  identify, claims, merchantOf, signalsOfReceipt, uidsIn, TIERS, type Counterparty, type RawCounterparty,
} from '../knowledge/counterparties.js';
import {
  loadKnowledge, companySpecific, BINDING_DIR, POLICY_DIR,
  type Knowledge, type KnowledgeFile, type Rule, type Section, type Guide,
} from '../knowledge/layers.js';
import { GATE_TESTS } from '../knowledge/gates.js';
import { loadCaseChart, loadCases, validateCase } from '../knowledge/cases.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { namesOf, mentionIn, counterpartiesNamedIn } from '../knowledge/mentions.js';
import { APP_ROOT, identityIn, openWorkspace } from '../workspace/workspace.js';

const ws = openWorkspace();
const DIR = join(APP_ROOT, 'processes');
const NEW_CASE = 'new-case.flow.yaml';
const PLANNED_SCRIPTS = new Set(['archive']);
const RULE_STATUSES = new Set(['proposed', 'open']);
const MODELS = new Set(['haiku', 'sonnet', 'opus']);
const SECTION_TOKEN_WARN = 900;

type Step = {
  id: string; kind?: string; by?: string; needs?: string[]; outcomes?: string[];
  uses?: string; process?: string; phase?: string;
  with?: { guide?: string; model?: string; escalate?: string; batch?: number };
};
type Flow = { id: string; phases?: string[]; steps: Step[] };

const errors: string[] = [];
const warnings: string[] = [];
const scripts: Record<string, string> = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')).scripts;

function who(s: Step): 'machine' | 'ai' | 'human' {
  if (s.by === 'ai' || s.by === 'human' || s.by === 'machine') return s.by;
  return s.kind === 'agent' ? 'ai' : s.kind === 'human' ? 'human' : 'machine';
}

const guides = new Map<string, Guide>();
function loadGuide(file: string): Guide | undefined {
  if (!guides.has(file)) {
    const path = join(DIR, file);
    if (!existsSync(path)) return undefined;
    guides.set(file, parse(readFileSync(path, 'utf8')) as Guide);
  }
  return guides.get(file);
}

let knowledge: Knowledge | undefined;
try {
  knowledge = loadKnowledge(APP_ROOT, ws.paths.root);
} catch (e) {
  errors.push((e as Error).message);
}
const counterparties: Counterparty[] = knowledge?.counterparties ?? [];
const counterpartyFiles: KnowledgeFile<RawCounterparty>[] = knowledge?.counterpartyFiles ?? [];
const policies = (knowledge?.guides ?? []).filter((g) => g.layer === 'workspace');
const fileOf = (cp: Counterparty) => cp.origin.binding ?? cp.origin.vendor;

// ─── Flows ──────────────────────────────────────────────────────────────────

const usedSections = new Map<string, Set<string>>();
const stepRefs = new Set<string>(); // every with.guide value: the address of a step's knowledge

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.flow.yaml')).sort()) {
  const flow = parse(readFileSync(join(DIR, file), 'utf8')) as Flow;
  const err = (msg: string) => errors.push(`${file}: ${msg}`);
  const steps = new Map(flow.steps.map((s) => [s.id, s]));
  const followed = new Set<string>();

  for (const s of flow.steps) {
    if (flow.phases && s.phase && !flow.phases.includes(s.phase)) err(`${s.id}: phase "${s.phase}" is not in phases`);

    for (const need of s.needs ?? []) {
      const [id, outcome] = need.split('.');
      const src = steps.get(id);
      if (!src) { err(`${s.id}: needs unknown step "${id}"`); continue; }
      if (outcome && !(src.outcomes ?? []).includes(outcome)) err(`${s.id}: "${id}" has no outcome "${outcome}" — declare it in its outcomes or name an existing one`);
      if (!outcome && src.outcomes) err(`${s.id}: needs "${id}", which has outcomes — name one, e.g. "${id}.${src.outcomes[0]}"`);
      followed.add(need);
    }

    if (s.uses?.startsWith('npm:')) {
      const script = s.uses.slice(4).split(' ')[0];
      if (!scripts[script]) {
        if (PLANNED_SCRIPTS.has(script)) warnings.push(`${file}: ${s.id} uses npm:${script}, which is planned but not built`);
        else err(`${s.id}: uses npm:${script}, which is not in package.json — add the script or fix the name`);
      }
    }
    if (s.process && !existsSync(join(DIR, s.process))) err(`${s.id}: process "${s.process}" does not exist`);

    // Engine inputs: who runs an AI step, and how many items per call.
    for (const k of ['model', 'escalate'] as const) {
      const m = s.with?.[k];
      if (m !== undefined && !MODELS.has(m)) err(`${s.id}: with.${k} "${m}" is not one of ${[...MODELS].join(', ')}`);
    }
    const batch = s.with?.batch;
    if (batch !== undefined && !(Number.isInteger(batch) && batch > 0)) err(`${s.id}: with.batch must be a positive integer`);

    // Contract 2: every judgment step has knowledge.
    const judgment = !s.process && s.kind !== 'start' && s.kind !== 'end' && s.kind !== 'wait'
      && (who(s) === 'ai' || (who(s) === 'human' && !!s.outcomes));
    const guideRef = s.with?.guide;
    if (judgment && !guideRef) {
      err(`${s.id}: ${who(s) === 'ai' ? 'an AI' : 'a human'} ${s.outcomes ? 'decision' : 'step'} needs knowledge — add with: { guide: ${flow.id}.guide.yaml#${s.id} }`);
    }
    // Only a step a script runs makes batch model calls; interactive steps run in the session's model.
    if (who(s) === 'ai' && s.uses?.startsWith('npm:') && !s.with?.model) {
      warnings.push(`${file}: ${s.id} is a scripted AI step without with.model — it runs on the default (sonnet)`);
    }
    if (guideRef) {
      stepRefs.add(guideRef);
      const [gfile, section] = guideRef.split('#');
      const guide = loadGuide(gfile);
      if (!guide) err(`${s.id}: guide file "${gfile}" does not exist`);
      else if (!section || !guide.steps?.[section]) err(`${s.id}: ${gfile} has no section "${section}" — add one under steps:`);
      else {
        if (!guide.steps[section].goal) err(`${s.id}: ${gfile}#${section} has no goal — say what the step must achieve`);
        if (!usedSections.has(gfile)) usedSections.set(gfile, new Set());
        usedSections.get(gfile)!.add(section);
      }
    }

    // Contract 1: an AI decision can always say "I don't know".
    if (s.outcomes && who(s) === 'ai' && !s.outcomes.includes('new_case')) {
      err(`${s.id}: an AI decision needs a new_case outcome, followed by a step with process: ${NEW_CASE}`);
    }
  }

  for (const s of flow.steps) {
    if (s.kind === 'end') continue;
    for (const o of s.outcomes ?? []) {
      if (!followed.has(`${s.id}.${o}`)) err(`${s.id}.${o} leads nowhere — add it to some step's needs`);
    }
    if (!s.outcomes && !followed.has(s.id)) err(`${s.id} leads nowhere — add it to some step's needs, or make it kind: end`);
    if ((s.outcomes ?? []).includes('new_case')) {
      const handlers = flow.steps.filter((t) => (t.needs ?? []).includes(`${s.id}.new_case`));
      if (!handlers.some((t) => t.process === NEW_CASE)) err(`${s.id}.new_case must lead to a step with process: ${NEW_CASE}`);
    }
  }
}

// ─── Rules, wherever they live ───────────────────────────────────────────────

const ruleIds = new Map<string, string>();
const runbookHeadings = new Map<string, string[]>();

function headingsOf(full: string): string[] {
  if (!runbookHeadings.has(full)) {
    runbookHeadings.set(full, existsSync(full)
      ? readFileSync(full, 'utf8').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/^#+ /, '').trim())
      : []);
  }
  return runbookHeadings.get(full)!;
}

function checkProcedure(where: string, procedure: string, err: (m: string) => void, root: string) {
  const [path, ...anchors] = procedure.split('§').map((p) => p.trim().replace(/,$/, '').trim());
  // A workspace rule may point at its own docs or at the app's public runbooks.
  const full = [join(root, path), join(APP_ROOT, path)].find((f) => existsSync(f));
  if (!full) { err(`${where}: procedure file "${path}" does not exist`); return; }
  const heads = headingsOf(full);
  for (const a of anchors.filter(Boolean)) {
    if (!heads.some((h) => h.startsWith(a))) err(`${where}: procedure "§ ${a}" is not a heading in ${path}`);
  }
}

function checkRules(where: string, rules: Rule[] | undefined, err: (m: string) => void, opts: { gates?: boolean; root?: string } = {}) {
  for (const rule of rules ?? []) {
    const at = `${where}/${rule.id ?? '(no id)'}`;
    for (const field of ['id', 'when', 'then', 'source'] as const) {
      if (!rule[field]) err(`${at}: rule has no ${field}`);
    }
    if (rule.status && !RULE_STATUSES.has(rule.status)) err(`${at}: status must be one of ${[...RULE_STATUSES].join(', ')}`);
    if (rule.test !== undefined) {
      if (!opts.gates) err(`${at}: only a gate can carry test:`);
      else if (!(GATE_TESTS as readonly string[]).includes(rule.test)) err(`${at}: test "${rule.test}" is not in src/knowledge/gates.ts — add it there or fix the name`);
    }
    if (rule.procedure) checkProcedure(at, rule.procedure, err, opts.root ?? APP_ROOT);
    if (rule.id) {
      if (ruleIds.has(rule.id)) err(`${at}: rule id also used in ${ruleIds.get(rule.id)} — ids are unique across guides, policies and counterparty files of both layers`);
      ruleIds.set(rule.id, where);
    }
  }
}

function sectionTokens(section: unknown): number {
  return Math.round(JSON.stringify(section ?? {}).length / 3.7);
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.guide.yaml')).sort()) {
  const guide = loadGuide(file)!;
  const err = (msg: string) => errors.push(`${file}: ${msg}`);
  const flowFile = file.replace('.guide.yaml', '.flow.yaml');
  if (!existsSync(join(DIR, flowFile))) err(`no ${flowFile} for this guide`);
  for (const [section, body] of Object.entries(guide.steps ?? {})) {
    if (!usedSections.get(file)?.has(section)) err(`section "${section}" is not referenced by any step's with.guide — reference it or delete it`);
    checkRules(section, body.gates, err, { gates: true });
    checkRules(section, body.rules, err);
    checkOneHome(file, section, body, err);
    checkAppLayer(section, body, err, `${POLICY_DIR}/${file}`);
    const t = sectionTokens(body);
    if (t > SECTION_TOKEN_WARN) warnings.push(`${file}#${section} is ~${t} tokens — every call for this step pays for it; move counterparty rules out or tighten`);
  }
}

/** One home per fact: a rule that is about one counterparty lives in its file. */
function checkOneHome(file: string, section: string, body: Section, err: (m: string) => void) {
  for (const rule of [...(body.gates ?? []), ...(body.rules ?? [])]) {
    const text = `${rule.when ?? ''} ${rule.then ?? ''}`;
    for (const cp of counterparties) {
      const hit = mentionIn(text, namesOf(cp));
      if (hit) err(`${section}/${rule.id}: names "${hit}" — move it to ${fileOf(cp)} under "${file}#${section}" (mentions in why: are fine)`);
    }
  }
}

/**
 * The app layer is public: rules true for any company, sources that name no item of one company,
 * no precedents, and no word of a counterparty that only a workspace knows.
 */
function checkAppLayer(where: string, body: Section & { why?: string; source?: string }, err: (m: string) => void, home: string) {
  if (body.precedents?.length) err(`${where}: precedents are one company's decisions — move them to ${home} under the same step`);
  for (const rule of [...(body.gates ?? []), ...(body.rules ?? [])]) {
    const why = companySpecific(rule);
    if (why) err(`${where}/${rule.id}: ${why} — make it generic, or move the rule to ${home}`);
    const text = [rule.when, rule.then, rule.why, rule.source].join(' ');
    for (const cp of counterparties.filter((c) => !c.origin.vendor)) {
      const hit = mentionIn(text, namesOf(cp));
      if (hit) err(`${where}/${rule.id}: names "${hit}", a private counterparty (${fileOf(cp)}) — say it without the name`);
    }
  }
}

// ─── Company policy overlays (workspace layer) ──────────────────────────────

for (const policy of policies) {
  const err = (msg: string) => errors.push(`${policy.path}: ${msg}`);
  const file = policy.path.split('/').pop()!;
  const generic = loadGuide(file);
  if (!generic) { err(`no processes/${file} for this policy — a policy adds to an existing guide`); continue; }
  for (const [section, body] of Object.entries(policy.body.steps ?? {})) {
    if (!generic.steps?.[section]) { err(`section "${section}" is not in processes/${file} — use a step id of that guide`); continue; }
    if (body.goal) err(`${section}: goal belongs to processes/${file}, not to a policy`);
    if (body.gates) err(`${section}: gates hold for every company — they live in processes/${file}`);
    checkRules(`${policy.path}#${section}`, body.rules, err, { root: policy.root });
    checkOneHome(policy.path, section, body, err);
  }
}

// ─── Counterparty files ─────────────────────────────────────────────────────

const signalOwner = new Map<string, string>();
for (const cp of counterparties) {
  const err = (msg: string) => errors.push(`${fileOf(cp)}: ${msg}`);
  if (cp.match.uid.includes(ws.company.uid)) err(`match.uid ${ws.company.uid} is our own UID and identifies nobody`);
  for (const tier of TIERS) {
    for (const sig of cp.match[tier]) {
      const key = `${tier}:${typeof sig === 'string' ? sig.toLowerCase() : sig.source}`;
      if (signalOwner.has(key)) err(`match.${tier} "${typeof sig === 'string' ? sig : sig.source}" is also claimed by ${signalOwner.get(key)} — a signal has one owner`);
      signalOwner.set(key, fileOf(cp)!);
    }
  }
  for (const [ref, raw] of Object.entries(cp.steps)) {
    const t = sectionTokens(raw);
    if (t > SECTION_TOKEN_WARN) warnings.push(`${fileOf(cp)} "${ref}" is ~${t} tokens — tighten it`);
  }
}
for (const f of counterpartyFiles) {
  const err = (msg: string) => errors.push(`${f.path}: ${msg}`);
  if (f.layer === 'app') {
    const home = `${BINDING_DIR}/${f.body.id}.yaml`;
    for (const d of (f.body.documents ?? []) as (Rule & { id?: string })[]) checkAppLayer(`documents ${d.id}`, { rules: [{ ...d, when: '', then: '' }] }, err, home);
    for (const [ref, raw] of Object.entries(f.body.steps ?? {})) checkAppLayer(`steps."${ref}"`, raw as Section, err, home);
  }
  for (const [ref, raw] of Object.entries(f.body.steps ?? {})) {
    if (!stepRefs.has(ref)) err(`steps."${ref}" is not the with.guide of any flow step — use the exact string, e.g. "booking.guide.yaml#classify"`);
    const section = raw as Section;
    if (section.goal) err(`steps."${ref}": goal belongs to the step's guide, not to a counterparty`);
    checkRules(`${f.path} ${ref}`, section.rules, err, { root: f.root });
    if (section.gates) err(`steps."${ref}": gates hold for every counterparty — they live in the guide`);
  }
}

// ─── Routing, proven on the current index ───────────────────────────────────

const unknownMerchants = new Map<string, number>();
if (existsSync(ws.paths.books) && counterparties.length) {
  const index = loadBooks(ws);

  // A UID routes the strongest tier, so it must belong to this counterparty alone.
  for (const cp of counterparties) {
    for (const uid of cp.match.uid) {
      const strays = index.receipts.filter((r) => uidsIn(r).includes(uid)
        && !TIERS.filter((t) => t !== 'uid').some((t) => claims(cp, t, signalsOfReceipt(r))));
      if (strays.length) {
        errors.push(`${fileOf(cp)}: match.uid ${uid} is also on receipts nothing else ties to ${cp.id} (${strays.slice(0, 3).map((r) => r.filename).join(', ')}${strays.length > 3 ? ', …' : ''}) — remove the uid or add a file/tx signal that covers them`);
      }
    }
  }

  // No item is claimed by two files in the same tier.
  const clashes = new Map<string, string[]>(); // "fedex and ups (tx)" → items
  const clash = (route: { candidates: string[]; tier: string }, item: string) => {
    const key = `${route.candidates.join(' and ')} (${route.tier})`;
    clashes.set(key, [...(clashes.get(key) ?? []), item]);
  };
  for (const r of index.receipts) {
    const route = identify(signalsOfReceipt(r), counterparties);
    if (route.kind === 'ambiguous') clash(route, r.filename);
  }
  for (const tx of index.transactions) {
    const merchant = merchantOf(tx.description);
    const route = identify({ uids: [], domains: [], merchant, filenames: [] }, counterparties);
    if (route.kind === 'ambiguous') clash(route, `${tx.ref} "${merchant}"`);
    if (route.kind === 'unknown' && tx.type !== 'wise-fee') {
      const key = merchant.toLowerCase().replace(/[\d*#]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      unknownMerchants.set(key, (unknownMerchants.get(key) ?? 0) + 1);
    }
  }
  for (const [pair, items] of clashes) {
    errors.push(`counterparties: ${items.length} item(s) claimed by both ${pair}, e.g. ${items.slice(0, 2).join(', ')} — make one signal stricter`);
  }
}

// Second homes growing back: counterparty names in code. src/knowledge is the loader of their one home.
const codeHits: string[] = [];
const sources = readdirSync(join(APP_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.tsx?$/.test(f) && !f.startsWith(`knowledge${sep}`))
  .sort();
for (const f of sources) {
  const named = counterpartiesNamedIn(readFileSync(join(APP_ROOT, 'src', f), 'utf8'), f, counterparties);
  if (named.length) codeHits.push(`src/${f.split(sep).join('/')} (${named.join(', ')})`);
}
if (codeHits.length) warnings.push(`counterparty knowledge still hardcoded in ${codeHits.length} file(s), to move behind decide(): ${codeHits.join('; ')}`);

// The app is any company's: who this one is lives in belege.workspace.yaml, never in src/.
for (const f of readdirSync(join(APP_ROOT, 'src'), { recursive: true, encoding: 'utf8' }).filter((f) => /\.(tsx?|html)$/.test(f)).sort()) {
  const hits = identityIn(readFileSync(join(APP_ROOT, 'src', f), 'utf8'), ws.company);
  if (hits.length) errors.push(`src/${f.split(sep).join('/')}: names the company (${hits.join(', ')}); read it from openWorkspace().company`);
}

// ─── Casebook (examples/cases/) ─────────────────────────────────────────────

// A case is public, so it may only cite the app's own rules.
const appRuleIds = new Set([...guides.values()]
  .flatMap((g) => Object.values(g.steps ?? {}).flatMap((s) => [...(s.gates ?? []), ...(s.rules ?? [])].flatMap((r) => (r.id ? [r.id] : [])))));
let caseCount = 0;
try {
  const cases = loadCases();
  const chart = loadCaseChart();
  const fx = loadFxResolver();
  caseCount = cases.length;
  for (const c of cases) errors.push(...validateCase(c, { chart, ruleIds: appRuleIds, fx }));
  const ranks = cases.map((c) => c.rank);
  const twice = ranks.find((r, i) => ranks.indexOf(r) !== i);
  if (twice !== undefined) errors.push(`examples/cases: rank ${twice} is used twice — every case has its own place in the casebook`);
} catch (e) {
  errors.push((e as Error).message);
}

// ─── Report ─────────────────────────────────────────────────────────────────

for (const w of warnings) console.log(`warn   ${w}`);
for (const e of errors) console.log(`error  ${e}`);
const allRules = [
  ...[...guides.values(), ...policies.map((p) => p.body)].flatMap((g) => Object.values(g.steps ?? {}).flatMap((s) => [...(s.gates ?? []), ...(s.rules ?? [])])),
  ...counterpartyFiles.flatMap((f) => Object.values(f.body.steps ?? {}).flatMap((s) => (s as Section).rules ?? [])),
];
const unrouted = [...unknownMerchants.values()].reduce((a, b) => a + b, 0);
console.log(`\n${errors.length} error(s), ${warnings.length} warning(s); ${counterparties.length} counterparties; ${caseCount} casebook cases; ${allRules.filter((r) => r.status === 'open').length} open question(s), ${allRules.filter((r) => r.status === 'proposed').length} proposed rule(s) awaiting confirmation; ${unrouted} transactions route to no counterparty (generic rules)`);
if (process.argv.includes('--unknown')) {
  console.log('\nMerchants no counterparty file claims, most frequent first:');
  for (const [m, n] of [...unknownMerchants].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${String(n).padStart(4)}  ${m}`);
}
process.exit(errors.length ? 1 : 0);
