/**
 * The export's words in the user's language, from the UI's own dictionaries (src/app/i18n), so
 * the dialog and the files it writes name every part alike. A new UI language is added here too.
 */
import de from '../app/i18n/locales/de.js';
import en from '../app/i18n/locales/en.js';
import fr from '../app/i18n/locales/fr.js';
import it from '../app/i18n/locales/it.js';
import { accountingNameIn, formatIn, type Language } from '../app/i18n/core.js';
import type { Words } from './tables.js';

const LANGUAGES: Record<string, Language> = {
  de: { code: 'de', messages: de.messages },
  fr: { code: 'fr', messages: fr.messages },
  it: { code: 'it', messages: it.messages },
  en: { code: 'en', messages: en.messages },
};

export function wordsIn(code: string): Words & { code: string } {
  const lang = LANGUAGES[code] ?? LANGUAGES.de;
  return { code: lang.code, t: (key, vars = {}) => formatIn(lang, key, vars), accountingName: (g) => accountingNameIn(lang, g) };
}
