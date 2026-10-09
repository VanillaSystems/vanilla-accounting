import type { messages } from './locales/de.js';

/** A text that depends on a count `{n}`: Intl.PluralRules picks the form. */
export interface Plural { one: string; other: string }

type German = typeof messages;
/** Every UI text has a key; German (locales/de.ts) is the source every other language must match. */
export type Key = keyof German;
export type Messages = { [K in Key]: German[K] extends string ? string : Plural };

export interface Locale {
  /** The language's own name, shown in the picker's tooltip. */
  name: string;
  /** Position in the picker: de, fr, it, rm, en. */
  order: number;
  messages: Messages;
}

type Holes<S> = S extends `${string}{${infer V}}${infer R}` ? V | Holes<R> : never;
type Texts<T> = T extends string ? T : T extends Plural ? T['one'] | T['other'] : never;
/** The `{placeholders}` of a key's German text, plus `n` for a plural. */
export type VarsOf<K extends Key> = Holes<Texts<German[K]>> | (German[K] extends string ? never : 'n');
export type Vars<K extends Key> = Record<VarsOf<K>, string | number>;
