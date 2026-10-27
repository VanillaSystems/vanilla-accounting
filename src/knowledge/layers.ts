/**
 * Process knowledge in two layers, merged once at read time.
 *
 * App layer (public, true for any company):
 *   processes/<process>.guide.yaml         generic rules per step
 *   processes/<role>/<id>.yaml             facts of a business true for every company: name, match, grouped,
 *                                          documents, rules; <role> is suppliers, customers or authorities
 * Workspace layer (one company's books):
 *   knowledge/rules/<process>.guide.yaml   company rules and precedents per step
 *   knowledge/<role>/<id>.yaml             the binding of an app file (accounts, company rules, precedents,
 *                                          extra signals), or a whole private business
 *
 * A business has one file per layer, in the folder of its main role; `roles:` names any other.
 * Every field has one owner, so no layer overrides another: a binding adds signals, documents
 * and rules after the app layer's, it never replaces one. The lint in check-processes keeps
 * company facts out of the app layer.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse } from 'yaml';
import { compileCounterparty, ROLES, TIERS, type Counterparty, type RawCounterparty, type Role, type Routing } from './counterparties.js';

export const GUIDE_DIR = 'processes';
export const KNOWLEDGE_DIR = 'knowledge';
export const RULES_DIR = `${KNOWLEDGE_DIR}/rules`;
/** The folder of each main role, the same in both layers. */
export const ROLE_DIRS: Record<Role, string> = { supplier: 'suppliers', customer: 'customers', authority: 'authorities' };
/** The workspace layout before knowledge/ (npm run migrate-workspace moves it). */
export const LEGACY_DIRS = ['counterparties', 'policy'] as const;

/** Where a business's file lives in a layer. */
export function homeOf(layer: Layer, role: Role, id: string): string {
  return `${layer === 'app' ? GUIDE_DIR : KNOWLEDGE_DIR}/${ROLE_DIRS[role]}/${id}.yaml`;
}

export type Layer = 'app' | 'workspace';

export type Rule = {
  id?: string; when?: string; then?: string; why?: string; source?: string;
  status?: string; procedure?: string; test?: string;
  /** What code carries out of a rule of a business file (src/booking/purchase-vat.ts parseApply). */
  apply?: unknown;
  /** The sentence of the notes an executable rule carries out (src/booking/rules.ts BookingRule.note). */
  note?: unknown;
};
export type Section = {
  goal?: string; gates?: Rule[]; rules?: Rule[]; precedents?: unknown[]; ask_human_when?: string[];
  [key: string]: unknown;
};
export type Guide = { process?: string; steps?: Record<string, Section> };

/** One parsed knowledge file. `path` is relative to `root`, the root of its layer. */
export interface KnowledgeFile<T> { layer: Layer; root: string; path: string; body: T }
export type CounterpartyFile = KnowledgeFile<RawCounterparty> & { role: Role };

export interface Knowledge {
  counterparties: Counterparty[];
  guides: KnowledgeFile<Guide>[];
  counterpartyFiles: CounterpartyFile[];
  /** What an agent reads for one item of a step: the step's section (generic, then policy) and its counterparty's. */
  section(stepRef: string, routing: Routing): { step?: Section; counterparty?: Section };
}

/** Pure. One step section from both layers: lists concatenated, app layer first. */
export function mergeSection(app: Section | undefined, workspace: Section | undefined): Section | undefined {
  if (!app || !workspace) return app ?? workspace;
  const out: Section = { ...app, ...workspace };
  for (const k of ['gates', 'rules', 'precedents', 'ask_human_when'] as const) {
    if (app[k] || workspace[k]) out[k] = [...(app[k] ?? []), ...(workspace[k] ?? [])] as never;
  }
  return out;
}

/**
 * Pure. Same id in both layers = one counterparty.
 * - name: the vendor's (a binding of a vendor may not redeclare it).
 * - grouped: the vendor's when its file says it; else the binding's (a company learns that a business pays several receipts at once, #190).
 * - accounts: the binding's only (the app layer cannot know a chart of accounts).
 * - match, documents: union, vendor first; one signal or document id has one owner.
 * - steps: per address, vendor rules first, then the binding's.
 * A binding with no vendor is a private counterparty and carries name and match itself.
 */
