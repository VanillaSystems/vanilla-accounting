/**
 * The opening date is the app's fact, not the AI's (r6-5, #496): the books follow the calendar year
 * and open on 1 January from the balance sheet of 31 December. A setup reply whose sentence about the
 * opening names another day («die Zwischenbilanz vom 30.6.2026 ist die richtige», «die
 * Eröffnungssalden per 1. Juli») is not shown as the model said it: code puts the app's sentence in
 * its place (`openingFact`). Pure.
 */
import type { Words } from '../export/tables.js';
import { handKeys } from './hand.js';

type T = Words['t'];

/** Words that make a sentence one about the opening, in the app's four languages. */
const OPENING = /er[öo]ffnung|anfangss?ald|anfangsbestand|endsald|opening|ouverture|apertura|saldi iniziali|soldes? initia/i;
/** An interim balance sheet: never the opening's source, whatever day it names. */
const INTERIM = /zwischenbilanz|zw[üu]schebilanz|interim balance|bilan interm[ée]diaire|bilancio intermedio|situazione intermedia/i;

const MONTHS: ReadonlyArray<readonly string[]> = [
  ['januar', 'jänner', 'january', 'janvier', 'gennaio'],
  ['februar', 'feber', 'february', 'février', 'fevrier', 'febbraio'],
  ['märz', 'maerz', 'march', 'mars', 'marzo'],
  ['april', 'avril', 'aprile'],
  ['mai', 'may', 'maggio'],
  ['juni', 'june', 'juin', 'giugno'],
  ['juli', 'july', 'juillet', 'luglio'],
  ['august', 'août', 'aout', 'agosto'],
  ['september', 'septembre', 'settembre'],
  ['oktober', 'october', 'octobre', 'ottobre'],
  ['november', 'novembre'],
  ['dezember', 'december', 'décembre', 'decembre', 'dicembre'],
];
const MONTH = MONTHS.flat().sort((a, b) => b.length - a.length).join('|');
const monthOf = (name: string) => MONTHS.findIndex((m) => m.includes(name.toLowerCase())) + 1;

/** The days (day, month) a sentence names: 30.6.2026, 30.06., 2026-06-30, 30. Juni, 1er juillet, 1 July, July 1. */
function daysIn(sentence: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of sentence.matchAll(/(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.(?:\d{2,4})?(?![\d])/g)) out.push([Number(m[1]), Number(m[2])]);
  for (const m of sentence.matchAll(/\b\d{4}-(\d{2})-(\d{2})\b/g)) out.push([Number(m[2]), Number(m[1])]);
  for (const m of sentence.matchAll(new RegExp(`(?<![\\d.])(\\d{1,2})(?:\\.|er|°|st|nd|rd|th)?\\s+(${MONTH})(?![a-zà-ÿ])`, 'gi'))) out.push([Number(m[1]), monthOf(m[2])]);
  for (const m of sentence.matchAll(new RegExp(`(?<![a-zà-ÿ])(${MONTH})\\s+(\\d{1,2})(?!\\d)`, 'gi'))) out.push([Number(m[2]), monthOf(m[1])]);
  return out.filter(([d, mo]) => d >= 1 && d <= 31 && mo >= 1 && mo <= 12);
}

/** The opening's own days: 1 January, and 31 December of the year before. */
const allowed = ([d, m]: [number, number]) => (d === 1 && m === 1) || (d === 31 && m === 12);

/** The sentences of a reply: a full stop after a digit (30. Juni, 30.6.) ends none. */
const sentencesOf = (text: string) => text.split(/(?<=[^\d\s][.!?])\s+|\n+/).filter((s) => s.trim());

/**
 * The sentences of `text` that state an opening the app does not have: one about the opening (or an
 * interim balance sheet) that names a day other than 1 January or 31 December, or takes an interim
 * balance sheet as its source. Empty: the reply keeps to the app's facts.
 */
export function strayOpening(text: string): string[] {
  return sentencesOf(text).filter((s) => (OPENING.test(s) || INTERIM.test(s)) && (INTERIM.test(s) || daysIn(s).some((d) => !allowed(d))));
}

/** The app's sentence of the opening, in the person's language: per 1 January of `year`, from the balance sheet of 31 December before. */
export function openingFact(t: T, year: string): string {
  const say = t as unknown as (key: string, vars?: Record<string, string>) => string;
  const place = handKeys('opening').map((k) => say(k)).join(' › ');
  return say('onboarding.openingFact', { date: `01.01.${year}`, prev: `31.12.${Number(year) - 1}`, place });
}

/** The reply as shown: the model's words, or the app's sentence of the opening in their place when they state another (`withdrawn`: what the model said). */
export function keptToOpening(text: string, t: T, year: string): { text: string; withdrawn?: string } {
  return strayOpening(text).length ? { text: openingFact(t, year), withdrawn: text } : { text };
}
