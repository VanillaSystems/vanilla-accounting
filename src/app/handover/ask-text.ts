/**
 * The questions before a link opens (reviews of PR #538). The page (LinkParts OpenLink) and the Mac
 * app's dialogs for `vanilla-accounting://` (src/desktop/main.ts) say the same, each with its own t().
 *
 * - Before the download: the service, and who shares which books as the link itself claims, one
 *   line each and short, so the envelope cannot draw lines of its own into the dialog.
 * - After it, when the package would move a copy here that it does not continue (shareCopyOther):
 *   that copy's real facts, the package's claims, and plainly that the sender cannot be verified.
 */
import type { LinkPreview } from '../../share/sharing.js';

type Say = (key: 'share.ask.claim' | 'share.ask.unknown' | 'share.ask.foreign' | 'share.ask.replaceReal', vars: Record<string, string>) => string;

/** Control characters, line and paragraph separators, and bidirectional overrides. */
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g');

/** One line, at most `max` characters: control characters and line breaks become spaces. */
export const oneLine = (s: string | undefined, max = 80): string => {
  const flat = (s ?? '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function askLines(say: Say, p: LinkPreview): { what: string; warnings: string[] } {
  const name = oneLine(p.senderName);
  const what = name ? say('share.ask.claim', { company: oneLine(p.company) || '–', name, host: p.host }) : say('share.ask.unknown', { host: p.host });
  return { what, warnings: p.foreign ? [say('share.ask.foreign', { host: p.host })] : [] };
}

/** The question when a link would move an existing copy without continuing its hand-overs (the refusal's params). */
export const askReplace = (say: Say, p: Record<string, string>): string =>
  say('share.ask.replaceReal', { firm: oneLine(p.firm), version: oneLine(p.version, 12), was: oneLine(p.was), now: oneLine(p.now), claimed: oneLine(p.claimed), host: oneLine(p.host) });
