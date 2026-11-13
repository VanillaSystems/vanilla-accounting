/**
 * The opening date is the app's fact, not the AI's (r6-5, #496): the opening balances hold per
 * 1 January, from the balance sheet of 31 December. A sentence of a setup reply that ties the opening
 * to another day («Eröffnungssalden per 1. Juli», «aus der Bilanz per Ende Juni»), takes an interim
 * balance sheet as its source («die Zwischenbilanz vom 30.6.2026 ist die richtige») or calls the
 * year-end balance sheet not needed is not shown as the model said it: code puts the app's sentence
 * in its place (`openingFact`) and leaves the reply's other sentences as they are. Pure.
 */
import type { Words } from '../export/tables.js';
import { handKeys } from './hand.js';

type T = Words['t'];

/** Words that make a clause one about the opening balances, in the app's four languages. */
const OPENING = /er[öo]ffnung|anfangss?ald|anfangsbestand|endsald|opening|ouverture|apertura|saldi iniziali|soldes? initia/i;
/** An account opened at a bank is no opening of the books: «Kontoeröffnung», «ouverture du compte», «account opening». */
const ACCOUNT_OPENED = /kontoer[öo]ffnung|er[öo]ffnung (des|deines|eures|ihres|eines) (bank)?kontos|ouverture (du|d['’]un) compte|apertura (del|di un) conto|account (opening|was opened)|opening (of )?(the|an|a|your) (bank )?account/i;
/** An interim balance sheet: never the opening's source, whatever day it names. */
const INTERIM = /zwischenbilanz|zw[üu]schebilanz|interim balance|bilan interm[ée]diaire|bilancio intermedio|situazione intermedia/i;
/** A negation before the interim balance sheet in its clause: «nimm nicht die Zwischenbilanz» keeps to the facts. */
const NEGATION = /\b(nicht|kein\w*|nie|niemals|never|not|no|pas|jamais|non|mai|nessun\w*)\b/i;
/** The year-end balance sheet called not needed («die Bilanz vom 31.12.2025 brauchst du nicht»). */
const BALANCE_SHEET = /bilanz|balance sheet|bilan|bilancio/i;
const NOT_NEEDED = /brauchs?t\w*\b.*\bnicht|nicht (n[öo]tig|notwendig|gebraucht)|(don['’]t|do not|doesn['’]t|does not) need|not needed|pas besoin|n['’]est pas n[ée]cessaire|non (ti )?serve|non [èe] necessari/i;

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

/** The words that tie a day to what the clause speaks of: «per 1. Juli», «vom 30.6.», «au 1er juillet», «as at 30 June»; not «bis zum», «ab dem», «am». */
const TIE = String.raw`(?<![a-zà-ÿ])(?<!\bbis\s)(?<!until\s)(?:per|vom|von|zum|au|du|as at|as of|al|del|dal)\s+(?:dem\s+|le\s+|the\s+|il\s+|l['’])?`;

/** The days (day, month) a clause ties to it; «Ende Juni» is the month's last day, «Mitte Jahr» the middle (0, 0). */
function tiedDays(clause: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const at = (pattern: string) => clause.matchAll(new RegExp(TIE + pattern, 'gi'));
  for (const m of at(String.raw`(\d{1,2})\.\s?(\d{1,2})\.(?:\d{2,4})?(?!\d)`)) out.push([Number(m[1]), Number(m[2])]);
  for (const m of at(String.raw`\d{4}-(\d{2})-(\d{2})\b`)) out.push([Number(m[2]), Number(m[1])]);
  for (const m of at(String.raw`(\d{1,2})(?:\.|er|°|st|nd|rd|th)?\s+(${MONTH})(?![a-zà-ÿ])`)) out.push([Number(m[1]), monthOf(m[2])]);
  for (const m of at(String.raw`(${MONTH})\s+(\d{1,2})(?!\d)`)) out.push([Number(m[2]), monthOf(m[1])]);
  for (const m of at(String.raw`(?:ende|end of|fin|fine)\s+(?:de\s+|d['’]|di\s+)?(${MONTH})(?![a-zà-ÿ])`)) { const mo = monthOf(m[1]); out.push([mo === 12 ? 31 : 28, mo]); }
  if (new RegExp(TIE + String.raw`(?:mitte (?:des )?jahr|mid-?year|the middle of the year|mi-ann[ée]e|met[àa] (?:dell['’])?anno)`, 'i').test(clause)) out.push([0, 0]);
  return out.filter(([d, mo]) => (d === 0 && mo === 0) || (d >= 1 && d <= 31 && mo >= 1 && mo <= 12));
}

/** The opening's own days: 1 January, and 31 December of the year before. */
const allowed = ([d, m]: [number, number]) => (d === 1 && m === 1) || (d === 31 && m === 12);

/** The sentences of a reply: a full stop after a digit (30. Juni, 30.6.) ends none. */
const sentencesOf = (text: string) => text.split(/(?<=[^\d\s][.!?])\s+|\n+/).filter((s) => s.trim());
/** A sentence's clauses: what a comma, a semicolon, a colon or a dash sets apart. */
const clausesOf = (sentence: string) => sentence.split(/[,;:]\s|\s[–—-]\s/);

/** Whether a clause speaks of the books' opening, not of a bank account opened. */
const aboutOpening = (clause: string) => OPENING.test(clause.replace(new RegExp(ACCOUNT_OPENED.source, 'gi'), ''));

function stray(sentence: string): boolean {
  const clauses = clausesOf(sentence);
  if (clauses.some((c) => aboutOpening(c) && tiedDays(c).some((d) => !allowed(d)))) return true;
  if (clauses.some((c) => { const i = c.search(INTERIM); return i >= 0 && !NEGATION.test(c.slice(0, i)); })) return true;
  return BALANCE_SHEET.test(sentence) && NOT_NEEDED.test(sentence);
}

/**
 * The sentences of `text` that state an opening the app does not have. Empty: the reply keeps to the
 * app's facts.
 */
export function strayOpening(text: string): string[] {
  return sentencesOf(text).filter(stray);
}

/** The app's sentence of the opening, in the person's language: per 1 January of `year`, from the balance sheet of 31 December before. */
export function openingFact(t: T, year: string): string {
  const say = t as unknown as (key: string, vars?: Record<string, string>) => string;
  const place = handKeys('opening').map((k) => say(k)).join(' › ');
  return say('onboarding.openingFact', { date: `01.01.${year}`, prev: `31.12.${Number(year) - 1}`, place });
}

/**
 * The reply as shown: the model's words, or, when sentences of them state another opening, those
 * sentences taken out and the app's sentence in place of the first (`withdrawn`: what the model said).
 */
export function keptToOpening(text: string, t: T, year: string): { text: string; withdrawn?: string } {
  const wrong = strayOpening(text);
  if (!wrong.length) return { text };
  let out = text;
  wrong.forEach((s, i) => { out = out.replace(s, i ? '' : openingFact(t, year)); });
  out = out.split('\n').map((line) => line.replace(/[ \t]{2,}/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, withdrawn: text };
}
