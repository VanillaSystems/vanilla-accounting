/**
 * A form that shows what the books hold follows every change of the books (a save, an undo, the
 * toast's undo, another tab): a field the person left as the books gave it takes the books' new
 * value; a field she changed keeps what she typed, focused or not. So a field never shows a value
 * the books no longer hold, and leaving it saves only what she changed.
 */
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';

type Values = Record<string, string>;

/** `shown` after the books went from `was` to `now`: each field still as `was` gave it takes `now`'s value. */
export function rebase<T extends Values>(shown: T, was: T, now: T): T {
  const next = { ...shown };
  for (const k of Object.keys(now) as (keyof T)[]) if (shown[k] === (was[k] ?? now[k])) next[k] = now[k];
  return next;
}

/** A form held in React state, prefilled from the books (`now`): the state follows the books by `rebase`. */
export function useBookedState<T extends Values>(now: T): [T, Dispatch<SetStateAction<T>>] {
  const [f, setF] = useState(now);
  const was = useRef(now);
  const at = JSON.stringify(now);
  useEffect(() => {
    const before = was.current;
    was.current = now;
    setF((shown) => rebase(shown, before, now));
  }, [at]);
  return [f, setF];
}

/**
 * Fields that hold their own values (named inputs in `box`, read by FormData): after each change of
 * `now` the fields follow it by `rebase`. The returned `reset(true)` puts every field back to `now`
 * (a refused save). A combobox hears its new value as an input event, so its own state and name line
 * follow; the event is not trusted, which a combobox reads as «not typed».
 */
export function useBookedFields(box: RefObject<HTMLElement | null>, now: Values): (force?: boolean) => void {
  const was = useRef(now);
  const reset = (force = false) => {
    const before = was.current;
    was.current = now;
    const fields = Object.keys(now).flatMap((name) => box.current?.querySelector<HTMLInputElement>(`[name="${name}"]`) ?? []);
    const shown = Object.fromEntries(fields.map((el) => [el.name, el.value]));
    const next = force ? now : rebase(shown, before, now);
    const changed = fields.filter((el) => el.value !== next[el.name]);
    // The prototype's setter: React's own tracker would otherwise swallow the input event below.
    for (const el of changed) Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set?.call(el, next[el.name]);
    for (const el of changed) if (el.getAttribute('role') === 'combobox') el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const at = JSON.stringify(now);
  useEffect(() => reset(), [at]);
  return reset;
}
