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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { BankTransaction, Receipt } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { homeOf } from '../knowledge/layers.js';
import { identify, type Counterparty, type Role } from '../knowledge/counterparties.js';
import { accountOfKinds, namesWord, withheldKinds, type Collectors } from '../booking/withheld.js';
import { setup } from '../engines/index.js';
import { assertMap, blockOf, eolOf, slug, writeAtomic } from './insurer-way.js';
import { PayrollRefusal } from './close.js';

/** Where `collects:` is written: the business's own file in the company's knowledge, made when `created`. */
export interface CollectsTarget { id: string; role: Role; name: string; path: string; created: boolean }

/** What the payment's hand form offers: the business, its file, the kinds it may collect (each named by the payment or its documents). */
export interface CollectsOffer { target: CollectsTarget; kinds: string[]; collects: string[] }

/** The marker a file the click made starts with, naming the hash of what it wrote besides `collects:`. */
const MADE = /^# Made by «Zieht Lohnabzüge ein» \(Löhne\) ([0-9a-f]{12}): removed again by its «Rückgängig»\.\r?\n/;
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
/** The first line of a file the click made over `rest` (what it wrote besides `collects:`): «Rückgängig» removes the file while it still holds exactly that. */
export const madeLine = (rest: string): string => `# Made by «Zieht Lohnabzüge ein» (Löhne) ${hashOf(rest)}: removed again by its «Rückgängig».`;

const collectsOfText = (text: string): string[] => {
  const c = (parseDocument(text).toJSON() as { collects?: unknown } | null)?.collects;
  return Array.isArray(c) ? c.filter((k): k is string => typeof k === 'string') : [];
};

/**
 * The file's text with its top-level `collects:` set to `kinds` (taken out when there are none), everything else as it was.
 * A file without content gets its head (a binding of an app file: its id alone; `create`: a whole business), after a
 * marker line (madeLine). The result is read again: one that is no YAML map or does not say exactly `kinds` (a quoted
 * key, a second document) is refused, never written.
 */
export function withCollects(text: string, kinds: readonly string[], id: string, create?: { name: string; payee?: string; iban?: string }, path = `${id}.yaml`): string {
  const eol = eolOf(text);
  assertMap(text, path);
  // An anchor, an alias or a tag on `collects:` would be lost or broken by a line written in its place.
  const node = parseDocument(text).get('collects', true) as { anchor?: string; tag?: string } | undefined;
  if (node && typeof node === 'object' && (node.anchor || node.tag) || /^collects\s*:\s*[&*!]/m.test(text)) throw new PayrollRefusal('badInput', `${path}: «collects:» trägt einen Anker oder Typ: von Hand richten.`);
  const head = create
    ? [`id: ${JSON.stringify(id)}`, `name: ${JSON.stringify(create.name)}`, 'match:', ...(create.payee ? [`  payee: [${JSON.stringify(create.payee)}]`] : []), ...(create.iban ? [`  iban: [${JSON.stringify(create.iban)}]`] : [])].join(eol) + eol
    : `id: ${JSON.stringify(id)}${eol}`;
  const empty = parseDocument(text).contents === null;
  const base = !empty || !kinds.length ? text : text.trim() ? `${text}${text.endsWith(eol) ? '' : eol}${head}` : `${madeLine(head)}${eol}${head}`;
  const line = kinds.length ? [`collects: [${kinds.join(', ')}]`] : [];
  const lines = base.split(eol);
  const at = blockOf(lines, 'collects');
  const out = at ? [...lines.slice(0, at.from), ...line, ...lines.slice(at.to)].join(eol) : !kinds.length ? base : `${base}${base.endsWith(eol) ? '' : eol}${line[0]}${eol}`;
  const doc = parseDocument(out);
  if (doc.errors.length || doc.contents === null || JSON.stringify(collectsOfText(out)) !== JSON.stringify([...kinds])) throw new PayrollRefusal('badInput', `${path}: «collects:» lässt sich hier nicht sicher setzen (die Datei ist anders aufgebaut): von Hand richten.`);
  return out;
}

