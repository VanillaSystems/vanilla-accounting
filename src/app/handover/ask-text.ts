/**
 * The question before a link opens (reviews of PR #538). The page (LinkParts OpenLink) and the Mac
 * app's dialog for `vanilla-accounting://` (src/desktop/main.ts) say the same, each with its own t():
 * the service, and who shares which books as the link itself claims, one line each and short, so
 * the envelope cannot draw lines of its own into the dialog.
 */
import type { LinkPreview } from '../../share/sharing.js';

type Say = (key: 'share.ask.claim' | 'share.ask.unknown' | 'share.ask.foreign', vars: Record<string, string>) => string;

/** Control and format characters (every bidirectional mark, override and isolate, zero-width spaces and joiners: Unicode Cc and Cf), line and paragraph separators. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

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
