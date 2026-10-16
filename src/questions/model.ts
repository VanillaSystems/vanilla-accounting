/**
 * Questions between the people who keep the books (docs/0.4.0/views.md, "Questions"): one person
 * asks about a payment, a receipt or a booking, another answers on the same item. They travel with
 * the books: transactional-data/<year>/questions.jsonl (LAYOUT), append-only, one event per line,
 * so two people who share the folder at different times (git, a shared folder) never rewrite each
 * other's lines. A question is the fold of its events. Browser-safe: the UI folds the same lines.
 */
import type { BookChange } from '../types/assistant.js';

/** The version of a line's shape; a reader skips a line of a version it does not know. */
export const QUESTION_LINE_VERSION = 1;

/** What a question is about; `payment` is a transaction ref, as the AI sidebar's context names it. */
export interface QuestionTarget { kind: 'payment' | 'receipt' | 'entry'; id: string }
export const TARGET_KINDS: ReadonlyArray<QuestionTarget['kind']> = ['payment', 'receipt', 'entry'];

/** «privat oder geschäftlich?»: a person's question about a payment, kept as a precedent of its counterparty. */
export const PRIVATE_CHOICES = ['private', 'business'] as const;
export type PrivateChoice = (typeof PRIVATE_CHOICES)[number];

/** The owner's three answers: a domestic sale at the normal rate, an export, or no sale at all (a loan, a refund). */
export const SALE_CHOICES = ['saleDomestic', 'saleAbroad', 'notSale'] as const;
export type SaleChoice = (typeof SALE_CHOICES)[number];

/** Why the app proposes what it does: the money's currency, or the payer's IBAN country. */
export type SaleWhy = 'domesticIban' | 'domesticCurrency' | 'foreignCurrency' | 'foreignIban';
export interface SaleProposal { choice: SaleChoice; why: SaleWhy }

/** The answers the app can act on; any other answer is a short text the asker reads. */
export const CHOICES = [...PRIVATE_CHOICES, ...SALE_CHOICES] as const;
export type Choice = PrivateChoice | SaleChoice;

/**
 * The choices a question can offer: those of one kind the app acts on («privat oder geschäftlich?»,
 * or a customer payment's VAT), each once; none for an answer in words. Undefined for any other
 * mix, which no question card shows.
 */
export function questionChoices(raw: readonly unknown[]): Choice[] | undefined {
  const set = [...new Set(raw)];
  const within = (kind: readonly string[]) => set.every((c) => typeof c === 'string' && kind.includes(c));
  return within(PRIVATE_CHOICES) || within(SALE_CHOICES) ? set as Choice[] : undefined;
}

/** What a question the app asks by itself is about: `saleVat`, a customer payment without an invoice (src/intake/sale-questions.ts). */
export type QuestionTopic = 'saleVat';

export type Answer = { choice: Choice } | { text: string };

/** Who put the question: a person, the AI sidebar, or the booking when it needs the person's knowledge. */
export type QuestionOrigin = 'person' | 'assistant' | 'booking';

/** Why the app did not act on an answer: then the asker decides. */
export const NOT_ACTED = ['closed', 'noPayment', 'severalPayments', 'paidPrivately', 'notBankExpense', 'hasReceipt', 'hasInvoice', 'noSaleEntry', 'refused'] as const;
export type NotActed = (typeof NOT_ACTED)[number];

/** Why the app's question about a sale needs no answer any more: its payment is gone, filed, or a document decides it now. */
export const SALE_GONE = ['noPayment', 'closed', 'hasReceipt', 'hasInvoice'] as const;
export type SaleGone = (typeof SALE_GONE)[number];

/**
 * What the app did with an answer: the bookings it wrote or changed, with the changes that take
 * them back, and the precedent or the rule it kept; or why it did nothing (a filed quarter, a
 * payment it cannot read; `detail`: the refusal's own words). A sale's answer says the VAT code it
 * booked (`vatCode`, empty: none) and, «kein Umsatz», that it marked the payment as needing no receipt;
 * `correction`: the answer is a person's correction of the booking, which booked it already.
 */
export type Acted =
  | { booked: string[]; undo: BookChange[]; precedent?: string; rule?: string; vatCode?: string; marked?: true; correction?: true }
  | { precedent: string }
  | { refused: NotActed; detail?: string };

interface LineBase { v: typeof QUESTION_LINE_VERSION; id: string; at: string; by: string }

export type QuestionLine =
  /** `topic` and `proposal`: a question the app asks by itself, and the choice it would make. */
  | LineBase & { event: 'asked'; on: QuestionTarget; text: string; choices: Choice[]; to?: string; origin: QuestionOrigin; topic?: QuestionTopic; proposal?: SaleProposal }
  /** `from`: the precedent that answered it, without anyone asked. */
  | LineBase & { event: 'answered'; answer: Answer; acted?: Acted; from?: string }
  /** The answer's bookings taken back: the question is open again. */
  | LineBase & { event: 'undone' }
  /** `why`: the app closed its own question because its reason went away. */
  | LineBase & { event: 'closed'; how: 'done' | 'withdrawn'; why?: SaleGone };

export type QuestionStatus = 'open' | 'answered' | 'closed';

