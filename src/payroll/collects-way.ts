/**
 * «Zieht Lohnabzüge ein» (docs/specs/payroll.md §22 decision 110): the person marks the business a payment goes to as one
 * that collects wage deductions, without editing YAML. Offered on a payment out whose payee or text names a kind the
 * year's payslips withheld and no business collects yet (a pension fund's «Pensionskasse», «BVG»); the click writes
 * `collects: [<kind>]` into the company's file of that business (src/knowledge/counterparties.ts), the rest of the file
 * byte for byte, through a file beside it and a rename. A business the company has no file of gets one of its own,
 * matched by the payee the bank writes (and its IBAN), in the folder of the kind's collector (setup.yaml `wages.roles`);
 * a binding of an app file starts with its id. «Rückgängig» works from the file alone, after a restart too: it takes the
 * kinds out of `collects:` again, and removes a file the click made (its first line says so) once it holds nothing else.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { identify } from '../knowledge/counterparties.js';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { BankTransaction, Receipt } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { homeOf } from '../knowledge/layers.js';
import type { Counterparty, Role } from '../knowledge/counterparties.js';
import { accountOfKinds, namesWord, withheldKinds, type Collectors } from '../booking/withheld.js';
import { setup } from '../engines/index.js';
import { assertMap, blockOf, eolOf, slug, writeAtomic } from './insurer-way.js';

/** Where `collects:` is written: the business's own file in the company's knowledge, made when `created`. */
export interface CollectsTarget { id: string; role: Role; name: string; path: string; created: boolean }

/** What the payment's hand form offers: the business, its file, the kinds it may collect (each named by the payment or its documents). */
export interface CollectsOffer { target: CollectsTarget; kinds: string[]; collects: string[] }

/** The first line of a file the click made: «Rückgängig» removes such a file once it holds nothing else. */
export const MADE_LINE = '# Made by «Zieht Lohnabzüge ein» (Löhne): removed again by its «Rückgängig».';

/** The file's text with its top-level `collects:` set to `kinds` (taken out when there are none), everything else as it was. */
export function withCollects(text: string, kinds: readonly string[], id: string, create?: { name: string; payee: string; iban?: string }, path = `${id}.yaml`): string {
  const eol = eolOf(text);
  assertMap(text, path);
  const head = create
    ? [MADE_LINE, `id: ${JSON.stringify(id)}`, `name: ${JSON.stringify(create.name)}`, 'match:', `  payee: [${JSON.stringify(create.payee)}]`, ...(create.iban ? [`  iban: [${JSON.stringify(create.iban)}]`] : [])].join(eol) + eol
    : `id: ${JSON.stringify(id)}${eol}`;
  const empty = parseDocument(text).contents === null;
  const base = !empty || !kinds.length ? text : text.trim() ? `${text}${text.endsWith(eol) ? '' : eol}${head}` : head;
  const line = kinds.length ? [`collects: [${kinds.join(', ')}]`] : [];
  const lines = base.split(eol);
  const at = blockOf(lines, 'collects');
  if (at) return [...lines.slice(0, at.from), ...line, ...lines.slice(at.to)].join(eol);
  if (!kinds.length) return base;
  return `${base}${base.endsWith(eol) ? '' : eol}${line[0]}${eol}`;
}

/** The folder of a new file of the collector of `kinds`: setup.yaml `wages.roles`, an authority where any kind says so, else a supplier. */
export const roleOfKinds = (kinds: readonly string[]): Role => (kinds.some((k) => setup().wages?.roles?.[k] === 'authority') ? 'authority' : 'supplier');