/** The folder of a new file of the collector of `kinds`: setup.yaml `wages.roles`, an authority where any kind says so, else a supplier. */
export const roleOfKinds = (kinds: readonly string[]): Role => (kinds.some((k) => setup().wages?.roles?.[k] === 'authority') ? 'authority' : 'supplier');

/** Where the payment's business keeps `collects:`: the file it routes to, else a new company file named after the payee, in the folder of `kinds`' collector. */
export function collectsTarget(routed: string | undefined, tx: Pick<BankTransaction, 'counterparty' | 'description'>, counterparties: readonly Pick<Counterparty, 'id' | 'role' | 'name'>[], kinds: readonly string[] = []): CollectsTarget | undefined {
  const known = counterparties.find((c) => c.id === routed);
  if (known) return { id: known.id, role: known.role, name: known.name, path: homeOf('workspace', known.role, known.id), created: false };
  // Without the payee's name the bank wrote, no file is made: its whole text would name and match it (review of walk 3).
  const name = tx.counterparty?.trim();
  if (!name) return undefined;
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
  const named = namedKinds(input.tx, input.linked);
  return [...withheldKinds(input.books, input.tx.date.slice(0, 4))]
    .filter((k) => !taken.has(k) && named.includes(k) && (!account || accountOfKinds([...own, k]) === account))
    .sort();
}

/** The deduction kinds a payment names: by its payee, its text or the first lines of its documents (setup.yaml `wages.withholds` words). */
export function namedKinds(tx: Pick<BankTransaction, 'counterparty' | 'description'>, linked: readonly Pick<Receipt, 'extractedText'>[]): string[] {
  const words = setup().wages?.withholds ?? {};
  const said = [tx.counterparty ?? '', tx.description, ...linked.map((r) => (r.extractedText ?? '').split('\n').slice(0, 12).join('\n'))].join('\n');
  return Object.keys(words).filter((k) => words[k]?.length && namesWord(words[k])(said));
}

/** The offer for a payment, or undefined: its target file and the kinds it may name. */
export function collectsOffer(input: Parameters<typeof offeredKinds>[0] & { counterparties: readonly Counterparty[] }): CollectsOffer | undefined {
  const kinds = offeredKinds(input);
  const target = kinds.length ? collectsTarget(input.business, input.tx as BankTransaction, input.counterparties, kinds) : undefined;
  if (!target) return undefined;
  return { target, kinds, collects: [...(input.business ? input.collectors.get(input.business) ?? [] : [])] };
}

/** The text the target's file takes with `kinds` added to what it collects; refused (nothing written) when the file is no YAML map. */
export function keptCollectsText(ws: Pick<Workspace, 'paths'>, target: CollectsTarget, kinds: readonly string[], tx: Pick<BankTransaction, 'counterparty' | 'counterpartyIban'>): { text: string; before: string | undefined } {
  const file = join(ws.paths.root, target.path);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const text = before ?? '';
  const had = collectsOfText(text);
  const payee = tx.counterparty?.trim();
  const iban = tx.counterpartyIban?.replace(/\s/g, '').toUpperCase();
  const create = target.created && !text.trim() ? { name: target.name, ...(payee ? { payee } : {}), ...(iban ? { iban } : {}) } : undefined;
  return { text: withCollects(text, [...new Set([...had, ...kinds])], target.id, create, target.path), before };
}

/** Writes the kept text into the target's file; its path in the workspace. */
export function writeCollects(ws: Pick<Workspace, 'paths'>, path: string, text: string): string {
  writeAtomic(join(ws.paths.root, path), text);
  return path;
}

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
 * «Rückgängig», from the file alone: `kinds` (absent: all) leave the company file's `collects:`; a file the click made goes
 * once it holds exactly what the click wrote besides (its marker's hash: a file a person edited since only loses the
 * key). The path, or undefined when it collects none of them.
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
  const made = MADE.exec(next);
  if (made && !left.length && hashOf(next.slice(made[0].length)) === made[1]) rmSync(file, { force: true });
  else writeAtomic(file, next);
  return path;
}