export interface Question {
  id: string;
  on: QuestionTarget;
  text: string;
  choices: Choice[];
  by: string;
  to?: string;
  origin: QuestionOrigin;
  topic?: QuestionTopic;
  proposal?: SaleProposal;
  askedAt: string;
  status: QuestionStatus;
  answer?: { by: string; at: string; answer: Answer; acted?: Acted; from?: string };
  closed?: { by: string; at: string; how: 'done' | 'withdrawn'; why?: SaleGone };
}

/** GET /api/questions: every question, the names to pick from, the owner's account («2451 Kontokorrent …»), which «privat» books on. */
export interface QuestionsView { questions: Question[]; people: string[]; owner: string }

/** The questions the lines tell, oldest first. A line about an unknown question is skipped. */
export function fold(lines: readonly QuestionLine[]): Question[] {
  const byId = new Map<string, Question>();
  for (const l of [...lines].sort((a, b) => a.at.localeCompare(b.at))) {
    if (l.event === 'asked') {
      if (!byId.has(l.id)) byId.set(l.id, { id: l.id, on: l.on, text: l.text, choices: l.choices, by: l.by, ...(l.to ? { to: l.to } : {}), origin: l.origin, ...(l.topic ? { topic: l.topic } : {}), ...(l.proposal ? { proposal: l.proposal } : {}), askedAt: l.at, status: 'open' });
      continue;
    }
    const q = byId.get(l.id);
    if (!q || q.status === 'closed') continue;
    switch (l.event) {
      case 'answered': q.status = 'answered'; q.answer = { by: l.by, at: l.at, answer: l.answer, ...(l.acted ? { acted: l.acted } : {}), ...(l.from ? { from: l.from } : {}) }; break;
      case 'undone': q.status = 'open'; delete q.answer; break;
      case 'closed': q.status = 'closed'; q.closed = { by: l.by, at: l.at, how: l.how, ...(l.why ? { why: l.why } : {}) }; break;
    }
  }
  return [...byId.values()];
}

const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Open questions `me` is to answer: those put to them, or, put to nobody, asked by someone else. */
export const forMe = (qs: readonly Question[], me: string): Question[] =>
  qs.filter((q) => q.status === 'open' && (q.to ? same(q.to, me) : !same(q.by, me)));

/** The questions `me` asked that are not closed: open ones, and answered ones until they mark them done. */
export const askedByMe = (qs: readonly Question[], me: string): Question[] =>
  qs.filter((q) => q.status !== 'closed' && same(q.by, me));

export const onTarget = (qs: readonly Question[], on: QuestionTarget): Question[] =>
  qs.filter((q) => q.on.kind === on.kind && q.on.id === on.id && q.status !== 'closed');

/** The names the asker and the addressee are picked from: the owner first, then everyone who asked or answered. */
export function peopleOf(owner: string, qs: readonly Question[]): string[] {
  const out: string[] = [];
  for (const n of [owner, ...qs.flatMap((q) => [q.origin === 'booking' ? undefined : q.by, q.to, q.answer?.by])]) {
    if (n && !out.some((x) => same(x, n))) out.push(n.trim());
  }
  return out;
}

/** Parses one stored line; undefined for a line of another version or shape, which the reader skips. */
export function parseLine(raw: unknown): QuestionLine | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const l = raw as Record<string, unknown>;
  if (l.v !== QUESTION_LINE_VERSION || typeof l.id !== 'string' || typeof l.at !== 'string' || typeof l.by !== 'string') return undefined;
  switch (l.event) {
    case 'asked': {
      const on = l.on as QuestionTarget | undefined;
      if (!on || !TARGET_KINDS.includes(on.kind) || typeof on.id !== 'string' || typeof l.text !== 'string') return undefined;
      const choices = Array.isArray(l.choices) ? l.choices.filter((c): c is Choice => CHOICES.includes(c as Choice)) : [];
      const origin = (['person', 'assistant', 'booking'] as const).find((o) => o === l.origin) ?? 'person';
      const p = l.proposal as Partial<SaleProposal> | undefined;
      const proposal = p && (SALE_CHOICES as readonly string[]).includes(p.choice as string) && typeof p.why === 'string' ? { choice: p.choice as SaleChoice, why: p.why as SaleProposal['why'] } : undefined;
      return {
        v: 1, event: 'asked', id: l.id, at: l.at, by: l.by, on: { kind: on.kind, id: on.id }, text: l.text, choices, ...(typeof l.to === 'string' && l.to ? { to: l.to } : {}), origin,
        ...(l.topic === 'saleVat' ? { topic: 'saleVat' as const } : {}), ...(proposal ? { proposal } : {}),
      };
    }
    case 'answered': {
      const a = l.answer as Record<string, unknown> | undefined;
      const answer: Answer | undefined = a && CHOICES.includes(a.choice as Choice) ? { choice: a.choice as Choice } : a && typeof a.text === 'string' ? { text: a.text } : undefined;
      if (!answer) return undefined;
      return { v: 1, event: 'answered', id: l.id, at: l.at, by: l.by, answer, ...(l.acted ? { acted: l.acted as Acted } : {}), ...(typeof l.from === 'string' ? { from: l.from } : {}) };
    }
    case 'undone': return { v: 1, event: 'undone', id: l.id, at: l.at, by: l.by };
    case 'closed': {
      const why = SALE_GONE.find((w) => w === l.why);
      return l.how === 'done' || l.how === 'withdrawn' ? { v: 1, event: 'closed', id: l.id, at: l.at, by: l.by, how: l.how, ...(why ? { why } : {}) } : undefined;
    }
    default: return undefined;
  }
}
