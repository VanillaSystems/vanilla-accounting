/**
 * Named entry templates (#567): a hand entry kept under a name, for what comes back every month
 * (depreciation, a rent accrual, the owner's salary), started again from Buchungen › Neue Buchung
 * or ⌘K. They belong to the company, not to a viewer, so they live in the workspace beside the
 * chart: master-data/entry-templates.json. A template is only a form's start: it books nothing, and
 * every booking from it goes through the form and the write door like any other.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Workspace } from './workspace.js';
import type { Tags } from '../books/tags.js';

export const ENTRY_TEMPLATES_FILE = 'entry-templates.json';

/** A line of a Sammelbuchung template: the account opposite the shared one. */
export interface TemplateLine { account: string; amount?: number; vatCode?: string; description?: string }

export interface EntryTemplate {
  id: string;
  name: string;
  accountDebit: string;
  accountCredit: string;
  /** Absent: the amount is typed each time. */
  amount?: number;
  vatCode?: string;
  description?: string;
  tags?: Tags;
  /** A Sammelbuchung: the shared account stands on `side`, its lines on the other. */
  split?: { side: 'accountDebit' | 'accountCredit'; lines: TemplateLine[] };
}

/** The most templates a workspace keeps; a save beyond it is refused with the limit named. */
export const MAX_TEMPLATES = 100;

const pathOf = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.masterData, ENTRY_TEMPLATES_FILE);

export function readTemplates(ws: Pick<Workspace, 'paths'>): EntryTemplate[] {
  const path = pathOf(ws);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { templates?: unknown };
  return Array.isArray(raw.templates) ? (raw.templates as EntryTemplate[]) : [];
}

/** Written whole through a temporary file, so a reader never sees half of it. */
function write(ws: Pick<Workspace, 'paths'>, templates: readonly EntryTemplate[]): void {
  const path = pathOf(ws);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ templates }, null, 2) + '\n');
  renameSync(tmp, path);
}

/** The template a save of `t` replaces: the same id, or the same name (the same name means the same template). */
export const replacedBy = (all: readonly EntryTemplate[], t: { id?: string; name: string }): EntryTemplate | undefined =>
  // By id first: an undo puts its own template back, never one that took its name meanwhile.
  (t.id ? all.find((x) => x.id === t.id) : undefined) ?? all.find((x) => x.name.trim().toLowerCase() === t.name.trim().toLowerCase());

/**
 * Keeps a template, new or in place of the one it replaces. Refused (undefined) when its name is
 * empty, or when it is new and the workspace holds MAX_TEMPLATES already.
 */
export function saveTemplate(ws: Pick<Workspace, 'paths'>, t: Omit<EntryTemplate, 'id'> & { id?: string }): EntryTemplate | 'noName' | 'limit' {
  const name = t.name.trim();
  if (!name) return 'noName';
  const all = readTemplates(ws);
  const same = replacedBy(all, t);
  if (!same && all.length >= MAX_TEMPLATES) return 'limit';
  const kept: EntryTemplate = { ...t, name, id: same?.id ?? (t.id || randomBytes(6).toString('hex')) };
  write(ws, same ? all.map((x) => (x.id === same.id ? kept : x)) : [...all, kept].sort((a, b) => a.name.localeCompare(b.name)));
  return kept;
}

/** Removes a template; answers it, so an undo can keep it again. */
export function deleteTemplate(ws: Pick<Workspace, 'paths'>, id: string): EntryTemplate | undefined {
  const all = readTemplates(ws);
  const gone = all.find((x) => x.id === id);
  if (gone) write(ws, all.filter((x) => x.id !== id));
  return gone;
}
