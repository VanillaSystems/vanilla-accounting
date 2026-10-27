/**
 * The Aktionen of one entry (#216): change it, correct a filed one in the open period, reverse,
 * copy, its history (#215), its payment and receipt, delete, the AI. The most likely one first
 * (likelyEntry).
 */
import type { RouteOf } from '../../shell/route.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { askAbout } from '../../assistant/store.js';
import type { ActionSet, ObjAction } from '../../selection/ActionsMenu.js';
import { likelyEntry } from '../../selection/likely.js';
import type { EntryView } from './model.js';
import { runAct } from './commands.js';

type Props = AreaProps<RouteOf<'journal'>>;

/** The entry's Verlauf (#215): opened and in view. */
function showHistory(toast: (msg: string) => void): void {
  const sec = document.querySelector<HTMLElement>('.detail [data-testid=run-history]');
  if (!sec) { toast(t('actions.noHistory')); return; }
  if (!sec.classList.contains('open')) sec.querySelector<HTMLButtonElement>('.sum')?.click();
  sec.scrollIntoView({ block: 'nearest' });
}

export function entryActions(p: Props, v: EntryView): ActionSet {
  const { e } = v;
  const edit = p.canEdit && !v.locked && e.origin !== 'year-close';
  const all: Record<string, ObjAction | undefined> = {
    edit: edit ? { id: 'edit', label: t('actions.change'), key: 'E', run: () => runAct(p, 'edit') } : undefined,
    correct: p.canEdit && v.locked ? { id: 'correct', label: t('actions.correct'), run: () => runAct(p, 'correct') } : undefined,
    reverse: p.canEdit && !v.locked ? { id: 'reverse', label: t('journal.reverse'), run: () => runAct(p, 'reverse') } : undefined,
    copy: p.canEdit ? { id: 'copy', label: t('journal.copy'), run: () => runAct(p, 'copy') } : undefined,
    history: { id: 'history', label: t('actions.history'), run: () => showHistory(p.nav.toast) },
    openPayment: v.tx ? { id: 'openPayment', label: t('actions.openPayment'), key: '⇧↵', run: () => runAct(p, 'payment') } : undefined,
    openReceipt: v.receipts.length ? { id: 'openReceipt', label: t('actions.openReceipt'), key: '↵', run: () => runAct(p, 'receipt') } : undefined,
    del: edit ? { id: 'del', label: t('actions.delete'), key: '⌘⌫', run: () => runAct(p, 'del') } : undefined,
    ask: { id: 'ask', label: t('actions.ask'), run: () => askAbout({ kind: 'entry', id: e.id, label: e.description ?? e.id }) },
  };
  const likely = p.canEdit ? likelyEntry({ locked: v.locked, yearClose: e.origin === 'year-close' }) : undefined;
  const primary = likely ? all[likely] : undefined;
  return { primary, rest: Object.values(all).filter((a): a is ObjAction => !!a && a !== primary) };
}
