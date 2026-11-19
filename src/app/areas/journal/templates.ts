/**
 * The company's named entry templates in the app (#567, src/workspace/entry-templates.ts): loaded
 * once and after each change, kept and removed with an undo in the toast, and started as the hand
 * form on the day a new entry starts on. A template books nothing by itself.
 */
import { useSyncExternalStore } from 'react';
import type { Index } from '../../../types/index.js';
import type { EntryTemplate } from '../../../workspace/entry-templates.js';
import { api, errorText } from '../../lib/api.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { setUi, type Split } from './state.js';
import { newEntryDate } from './commands.js';

let list: readonly EntryTemplate[] = [];
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Reads the templates from the server; the static export has none. */
export function loadTemplates(again = false): Promise<void> {
  if (loading && !again) return loading;
  loading = api.entryTemplates().then((r) => { list = r.templates; changed(); }, () => { list = []; changed(); });
  return loading;
}

/** The templates as loaded; the first call loads them (⌘K lists them before the form was opened). */
export const templatesNow = (): readonly EntryTemplate[] => { void loadTemplates(); return list; };

export function useTemplates(): readonly EntryTemplate[] {
  return useSyncExternalStore((l) => { listeners.add(l); void loadTemplates(); return () => listeners.delete(l); }, () => list);
}

/** The hand form started from a template, dated `date` (a new entry's day); its last split line without an amount holds the rest. */
export function startFrom(books: Index, x: EntryTemplate, date = newEntryDate(books)): void {
  const split: Split | undefined = x.split && {
    side: x.split.side,
    lines: x.split.lines.map((l, i, all) => ({ account: l.account, ...(l.amount !== undefined && { amount: l.amount }), vatCode: l.vatCode ?? '', description: l.description ?? '', ...(i === all.length - 1 && l.amount === undefined && { auto: true as const }) })),
  };
  setUi({ overlay: { kind: 'new', template: x.id, draft: {
    date, accountDebit: x.accountDebit, accountCredit: x.accountCredit,
    ...(x.amount !== undefined && { amount: x.amount }), vatCode: x.vatCode ?? '', description: x.description ?? '', ...(x.tags && { tags: x.tags }),
  }, ...(split && { split }) } });
}

/** Keeps the form as a template; the undo puts back the one it replaced, or removes it. */
export async function keepTemplate(nav: Nav, x: Omit<EntryTemplate, 'id'>): Promise<EntryTemplate | undefined> {
  try {
    const { template, replaced } = await api.saveEntryTemplate(x);
    await loadTemplates(true);
    nav.toast(t(replaced ? 'journal.template.replaced' : 'journal.template.kept', { name: template.name }), () => {
      (replaced ? api.saveEntryTemplate(replaced) : api.deleteEntryTemplate(template.id)).then(() => loadTemplates(true), (e) => nav.toast(errorText(e)));
    });
    return template;
  } catch (e) {
    nav.toast(errorText(e));
    return undefined;
  }
}

/** Removes a template; the undo keeps it again under its id. */
export async function dropTemplate(nav: Nav, x: EntryTemplate): Promise<boolean> {
  try {
    await api.deleteEntryTemplate(x.id);
    await loadTemplates(true);
    nav.toast(t('journal.template.deleted', { name: x.name }), () => {
      api.saveEntryTemplate(x).then(() => loadTemplates(true), (e) => nav.toast(errorText(e)));
    });
    return true;
  } catch (e) {
    nav.toast(errorText(e));
    return false;
  }
}
