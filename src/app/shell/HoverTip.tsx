/**
 * The app's one tooltip: an element's `data-tip`, or the `aria-label` of a control that shows no
 * words (an icon, or a sign such as × or ◐), in a bubble beside it after a short hover or on keyboard focus. Native
 * `title` tooltips do not show reliably in the Mac app, so no element carries one
 * (tests/tooltips.test.ts).
 */
import { useEffect, useRef, useState } from 'react';

type Tip = { text: string; x: number; y: number; below: boolean };

const DELAY = 400;
/** Moving from one tip to the next within this time shows the next at once. */
const WARM = 600;
const GAP = 6;
const FIELD = 'input, textarea, select';
const WORDS = /[\p{L}\p{N}]/u;

/** The element whose tip shows for a pointer or focus on `node`, and its text. */
export function tipOf(node: EventTarget | null): { el: Element; text: string } | null {
  for (let el = node instanceof Element ? node : null; el; el = el.parentElement) {
    if (el.classList.contains('hovertip')) return null;
    const tip = el.getAttribute('data-tip');
    if (tip) return { el, text: tip };
    const label = el.getAttribute('aria-label');
    if (label && !el.matches(FIELD) && !WORDS.test(el.textContent ?? '')) return { el, text: label };
  }
  return null;
}

export function HoverTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let target: Element | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    let shownAt = 0;
    /** Takes the bubble away; the element stays the target, so it shows again only once the pointer has left it. */
    const dismiss = () => {
      clearTimeout(timer);
      if (visible) shownAt = Date.now();
      visible = false;
      setTip(null);
    };
    const hide = () => { dismiss(); target = null; };
    const show = (el: Element, text: string) => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      visible = true;
      const below = r.bottom + 40 < window.innerHeight;
      setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + GAP : r.top - GAP, below });
    };
    const begin = (node: EventTarget | null) => {
      const found = tipOf(node);
      if (found?.el === target) return;
      const warm = visible || Date.now() - shownAt < WARM;
      hide();
      if (!found) return;
      target = found.el;
      timer = setTimeout(() => { if (target === found.el && found.el.isConnected) show(found.el, found.text); }, warm ? 0 : DELAY);
    };
    const over = (e: PointerEvent) => { if (e.pointerType !== 'touch') begin(e.target); };
    const focus = (e: FocusEvent) => { if (e.target instanceof Element && e.target.matches(':focus-visible')) begin(e.target); };
    const out = (e: PointerEvent) => { if (!e.relatedTarget) hide(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Kept inside the window: centred on the element, then pushed in from either edge.
  useEffect(() => {
    const el = box.current;
    if (!el || !tip) return;
    const w = el.offsetWidth;
    el.style.left = `${Math.max(8, Math.min(tip.x - w / 2, window.innerWidth - w - 8))}px`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={box} className={`hovertip${tip.below ? '' : ' above'}`} aria-hidden="true" data-testid="hovertip"
      style={tip.below ? { top: tip.y } : { bottom: window.innerHeight - tip.y }}
    >{tip.text}</div>
  );
}
