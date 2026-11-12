/**
 * The setup conversation as code draws it (docs/0.4.0/onboarding.md, the prototype
 * docs/0.4.0/mockups/onboarding-chat/): from the person's answers and what the app knows, the steps
 * so far, each with the specialist's words, a card and the answers to click, and the reply to the
 * answer given. The steps stop at the first question not answered yet, so the conversation shows
 * where it stands after any restart, without an AI call. Whatever the person types instead goes to
 * the AI, which may answer a question for them (a `setupAnswer` change) or mark a topic.
 *
 * Words are i18n keys under `onboarding.` with their parameters; the UI says them with t(). Pure.
 */
import { SETUP_TOPICS, kindsOfAnswer, type Answer, type AnswerValue, type QuestionId, type SetupProgress, type SetupTopic, type TopicState } from './model.js';
import type { ClearPartner, MixedPartner, SetupFacts } from './facts.js';
import { TOPIC_HAND, type HandPlace } from './hand.js';
import { NOT_REGISTERED, methodOf, onAgreedBasis, type VatBasis, type VatSetup } from '../workspace/vat-setup.js';
import { SALES_KINDS, type SalesKind } from '../workspace/setup.js';

/** A parameter of a line: a value, another key said in the person's language, a date to format, or keys said and joined by commas. */
export type Param = string | number | { key: string } | { date: string } | { list: string[] };
export interface Line { key: string; params?: Record<string, Param> }
export interface Choice { value: string; label: Line; sub?: Line; primary?: boolean }

/** Where a badge says a fact comes from. */
export type Origin = 'form' | 'answer' | 'app';

export type SetupCard =
  /**
   * What the app knows of the firm, shown once (#345): the form or the conversation that created the books
   * asked it a minute ago, so nothing of it is asked again. `origin`: which of the two. `sells`: the kinds
   * the profile keeps. `change`: «Etwas ändern» is still offered (not once the person took it).
   */
  | { kind: 'company'; company: SetupFacts['company']; sells?: SalesKind[]; origin: Extract<Origin, 'form' | 'answer'>; change: boolean }
  /** The VAT setup the answer asks for, against the one the app has: `proposed` waits for «Übernehmen», `kept` was taken. */
  | { kind: 'vat'; from: VatSetup; to: VatKind; state: 'proposed' | 'kept' }
  /** What the firm sells as answered, with the default accounts that follow; `proposed` until the profile says the same («Übernehmen»). */
  | { kind: 'sells'; kinds: SalesKind[]; purchase: Array<{ kind: SalesKind; account: string }>; sales: Array<{ kind: SalesKind; account: string }>; state: 'proposed' | 'kept' }
  | { kind: 'opening'; year: string; rows: SetupFacts['opening'] }
  | { kind: 'banks'; banks: SetupFacts['banks'] }
  | { kind: 'sources'; sources: SetupFacts['sources'] }
  | { kind: 'partners'; clear: ClearPartner[]; mixed: MixedPartner[]; rare: Array<{ name: string; n: number }>; rareMore: number }
  /** `first`: the person's first step in the app, the statement, and from which period on. */
  | { kind: 'summary'; items: Array<{ what: Line; origin: Origin }>; open: Array<{ topic: SetupTopic; state: TopicState; go: HandPlace | null }>; first: Line };

export type StepId = QuestionId | 'summary';

export interface SetupStep {
  id: StepId;
  topic: SetupTopic | null;
  say: Line[];
  card?: SetupCard;
  choices: Choice[];
  answer?: Answer;
  /** What follows the answer: the specialist's words, a card, a place by hand. */
  reply?: { lines: Line[]; card?: SetupCard; go?: HandPlace };
  /** Where this step is done by hand, offered on the card. */
  go?: HandPlace;
  /** The choices are toggles, any combination, sent at once (`sells`): the answer joins them (sellsAnswer). */
  multi?: true;
}

export type VatKind = 'none' | 'effective' | 'net-rate';
export const vatKind = (v: VatSetup): VatKind => methodOf(v) as VatKind;

/** The setup a click on a VAT answer asks for, on the basis the firm reports on now; a net tax rate needs the rate, which the card asks. */
export function vatSetupOf(kind: VatKind, rate?: { rate: number; label?: string }, reporting: VatBasis = 'received'): VatSetup | null {
  if (kind === 'none') return NOT_REGISTERED;
  if (kind === 'effective') return { registered: true, method: 'effective', reporting, period: 'quarterly' };
  return rate ? { registered: true, method: 'net-rate', reporting, period: 'half-yearly', rates: [{ rate: rate.rate, ...(rate.label ? { label: rate.label } : {}) }] } : null;
}

