/**
 * «Immer so» on a payment to a payroll insurer (docs/specs/payroll.md §22 decision 59): «für Monate ab dem Lohnstart»
 * kept in the company's file of the fund (`payroll: { payments: liability }`, src/knowledge/payroll-way.ts), which
 * insurerPaymentOf then honours. The file is the insurance's business, else the one the payment routes to, else a new
 * file of the company's own named after the insurer and matched by the payee the bank writes (and its IBAN). The rest
 * of an existing file stays as it was, byte for byte: only the `payroll:` block is added or taken out. «Rückgängig»
 * removes the block again.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import type { BankTransaction } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { homeOf } from '../knowledge/layers.js';
import { identify, type Counterparty, type Role } from '../knowledge/counterparties.js';
import type { PayrollWay } from '../knowledge/payroll-way.js';
import type { PayrollInsurance } from './model.js';
import { PayrollRefusal } from './close.js';

export const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/** The lines of a top-level key's block (`payroll:`, `collects:`): its key line and every indented line after it (blank lines inside it too), or a list's items at the margin. */
export function blockOf(lines: readonly string[], key = 'payroll'): { from: number; to: number } | undefined {
  const from = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (from < 0) return undefined;
  const indented = (l: string | undefined) => !!l && /^(?:[ \t]|-(?:\s|$))/.test(l);
  const nextFilled = (i: number) => lines.slice(i + 1).find((l) => l.trim());
  let to = from + 1;
  while (to < lines.length && (indented(lines[to]) || (!lines[to].trim() && indented(nextFilled(to))))) to++;
  return { from, to };
}

