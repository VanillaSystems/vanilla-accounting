/**
 * «Zieht Lohnabzüge ein» (docs/specs/payroll.md §22 decision 110): the person marks the business a payment goes to as one
 * that collects wage deductions, without editing YAML. Offered on a payment out whose payee or text names a kind the
 * year's payslips withheld and no business collects yet (a pension fund's «Pensionskasse», «BVG»); the click writes
 * `collects: [<kind>]` into the company's file of that business (src/knowledge/counterparties.ts), the rest of the file
 * byte for byte, through a file beside it and a rename. A business the company has no file of gets one of its own,
 * matched by the payee the bank writes (and its IBAN); a binding of an app file starts with its id. «Rückgängig» puts the
 * file back as the click found it (a file the click made goes), only while nobody changed it since.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
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

/** The file's text with its top-level `collects:` set to `kinds` (taken out when there are none), everything else as it was. */
export function withCollects(text: string, kinds: readonly string[], id: string, create?: { name: string; payee: string; iban?: string }, path = `${id}.yaml`): string {
  const eol = eolOf(text);
  assertMap(text, path);
  const head = create
    ? [`id: ${JSON.stringify(id)}`, `name: ${JSON.stringify(create.name)}`, 'match:', `  payee: [${JSON.stringify(create.payee)}]`, ...(create.iban ? [`  iban: [${JSON.stringify(create.iban)}]`] : [])].join(eol) + eol
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

/** Where the payment's business keeps `collects:`: the file it routes to, else a new company file named after the payee. */
export function collectsTarget(routed: string | undefined, tx: Pick<BankTransaction, 'counterparty' | 'description'>, counterparties: readonly Pick<Counterparty, 'id' | 'role' | 'name'>[]): CollectsTarget {
  const known = counterparties.find((c) => c.id === routed);
  if (known) return { id: known.id, role: known.role, name: known.name, path: homeOf('workspace', known.role, known.id), created: false };
  const name = tx.counterparty?.trim() || tx.description.trim();
  const taken = new Set(counterparties.map((c) => c.id));
  const base = slug(name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return { id, role: 'authority', name, path: homeOf('workspace', 'authority', id), created: true };
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
  return { target: collectsTarget(input.business, input.tx as BankTransaction, input.counterparties), kinds, collects: [...(input.business ? input.collectors.get(input.business) ?? [] : [])] };
}

/** The text the target's file takes with `kinds` added to what it collects; refused (nothing written) when the file is no YAML map. */
export function keptCollectsText(ws: Pick<Workspace, 'paths'>, target: CollectsTarget, kinds: readonly string[], tx: Pick<BankTransaction, 'counterparty' | 'counterpartyIban'>): { text: string; before: string | undefined } {
  const file = join(ws.paths.root, target.path);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const text = before ?? '';
  const had = (() => { const c = (parseDocument(text).toJSON() as { collects?: unknown } | null)?.collects; return Array.isArray(c) ? c.filter((k): k is string => typeof k === 'string') : []; })();
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

/** «Rückgängig»: the file back as it was (`before`; none: the click made it, so it goes). */
export function restoreCollects(ws: Pick<Workspace, 'paths'>, path: string, before: string | undefined): void {
  const file = join(ws.paths.root, path);
  if (before === undefined) rmSync(file, { force: true });
  else writeAtomic(file, before);
}
