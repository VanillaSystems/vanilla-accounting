/// <reference types="vite/client" />
/**
 * The UI's texts in de, fr, it and en. One file per language in ./locales, found by the glob
 * below, so a new language is one new file (docs/i18n.md). Formats stay Swiss in every
 * language (lib/utils.ts): CHF, 1'234.56, dd.mm.yyyy.
 */
import type { Key, Locale, Vars, VarsOf } from './types.js';
import { accountingNameIn, formatIn } from './core.js';

const modules = import.meta.glob<{ default: Locale }>('./locales/*.ts', { eager: true });

export const LOCALES: ReadonlyArray<{ code: string } & Locale> = Object.entries(modules)
  .map(([path, m]) => ({ code: path.match(/([a-z]+)\.ts$/)![1], ...m.default }))
  .sort((a, b) => a.order - b.order);

export const DEFAULT_LANGUAGE = 'de';
const byCode = new Map(LOCALES.map((l) => [l.code, l]));
let current = byCode.get(DEFAULT_LANGUAGE)!;

/** A language code with a dictionary, from a stored or configured value. */
export function supportedLanguage(code: string | null | undefined): string | undefined {
  const base = code?.toLowerCase().split(/[-_]/)[0];
  return base && byCode.has(base) ? base : undefined;
}

export function setLanguage(code: string): void {
  current = byCode.get(supportedLanguage(code) ?? DEFAULT_LANGUAGE)!;
  document.documentElement.lang = current.code;
}

export const language = (): string => current.code;

/** For month and weekday names only: numbers and dates keep the Swiss German format (lib/utils.ts). */
export const monthLocale = (): string => `${current.code}-CH`;

export function isKey(key: string): key is Key {
  return key in current.messages;
}

/** The text of `key` in the current language, `{placeholders}` filled from `vars`. */
export function t<K extends Key>(key: K, ...[vars]: [VarsOf<K>] extends [never] ? [] : [Vars<K>]): string {
  return formatIn(current, key, (vars ?? {}) as Record<string, string | number>);
}

/**
 * The UI name of a statement section or row that src/accounting names in German (the CLI's
 * language): the balance sheet's and income statement's groups. Unknown names stay as they are.
 */
export const accountingName = (german: string): string => accountingNameIn(current, german);
