/**
 * Process knowledge in two layers, merged once at read time.
 *
 * App layer (public, true for any company):
 *   processes/<process>.guide.yaml         generic rules per step
 *   processes/counterparties/<id>.yaml     vendor facts: name, match, grouped, documents, vendor-true rules
 * Workspace layer (one company's books):
 *   policy/<process>.guide.yaml            company rules and precedents per step
 *   counterparties/<id>.yaml               the binding of a vendor (accounts, company rules, precedents,
 *                                          extra signals), or a whole private counterparty
 *
 * Every field has one owner, so no layer overrides another: a binding adds signals, documents
 * and rules after the app layer's, it never replaces one. The lint in check-processes keeps
 * company facts out of the app layer.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse } from 'yaml';
import { compileCounterparty, TIERS, type Counterparty, type RawCounterparty, type Routing } from './counterparties.js';

export const GUIDE_DIR = 'processes';
export const VENDOR_DIR = 'processes/counterparties';
export const POLICY_DIR = 'policy';
export const BINDING_DIR = 'counterparties';

export type Layer = 'app' | 'workspace';

export type Rule = {
  id?: string; when?: string; then?: string; why?: string; source?: string;
  status?: string; procedure?: string; test?: string;
};
export type Section = {
  goal?: string; gates?: Rule[]; rules?: Rule[]; precedents?: unknown[]; ask_human_when?: string[];
  [key: string]: unknown;
};
export type Guide = { process?: string; steps?: Record<string, Section> };

/** One parsed knowledge file. `path` is relative to `root`, the root of its layer. */
export interface KnowledgeFile<T> { layer: Layer; root: string; path: string; body: T }

export interface Knowledge {
  counterparties: Counterparty[];
  guides: KnowledgeFile<Guide>[];
  counterpartyFiles: KnowledgeFile<RawCounterparty>[];
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
 * - name, grouped: the vendor's (a binding of a vendor may not redeclare them).
 * - accounts: the binding's only (the app layer cannot know a chart of accounts).
 * - match, documents: union, vendor first; one signal or document id has one owner.
 * - steps: per address, vendor rules first, then the binding's.
 * A binding with no vendor is a private counterparty and carries name and match itself.
 */
export function mergeCounterparty(
  vendor: RawCounterparty | undefined, binding: RawCounterparty | undefined,
  files: Counterparty['origin'],
): Counterparty {
  const fail = (file: string | undefined, msg: string): never => { throw new Error(`${file}: ${msg}`); };
  for (const [raw, file] of [[vendor, files.vendor], [binding, files.binding]] as const) {
    if (raw && raw.id !== basename(file!, '.yaml')) fail(file, `id must be "${basename(file!, '.yaml')}" (the file name)`);
  }
  if (vendor?.accounts) fail(files.vendor, `accounts are one company's chart — move them to ${BINDING_DIR}/${vendor.id}.yaml`);
  if (!vendor) return compileCounterparty(binding!, files);
  if (!binding) return compileCounterparty(vendor, files);
  for (const k of ['name', 'grouped'] as const) {
    if (binding[k] !== undefined) fail(files.binding, `${k} belongs to the vendor file ${files.vendor} — delete it here`);
  }
  const match: Partial<Record<(typeof TIERS)[number], string[]>> = {};
  for (const t of TIERS) {
    const sigs = [...(vendor.match?.[t] ?? []), ...(binding.match?.[t] ?? [])];
    const twice = sigs.find((s, i) => sigs.indexOf(s) !== i);
    if (twice) fail(files.binding, `match.${t} "${twice}" is also in ${files.vendor} — a signal has one owner`);
    if (sigs.length) match[t] = sigs;
  }
  const documents = [...(vendor.documents ?? []), ...(binding.documents ?? [])];
  const dup = documents.find((d, i) => documents.findIndex((e) => e.id === d.id) !== i);
  if (dup) fail(files.binding, `documents ${dup.id} is also in ${files.vendor} — a document type has one owner`);
  const steps: Record<string, unknown> = { ...vendor.steps };
  for (const [ref, section] of Object.entries(binding.steps ?? {})) {
    steps[ref] = mergeSection(vendor.steps?.[ref] as Section | undefined, section as Section);
  }
  return compileCounterparty({
    id: vendor.id, name: vendor.name, grouped: vendor.grouped, accounts: binding.accounts,
    match, documents, steps,
  }, files);
}

function yamlFiles<T>(layer: Layer, root: string, dir: string, suffix: string): KnowledgeFile<T>[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full).filter((f) => f.endsWith(suffix)).sort().map((f) => ({
    layer, root, path: `${dir}/${f}`, body: (parse(readFileSync(join(full, f), 'utf8')) ?? {}) as T,
  }));
}

/**
 * Read both layers and merge them. `appRoot` holds processes/, `workspaceRoot` the company's
 * counterparties/ and policy/. Throws naming the file and the fix.
 */
export function loadKnowledge(appRoot: string, workspaceRoot: string): Knowledge {
  const vendors = yamlFiles<RawCounterparty>('app', appRoot, VENDOR_DIR, '.yaml');
  const bindings = yamlFiles<RawCounterparty>('workspace', workspaceRoot, BINDING_DIR, '.yaml');
  const guides = [
    ...yamlFiles<Guide>('app', appRoot, GUIDE_DIR, '.guide.yaml'),
    ...yamlFiles<Guide>('workspace', workspaceRoot, POLICY_DIR, '.guide.yaml'),
  ];
  const stem = (f: KnowledgeFile<unknown>) => basename(f.path, '.yaml');
  const ids = [...new Set([...vendors, ...bindings].map(stem))].sort();
  const counterparties = ids.map((id) => {
    const v = vendors.find((f) => stem(f) === id);
    const b = bindings.find((f) => stem(f) === id);
    return mergeCounterparty(v?.body, b?.body, { vendor: v?.path, binding: b?.path });
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
  /^(MWSTG|MWSTV) /,
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
