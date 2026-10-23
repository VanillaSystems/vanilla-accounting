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
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, methodOf, type VatSetup } from '../workspace/vat-setup.js';
import { SALES_KINDS, type SalesKind } from '../workspace/setup.js';

/** A parameter of a line: a value, another key said in the person's language, or a date to format. */
export type Param = string | number | { key: string } | { date: string };
export interface Line { key: string; params?: Record<string, Param> }
export interface Choice { value: string; label: Line; sub?: Line; primary?: boolean }

/** Where a badge says a fact comes from. */
export type Origin = 'form' | 'answer' | 'app' | 'later' | 'open';

export type SetupCard =
  /** `origin`: the form saved it, or the person answered it in the conversation that created the books (#139). */
  | { kind: 'company'; company: SetupFacts['company']; origin: Extract<Origin, 'form' | 'answer'> }
  /** The VAT setup the answer asks for, against the one the app has: `proposed` waits for «Übernehmen», `kept` was taken. */
  | { kind: 'vat'; from: VatSetup; to: VatKind; state: 'proposed' | 'kept' }
  /** What the firm sells as answered, with the default accounts that follow; `proposed` until the profile says the same («Übernehmen»). */
  | { kind: 'sells'; kinds: SalesKind[]; purchase: Array<{ kind: SalesKind; account: string }>; sales: Array<{ kind: SalesKind; account: string }>; state: 'proposed' | 'kept' }
  | { kind: 'needs'; items: Array<{ what: Line; why: Line; who: Line }>; note: Line }
  | { kind: 'opening'; year: string; rows: SetupFacts['opening'] }
  | { kind: 'banks'; banks: SetupFacts['banks'] }
  | { kind: 'sources'; sources: SetupFacts['sources'] }
  | { kind: 'partners'; clear: ClearPartner[]; mixed: MixedPartner[]; rare: Array<{ name: string; n: number }>; rareMore: number }
  | { kind: 'summary'; items: Array<{ what: Line; origin: Origin }>; open: Array<{ topic: SetupTopic; state: TopicState; go: HandPlace | null }> };

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

/** The setup a click on a VAT answer asks for; a net tax rate needs the rate, which the card asks. */
export function vatSetupOf(kind: VatKind, rate?: { rate: number; label?: string }): VatSetup | null {
  if (kind === 'none') return NOT_REGISTERED;
  if (kind === 'effective') return EFFECTIVE_QUARTERLY;
  return rate ? { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: rate.rate, ...(rate.label ? { label: rate.label } : {}) }] } : null;
}

const L = (key: string, params?: Record<string, Param>): Line => ({ key: `onboarding.${key}`, ...(params ? { params } : {}) });
const choice = (q: QuestionId, value: string, opts: { params?: Record<string, Param>; sub?: boolean; primary?: boolean } = {}): Choice => ({
  value, label: L(`q.${q}.${value}`, opts.params), ...(opts.sub ? { sub: L(`q.${q}.${value}.sub`, opts.params) } : {}), ...(opts.primary ? { primary: true } : {}),
});

const PERIOD_ENDS = { quarter: ['03-31', '06-30', '09-30', '12-31'], half: ['06-30', '12-31'] } as const;
type Length = keyof typeof PERIOD_ENDS;
const PERIOD_STARTS = { quarter: ['01-01', '04-01', '07-01', '10-01'], half: ['01-01', '07-01'] } as const;

/** The VAT setup the conversation goes on with: what the person answered, else what the app has. */
function intendedVat(p: SetupProgress, f: SetupFacts): VatKind {
  const a = p.answers.vat?.value;
  return a && a !== 'unknown' ? a : vatKind(f.company.vat);
}
function lengthOf(p: SetupProgress, f: SetupFacts): Length {
  const kind = intendedVat(p, f);
  const v = f.company.vat;
  return kind === 'net-rate' || (kind === vatKind(v) && v.registered && v.period === 'half-yearly') ? 'half' : 'quarter';
}

/** How many filing periods of the open year ended before today. */
function endedPeriods(f: Pick<SetupFacts, 'today' | 'year'>, length: Length): number {
  const ends = PERIOD_ENDS[length];
  return ends.filter((e) => `${f.year}-${e}` < f.today).length;
}
const periodsLine = (length: Length, n: number): Line => L(`q.filed.${length === 'half' ? 'h' : 'q'}${n}`);
const endOf = (f: SetupFacts, length: Length, n: number) => `${f.year}-${PERIOD_ENDS[length][n - 1]}`;
/** The first day of the period today is in: where «im laufenden Jahr» starts. */
const runningFrom = (f: SetupFacts, length: Length) => {
  const n = Math.min(endedPeriods(f, length), PERIOD_STARTS[length].length - 1);
  return `${f.year}-${PERIOD_STARTS[length][n]}`;
};