export function mergeCounterparty(
  vendor: RawCounterparty | undefined, binding: RawCounterparty | undefined,
  files: Counterparty['origin'], role: Role,
): Counterparty {
  const fail = (file: string | undefined, msg: string): never => { throw new Error(`${file}: ${msg}`); };
  for (const [raw, file] of [[vendor, files.vendor], [binding, files.binding]] as const) {
    if (raw && raw.id !== basename(file!, '.yaml')) fail(file, `id must be "${basename(file!, '.yaml')}" (the file name)`);
  }
  if (vendor?.accounts) fail(files.vendor, `accounts are one company's chart — move them to ${homeOf('workspace', role, vendor.id!)}`);
  if (!vendor) return compileCounterparty(binding!, files, role);
  if (!binding) return compileCounterparty(vendor, files, role);
  if (binding.name !== undefined) fail(files.binding, `name belongs to the vendor file ${files.vendor} — delete it here`);
  // Whether it pays several receipts in one payment: the vendor's fact when its file says so; else the company may have learned it from its own links (#190).
  if (binding.grouped !== undefined && vendor.grouped !== undefined) fail(files.binding, `grouped is said in the vendor file ${files.vendor} already — delete it here`);
  const match: Partial<Record<(typeof TIERS)[number], string[]>> = {};
  for (const t of TIERS) {
    const sigs = [...(vendor.match?.[t] ?? []), ...(binding.match?.[t] ?? [])];
    const twice = sigs.find((s, i) => sigs.indexOf(s) !== i);
    if (twice) fail(files.binding, `match.${t} "${twice}" is also in ${files.vendor} — a signal has one owner`);
    if (sigs.length) match[t] = sigs;
  }
  const documents = [...(vendor.documents ?? []), ...(binding.documents ?? [])];
  const facts = [...(vendor.facts ?? []), ...(binding.facts ?? [])];
  for (const [what, list] of [['documents', documents], ['facts', facts]] as const) {
    const dup = list.find((d, i) => list.findIndex((e) => e.id === d.id) !== i);
    if (dup) fail(files.binding, `${what} ${dup.id} is also in ${files.vendor} — each has one owner`);
  }
  const steps: Record<string, unknown> = { ...vendor.steps };
  for (const [ref, section] of Object.entries(binding.steps ?? {})) {
    steps[ref] = mergeSection(vendor.steps?.[ref] as Section | undefined, section as Section);
  }
  return compileCounterparty({
    id: vendor.id, name: vendor.name, grouped: vendor.grouped ?? binding.grouped, accounts: binding.accounts,
    roles: [...new Set([...(vendor.roles ?? []), ...(binding.roles ?? [])])], match, documents, facts, steps,
  }, files, role);
}

function yamlFiles<T>(layer: Layer, root: string, dir: string, suffix: string): KnowledgeFile<T>[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  // A file starting with _ is a commented template (npm run init), never knowledge.
  return readdirSync(full).filter((f) => f.endsWith(suffix) && !f.startsWith('_')).sort().map((f) => ({
    layer, root, path: `${dir}/${f}`, body: (parse(readFileSync(join(full, f), 'utf8')) ?? {}) as T,
  }));
}

/** A layer's business files, each tagged with the main role of its folder. One file per id per layer. */
function counterpartyFilesOf(layer: Layer, root: string): CounterpartyFile[] {
  const base = layer === 'app' ? GUIDE_DIR : KNOWLEDGE_DIR;
  const files = ROLES.flatMap((role) => yamlFiles<RawCounterparty>(layer, root, `${base}/${ROLE_DIRS[role]}`, '.yaml').map((f) => ({ ...f, role })));
  for (const [i, f] of files.entries()) {
    const twin = files.slice(i + 1).find((g) => basename(g.path) === basename(f.path));
    if (twin) throw new Error(`${f.path} and ${twin.path}: one business has one file, in the folder of its main role — merge them and list the other role under roles:`);
  }
  return files;
}

/**
 * Read both layers and merge them. `appRoot` holds processes/, `workspaceRoot` the company's
 * knowledge/. Throws naming the file and the fix.
 */
