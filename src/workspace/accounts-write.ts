/**
 * The chart of accounts (accounts.json) from the Firma page: an account renamed, or a new one
 * added in number order. ADR 0004: each account object is kept as it is on disk and only its
 * name is set, so fields this app does not know stay.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from '../invoices/store.js';
import type { Workspace } from './workspace.js';
import { WorkspaceError } from './workspace.js';

export const ACCOUNT_NUMBER = /^\d{4}$/;

/** Sets the name of account `number`, adding the account when the chart has none of that number. */
export function setAccountName(ws: Pick<Workspace, 'paths'>, number: string, name: string): { number: string; name: string; added: boolean } {
  if (!ACCOUNT_NUMBER.test(number)) throw new WorkspaceError(`Account "${number}": four digits.`);
  const clean = name.trim();
  if (!clean) throw new WorkspaceError(`Account ${number}: the name is empty.`);
  const path = ws.paths.accounts;
  const chart = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>> : [];
  if (!Array.isArray(chart)) throw new WorkspaceError(`${path} is not a list of accounts.`);
  const found = chart.find((a) => String(a.number) === number);
  if (found) found.name = clean;
  else {
    const at = chart.findIndex((a) => String(a.number) > number);
    chart.splice(at < 0 ? chart.length : at, 0, { number, name: clean });
  }
  writeAtomic(path, JSON.stringify(chart, null, 2) + '\n');
  return { number, name: clean, added: !found };
}