/** A file's text must be a YAML map to take the block: a broken file or a list is refused with its path, never overwritten. */
export function assertMap(text: string, path: string): void {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new PayrollRefusal('badInput', `${path} ist kein gültiges YAML (${doc.errors[0].message.split('\n')[0]}): erst die Datei richten.`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new PayrollRefusal('badInput', `${path} ist keine Zuordnung (key: value): erst die Datei richten.`);
}

/**
 * The file's text with the `payroll:` block set (one written before replaced in place), everything else as it was.
 * A file without content starts with its `id` (a binding of an app file: the id alone), or as a whole business of the
 * company's own when `create` names it; comments it holds stay above.
 */
export function withPayrollWay(text: string, way: PayrollWay, source: string, id: string, create?: { name: string; payee: string; iban?: string }, path = `${id}.yaml`): string {
  const eol = eolOf(text);
  const head = create
    ? [`id: ${JSON.stringify(id)}`, `name: ${JSON.stringify(create.name)}`, 'match:', `  payee: [${JSON.stringify(create.payee)}]`, ...(create.iban ? [`  iban: [${JSON.stringify(create.iban)}]`] : [])].join(eol) + eol
    : `id: ${JSON.stringify(id)}${eol}`;
  assertMap(text, path);
  const empty = parseDocument(text).contents === null;
  const base = !empty ? text : text.trim() ? `${text}${text.endsWith(eol) ? '' : eol}${head}` : head;
  const block = ['payroll:', `  payments: ${way}`, `  source: ${source}`];
  const lines = base.split(eol);
  const at = blockOf(lines);
  const out = at ? [...lines.slice(0, at.from), ...block, ...lines.slice(at.to)].join(eol) : `${base}${base.endsWith(eol) ? '' : eol}${block.join(eol)}${eol}`;
  // Read again: a file shaped otherwise (a quoted key, a second document) is refused, never written half right.
  const doc = parseDocument(out);
  if (doc.errors.length || (doc.toJSON() as { payroll?: { payments?: unknown } } | null)?.payroll?.payments !== way) throw new PayrollRefusal('badInput', `${path}: «payroll:» lässt sich hier nicht sicher setzen (die Datei ist anders aufgebaut): von Hand richten.`);
  return out;
}

/** The file's text without its `payroll:` block, everything else as it was; undefined when it has none. */
export function withoutPayrollWay(text: string): string | undefined {
  const eol = eolOf(text);
  const lines = text.split(eol);
  const at = blockOf(lines);
  return at ? [...lines.slice(0, at.from), ...lines.slice(at.to)].join(eol) : undefined;
}

export const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'versicherung';

export interface WayTarget { id: string; role: Role; name: string; path: string; created: boolean }

/**
 * Where the way of `insurance` is kept: its business's file, else the business the payment routes to, else a new
 * file named after the insurer (its id unused by any business, in `role`'s folder).
 */
export function wayTarget(insurance: Pick<PayrollInsurance, 'business' | 'name'>, routed: string | undefined, counterparties: readonly Pick<Counterparty, 'id' | 'role' | 'name'>[], role: Role): WayTarget {
  const known = [insurance.business, routed].map((id) => counterparties.find((c) => c.id === id)).find(Boolean);
  if (known) return { id: known.id, role: known.role, name: known.name, path: homeOf('workspace', known.role, known.id), created: false };
  const taken = new Set(counterparties.map((c) => c.id));
  const base = slug(insurance.name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return { id, role, name: insurance.name, path: homeOf('workspace', role, id), created: true };
}

/** The business file that keeps `insurance`'s way, when one does: its own business, else the business its name routes to as a payee. */
export function keptWayOf(insurance: Pick<PayrollInsurance, 'business' | 'name'>, counterparties: readonly Counterparty[]): { business: string; path: string; source?: string } | undefined {
  const routed = identify({ uids: [], ibans: [], domains: [], names: [insurance.name], payees: [insurance.name], filenames: [], originalFilenames: [] }, counterparties);
  const cp = [insurance.business, routed.kind === 'known' ? routed.counterparty : undefined].map((id) => counterparties.find((c) => c.id === id && c.payroll)).find(Boolean);
  return cp && { business: cp.id, path: homeOf('workspace', cp.role, cp.id), ...(cp.payroll?.source ? { source: cp.payroll.source } : {}) };
}

/** Writes through a file beside it and a rename: a crash leaves the old file or the new one, never half of one. */
export function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** The text the target's file takes with the way; refused (nothing written) when the file is no YAML map. */
export function keptText(ws: Pick<Workspace, 'paths'>, target: WayTarget, way: PayrollWay, tx: Pick<BankTransaction, 'counterparty' | 'counterpartyIban'>, today: string): string {
  const file = join(ws.paths.root, target.path);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const payee = tx.counterparty?.trim() || target.name;
  const iban = tx.counterpartyIban?.replace(/\s/g, '').toUpperCase();
  return withPayrollWay(text, way, `hand ${today}`, target.id, target.created && !text.trim() ? { name: target.name, payee, ...(iban ? { iban } : {}) } : undefined, target.path);
}

/** Writes a text keptText made into the target's file; returns its path in the workspace. */
export function writeKept(ws: Pick<Workspace, 'paths'>, target: Pick<WayTarget, 'path'>, text: string): string {
  writeAtomic(join(ws.paths.root, target.path), text);
  return target.path;
}

/** keptText and writeKept in one. */
export const keepPayrollWay = (ws: Pick<Workspace, 'paths'>, target: WayTarget, way: PayrollWay, tx: Pick<BankTransaction, 'counterparty' | 'counterpartyIban'>, today: string): string =>
  writeKept(ws, target, keptText(ws, target, way, tx, today));

/** Removes the kept way from the company's file of `business`; the file's path, or undefined when it kept none. */
export function forgetPayrollWay(ws: Pick<Workspace, 'paths'>, business: Pick<Counterparty, 'id' | 'role'>): string | undefined {
  const path = homeOf('workspace', business.role, business.id);
  const file = join(ws.paths.root, path);
  if (!existsSync(file)) return undefined;
  const next = withoutPayrollWay(readFileSync(file, 'utf8'));
  if (next === undefined) return undefined;
  writeAtomic(file, next);
  return path;
}
