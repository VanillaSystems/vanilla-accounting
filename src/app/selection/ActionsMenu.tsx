/**
 * «Aktionen» on a receipt, a payment, an entry or a selection (#216): only the actions that fit
 * it, the most likely one as the large primary button beside the menu. A opens the menu, ⌘K lists
 * the same actions; the detail shown registers its actions here, so the shell's key and palette
 * reach them without knowing the area.
 */
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { Menu } from '../shell/Menu.js';
import './selection.css';

export interface ObjAction {
  id: string;
  label: string;
  run(): void;
  /** A key the area already gives it, shown beside it. */
  key?: string;
  /** What it does, in words, on the button's tip. */
  tip?: string;
}

/** The actions of what is shown: the primary first, the rest in the menu. */
export interface ActionSet { primary?: ObjAction; rest: ObjAction[] }

interface Mounted { open(): void; set: ActionSet }
let mounted: Mounted | undefined;

/** A: the menu of the detail shown; false when none shows one. */
export function openActions(): boolean {
  if (!mounted) return false;
  mounted.open();
  return true;
}

/** ⌘K: every action of the detail shown, the primary first. */
export const actionsNow = (): ObjAction[] => (mounted ? [...(mounted.set.primary ? [mounted.set.primary] : []), ...mounted.set.rest] : []);

export function ActionsMenu({ set }: { set: ActionSet }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const me = useRef<Mounted>({ open: () => {}, set });
  me.current.set = set;
  me.current.open = () => { if (button.current) setAnchor(button.current.getBoundingClientRect()); };
  useEffect(() => {
    const m = me.current;
    mounted = m;
    return () => { if (mounted === m) mounted = undefined; };
  }, []);
  if (!set.primary && !set.rest.length) return null;
  return (
    <span className="actions" data-testid="actions">
      {set.primary && <button type="button" className="btn primary" data-act={`primary-${set.primary.id}`} data-tip={set.primary.tip} onClick={set.primary.run}>{set.primary.label}</button>}
      {set.rest.length > 0 && (
        <button type="button" ref={button} className="btn" aria-haspopup="menu" aria-expanded={!!anchor} data-act="actions" data-tip={t('actions.tip')} onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
          {t('actions.label')}<span className="k">A</span>
        </button>
      )}
      {anchor && (
        <Menu anchor={anchor} items={set.rest.map((a) => ({ label: <span data-action={a.id}>{a.label}</span>, side: a.key, run: a.run }))} onClose={() => setAnchor(null)} />
      )}
    </span>
  );
}