/** Where the payment's business keeps `collects:`: the file it routes to, else a new company file named after the payee, in the folder of `kinds`' collector. */
export function collectsTarget(routed: string | undefined, tx: Pick<BankTransaction, 'counterparty' | 'description'>, counterparties: readonly Pick<Counterparty, 'id' | 'role' | 'name'>[], kinds: readonly string[] = []): CollectsTarget {
  const known = counterparties.find((c) => c.id === routed);
  if (known) return { id: known.id, role: known.role, name: known.name, path: homeOf('workspace', known.role, known.id), created: false };
  const name = tx.counterparty?.trim() || tx.description.trim();
  const taken = new Set(counterparties.map((c) => c.id));
  const base = slug(name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const role = roleOfKinds(kinds);
  return { id, role, name, path: homeOf('workspace', role, id), created: true };
}

/**
 * The kinds a payment out may say its business collects: those the year's payslips withheld (withheldKinds), no business
 * collects yet, owed on the business's own account where it collects some already, and named by the payee, the
 * payment's text or the first lines of its documents (setup.yaml `wages.withholds` words). Empty when nothing fits.
 */
export function offeredKinds(input: {
  books: Parameters<typeof withheldKinds>[0];
  tx: Pick<BankTransaction, 'date' | 'direction' | 'counterparty' | 'description'>;
  linked: readonly Pick<Receipt, 'extractedText' | 'kind'>[];
  business: string | undefined;
  collectors: Collectors;
}): string[] {
  const words = setup().wages?.withholds;
  // A wage pays a payslip, whose rows name every deduction: no collector.
  if (!words || input.tx.direction !== 'DBIT' || input.linked.some((r) => r.kind === 'payslip')) return [];
  const taken = new Set([...input.collectors.values()].flat());
  const own = input.business ? input.collectors.get(input.business) ?? [] : [];
  const account = own.length ? accountOfKinds(own) : undefined;
  const said = [input.tx.counterparty ?? '', input.tx.description, ...input.linked.map((r) => (r.extractedText ?? '').split('\n').slice(0, 12).join('\n'))].join('\n');
  return [...withheldKinds(input.books, input.tx.date.slice(0, 4))]
    .filter((k) => !taken.has(k) && words[k]?.length && namesWord(words[k])(said) && (!account || accountOfKinds([...own, k]) === account))
    .sort();
}

/** The offer for a payment, or undefined: its target file and the kinds it may name. */
export function collectsOffer(input: Parameters<typeof offeredKinds>[0] & { counterparties: readonly Counterparty[] }): CollectsOffer | undefined {
  const kinds = offeredKinds(input);
  if (!kinds.length) return undefined;
  return { target: collectsTarget(input.business, input.tx as BankTransaction, input.counterparties, kinds), kinds, collects: [...(input.business ? input.collectors.get(input.business) ?? [] : [])] };
}

/** The text the target's file takes with `kinds` added to what it collects; refused (nothing written) when the file is no YAML map. */
export function keptCollectsText(ws: Pick<Workspace, 'paths'>, target: CollectsTarget, kinds: readonly string[], tx: Pick<BankTransaction, 'counterparty' | 'counterpartyIban'>): { text: string; before: string | undefined } {
  const file = join(ws.paths.root, target.path);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const text = before ?? '';
  const had = collectsOfText(text);
  const payee = tx.counterparty?.trim() || target.name;
  const iban = tx.counterpartyIban?.replace(/\s/g, '').toUpperCase();
  const create = target.created && !text.trim() ? { name: target.name, payee, ...(iban ? { iban } : {}) } : undefined;
  return { text: withCollects(text, [...new Set([...had, ...kinds])], target.id, create, target.path), before };
}

/** Writes the kept text into the target's file; its path in the workspace. */
export function writeCollects(ws: Pick<Workspace, 'paths'>, path: string, text: string): string {
  writeAtomic(join(ws.paths.root, path), text);
  return path;
}

const collectsOfText = (text: string): string[] => {
  const c = (parseDocument(text).toJSON() as { collects?: unknown } | null)?.collects;
  return Array.isArray(c) ? c.filter((k): k is string => typeof k === 'string') : [];
};

/** What the company's file of a business collects, where it says so: the file and its kinds; undefined without such a file. */
export function keptCollects(ws: Pick<Workspace, 'paths'>, business: Pick<Counterparty, 'id' | 'role' | 'name'>): { business: string; name: string; path: string; kinds: string[] } | undefined {
  const path = homeOf('workspace', business.role, business.id);
  const file = join(ws.paths.root, path);
  if (!existsSync(file)) return undefined;
  const kinds = collectsOfText(readFileSync(file, 'utf8'));
  return kinds.length ? { business: business.id, name: business.name, path, kinds } : undefined;
}

/** The company file of a payroll insurance's business that says what it collects: its own business, else the one its name routes to (as keptWayOf). */
export function keptCollectsOf(ws: Pick<Workspace, 'paths'>, insurance: { business?: string; name: string }, counterparties: readonly Counterparty[]): ReturnType<typeof keptCollects> {
  const routed = identify({ uids: [], ibans: [], domains: [], names: [insurance.name], payees: [insurance.name], filenames: [], originalFilenames: [] }, counterparties);
  const cp = [insurance.business, routed.kind === 'known' ? routed.counterparty : undefined].map((id) => counterparties.find((c) => c.id === id && c.collects?.length)).find(Boolean);
  return cp && keptCollects(ws, cp);
}

/**
 * «Rückgängig», from the file alone: `kinds` (absent: all) leave the company file's `collects:`; a file the click made
 * (its first line MADE_LINE) that then holds only its id, name and match goes. The path, or undefined when it collects none of them.
 */
export function forgetCollects(ws: Pick<Workspace, 'paths'>, business: Pick<Counterparty, 'id' | 'role'>, kinds?: readonly string[]): string | undefined {
  const path = homeOf('workspace', business.role, business.id);
  const file = join(ws.paths.root, path);
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  const had = collectsOfText(text);
  const left = kinds ? had.filter((k) => !kinds.includes(k)) : [];
  if (left.length === had.length) return undefined;
  const next = withCollects(text, left, business.id, undefined, path);
  const rest = parseDocument(next).toJSON() as Record<string, unknown> | null;
  const bare = !!rest && Object.keys(rest).every((k) => k === 'id' || k === 'name' || k === 'match');
  if (next.startsWith(MADE_LINE) && bare) rmSync(file, { force: true });
  else writeAtomic(file, next);
  return path;
}
