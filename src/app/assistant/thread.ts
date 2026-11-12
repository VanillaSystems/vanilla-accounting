/**
 * Which conversation the AI sidebar continues (src/app/assistant/store.ts): the one open stays
 * open across pages and a reload of the window, so a follow-up such as «und auch …» after a look
 * at another page still knows what it refers to. A new one starts only on «Neu», or when «Mit KI …»
 * on an object opens the sidebar while it is closed. Pure, so a test can walk it without a browser.
 */
import { PURPOSES, type ContextRef, type Purpose, type Turn } from '../../types/assistant.js';

export interface Thread {
  open: boolean;
  conversation?: string;
  turns: Turn[];
  /** Added by «Mit KI …» or @, beside the page's own reference. */
  extra: ContextRef[];
  /** The page's reference is left out of the next message. */
  pageOff: boolean;
  /** Why a button started this conversation: its messages leave the page out until the person adds it with «+». */
  purpose?: Purpose;
}

/** Where the open conversation's id is remembered in this browser. */
export const KEPT_CONVERSATION = 'assistant.conversation';

/** The purpose of a new conversation not sent yet (the setup before «Los geht's»); a sent one keeps its purpose on the server. */
export const KEPT_PURPOSE = 'assistant.purpose';

/** At start: the conversation open before the window was loaded again (its turns and purpose are read from the server), else the purpose of the one not sent yet. */
export const startThread = (stored: (key: string) => string | null): Partial<Pick<Thread, 'conversation' | 'purpose' | 'pageOff'>> => {
  const id = stored(KEPT_CONVERSATION);
  if (id) return { conversation: id };
  const purpose = PURPOSES.find((p) => p === stored(KEPT_PURPOSE));
  return purpose ? { purpose, pageOff: true } : {};
};

/**
 * Whether the sidebar leaves the setup conversation for an ordinary one (#342): the setup is over
 * (the person said «Los geht's») and she did not open it again herself (Firma › «Einrichtung …»,
 * `wanted`). So after the setup, and after a reload, ⌘J opens the ordinary sidebar at its ordinary width.
 */
export const leavesSetup = (t: Pick<Thread, 'purpose'>, setup: { over: boolean; wanted: boolean }): boolean =>
  t.purpose === 'onboarding' && setup.over && !setup.wanted;

/** A new conversation; one with a purpose starts without the page's reference. */
export const newThread = (purpose?: Purpose): Pick<Thread, 'conversation' | 'turns' | 'extra' | 'pageOff' | 'purpose'> => ({ conversation: undefined, turns: [], extra: [], pageOff: !!purpose, purpose });

/** After a message is sent: the page goes with the next one again, except in a conversation with a purpose, where it stays as the person left it. */
export const afterSend = (t: Thread): Pick<Thread, 'pageOff'> => ({ pageOff: t.purpose ? t.pageOff : false });

/** «Mit KI …» on an object: one more reference in the open conversation; with the sidebar closed, a new conversation about that object. */
export function askAboutThread(t: Thread, ref: ContextRef): Partial<Thread> {
  if (t.open) return { extra: t.extra.some((r) => r.kind === ref.kind && r.id === ref.id) ? t.extra : [...t.extra, ref] };
  return { ...newThread(), open: true, extra: [ref], pageOff: true };
}

/** What a message sends: into the open conversation, with the page shown now (unless taken off) and the added references. */
export function messageOf(t: Thread, page: ContextRef | undefined): { conversation?: string; context: ContextRef[] } {
  return { ...(t.conversation ? { conversation: t.conversation } : {}), context: [...(page && !t.pageOff ? [page] : []), ...t.extra] };
}
