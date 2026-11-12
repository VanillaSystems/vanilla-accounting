/**
 * The wide conversation of the start screen (FirstRun, DraftConversation) keeps its newest turn in
 * sight, as a chat does: the input box `.obtalk` sticks to the window's bottom edge and lies over
 * whatever the page holds below it, so a new turn whose answers fall under the box would be out of
 * reach of a click. When a turn appears (a message or a row of answers), the view scrolls to the end
 * marker; while the person has not scrolled up, a turn that grows (a card that changes, the
 * language switched) keeps the end in sight too, unless a field of the conversation has the focus.
 * Smooth only without prefers-reduced-motion.
 */
import { useEffect, type RefObject } from 'react';

/** What counts as a turn: a message (the AI's or the person's) or a row of answers. */
const TURN = '.msg, .qacts';

export function useFollowEnd(turns: RefObject<HTMLElement | null>, end: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const box = turns.current;
    const mark = end.current;
    if (!box || !mark) return;
    const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    /** The end marker is in sight above the input box. */
    const atEnd = () => {
      const talk = box.closest('.obflow')?.querySelector('.obtalk')?.getBoundingClientRect().top ?? innerHeight;
      return mark.getBoundingClientRect().bottom <= Math.min(talk, innerHeight) + 2;
    };
    const editing = () => { const a = document.activeElement; return !!a && box.contains(a) && a.matches('input, textarea, select, summary'); };
    let pinned = true;
    let seen = box.querySelectorAll(TURN).length;
    let top = mark.getBoundingClientRect().top;
    const follow = (smooth: boolean) => {
      pinned = true;
      mark.scrollIntoView({ block: 'end', behavior: smooth && !reduced() ? 'smooth' : 'auto' });
    };
    const changed = () => {
      const n = box.querySelectorAll(TURN).length;
      const grew = n > seen;
      seen = n;
      top = mark.getBoundingClientRect().top;
      if (grew) follow(true);
      else if (pinned && !atEnd() && !editing()) follow(false);
    };
    // The end moved down without the content changing: the person scrolled up, and the view stays where they put it until they are back at the end.
    const scrolled = () => {
      const now = mark.getBoundingClientRect().top;
      if (now > top + 1) pinned = atEnd();
      else if (atEnd()) pinned = true;
      top = now;
    };
    const mutations = new MutationObserver(changed);
    mutations.observe(box, { childList: true, subtree: true });
    const sizes = new ResizeObserver(changed);
    sizes.observe(box);
    addEventListener('scroll', scrolled, { capture: true, passive: true });
    follow(false);
    return () => { mutations.disconnect(); sizes.disconnect(); removeEventListener('scroll', scrolled, { capture: true }); };
  }, [turns, end]);
}
