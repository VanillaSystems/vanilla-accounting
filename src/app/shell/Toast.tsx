import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { NO_AI_EVENT } from '../lib/api.js';

/** `noAi`: the error line of a step that needed an AI where none answers; it stays until the person answers it. */
interface Shown { msg: string; undo?: () => void; noAi?: true; n: number }

/**
 * One message at a time; with an undo it stays 6 s and ⌘Z or its button takes the action back.
 * The undo outlives the toast: ⌘Z after it has gone still takes the last action back (r8k-7,
 * r8h-25), once, until another message takes its place. A refusal for want of an AI (src/app/lib/api.ts
 * NO_AI_EVENT) shows as the error line with «KI einrichten» (`onSetUp`) and «Von Hand erfassen»,
 * and stays until one is clicked; the same text toasted by the caller does not replace it.
 */
export function useToast(onSetUp?: () => void) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [visible, setVisible] = useState(false);
  const n = useRef(0);

  const toast = useCallback((msg: string, undo?: () => void) => {
    setShown((was) => (was?.noAi && was.msg === msg ? was : { msg, undo, n: ++n.current }));
    setVisible(true);
  }, []);

  useEffect(() => {
    const line = (e: Event) => {
      setShown({ msg: String((e as CustomEvent).detail ?? ''), noAi: true, n: ++n.current });
      setVisible(true);
    };
    window.addEventListener(NO_AI_EVENT, line);
    return () => window.removeEventListener(NO_AI_EVENT, line);
  }, []);

  useEffect(() => {
    if (!shown || shown.noAi) return;
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
    <div className={`toast${visible ? ' show' : ''}${shown?.noAi ? ' noai' : ''}`} role="status" aria-live="polite" data-testid={shown?.noAi ? 'no-ai-line' : undefined}>
      {shown && <span>{shown.msg}</span>}
      {shown?.noAi ? (
        <>
          {onSetUp ? <button type="button" data-act="ai-set-up" onClick={() => { setVisible(false); onSetUp(); }}>{t('aiSetup.line.setUp')}</button> : null}
          <button type="button" data-act="by-hand" onClick={() => setVisible(false)}>{t('aiSetup.line.byHand')}</button>
        </>
      ) : null}
      {shown?.undo && (
        <button type="button" onClick={undo}>{t('shell.undo')}<span className="k">⌘Z</span></button>
      )}
    </div>
  );
  return { toast, note, dismiss, undo, node };
}