const L = (key: string, params?: Record<string, Param>): Line => ({ key: `onboarding.${key}`, ...(params ? { params } : {}) });
const choice = (q: QuestionId, value: string, opts: { params?: Record<string, Param>; sub?: boolean; primary?: boolean } = {}): Choice => ({
  value, label: L(`q.${q}.${value}`, opts.params), ...(opts.sub ? { sub: L(`q.${q}.${value}.sub`, opts.params) } : {}), ...(opts.primary ? { primary: true } : {}),
});

/** Whether the answer to `sells` is what the profile keeps: nothing left to take over. A workspace without a profile is not asked. */
function sellsSettled(p: SetupProgress, f: SetupFacts): boolean {
  if (!f.sells) return true;
  const a = p.answers.sells?.value;
  return !!a && kindsOfAnswer(a).join('+') === f.sells.kinds.join('+');
}

/** Whether the person asked to change what the app has of the firm: only then are the VAT and the sales question asked. */
const changing = (p: SetupProgress) => p.answers.company?.value === 'fix';
/** Whether a question of the firm is drawn: answered (by the person, or by the AI from typed words), or waiting after «Etwas ändern». */
const firmAsked = (p: SetupProgress, q: 'vat' | 'sells') => !!p.answers[q] || changing(p);

/** The card of an answer to `sells`: the kinds and the default accounts they give. */
function sellsCard(kinds: SalesKind[], f: Required<Pick<SetupFacts, 'sells'>>['sells'], kept: boolean): Extract<SetupCard, { kind: 'sells' }> {
  return {
    kind: 'sells', kinds, state: kept ? 'kept' : 'proposed',
    purchase: kinds.flatMap((kind) => (f.accounts[kind].purchase ? [{ kind, account: f.accounts[kind].purchase! }] : [])),
    sales: kinds.map((kind) => ({ kind, account: f.accounts[kind].sales })),
  };
}

/** Whether a VAT answer is settled: as the app has it now, or nothing to change. */
function vatSettled(p: SetupProgress, f: SetupFacts): boolean {
  const a = p.answers.vat?.value;
  return !!a && (a === 'unknown' || a === vatKind(f.company.vat));
}

/**
 * Each topic as the app sees it: done by what it observes (the firm as the settings have it, a bank
 * account with an IBAN, a source switched on, opening balances, partners seen or none to see),
 * skipped where the person left it for later; a topic marked by the AI or by hand keeps that mark
 * unless the app sees it done.
 */
export function topicStates(p: SetupProgress, f: SetupFacts): Record<SetupTopic, TopicState> {
  const a = p.answers;
  const partners = f.partners.clear.length + f.partners.mixed.length + f.partners.rare.length;
  const seen: Record<SetupTopic, TopicState> = {
    firm: (!firmAsked(p, 'vat') || vatSettled(p, f)) && (!f.sells || !firmAsked(p, 'sells') || sellsSettled(p, f)) ? 'done' : 'open',
    opening: f.opening.length ? 'done' : a.opening?.value === 'later' ? 'skipped' : 'open',
    bank: f.banks.some((b) => b.iban) ? 'done' : a.bank?.value === 'later' ? 'skipped' : 'open',
    receipts: f.sources.length ? 'done' : a.receipts?.value === 'later' ? 'skipped' : 'open',
    knowledge: a.partners || !partners ? 'done' : 'open',
  };
  return Object.fromEntries(SETUP_TOPICS.map((t) => {
    const marked = p.topics[t].state;
    return [t, seen[t] === 'done' ? 'done' : marked !== 'open' ? marked : seen[t]];
  })) as Record<SetupTopic, TopicState>;
}

/**
 * The steps so far: every answered one, then the first open one (or the summary when all are answered).
 * Asked is only what neither the settings nor the first bank statement tell the app (#345): the firm,
 * its VAT setup and what it sells are shown as the app has them; from when the books run, the first
 * statement says; a bank account with its IBAN and books without partners are not walked through.
 */
