/**
 * «Immer so» on a payment to a payroll insurer (docs/specs/payroll.md §22 decision 126): the choice the hand form
 * asks («für Monate ab dem Lohnstart» / «für Monate davor») kept in the company's file of the fund
 * (`payroll: { payments }`, src/knowledge/payroll-way.ts), which insurerPaymentOf then honours. The file is the
 * insurance's business, else the one the payment routes to, else a new file of the company's own named after the
 * insurer and matched by the payee the bank writes. «Rückgängig» removes the section again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import type { BankTransaction } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { homeOf } from '../knowledge/layers.js';
import type { Counterparty, Role } from '../knowledge/counterparties.js';
import type { PayrollWay } from '../knowledge/payroll-way.js';
import type { PayrollInsurance } from './model.js';

/** The file's text with `payroll: { payments, source }` set; a new file of the company's own when `text` is empty and `create` names it. */
export function withPayrollWay(text: string, way: PayrollWay, source: string, create?: { id: string; name: string; payee: string }): string {
  const doc = parseDocument(text.trim() ? text : create ? `id: ${JSON.stringify(create.id)}\nname: ${JSON.stringify(create.name)}\nmatch:\n  payee: [${JSON.stringify(create.payee)}]\n` : '');
  doc.setIn(['payroll'], doc.createNode({ payments: way, source }));
  return doc.toString({ lineWidth: 0 });
}

/** The file's text without its `payroll` section; undefined when it has none. */
export function withoutPayrollWay(text: string): string | undefined {
  const doc = parseDocument(text);
  if (!doc.has('payroll')) return undefined;
  doc.delete('payroll');
  return doc.toString({ lineWidth: 0 });
}

const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'versicherung';

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

/** Writes the way into the target's file; returns its path in the workspace. */
export function keepPayrollWay(ws: Pick<Workspace, 'paths'>, target: WayTarget, way: PayrollWay, tx: Pick<BankTransaction, 'counterparty'>, today: string): string {
  const file = join(ws.paths.root, target.path);
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const payee = tx.counterparty?.trim() || target.name;
  writeFileSync(file, withPayrollWay(text, way, `hand ${today}`, target.created ? { id: target.id, name: target.name, payee } : undefined));
  return target.path;
}

/** Removes the kept way from the company's file of `business`; the file's path, or undefined when it kept none. */
export function forgetPayrollWay(ws: Pick<Workspace, 'paths'>, business: Pick<Counterparty, 'id' | 'role'>): string | undefined {
  const path = homeOf('workspace', business.role, business.id);
  const file = join(ws.paths.root, path);
  if (!existsSync(file)) return undefined;
  const next = withoutPayrollWay(readFileSync(file, 'utf8'));
  if (next === undefined) return undefined;
  writeFileSync(file, next);
  return path;
}
