/**
 * The dictionaries outside the page: the desktop's native menu (src/desktop/menu.ts) and the words
 * a Terminal script prints (src/server/ai-setup.ts) speak the person's language too.
 */
import { formatIn } from './core.js';
import type { Key, Locale } from './types.js';
import de from './locales/de.js';
import en from './locales/en.js';
import fr from './locales/fr.js';
import it from './locales/it.js';

const LOCALES: Record<string, Locale> = { de, en, fr, it };

/** The language of `code` (de-CH, fr, …), German when the app has none for it. */
export const languageOf = (code: string | undefined): string => {
  const base = code?.toLowerCase().split(/[-_]/)[0] ?? '';
  return base in LOCALES ? base : 'de';
};

export const textsIn = (language: string) => (key: Key, values: Record<string, string> = {}): string =>
  formatIn({ code: language, messages: LOCALES[language].messages }, key, values);