export function loadKnowledge(appRoot: string, workspaceRoot: string): Knowledge {
  const legacy = LEGACY_DIRS.filter((d) => existsSync(join(workspaceRoot, d)));
  if (legacy.length) {
    throw new Error(`${workspaceRoot} keeps its knowledge in ${legacy.map((d) => `${d}/`).join(' and ')}, the layout before knowledge/ — run npm run migrate-workspace`);
  }
  const vendors = counterpartyFilesOf('app', appRoot);
  const bindings = counterpartyFilesOf('workspace', workspaceRoot);
  const guides = [
    ...yamlFiles<Guide>('app', appRoot, GUIDE_DIR, '.guide.yaml'),
    ...yamlFiles<Guide>('workspace', workspaceRoot, RULES_DIR, '.guide.yaml'),
  ];
  const stem = (f: KnowledgeFile<unknown>) => basename(f.path, '.yaml');
  const ids = [...new Set([...vendors, ...bindings].map(stem))].sort();
  const counterparties = ids.map((id) => {
    const v = vendors.find((f) => stem(f) === id);
    const b = bindings.find((f) => stem(f) === id);
    if (v && b && v.role !== b.role) throw new Error(`${b.path}: ${v.path} files it under ${ROLE_DIRS[v.role]} — move it to ${homeOf('workspace', v.role, id)}`);
    return mergeCounterparty(v?.body, b?.body, { vendor: v?.path, binding: b?.path }, (v ?? b)!.role);
  });
  const stepOf = (layer: Layer, file: string, id: string) =>
    guides.find((g) => g.layer === layer && basename(g.path) === file)?.body.steps?.[id];

  return {
    counterparties,
    guides,
    counterpartyFiles: [...vendors, ...bindings],
    section(stepRef, routing) {
      const [file, id] = stepRef.split('#');
      const cp = routing.kind === 'known' ? counterparties.find((c) => c.id === routing.counterparty) : undefined;
      return {
        step: mergeSection(stepOf('app', file, id), stepOf('workspace', file, id)),
        counterparty: cp?.steps[stepRef] as Section | undefined,
      };
    },
  };
}

// ─── What the app layer may say ─────────────────────────────────────────────

/** Sources that name a law, a document of the app, or a dated decision — never one company's items, nor a commit or a note the public repo does not have. */
const GENERIC_SOURCES = [
  /^definition$/,
  /^(AGENTS|CONTEXT)\.md\b/, /^docs\//, /^processes\//, /^reference\//, /^[\w-]+\.(flow|guide)\.yaml\b/, /^src\//,
  // A federal law by its abbreviation: VAT, social insurance, Code of Obligations, direct tax.
  /^(MWSTG|MWSTV|AHVG|AHVV|BVG|UVG|OR|DBG|StHG) /,
  /^(owner |advisor )?decision \d{4}-\d{2}-\d{2}(, (owner|advisor))?$/,
  /^proposed \d{4}-\d{2}-\d{2} by Claude — confirm or replace$/,
];

/** One company's items in a text: bank refs, dates, long numbers (invoice, order, account no.). */
const SPECIFICS: [string, RegExp][] = [
  ['a bank ref', /\b(CARD|TRANSFER|FEE)-\d/],
  ['a date', /\b\d{1,2}\.\d{1,2}\.\d{4}\b/],
  ['a long number', /\b\d{6,}\b/],
  ['an order number', /#\d{4,}\b/],
];
/** In why and source an amount to the cent is a figure from the books; a round one is a threshold (CHF 10,000). */
const EVIDENCE_SPECIFICS: [string, RegExp][] = [['an amount', /\b\d+\.\d{2}\b/]];

/** Why a rule cannot live in the app layer, or undefined when it can. */
export function companySpecific(rule: Rule): string | undefined {
  if (rule.source && !GENERIC_SOURCES.some((re) => re.test(rule.source!))) {
    return `source "${rule.source}" is not generic — use "decision <date>, owner", "docs/…", "AGENTS.md § …", a law, or "proposed <date> by Claude — confirm or replace"`;
  }
  for (const field of ['when', 'then', 'why', 'source'] as const) {
    const text = rule[field] ?? '';
    const evidence = field === 'why' || field === 'source';
    const hit = [...SPECIFICS, ...(evidence ? EVIDENCE_SPECIFICS : [])].find(([, re]) => re.test(text));
    if (hit) return `${field} names ${hit[0]} ("${text.match(hit[1])![0]}"), an item of one company`;
  }
  return undefined;
}
