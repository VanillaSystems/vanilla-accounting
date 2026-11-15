/**
 * The invitation's sentences in the sharer's language (src/share/invitation.ts renders them): taken
 * from the app's dictionaries, `invite.*`, so a German, French, Italian or English sharer sends the
 * recipient the steps in her own language.
 */
import type { InvitationTexts } from '../share/invitation.js';
import { languageOf, textsIn } from '../app/i18n/texts-in.js';
import type { Key } from '../app/i18n/types.js';

const INVITE_KEYS = ['subject', 'subjectReturn', 'intro', 'introNoCompany', 'messageFrom', 'stepsTitle', 'step1', 'step2', 'step3', 'step4', 'button', 'until', 'lock', 'fallback', 'footer'] as const satisfies ReadonlyArray<keyof InvitationTexts>;
const LOCALES: Record<string, string> = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH', en: 'en-GB' };

/** The invitation's sentences in `language` (the sharer's), their placeholders left for renderInvitation. */
export function invitationTexts(language: string | undefined): { texts: InvitationTexts; locale: string } {
  const lang = languageOf(language);
  const say = textsIn(lang);
  const keep = { sender: '{sender}', company: '{company}', date: '{date}', hours: '{hours}', download: '{download}' };
  const texts = Object.fromEntries(INVITE_KEYS.map((k) => [k, say(`invite.${k}` as Key, keep)])) as unknown as InvitationTexts;
  return { texts, locale: LOCALES[lang] ?? 'de-CH' };
}