const PROGRAMS_WITH_JOURNAL = new Set(['bexio', 'abacus', 'banana']);
const programParam = (v: AnswerValue<'program'> | undefined): Param => ({ key: `onboarding.program.${v ?? 'excel'}` });

/** Whether the answer to `sells` is what the profile keeps: nothing left to take over. A workspace without a profile is not asked. */
function sellsSettled(p: SetupProgress, f: SetupFacts): boolean {
  if (!f.sells) return true;
  const a = p.answers.sells?.value;
  return !!a && kindsOfAnswer(a).join('+') === f.sells.kinds.join('+');
}

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

/** How many periods the answer says were filed, never more than are over (an answer given before the VAT setup changed). */
const filedCount = (p: SetupProgress, f: SetupFacts) => Math.min(Number(p.answers.filed?.value ?? 0), endedPeriods(f, lengthOf(p, f)));

/**
 * Each topic as the app sees it: done by what it observes (a bank account with an IBAN, a source
 * switched on, opening balances, the VAT setup confirmed or kept), skipped where the person left it
 * for later or the app has no place for it yet; a topic marked by the AI or by hand keeps that mark
 * unless the app sees it done.
 */
export function topicStates(p: SetupProgress, f: SetupFacts): Record<SetupTopic, TopicState> {
  const a = p.answers;
  const length = lengthOf(p, f);
  const filed = filedCount(p, f);
  const seen: Record<SetupTopic, TopicState> = {
    firm: a.company && vatSettled(p, f) && sellsSettled(p, f) ? 'done' : 'open',
    periods: !a.start ? 'open' : !needsFiled(p, f) ? 'done' : !a.filed ? 'open'
      : !filed || (!!f.closedThrough && f.closedThrough >= endOf(f, length, filed)) ? 'done' : 'skipped',
    history: a.program?.value === 'new' ? 'done' : a.needs ? 'skipped' : 'open',
    opening: f.opening.length ? 'done' : a.opening?.value === 'later' ? 'skipped' : 'open',
    bank: f.banks.some((b) => b.iban) ? 'done' : a.bank?.value === 'later' ? 'skipped' : 'open',
    receipts: f.sources.length ? 'done' : a.receipts?.value === 'later' ? 'skipped' : 'open',
    knowledge: a.partners ? 'done' : 'open',
  };
  return Object.fromEntries(SETUP_TOPICS.map((t) => {
    const marked = p.topics[t].state;
    return [t, seen[t] === 'done' ? 'done' : marked !== 'open' ? marked : seen[t]];
  })) as Record<SetupTopic, TopicState>;
}

/** Whether the conversation asks which returns were filed: a registered firm, a period of the year over. */
function needsFiled(p: SetupProgress, f: SetupFacts): boolean {
  return intendedVat(p, f) !== 'none' && endedPeriods(f, lengthOf(p, f)) > 0;
}

