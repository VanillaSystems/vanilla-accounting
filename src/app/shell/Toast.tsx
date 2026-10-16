import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';

interface Shown { msg: string; undo?: () => void; n: number }

/**
 * One message at a time; with an undo it stays 6 s and ⌘Z or its button takes the action back.
 * The undo outlives the toast: ⌘Z after it has gone still takes the last action back (r8k-7,
 * r8h-25), once, until another message takes its place.
 */
export function useToast() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [visible, setVisible] = useState(false);
  const n = useRef(0);

  const toast = useCallback((msg: string, undo?: () => void) => {
    setShown({ msg, undo, n: ++n.current });
    setVisible(true);
  }, []);

  useEffect(() => {
    if (!shown) return;
    const id = setTimeout(() => setVisible(false), shown.undo ? 6000 : 2600);
    return () => clearTimeout(id);
  }, [shown]);

  const dismiss = useCallback(() => setVisible(false), []);
  /** A message that waits for nothing: it does not take the place of a shown undo (a run finishing right after a delete). */
  const note = useCallback((msg: string) => {
    if (!(visible && shown?.undo)) toast(msg);
  }, [visible, shown, toast]);

  /** Runs the last undo, shown or gone; false when there is none left. */
  const undo = useCallback(() => {
    if (!shown?.undo) return false;
    shown.undo();
    setShown({ ...shown, undo: undefined });
    setVisible(false);
    return true;
  }, [shown]);

  const node = (
    <div className={`toast${visible ? ' show' : ''}`} role="status" aria-live="polite">
      {shown && <span>{shown.msg}</span>}
      {shown?.undo && (
        <button type="button" onClick={undo}>{t('shell.undo')}<span className="k">⌘Z</span></button>
      )}
    </div>
  );
  return { toast, note, dismiss, undo, node };
}
