/**
 * The question before a link opens (review of PR #538): whose books, from whom, through which
 * service; a plain warning when the service is not this app's, and when an existing copy would move
 * to this link. The page (LinkParts OpenLink) and the Mac app's dialog for `vanilla-accounting://`
 * (src/desktop/main.ts) say the same, each with its own t().
 */
import type { LinkPreview } from '../../share/sharing.js';

type Say = (key: 'share.ask.what' | 'share.ask.unknown' | 'share.ask.foreign' | 'share.ask.replace' | 'share.ask.via', vars: Record<string, string>) => string;

export function askLines(say: Say, p: LinkPreview): { what: string; warnings: string[]; replaces: boolean } {
  const what = p.senderName ? say('share.ask.what', { company: p.company ?? '', name: p.senderName, host: p.host }) : say('share.ask.unknown', { host: p.host });
  const warnings: string[] = [];
  if (p.foreign) warnings.push(say('share.ask.foreign', { host: p.host }));
  const replaces = !!p.copy && (p.copy.sharer !== p.senderName || (!!p.copy.service && p.copy.service !== p.service));
  if (p.copy) warnings.push(say('share.ask.replace', { firm: p.copy.firm, sharer: p.copy.sharer, via: p.copy.service ? say('share.ask.via', { host: new URL(p.copy.service).host }) : '' }));
  return { what, warnings, replaces };
}
