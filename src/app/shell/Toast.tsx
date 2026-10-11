import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';

/** A toast's button that is not an undo: it goes somewhere, and leaves ⌘Z alone. */
export interface ToastAction { label: string; run(): void }

interface Shown { msg: string; undo?: () => void; action?: ToastAction; n: number }

/** One message at a time; with an undo it stays 6 s and ⌘Z or its button takes the action back; with an action it stays 6 s too. */
export function useToast() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [visible, setVisible] = useState(false);
  const n = useRef(0);

  const toast = useCallback((msg: string, undo?: () => void, action?: ToastAction) => {
    setShown({ msg, undo, action, n: ++n.current });
    setVisible(true);
  }, []);

  useEffect(() => {
    if (!shown) return;
    const id = setTimeout(() => setVisible(false), shown.undo || shown.action ? 6000 : 2600);
    return () => clearTimeout(id);
  }, [shown]);

  /** Runs the shown undo; false when there is none. */
  const undo = useCallback(() => {
    if (!visible || !shown?.undo) return false;
    shown.undo();
    setVisible(false);
    return true;
  }, [visible, shown]);

  const node = (
    <div className={`toast${visible ? ' show' : ''}`} role="status" aria-live="polite">
      {shown && <span>{shown.msg}</span>}
      {shown?.undo && (
        <button type="button" onClick={undo}>{t('shell.undo')}<span className="k">⌘Z</span></button>
      )}
      {shown?.action && (
        <button type="button" onClick={() => { shown.action!.run(); setVisible(false); }}>{shown.action.label}</button>
      )}
    </div>
  );
  return { toast, undo, node };
}