/** The steps so far: every answered one, then the first open one (or the summary when all are answered). */
export function setupThread(p: SetupProgress, f: SetupFacts): SetupStep[] {
  const steps: SetupStep[] = [];
  const a = p.answers;
  const take = (s: Omit<SetupStep, 'answer'> & { id: QuestionId }): boolean => {
    const answer = a[s.id] as Answer | undefined;
    steps.push({ ...s, ...(answer ? { answer } : {}) });
    return !!answer;
  };
  const length = lengthOf(p, f);
  const prev = String(Number(f.year) - 1);

  // Firm and VAT
  if (!take({
    id: 'company', topic: 'firm',
    say: [f.company.owner ? L('s.hello', { owner: f.company.owner.split(/\s+/)[0] }) : L('s.helloNoName'), L('s.company')],
    card: { kind: 'company', company: f.company, origin: p.created ? 'answer' : 'form' },
    choices: [choice('company', 'ok', { primary: true }), choice('company', 'fix')],
    ...(a.company?.value === 'fix' ? { reply: { lines: [L('r.companyFix')], go: { area: 'company', section: 'profile' } } } : {}),
  })) return steps;

  const now = vatKind(f.company.vat);
  const vatAnswer = a.vat?.value;
  const vatReply = (): SetupStep['reply'] => {
    if (!vatAnswer) return undefined;
    const kept = a.vat?.kept;
    if (kept) return { lines: [L('r.vatChange')], card: { kind: 'vat', from: kept.before, to: vatAnswer as VatKind, state: 'kept' }, go: TOPIC_HAND.firm ?? undefined };
    if (vatAnswer === 'unknown') return { lines: [L('r.vatUnknown')] };
    if (vatAnswer === now) return { lines: [L(now === 'none' ? 'r.vatSameNone' : 'r.vatSame')] };
    return { lines: [L('r.vatChange')], card: { kind: 'vat', from: f.company.vat, to: vatAnswer, state: 'proposed' }, go: TOPIC_HAND.firm ?? undefined };
  };
  if (!take({
    id: 'vat', topic: 'firm',
    say: [L('s.vat')],
    choices: (['none', 'effective', 'net-rate', 'unknown'] as const).map((v) => choice('vat', v, { sub: true, primary: v === now })),
    reply: vatReply(),
  })) return steps;

  // Was verkauft ihr? (#46)
  if (f.sells) {
    const sold = a.sells ? kindsOfAnswer(a.sells.value) : undefined;
    if (!take({
      id: 'sells', topic: 'firm', multi: true,
      say: [L('s.sells')],
      choices: SALES_KINDS.map((k) => ({ ...choice('sells', k, { sub: true }), ...(f.sells!.kinds.includes(k) ? { primary: true } : {}) })),
      ...(sold ? { reply: { lines: [L('r.sells')], card: sellsCard(sold, f.sells, sellsSettled(p, f)) } } : {}),
    })) return steps;
  }

  // Geschäftsjahr
  const from = runningFrom(f, length);
  if (!take({
    id: 'start', topic: 'periods',
    say: [L('s.start')],
    choices: [choice('start', 'year', { params: { year: f.year }, sub: true, primary: true }), ...(from > `${f.year}-01-01` ? [choice('start', 'during', { params: { from: { date: from } }, sub: true })] : [])],
  })) return steps;
  if (needsFiled(p, f)) {
    const ended = endedPeriods(f, length);
    const n = filedCount(p, f);
    const sealed = !!f.closedThrough && n > 0 && f.closedThrough >= endOf(f, length, n);
    if (!take({
      id: 'filed', topic: 'periods',
      say: [L('s.filed', { year: f.year })],
      choices: [{ value: '0', label: L('q.filed.0') }, ...Array.from({ length: ended }, (_, i) => ({ value: String(i + 1), label: periodsLine(length, i + 1) }))],
      ...(a.filed ? {
        reply: !n ? { lines: [L('r.filedNone', { from: { date: a.start?.value === 'during' ? from : `${f.year}-01-01` } })] }
          : sealed ? { lines: [L('r.filedSealed', { date: { date: f.closedThrough! } })] }
            : { lines: [L('r.filedLater', { periods: { key: periodsLine(length, n).key } })], go: TOPIC_HAND.periods ?? undefined },
      } : {}),
    })) return steps;
  }

  // Bisheriges Programm
  const program = a.program?.value;
  if (!take({
    id: 'program', topic: 'history',
    say: [L('s.program')],
    choices: (['bexio', 'abacus', 'banana', 'excel', 'accountant', 'new'] as const).map((v) => choice('program', v)),
    ...(program ? { reply: { lines: [L(`r.program.${program}`)] } } : {}),
  })) return steps;
  if (program !== 'new') {
    const entry = a.entry?.value;
    if (!take({
      id: 'entry', topic: 'history',
      say: [program && PROGRAMS_WITH_JOURNAL.has(program) ? L('s.entryLikely', { program: programParam(program) }) : L('s.entry')],
      choices: [choice('entry', 'double', { primary: !!program && PROGRAMS_WITH_JOURNAL.has(program) }), choice('entry', 'single'), choice('entry', 'unknown')],
      ...(entry && entry !== 'double' ? { reply: { lines: [L(`r.entry.${entry}`)] } } : {}),
    })) return steps;
    if (program !== 'accountant' && !take({
      id: 'access', topic: 'history',
      say: [L('s.access', { program: programParam(program) })],
      choices: (['me', 'accountant', 'both'] as const).map((v) => choice('access', v)),
    })) return steps;
    const viaAccountant = program === 'accountant' || a.access?.value === 'accountant';
    const who = viaAccountant ? L('needs.who.accountant') : L('needs.who.export', { program: programParam(program) });
    const single = entry === 'single';
    const n = filedCount(p, f);
    const items: Array<{ what: Line; why: Line; who: Line }> = [
      ...(single ? [] : [{ what: L('needs.chart'), why: L('needs.chartWhy', { program: programParam(program) }), who }]),
      ...(single ? [] : [{ what: L('needs.journal', { year: prev }), why: L('needs.journalWhy'), who }]),
      { what: L('needs.balance', { date: { date: `${prev}-12-31` } }), why: L('needs.balanceWhy', { date: { date: `${f.year}-01-01` } }), who },
      ...(a.start?.value === 'during' && !single ? [{ what: L('needs.journalNow', { from: { date: `${f.year}-01-01` }, to: { date: dayBefore(from) } }), why: L('needs.journalNowWhy'), who }] : []),
      ...(n ? [{ what: L('needs.returns', { periods: { key: periodsLine(length, n).key }, year: f.year }), why: L('needs.returnsWhy'), who: viaAccountant ? who : L('needs.who.portal') }] : []),
      { what: L('needs.receipts', { year: prev }), why: L('needs.receiptsWhy'), who: L('needs.who.optional') },
    ];
    if (!take({
      id: 'needs', topic: 'history',
      say: [L('s.needs')],
      card: { kind: 'needs', items, note: L('needs.later', { program: programParam(program) }) },
      choices: [choice('needs', 'ok', { primary: true })],
    })) return steps;
  }

  // Eröffnung
  const hasOpening = f.opening.length > 0;
  if (!take({
    id: 'opening', topic: 'opening',
    say: [hasOpening ? L('s.openingSet', { date: { date: `${f.year}-01-01` } }) : L(program === 'new' ? 's.openingNew' : 's.openingNone', { date: { date: `${f.year}-01-01` }, prev: { date: `${prev}-12-31` } })],
    ...(hasOpening ? { card: { kind: 'opening', year: f.year, rows: f.opening } } : {}),
    choices: [choice('opening', 'next', { primary: hasOpening }), choice('opening', 'later', { primary: !hasOpening })],
    go: TOPIC_HAND.opening ?? undefined,
  })) return steps;

  // Bank
  const withIban = f.banks.filter((b) => b.iban).length;
  if (!take({
    id: 'bank', topic: 'bank',
    say: [withIban ? L('s.bank') : L('s.bankNone')],
    card: { kind: 'banks', banks: f.banks },
    choices: [choice('bank', 'next', { primary: withIban > 0 }), choice('bank', 'later', { primary: !withIban })],
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

  // Partner und Wissen
  const bins = f.partners;
  const partners = bins.clear.length + bins.mixed.length + bins.rare.length;
  if (!take({
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

const dayBefore = (iso: string) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

/** The VAT setup in words: not registered, effective with its period, the net tax rates with theirs. */
export function vatLine(v: VatSetup): Line {
  if (!v.registered) return L('sum.vatNone');
  const period: Param = { key: `onboarding.period.${v.period}` };
  return v.method === 'effective' ? L('sum.vatEffective', { period }) : L('sum.vatNetRate', { rates: v.rates.map((r) => `${r.rate} %${r.label ? ` ${r.label}` : ''}`).join(', '), period });
}

/** The closing card: what the app now knows and where it comes from, and what is still open with its place by hand. */
function summaryOf(p: SetupProgress, f: SetupFacts): Extract<SetupCard, { kind: 'summary' }> {
  const a = p.answers;
  const states = topicStates(p, f);
  const length = lengthOf(p, f);
  const n = filedCount(p, f);
  const items: Array<{ what: Line; origin: Origin }> = [
    { what: L('sum.company', { name: f.company.name }), origin: a.company?.value === 'ok' ? 'answer' : 'form' },
    { what: vatLine(f.company.vat), origin: vatSettled(p, f) && a.vat?.value !== 'unknown' ? 'answer' : 'form' },
    { what: a.start?.value === 'during' ? L('sum.startDuring', { from: { date: runningFrom(f, length) } }) : L('sum.startYear', { year: f.year }), origin: 'answer' },
    ...(n ? [{ what: L('sum.filed', { periods: { key: periodsLine(length, n).key } }), origin: (states.periods === 'done' ? 'app' : 'later') as Origin }] : []),
    ...(a.program && a.program.value !== 'new' ? [{ what: L('sum.program', { program: programParam(a.program.value) }), origin: 'later' as Origin }] : []),
    { what: f.opening.length ? L('sum.opening', { n: f.opening.length }) : L('sum.openingNone'), origin: f.opening.length ? 'app' : 'open' },
    { what: f.banks.some((b) => b.iban) ? L('sum.banks', { n: f.banks.filter((b) => b.iban).length }) : L('sum.banksNone'), origin: f.banks.some((b) => b.iban) ? 'app' : 'open' },
    { what: f.sources.length ? L('sum.sources', { n: f.sources.length }) : L('sum.sourcesNone'), origin: f.sources.length ? 'app' : 'open' },
    ...(f.rules ? [{ what: L('sum.rules', { n: f.rules }), origin: 'app' as Origin }] : []),
  ];
  const open = SETUP_TOPICS.filter((t) => states[t] !== 'done').map((t) => ({ topic: t, state: states[t], go: TOPIC_HAND[t] }));
  return { kind: 'summary', items, open };
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
