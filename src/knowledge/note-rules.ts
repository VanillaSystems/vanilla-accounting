/**
 * Rules kept from a sentence of the notes (docs/0.4.0/knowledge.md "When the AI offers one", "The
 * sentence is marked"). Browser-safe and pure.
 *
 * Such a rule quotes the sentence it carries out (`note:`) and says so in its source
 * (`source: notes <date>`). Whether a sentence may become a rule is decided here, by checks in code,
 * never by a model's confidence: the rule is for one partner or payer, no rule switched on already
 * says it, the sentence leaves no choice open, and the open year's payments it holds for are booked
 * today as it would book them. A sentence that leaves a choice open is offered only as an ask rule;
 * one whose payments are booked otherwise stays a note.
 *
 * On the notes page the sentence of a rule switched on carries a mark; when the person changed it, the
 * rule's card asks whether to adjust the rule. The rule never changes by itself, and switching it off
 * or deleting it removes the mark, never the sentence.
 */
import type { RuleRow } from '../booking/rule-book.js';
import type { RuleBooking } from '../booking/rules.js';
import type { RulePreview } from '../booking/rule-preview.js';

/** `source:` of a rule kept from the notes. */
export const NOTES_SOURCE = /^notes \d{4}-\d{2}-\d{2}$/;

/** Words that leave the choice open, in the notes' languages: such a sentence is not a rule that books by itself. */
const OPEN_CHOICE = /\b(meistens|meist|manchmal|oft|häufig|teilweise|gelegentlich|ausnahmsweise|in der regel|je nach\b[^.,;]*|vielleicht|eventuell|normalerweise|souvent|parfois|la plupart|selon\b[^.,;]*|généralement|spesso|a volte|di solito|secondo\b[^.,;]*|mostly|usually|sometimes|often|depending on\b[^.,;]*)/giu;

/** The words of a sentence that leave a choice open: «meistens», «je nach Beleg». */
export function openChoice(sentence: string): string[] {
  return [...new Set([...sentence.matchAll(OPEN_CHOICE)].map((m) => m[0].trim()))];
}

/** Why a sentence is not offered as the rule drafted from it. */
export type NoteReason =
  /** The rule is not for one partner or payer: it would stand in the company's general rules. */
  | { code: 'notOnePartner' }
  /** The sentence leaves a choice open: only an ask rule may carry it out. */
  | { code: 'openChoice'; words: string[] }
  /** Payments it holds for are booked today otherwise than it would book them. */
  | { code: 'bookedOtherwise'; n: number }
  /** A rule switched on already says it: its id. */
  | { code: 'alreadySaid'; rule: string };

/**
 * What a sentence offers: the rule as drafted, only an ask rule, or nothing (it stays a note). A
 * rule the person adjusts to a changed sentence is offered even when payments are booked otherwise
 * today: it books differently from the next payment on, so keeping it asks for «Trotzdem behalten»
 * (`otherwise`: how many).
 */
export type NoteOffer = { offer: 'rule'; otherwise?: number } | { offer: 'ask' | 'note'; why: NoteReason[] };

const keyOf = (r: Pick<RuleRow, 'file' | 'step' | 'id'>) => `${r.file}#${r.step}#${r.id}`;

/** The partner or payer a rule is for, or undefined when it is for neither. */
function partnerOf(r: RuleRow): string | undefined {
  const w = r.rule?.when;
  return r.business ?? w?.counterparty ?? (w?.payer ? `payer:${w.payer}` : undefined);
}

/** Whether `other` already books what `row` would: the same partner, no narrower condition, the same outcome, or the same sentence. */
function says(other: RuleRow, row: RuleRow): boolean {
  if (other.kind !== 'rule' || !other.rule || other.off || keyOf(other) === keyOf(row) || partnerOf(other) !== partnerOf(row)) return false;
  if (other.rule.note && other.rule.note === row.rule!.note) return true;
  const mine = row.rule!.when as Record<string, unknown>;
  const wider = Object.entries(other.rule.when).every(([k, v]) => JSON.stringify(mine[k]) === JSON.stringify(v));
  return wider && JSON.stringify(other.rule.then) === JSON.stringify(row.rule!.then);
}

/**
 * The checks for a rule drafted from a sentence of the notes (one that carries `note:`); undefined
 * for any other rule. `rules`: every rule of the workspace with the draft applied. `adjusting`: the
 * rule exists already and the person adjusts it to its changed sentence.
 */
export function noteOffer(row: RuleRow, preview: RulePreview | undefined, rules: readonly RuleRow[], adjusting = false): NoteOffer | undefined {
  const rule = row.rule;
  if (row.kind !== 'rule' || !rule?.note) return undefined;
  const stays: NoteReason[] = [];
  if (!partnerOf(row)) stays.push({ code: 'notOnePartner' });
  const already = rules.find((o) => says(o, row));
  if (already) stays.push({ code: 'alreadySaid', rule: already.id });
  const otherwise = rule.then.kind === 'book' ? preview?.otherwise ?? 0 : 0;
  if (otherwise && !adjusting) stays.push({ code: 'bookedOtherwise', n: otherwise });
  const open = openChoice(rule.note);
  const why: NoteReason[] = [...stays, ...(open.length ? [{ code: 'openChoice' as const, words: open }] : [])];
  if (stays.length) return { offer: 'note', why };
  if (open.length && rule.then.kind === 'book') return { offer: 'ask', why };
  return otherwise ? { offer: 'rule', otherwise } : { offer: 'rule' };
}

