/**
 * A button that hands its words to the AI («Mit KI einrichten»): the sidebar opens, the words fly
 * from the button into the chat and become the first message, the page dims for a moment and the
 * sidebar's edge lights up once, so the eye follows to the right. With reduced motion only the edge
 * lights up. The message starts a new conversation with the button's purpose and goes as any typed
 * one (sendMessage), without the page's reference, which stays off until the person adds it with «+».
 */
import type { Purpose } from '../../types/assistant.js';
import { newPurposeConversation, openAssistant, sendMessage } from './store.js';

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function askFrom(origin: Element | null, text: string, purpose: Purpose): Promise<void> {
  const from = origin?.getBoundingClientRect();
  newPurposeConversation(purpose);
  openAssistant();
  await frame();
  await frame();
  const aside = document.querySelector<HTMLElement>('aside.aside');
  if (aside) { aside.classList.remove('flash'); void aside.offsetWidth; aside.classList.add('flash'); setTimeout(() => aside.classList.remove('flash'), 1300); }
  const to = document.querySelector('.aiturns')?.getBoundingClientRect();
  if (from && to && !reduced()) {
    const dim = Object.assign(document.createElement('div'), { className: 'ai-dim' });
    const pill = Object.assign(document.createElement('div'), { className: 'flypill', textContent: text });
    pill.style.left = `${from.left}px`;
    pill.style.top = `${from.top}px`;
    document.body.append(dim, pill);
    setTimeout(() => dim.remove(), 900);
    await frame();
    pill.style.left = `${to.right - pill.offsetWidth - 14}px`;
    pill.style.top = `${to.top + 4}px`;
    await new Promise((done) => setTimeout(done, 560));
    pill.remove();
  }
  await sendMessage(text, undefined);
}
