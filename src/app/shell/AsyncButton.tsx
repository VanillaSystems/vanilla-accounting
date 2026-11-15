/**
 * The one button for an action that waits (owner rule 2026-11-15: «all async buttons should show
 * some form of loading»; AGENTS.md «UI», guarded by tests/async-buttons.test.ts).
 *
 * `AsyncButton` takes an onClick that may return a promise. While it is pending (or while `busy`, or
 * while the `AsyncForm` around a submit button waits) the button refuses further clicks, says
 * aria-busy, and after SHOW_AFTER ms shows a spinner in place of its label at the same width;
 * `progress` (0…1) adds a bar for a job that reports how far it is. It never says what happened:
 * the area shows the result or the refusal as before.
 */
import { createContext, forwardRef, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type FormHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

/** Below this the action counts as instant: no spinner flickers in and out. */
export const SHOW_AFTER = 150;

const isThenable = (v: unknown): v is PromiseLike<unknown> => !!v && typeof (v as PromiseLike<unknown>).then === 'function';

/** Counts the pending promises of a component; `track` hands each on and counts it until it settles. */
function usePending() {
  const [pending, setPending] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const track = (v: unknown) => {
    if (!isThenable(v)) return;
    setPending((n) => n + 1);
    const done = () => { if (live.current) setPending((n) => n - 1); };
    v.then(done, done);
  };
  return { pending: pending > 0, track };
}

/** True once `on` has held for SHOW_AFTER ms; false again at once when it ends. */
function useShown(on: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), SHOW_AFTER);
    return () => clearTimeout(timer);
  }, [on]);
  return shown;
}

const FormBusy = createContext(false);

export type AsyncButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  /** May return a promise: the button is busy until it settles. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => unknown;
  /** Busy from outside: a job the area follows, an action another control started. */
  busy?: boolean;
  /** How far a job is, 0…1, while busy. */
  progress?: number;
};

export const AsyncButton = forwardRef<HTMLButtonElement, AsyncButtonProps>(function AsyncButton({ onClick, busy, progress, className, children, type, ...rest }, ref) {
  const own = usePending();
  // A button without a type submits its form, as in HTML.
  const formBusy = useContext(FormBusy) && (type === undefined || type === 'submit');
  const waiting = own.pending || !!busy || formBusy;
  const shown = useShown(waiting);
  const click = (e: MouseEvent<HTMLButtonElement>) => {
    // Not `disabled` while it waits: that would grey the button out before the spinner is due.
    if (waiting) { e.preventDefault(); return; }
    own.track(onClick?.(e));
  };
  const bar = shown && progress !== undefined;
  return (
    <button {...rest} ref={ref} type={type} className={[className, shown && 'isbusy'].filter(Boolean).join(' ') || undefined}
      aria-busy={waiting || undefined} aria-disabled={waiting || rest['aria-disabled'] || undefined} onClick={click}>
      {children}
      {bar ? <span className="busybar" aria-hidden><i style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }} /></span> : null}
    </button>
  );
});

export type AsyncFormProps = Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> & {
  /** May return a promise: the form's submit buttons (AsyncButton type="submit") are busy until it settles. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => unknown;
  children?: ReactNode;
};

/** A form whose submit waits: a second submit (Enter, a click) is refused while the first is pending. */
export const AsyncForm = forwardRef<HTMLFormElement, AsyncFormProps>(function AsyncForm({ onSubmit, children, ...rest }, ref) {
  const own = usePending();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    if (own.pending) { e.preventDefault(); return; }
    own.track(onSubmit?.(e));
  };
  return <form {...rest} ref={ref} onSubmit={submit} aria-busy={own.pending || undefined}><FormBusy.Provider value={own.pending}>{children}</FormBusy.Provider></form>;
});