/** What the lint says about a rule's `note:` (npm run check-processes): a quoted sentence, on a rule the app carries out, with `source: notes <date>`. */
export function noteRuleProblems(raw: { note?: unknown; then?: unknown; source?: unknown }): string[] {
  const out: string[] = [];
  const fromNotes = typeof raw.source === 'string' && /^notes\b/.test(raw.source);
  if (raw.note === undefined) return fromNotes ? ['source: notes needs the sentence it carries out in note: "…"'] : [];
  if (typeof raw.note !== 'string' || !raw.note.trim()) out.push('note: must be the sentence of the notes the rule carries out, quoted');
  if (!raw.then || typeof raw.then !== 'object' || Array.isArray(raw.then)) out.push('note: only a rule the app carries out (then: a map) carries a sentence of the notes');
  if (typeof raw.source !== 'string' || !NOTES_SOURCE.test(raw.source)) out.push('a rule with note: has source: notes <YYYY-MM-DD>');
  return out;
}

// ─── The sentences of the notes ──────────────────────────────────────────────

/** Pure. A text as compared: without bold marks and list dashes, its spaces collapsed. */
export const plain = (s: string): string => s.replace(/\*\*/g, '').replace(/^\s*[-*] /gm, '').replace(/\s+/g, ' ').trim();

/** Where one sentence ends and the next begins: after . ! ? and a space, before a capital, a digit or an opening quote. */
export const SENTENCE_END = /(?<=[.!?…])\s+(?=[«"„(]?[\p{Lu}\d])/u;

/** Pure. The sentences of the notes, each as plain text. */
export function sentencesOf(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split(/\n+/).map(plain).filter((l) => l && !/^#{1,6} /.test(l)).flatMap((l) => l.split(SENTENCE_END)).map((s) => s.trim()).filter(Boolean);
}

const wordsOf = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));

/** Pure. The sentence of the notes most like `quoted` (half its words or more shared), or undefined when none is. */
export function closestSentence(text: string, quoted: string): string | undefined {
  const want = wordsOf(quoted);
  let best: { s: string; score: number } | undefined;
  for (const s of sentencesOf(text)) {
    const have = wordsOf(s);
    const shared = [...want].filter((w) => have.has(w)).length;
    const score = shared / new Set([...want, ...have]).size;
    if (score >= 0.5 && (!best || score > best.score)) best = { s, score };
  }
  return best?.s;
}

/** A rule from the notes whose sentence the person changed: the sentence now most like it, if any. */
export interface ChangedNote { row: RuleRow; now?: string }

/**
 * Pure. Which rules of a page mark their sentence, and which find it changed. Only a rule switched on
 * marks: switching it off or deleting it removes the mark and leaves the sentence as it is.
 */
export function noteMarks(text: string, rows: readonly RuleRow[]): { marked: RuleRow[]; changed: ChangedNote[] } {
  const prose = plain(text);
  const marked: RuleRow[] = [];
  const changed: ChangedNote[] = [];
  for (const row of rows) {
    const note = row.kind === 'rule' && !row.off ? row.rule?.note : undefined;
    if (!note) continue;
    if (prose.includes(plain(note))) marked.push(row);
    else { const now = closestSentence(text, note); changed.push({ row, ...(now ? { now } : {}) }); }
  }
  return { marked, changed };
}

/** Pure. Whether the mark of `note` belongs after `sentence`: the sentence holds the whole quote, or ends it. */
export const marksAfter = (sentence: string, note: string): boolean => {
  const s = plain(sentence);
  const n = plain(note);
  return !!s && (s.includes(n) || n.endsWith(s));
};

// ─── A first guess at the booking a sentence names ───────────────────────────

/**
 * Pure. What a sentence names that a rule can carry out, as a start for the form: an account of the
 * chart («auf 6513»), a rate («8.1 %», turned into a code by `codeFor`) and a private share («zur
 * Hälfte privat», «30 % privat»). The person or the AI decides; the checks above decide whether it
 * is offered.
 */
export function guessBooking(sentence: string, accounts: Readonly<Record<string, string>>, codeFor: (rate: number, account: string) => string | null): Partial<RuleBooking> {
  const account = [...sentence.matchAll(/\b(\d{4})\b/g)].map((m) => m[1]).find((n) => accounts[n] !== undefined);
  const share = /(\d{1,2})\s*%\s*privat|privat\w*\s*(?:zu\s*|à\s*|al\s*)?(\d{1,2})\s*%/i.exec(sentence);
  const half = /hälfte|moitié|metà|half/i.test(sentence) && /privat|privé|privato|private/i.test(sentence);
  const priv = share ? Number(share[1] ?? share[2]) : half ? 50 : undefined;
  const rateText = [...sentence.matchAll(/(\d{1,2}[.,]\d{1,2}|\d{1,2})\s*%/g)].map((m) => ({ at: m.index ?? 0, rate: Number(m[1].replace(',', '.')) }))
    .find((r) => !share || r.at < share.index || r.at >= share.index + share[0].length);
  const vat = account && rateText ? codeFor(rateText.rate, account) : null;
  return { ...(account ? { account } : {}), ...(vat ? { vat } : {}), ...(priv ? { private: priv } : {}) };
}