export function setupThread(p: SetupProgress, f: SetupFacts): SetupStep[] {
  const steps: SetupStep[] = [];
  const a = p.answers;
  const take = (s: Omit<SetupStep, 'answer'> & { id: QuestionId }): boolean => {
    const answer = a[s.id] as Answer | undefined;
    steps.push({ ...s, ...(answer ? { answer } : {}) });
    return !!answer;
  };

  // The firm as the app has it: shown, not asked. The person who sits there may not be the owner, so the greeting names no one.
  take({
    id: 'company', topic: 'firm',
    say: [L('s.hello'), L('s.company')],
    card: { kind: 'company', company: f.company, ...(f.sells ? { sells: f.sells.kinds } : {}), origin: p.created ? 'answer' : 'form', change: !a.company },
    choices: [],
    ...(changing(p) ? { reply: { lines: [L('r.companyFix')], go: { area: 'company', section: 'profile' } } } : {}),
  });

  const now = vatKind(f.company.vat);
  const vatAnswer = a.vat?.value;
  const vatReply = (): SetupStep['reply'] => {
    if (!vatAnswer) return undefined;
    const kept = a.vat?.kept;
    if (kept) return { lines: [L('r.vatChange')], card: { kind: 'vat', from: kept.before, to: vatAnswer as VatKind, state: 'kept' }, go: TOPIC_HAND.firm ?? undefined };
    if (vatAnswer === 'unknown') return { lines: [L('r.vatUnknown')] };
    if (vatAnswer === now) return { lines: [L(now === 'none' ? 'r.vatSameNone' : onAgreedBasis(f.company.vat) ? 'r.vatSameAgreed' : 'r.vatSame')] };
    return { lines: [L('r.vatChange')], card: { kind: 'vat', from: f.company.vat, to: vatAnswer, state: 'proposed' }, go: TOPIC_HAND.firm ?? undefined };
  };
  if (firmAsked(p, 'vat') && !take({
    id: 'vat', topic: 'firm',
    say: [L('s.vat')],
    choices: (['none', 'effective', 'net-rate', 'unknown'] as const).map((v) => choice('vat', v, { sub: true, primary: v === now })),
    reply: vatReply(),
  })) return steps;

  // Was verkauft ihr? (#46)
  if (f.sells && firmAsked(p, 'sells')) {
    const sold = a.sells ? kindsOfAnswer(a.sells.value) : undefined;
    if (!take({
      id: 'sells', topic: 'firm', multi: true,
      say: [L('s.sells')],
      choices: SALES_KINDS.map((k) => ({ ...choice('sells', k, { sub: true }), ...(f.sells!.kinds.includes(k) ? { primary: true } : {}) })),
      ...(sold ? { reply: { lines: [L('r.sells')], card: sellsCard(sold, f.sells, sellsSettled(p, f)) } } : {}),
    })) return steps;
  }

  // Eröffnung: «Später» says what it means, and where it comes back.
  const hasOpening = f.opening.length > 0;
  const prev = String(Number(f.year) - 1);
  if (!take({
    id: 'opening', topic: 'opening',
    say: [hasOpening ? L('s.openingSet', { date: { date: `${f.year}-01-01` } }) : L('s.openingNone', { date: { date: `${f.year}-01-01` }, prev: { date: `${prev}-12-31` } })],
    ...(hasOpening ? { card: { kind: 'opening', year: f.year, rows: f.opening } } : {}),
    choices: [choice('opening', 'next', { primary: hasOpening }), choice('opening', 'later', { primary: !hasOpening })],
    go: TOPIC_HAND.opening ?? undefined,
    ...(a.opening?.value === 'later' && !hasOpening ? { reply: { lines: [L('r.openingLater')], go: TOPIC_HAND.opening ?? undefined } } : {}),
  })) return steps;

  // Bank: asked only while no account has its IBAN; one that has is in the summary.
  const withIban = f.banks.some((b) => b.iban);
  if ((a.bank || !withIban) && !take({
    id: 'bank', topic: 'bank',
    say: [withIban ? L('s.bank') : L('s.bankNone')],
    card: { kind: 'banks', banks: f.banks },
    choices: [choice('bank', 'next', { primary: withIban }), choice('bank', 'later', { primary: !withIban })],
    go: TOPIC_HAND.bank ?? undefined,
  })) return steps;

  // Belege
  if (!take({
    id: 'receipts', topic: 'receipts',
    say: [f.sources.length ? L('s.receipts') : L('s.receiptsNone')],
    card: { kind: 'sources', sources: f.sources },
    choices: [choice('receipts', 'next', { primary: f.sources.length > 0 }), choice('receipts', 'later', { primary: !f.sources.length })],
    go: TOPIC_HAND.receipts ?? undefined,
  })) return steps;

  // Partner und Wissen: only books that hold bookings have partners to show.
  const bins = f.partners;
  const partners = bins.clear.length + bins.mixed.length + bins.rare.length;
  if ((a.partners || partners > 0) && !take({
    id: 'partners', topic: 'knowledge',
    say: partners ? [L('s.partners', { year: f.year, n: partners }), ...(bins.ruled ? [L('s.partnersRuled', { n: bins.ruled })] : [])] : [L('s.partnersEmpty')],
    ...(partners ? { card: { kind: 'partners', clear: bins.clear, mixed: bins.mixed, rare: bins.rare.slice(0, RARE_SHOWN).map((r) => ({ name: r.name, n: r.n })), rareMore: Math.max(0, bins.rare.length - RARE_SHOWN) } } : {}),
    choices: [choice('partners', 'next', { primary: true })],
    go: TOPIC_HAND.knowledge ?? undefined,
  })) return steps;

  steps.push({ id: 'summary', topic: null, say: [L('s.summary')], card: summaryOf(p, f), choices: [] });
  return steps;
}

