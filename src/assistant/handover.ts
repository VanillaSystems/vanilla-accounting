/**
 * What «Im Terminal weitermachen» in the composer hands to the terminal CLI (issue #146 follow-up):
 * the words typed in the field, as they are; with none, a short request from the conversation (its
 * last question and one line of what the chat answered). Plain text from the turns only: no
 * attachments, no references, no tool details, and capped, so a long conversation stays a prompt.
 */
import type { Turn } from '../types/assistant.js';
import { withoutChanges } from './changes.js';

export const QUESTION_MAX = 400;
export const CONTEXT_MAX = 160;

/** `s` on one line, without Markdown's marks, cut to `max` characters with «…». */
function line(s: string, max: number): string {
  const flat = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * `typed` when it holds words; otherwise the last question with `context` (the label, in the UI's
 * language) and the first line of the chat's answer after it; empty when nothing was asked yet.
 */
export function handover(typed: string, turns: readonly Turn[], context: string): string {
  if (typed.trim()) return typed.trim();
  const last = turns.map((t) => t.role).lastIndexOf('me');
  if (last < 0) return '';
  const question = line(turns[last].text, QUESTION_MAX);
  if (!question) return '';
  const answer = turns.slice(last + 1).find((t) => t.role === 'ai');
  const first = answer ? withoutChanges(answer.text).split('\n').find((l) => line(l, CONTEXT_MAX)) : undefined;
  return first ? `${question}\n\n${context}: ${line(first, CONTEXT_MAX)}` : question;
}