const RARE_SHOWN = 8;

/** The VAT setup in words: not registered, effective with its period, the net tax rates with theirs. */
export function vatLine(v: VatSetup): Line {
  if (!v.registered) return L('sum.vatNone');
  const period: Param = { key: `onboarding.period.${v.period}` };
  if (v.method === 'effective') return L(v.reporting === 'agreed' ? 'sum.vatEffectiveAgreed' : 'sum.vatEffective', { period });
  return L(v.reporting === 'agreed' ? 'sum.vatNetRateAgreed' : 'sum.vatNetRate', { rates: v.rates.map((r) => `${r.rate} %${r.label ? ` ${r.label}` : ''}`).join(', '), period });
}

/** What the firm sells, in words: the kinds the profile keeps. */
export const sellsLine = (kinds: readonly SalesKind[]): Line => L('sum.sells', { kinds: { list: kinds.map((k) => `onboarding.sellsCard.kind.${k}`) } });

/**
 * The closing card: what the app knows and where from, what is still open with its place by hand,
 * and the first step in the app. Each fact stands once: what is open is in `open`, not also in `items`.
 */
function summaryOf(p: SetupProgress, f: SetupFacts): Extract<SetupCard, { kind: 'summary' }> {
  const states = topicStates(p, f);
  const told: Origin = p.created ? 'answer' : 'form';
  const v = f.company.vat;
  const ibans = f.banks.filter((b) => b.iban).length;
  const items: Array<{ what: Line; origin: Origin }> = [
    { what: L('sum.company', { name: f.company.name }), origin: told },
    { what: vatLine(v), origin: p.answers.vat?.kept ? 'answer' : told },
    ...(f.sells ? [{ what: sellsLine(f.sells.kinds), origin: p.answers.sells ? 'answer' as Origin : told }] : []),
    ...(f.opening.length ? [{ what: L('sum.opening', { n: f.opening.length }), origin: 'app' as Origin }] : []),
    ...(ibans ? [{ what: L('sum.banks', { n: ibans }), origin: told }] : []),
    ...(f.sources.length ? [{ what: L('sum.sources', { n: f.sources.length }), origin: 'app' as Origin }] : []),
    ...(f.rules ? [{ what: L('sum.rules', { n: f.rules }), origin: 'app' as Origin }] : []),
  ];
  const open = SETUP_TOPICS.filter((t) => states[t] !== 'done').map((t) => ({ topic: t, state: states[t], go: TOPIC_HAND[t] }));
  const first = L(!v.registered ? 'sum.firstNone' : v.period === 'half-yearly' ? 'sum.firstHalf' : 'sum.firstQuarter');
  return { kind: 'summary', items, open, first };
}

/** Typed text that names exactly one of the open question's answers picks it; anything else goes to the AI. */
export function typedChoice(step: SetupStep | undefined, typed: string, labelOf: (c: Choice) => string): string | undefined {
  if (!step || step.answer || !step.choices.length || step.multi) return undefined;
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const text = norm(typed);
  if (!text) return undefined;
  const exact = step.choices.filter((c) => norm(labelOf(c)) === text);
  if (exact.length === 1) return exact[0].value;
  const words = (s: string) => new Set(norm(s).split(' '));
  const hits = step.choices.filter((c) => text.length >= 3 && (words(labelOf(c)).has(text) || norm(labelOf(c)).startsWith(text)));
  return hits.length === 1 ? hits[0].value : undefined;
}

/** The open question of the conversation, if one waits for an answer. */
export const openStep = (steps: readonly SetupStep[]): SetupStep | undefined => {
  const last = steps.at(-1);
  return last && !last.answer && last.choices.length ? last : undefined;
};


/** When each step was asked: when the step before it was answered ('' for the first), so the AI's turns fall between them in the order they happened. */
export const askedAt = (steps: readonly SetupStep[]): string[] => steps.map((_, i) => (i ? steps[i - 1].answer?.at ?? '' : ''));
