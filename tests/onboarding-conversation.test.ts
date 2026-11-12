/**
 * The setup conversation as code draws it (docs/0.4.0/onboarding.md, src/onboarding/conversation.ts):
 * the steps from the answers and the facts, the topics as the app sees them, the partner bins, the
 * words every step can say in each language, the answers over HTTP, and the AI's `setupAnswer`.
 * Each test names the wrong behaviour it catches.
 */
import './support/demo-workspace.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { setupCount, setupThread, topicStates, topicsTaken, typedChoice, askedAt, openStep, sellsLine, vatLine, type Line, type SetupStep } from '../src/onboarding/conversation.js';
import { emptyProgress, parseProgress, questionWordsKey, settledCount, stateWordsKey, topicWordsKey, withAnswer, withTopic, QUESTIONS, SETUP_TOPICS, type Answer, type QuestionId, type SetupProgress } from '../src/onboarding/model.js';
import { describedOr } from '../src/app/assistant/stored-change.js';
import { partnerBins, type SetupFacts } from '../src/onboarding/facts.js';
import { setupNote } from '../src/onboarding/prompt.js';
import { readProgress } from '../src/onboarding/store.js';
import { changesIn, ChangesError } from '../src/assistant/changes.js';
import { applyWorkspaceChange } from '../src/server/workspace-edits.js';
import { wordsIn } from '../src/export/texts.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED } from '../src/workspace/vat-setup.js';
import { tempWorkspace } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import type { Locale } from '../src/app/i18n/types.js';

const AT = '2026-10-21T09:00:00.000Z';
const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  today: '2026-10-21', year: '2026',
  company: { name: 'Muster GmbH', uid: 'CHE-123.456.789', owner: 'Anna Muster', legalForm: 'GmbH', vat: EFFECTIVE_QUARTERLY },
  banks: [], sources: [], opening: [], books: { payments: 0, receipts: 0, entries: 0 },
  partners: { clear: [], mixed: [], rare: [], ruled: 0 }, rules: 0,
  ...over,
});
const answered = (pairs: Partial<Record<QuestionId, string>>, p: SetupProgress = emptyProgress()): SetupProgress =>
  Object.entries(pairs).reduce((acc, [q, value], i) => withAnswer(acc, q as QuestionId, { value, at: `2026-10-21T09:0${i}:00.000Z` } as Answer), p);
const ids = (steps: SetupStep[]) => steps.map((s) => s.id);
const last = (steps: SetupStep[]) => steps.at(-1)!;
const IBAN = [{ label: 'Bank', bank: 'raiffeisen', currency: 'CHF', account: '1020', iban: 'CH-TEST-IBAN' }];
const SELLS = { kinds: ['made', 'services'] as Array<'made' | 'services'>, accounts: { made: { purchase: '4000', sales: '3000' }, traded: { purchase: '4200', sales: '3200' }, services: { sales: '3400' } } };

test('a fresh setup shows what the app knows of the firm once, greets no one by name, and asks the first thing the settings do not answer', () => {
  const steps = setupThread(emptyProgress(), facts({ sells: SELLS }));
  assert.deepEqual(ids(steps), ['company', 'opening'], 'the firm, its VAT and what it sells were asked a minute ago: not again (#345)');
  const s = steps[0];
  assert.deepEqual(s.say.map((l) => l.key), ['onboarding.s.hello', 'onboarding.s.company']);
  assert.equal(s.say[0].params, undefined, 'whoever sits there is not greeted with the owner\'s name');
  assert.deepEqual(s.choices, [], 'shown, not asked');
  assert.deepEqual(s.card, { kind: 'company', company: facts().company, sells: ['made', 'services'], origin: 'form', change: true });
  assert.equal(topicStates(emptyProgress(), facts()).firm, 'done', 'nothing of the firm waits');
  assert.equal(openStep(steps)?.id, 'opening');
});

test('«Etwas ändern» on the firm\'s card opens the VAT and the sales question; books of an older version that answered «Stimmt so» are not asked', () => {
  const fix = setupThread(answered({ company: 'fix' }), facts({ sells: SELLS }));
  assert.deepEqual(ids(fix), ['company', 'vat']);
  assert.equal(fix[0].reply?.lines[0].key, 'onboarding.r.companyFix');
  assert.deepEqual(fix[0].reply?.go, { area: 'company', section: 'profile' });
  assert.equal(fix[0].card?.kind === 'company' && fix[0].card.change, false, 'taken: the card offers it no more');
  assert.equal(topicStates(answered({ company: 'fix' }), facts()).firm, 'open');
  assert.deepEqual(ids(setupThread(answered({ company: 'fix', vat: 'effective' }), facts({ sells: SELLS }))), ['company', 'vat', 'sells']);
  assert.deepEqual(ids(setupThread(answered({ company: 'fix', vat: 'effective', sells: 'made+services' }), facts({ sells: SELLS }))), ['company', 'vat', 'sells', 'opening']);
  assert.deepEqual(ids(setupThread(answered({ company: 'ok' }), facts({ sells: SELLS }))), ['company', 'opening']);
  assert.deepEqual(ids(setupThread(answered({ vat: 'net-rate' }), facts())), ['company', 'vat', 'opening'], 'a VAT answer the AI recorded from typed words shows its card');
});

test('only what the app cannot know is asked: no start day, no filed returns, no old program; a bank with its IBAN and books without partners are not walked through', () => {
  const asked = new Set(Object.keys(QUESTIONS));
  for (const gone of ['start', 'filed', 'program', 'entry', 'access', 'needs']) assert.ok(!asked.has(gone), `${gone} led nowhere and is not asked`);
  assert.deepEqual([...SETUP_TOPICS], ['firm', 'opening', 'bank', 'receipts', 'knowledge']);
  // The tester's books: a bank account with its IBAN, nothing booked. Two clicks to the summary.
  let p = emptyProgress();
  const f = facts({ banks: IBAN });
  assert.equal(last(setupThread(p, f)).id, 'opening');
  p = answered({ opening: 'later' }, p);
  assert.equal(last(setupThread(p, f)).id, 'receipts', 'the bank account is known: not asked');
  p = answered({ receipts: 'later' }, p);
  assert.equal(last(setupThread(p, f)).id, 'summary', 'no bookings, no partners to show');
  // Without an IBAN the bank is asked; books with partners show them.
  assert.equal(last(setupThread(answered({ opening: 'later' }), facts())).id, 'bank');
  const withPartners = facts({ banks: IBAN, partners: { clear: [], mixed: [], rare: [{ id: 'x', name: 'X', n: 1 }], ruled: 0 } });
  assert.equal(last(setupThread(answered({ opening: 'later', receipts: 'later' }), withPartners)).id, 'partners');
  assert.equal(topicStates(emptyProgress(), withPartners).knowledge, 'open');
  assert.equal(topicStates(emptyProgress(), f).knowledge, 'skipped', 'nothing to show yet: left for later, not done');
});

test('the count never goes backwards: partners that appear with the first statement, after the setup ended, do not reopen a topic', () => {
  const p = answered({ opening: 'later', receipts: 'later' });
  const empty = facts({ banks: IBAN });
  assert.equal(settledCount(topicStates(p, empty)), 5);
  assert.deepEqual(setupCount(p, empty), { n: 4, of: 4 }, 'the partners were never shown: not counted as discussed (#364)');
  const booked = facts({ banks: IBAN, partners: { clear: [], mixed: [], rare: [{ id: 'x', name: 'X', n: 1 }], ruled: 0 } });
  const ended = { ...p, ready: AT };
  assert.equal(settledCount(topicStates(ended, booked)), 5, 'was 5 von 5, then 4 von 5 after the first statement');
  assert.deepEqual(setupCount(ended, booked), { n: 4, of: 4 }, 'partners that come after the setup ended are not a topic it took up');
  assert.equal(topicStates(ended, booked).knowledge, 'skipped');
  assert.equal(topicStates(answered({ partners: 'next' }, ended), booked).knowledge, 'done', 'seen: done');
});

test('a conversation stored by an earlier version names topics and questions this one no longer has: described in a generic sentence, never thrown', async () => {
  // As 0.4.1 stored them in data/assistant/<id>.json: {"kind":"setupTopic","topic":"periods","state":"skipped"}, {"kind":"setupAnswer","question":"start","value":"year"}.
  const stored = { topic: 'periods', state: 'skipped', question: 'start' };
  const keys = [topicWordsKey(stored.topic), stateWordsKey(stored.state), questionWordsKey(stored.question), topicWordsKey('history'), questionWordsKey('filed'), stateWordsKey('paused'), 'assistant.c.unknown'];
  assert.deepEqual(keys, ['onboarding.topic.gone', 'onboarding.state.skipped', 'onboarding.question.gone', 'onboarding.topic.gone', 'onboarding.question.gone', 'onboarding.state.open', 'assistant.c.unknown']);
  assert.equal(topicWordsKey('bank'), 'onboarding.topic.bank');
  assert.equal(questionWordsKey('opening'), 'onboarding.question.opening');
  const dir = 'src/app/i18n/locales';
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const messages = (await import(`../${dir}/${f}`) as { default: Locale }).default.messages as Record<string, unknown>;
    assert.deepEqual(keys.filter((k) => !(k in messages)), [], `${f} has the words`);
    for (const gone of ['onboarding.topic.periods', 'onboarding.question.start']) assert.ok(!(gone in messages), `${gone} is the key 0.4.1 used and this version lacks: the lookup that threw`);
  }
  // Any other kind a later or earlier version stored: the sidebar's description falls back instead of throwing.
  assert.deepEqual(describedOr<{ text: string }>(() => { throw new Error('Missing i18n key: onboarding.topic.periods'); }, () => ({ text: 'generic' })), { text: 'generic' });
  assert.deepEqual(describedOr(() => ({ text: 'fine' }), () => ({ text: 'generic' })), { text: 'fine' });
});

test('the count moves with every answer: each topic the conversation is through counts, done or left for later; one it never took up does not', () => {
  const f = facts();
  const count = (p: SetupProgress) => setupCount(p, f);
  assert.deepEqual(count(emptyProgress()), { n: 1, of: 4 }, 'the firm needs nothing; the partners come with the first bookings and are no topic yet (#364)');
  assert.deepEqual(count(answered({ opening: 'later' })), { n: 2, of: 4 });
  assert.deepEqual(count(answered({ opening: 'later', bank: 'later' })), { n: 3, of: 4 });
  assert.deepEqual(count(answered({ opening: 'later', bank: 'later', receipts: 'later' })), { n: 4, of: 4 }, 'was «5 von 5 besprochen» with «Partner und Wissen» never asked');
  // Books with partners take the topic up: shown, then counted once seen.
  const withPartners = facts({ partners: { clear: [], mixed: [], rare: [{ id: 'x', name: 'X', n: 1 }], ruled: 0 } });
  assert.deepEqual(topicsTaken(emptyProgress(), withPartners), [...SETUP_TOPICS]);
  assert.deepEqual(setupCount(answered({ opening: 'later', bank: 'later', receipts: 'later' }), withPartners), { n: 4, of: 5 });
  assert.deepEqual(setupCount(answered({ opening: 'later', bank: 'later', receipts: 'later', partners: 'next' }), withPartners), { n: 5, of: 5 });
});

test('without an AI the greeting and the receipts step say only what works on this Mac (#364)', () => {
  const [hello] = setupThread(emptyProgress(), facts())[0].say;
  assert.equal(hello.key, 'onboarding.s.hello');
  assert.equal(hello.noAi?.key, 'onboarding.s.helloNoAi', 'the words without an AI');
  const receipts = setupThread(answered({ opening: 'later', bank: 'later' }), facts()).find((s) => s.id === 'receipts')!;
  assert.equal(receipts.say[0].noAi?.key, 'onboarding.s.receiptsNoneNoAi');
});

test('«Später» on the opening says what it means and where it comes back; with an opening entered there is nothing to say', () => {
  const later = setupThread(answered({ opening: 'later' }), facts()).find((s) => s.id === 'opening')!;
  assert.deepEqual(later.reply, { lines: [{ key: 'onboarding.r.openingLater' }], go: { area: 'company', section: 'opening' } });
  assert.equal(later.say[0].key, 'onboarding.s.openingNone');
  const set = setupThread(answered({ opening: 'later' }), facts({ opening: [{ account: '1020', name: 'Bank', amount: 1 }] })).find((s) => s.id === 'opening')!;
  assert.equal(set.reply, undefined);
  assert.equal(setupThread(answered({ opening: 'next' }), facts()).find((s) => s.id === 'opening')!.reply, undefined);
});

test('the VAT answer: the same as the app has says so, another asks for a change kept on its card, never written by the answer itself', () => {
  const p = answered({ company: 'ok', vat: 'effective' });
  assert.deepEqual(setupThread(p, facts()).find((s) => s.id === 'vat')!.reply, { lines: [{ key: 'onboarding.r.vatSame' }] });
  const net = setupThread(answered({ company: 'ok', vat: 'net-rate' }), facts()).find((s) => s.id === 'vat')!;
  assert.deepEqual(net.reply?.card, { kind: 'vat', from: EFFECTIVE_QUARTERLY, to: 'net-rate', state: 'proposed' });
  const kept = withAnswer(answered({ company: 'ok' }), 'vat', { value: 'none', at: AT, kept: { before: EFFECTIVE_QUARTERLY, at: AT } });
  const card = setupThread(kept, facts({ company: { ...facts().company, vat: NOT_REGISTERED } })).find((s) => s.id === 'vat')!.reply?.card;
  assert.deepEqual(card, { kind: 'vat', from: EFFECTIVE_QUARTERLY, to: 'none', state: 'kept' }, 'kept: the card stays with what it was, for «Rückgängig»');
  assert.equal(setupThread(answered({ company: 'ok', vat: 'none' }), facts({ company: { ...facts().company, vat: NOT_REGISTERED } })).find((s) => s.id === 'vat')!.reply?.lines[0].key, 'onboarding.r.vatSameNone');
  assert.equal(topicStates(answered({ company: 'ok', vat: 'net-rate' }), facts()).firm, 'open', 'a change not taken leaves the firm open');
  assert.equal(topicStates(answered({ company: 'ok', vat: 'none' }), facts({ company: { ...facts().company, vat: NOT_REGISTERED } })).firm, 'done', 'the app shows what the person answered: done');
});

test('a topic is done when the app sees it, whatever was answered or marked: a bank with IBAN, a source switched on, opening balances', () => {
  const seen = facts({
    banks: [{ label: 'Bank', bank: 'raiffeisen', currency: 'CHF', account: '1020', iban: 'CH-TEST-IBAN' }],
    sources: [{ id: 'mail', label: { en: 'Mailbox' } }],
    opening: [{ account: '1020', name: 'Bank', amount: 1000 }],
  });
  const s = topicStates(withTopic(emptyProgress(), 'bank', 'skipped', AT), seen);
  assert.equal(s.bank, 'done', 'a skip by hand gives way to what the app sees');
  assert.equal(s.receipts, 'done');
  assert.equal(s.opening, 'done');
  assert.equal(topicStates(emptyProgress(), facts({ banks: [{ label: 'Bank', bank: 'b', currency: 'CHF', account: '1020' }] })).bank, 'open', 'an account without IBAN is not set up');
  assert.equal(topicStates(withTopic(emptyProgress(), 'bank', 'skipped', AT), facts()).bank, 'skipped', 'a mark stands while the app sees nothing');
  assert.equal(topicStates(answered({ bank: 'later' }), facts()).bank, 'skipped', '«Später» skips the topic');
});

test('the summary says each fact once and where from, lists only what is still open, never a topic answered as skipped, and ends with the first step', () => {
  const p = answered({ opening: 'later', receipts: 'later' });
  const sum = last(setupThread(p, facts({ banks: IBAN, sells: SELLS })));
  assert.equal(sum.card?.kind, 'summary');
  if (sum.card?.kind !== 'summary') return;
  assert.deepEqual(sum.card.items.map((i) => [i.what.key, i.origin]), [
    ['onboarding.sum.company', 'form'], ['onboarding.sum.vatEffective', 'form'], ['onboarding.sum.sells', 'form'], ['onboarding.sum.banks', 'form'],
  ], 'what is open is not listed here too');
  assert.deepEqual(sum.card.open, [
    { topic: 'opening', state: 'skipped', go: { area: 'company', section: 'opening' } },
    { topic: 'receipts', state: 'skipped', go: { area: 'company', section: 'sources' } },
    { topic: 'knowledge', state: 'notYet', go: { area: 'company', section: 'rules' } },
  ], 'only what is left for later, each with its place; the partners, never shown on books without bookings, come with the first bookings (#364)');
  assert.equal(sum.card.first.key, 'onboarding.sum.firstQuarter', 'the first step: the statement, from the first quarter not filed');
  const half = last(setupThread(p, facts({ banks: IBAN, company: { ...facts().company, vat: { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5 }] } } })));
  assert.equal(half.card?.kind === 'summary' && half.card.first.key, 'onboarding.sum.firstHalf');
  const none = last(setupThread(p, facts({ banks: IBAN, company: { ...facts().company, vat: NOT_REGISTERED } })));
  assert.equal(none.card?.kind === 'summary' && none.card.first.key, 'onboarding.sum.firstNone');
  const created = last(setupThread({ ...p, created: AT }, facts({ banks: IBAN })));
  assert.equal(created.card?.kind === 'summary' && created.card.items[0].origin, 'answer', 'books the conversation created: her own answers');
});

test('a firm that starts in the middle of the year is told what follows, and which balance the opening needs: never a July bank balance beside December figures', async () => {
  const de = (await import('../src/app/i18n/locales/de.js') as { default: Locale }).default.messages as unknown as Record<string, string>;
  // The first step is one sentence (#364); what follows from it stands behind «Mehr dazu», the same for each.
  for (const k of ['onboarding.sum.firstQuarter', 'onboarding.sum.firstHalf', 'onboarding.sum.firstNone']) {
    assert.match(de[k], /^Lies den Kontoauszug ab [^.;]+\.$/, `${k}: one sentence`);
  }
  assert.match(de['onboarding.sum.firstMore'], /Beginnst du mitten im Jahr, zeigen Bilanz und Erfolgsrechnung dieses Jahres nur/);
  assert.match(de['onboarding.sum.firstMore'], /die Eröffnung bleibt per 1\. Januar/);
  assert.match(de['onboarding.s.openingNone'], /auch den Stand des Bankkontos, aus der Bilanz per \{prev\}/);
  assert.doesNotMatch(de['onboarding.s.openingNone'], /ersten Kontoauszug/, 'the first statement of a firm that starts in July shows July\'s balance, not the opening\'s');
});

test('partners sort into the prototype\'s bins: always the same way at least four times, booked in mixed ways, rare; a partner with a rule stays out', () => {
  const e = (id: string, debit: string, vatCode?: string) => ({ id, accountDebit: debit, accountCredit: '1020', amount: -100, ...(vatCode ? { vatCode } : {}) });
  const entries = [e('a1', '6510', 'I81'), e('a2', '6510', 'I81'), e('a3', '6510', 'I81'), e('a4', '6510', 'I81'), e('b1', '6200', 'I81'), e('b2', '4210', 'M81'), e('b3', '6200', 'I81'), e('c1', '6500'), e('d1', '6570', 'I81'), e('d2', '6570', 'I81'), e('d3', '6570', 'I81'), e('d4', '6570', 'I81')];
  const bins = partnerBins({
    partners: [
      { id: 'swisscom', name: 'Swisscom', entries: ['a1', 'a2', 'a3', 'a4'], rules: 0 },
      { id: 'coop', name: 'Coop', entries: ['b1', 'b2', 'b3'], rules: 0 },
      { id: 'druck', name: 'Druckerei', entries: ['c1'], rules: 0 },
      { id: 'cloud', name: 'Cloud', entries: ['d1', 'd2', 'd3', 'd4'], rules: 1 },
      { id: 'none', name: 'Nobody', entries: [], rules: 0 },
    ],
    entries, bankAccounts: new Set(['1020']), accountName: (n) => ({ '6510': 'Telefon' } as Record<string, string>)[n] ?? '',
  });
  assert.deepEqual(bins.clear, [{ id: 'swisscom', name: 'Swisscom', n: 4, account: '6510', accountName: 'Telefon', vat: 'I81', sum: 400 }]);
  assert.deepEqual(bins.mixed.map((m) => [m.id, m.parts.map((x) => [x.account, x.n])]), [['coop', [['6200', 2], ['4210', 1]]]]);
  assert.deepEqual(bins.rare.map((r) => r.id), ['druck']);
  assert.equal(bins.ruled, 1, 'a partner with a rule needs no proposal');
  const credit = partnerBins({ partners: [{ id: 'k', name: 'Kunde', entries: ['x'], rules: 0 }], entries: [{ id: 'x', accountDebit: '1020', accountCredit: '3400', amount: 50 }], bankAccounts: new Set(['1020']), accountName: () => '' });
  assert.equal(credit.rare[0].id, 'k');
  assert.equal(partnerBins({ partners: [{ id: 'k', name: 'K', entries: ['x', 'y', 'z', 'w'], rules: 0 }], entries: ['x', 'y', 'z', 'w'].map((id) => ({ id, accountDebit: '1020', accountCredit: '3400', amount: 1 })), bankAccounts: new Set(['1020']), accountName: () => '' }).clear[0].account, '3400', 'a sale is booked for its revenue account, not the bank');
});

test('typed words that name exactly one answer pick it; anything else goes to the AI', () => {
  const step = setupThread(answered({ company: 'fix' }), facts()).at(-1)!;
  const label = (c: { label: Line }) => ({ 'onboarding.q.vat.none': 'Nicht MWST-pflichtig', 'onboarding.q.vat.effective': 'Effektiv, pro Quartal', 'onboarding.q.vat.net-rate': 'Saldosteuersatz, pro Halbjahr', 'onboarding.q.vat.unknown': 'Weiss nicht' } as Record<string, string>)[c.label.key];
  assert.equal(typedChoice(step, 'effektiv', label), 'effective');
  assert.equal(typedChoice(step, 'Saldosteuersatz, pro Halbjahr', label), 'net-rate');
  assert.equal(typedChoice(step, 'wir rechnen mit 4.5 Prozent ab', label), undefined, 'a sentence is the AI\'s to read');
  assert.equal(typedChoice(step, 'pro', label), undefined, 'a word of two answers picks neither');
  assert.equal(typedChoice({ ...step, answer: { value: 'effective', at: AT } }, 'effektiv', label), undefined, 'an answered step takes no typed answer');
});

test('a step stands where it was asked: the AI\'s turns between two answers fall between their steps', () => {
  const steps = setupThread(answered({ company: 'ok', vat: 'effective' }), facts());
  assert.deepEqual(askedAt(steps), ['', '2026-10-21T09:00:00.000Z', '2026-10-21T09:01:00.000Z']);
  // «Etwas ändern» clicked late: the VAT step is put before the opening, which was answered earlier. Its answer still follows its question.
  const late = withAnswer(withAnswer(withAnswer(emptyProgress(), 'opening', { value: 'later', at: '2026-10-21T09:00:00.000Z' }), 'company', { value: 'fix', at: '2026-10-21T09:05:00.000Z' }), 'vat', { value: 'effective', at: '2026-10-21T09:06:00.000Z' });
  const order = setupThread(late, facts());
  assert.deepEqual(ids(order).slice(0, 3), ['company', 'vat', 'opening']);
  order.forEach((s, i) => { if (s.answer) assert.ok(askedAt(order)[i] <= s.answer.at, `${s.id}: asked no later than answered`); });
});

test('every line a step can say has words in each language', async () => {
  const dir = 'src/app/i18n/locales';
  const locales = await Promise.all(readdirSync(dir).filter((f) => f.endsWith('.ts')).map(async (f) => ({ code: f.slice(0, -3), messages: (await import(`../${dir}/${f}`) as { default: Locale }).default.messages as Record<string, unknown> })));
  const keys = new Set<string>();
  const addLine = (l: Line) => { keys.add(l.key); for (const p of Object.values(l.params ?? {})) if (typeof p === 'object' && 'key' in p) keys.add(p.key); };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    if (typeof (v as Line).key === 'string' && (v as Line).key.startsWith('onboarding.')) addLine(v as Line);
    Object.values(v).forEach(walk);
  };
  const vats = [EFFECTIVE_QUARTERLY, NOT_REGISTERED, { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei' }] } as const];
  const answersOf = (q: QuestionId) => QUESTIONS[q] as readonly string[];
  for (const vat of vats) for (const company of answersOf('company')) for (const v of answersOf('vat')) for (const opening of [true, false]) for (const iban of [true, false]) for (const later of ['next', 'later']) {
    const f = facts({ company: { ...facts().company, vat }, sells: SELLS, banks: iban ? IBAN : [], opening: opening ? [{ account: '1020', name: 'Bank', amount: 1 }] : [], partners: { clear: [], mixed: [], rare: iban ? [{ id: 'x', name: 'X', n: 1 }] : [], ruled: 1 } });
    const p = answered({ company, vat: v, sells: 'made+traded', opening: later, bank: later, receipts: later, partners: 'next' });
    walk(setupThread(p, f));
    walk(setupThread(withAnswer(p, 'vat', { value: v as never, at: AT, kept: { before: EFFECTIVE_QUARTERLY, at: AT } }), f));
    walk(setupThread(emptyProgress(), f));
  }
  for (const l of [sellsLine(['made', 'traded', 'services'])]) { keys.add(l.key); for (const p of Object.values(l.params ?? {})) if (typeof p === 'object' && 'list' in p) p.list.forEach((k) => keys.add(k)); }
  for (const k of ['ok', 'fix']) keys.add(`onboarding.q.company.${k}`);
  for (const k of ['first', 'statement', 'lead', 'go', 'title', 'open', 'more']) keys.add(`onboarding.summary.${k}`);
  for (const k of ['onboarding.sum.firstMore', 'onboarding.sources.noAi', 'onboarding.state.notYet']) keys.add(k);
  walk(vats.map(vatLine));
  for (const q of Object.keys(QUESTIONS)) keys.add(`onboarding.question.${q}`);
  for (const k of ['form', 'answer', 'app']) keys.add(`onboarding.origin.${k}`);
  for (const k of ['none', 'effective', 'net-rate']) keys.add(`onboarding.vatCard.to.${k}`);
  assert.ok(keys.size > 70, `the walk reached the conversation (${keys.size} keys)`);
  for (const { code, messages } of locales) {
    const missing = [...keys].filter((k) => !(k in messages));
    assert.deepEqual(missing, [], `${code} has every line`);
  }
});

test('the message note tells the AI the checklist as the app sees it, the answers given and the question on screen', () => {
  const p = withTopic(answered({ company: 'ok', vat: 'effective' }), 'firm', 'done', AT);
  const note = setupNote(p, facts({ closedThrough: '2026-06-30' }), wordsIn('de').t);
  assert.match(note, /- firm: done 2026-10-21 · by hand: Firma › MWST/);
  assert.match(note, /- opening: open ← next · by hand: Firma › Eröffnung/);
  assert.doesNotMatch(note, /periods|history/, 'no topic the app has nothing for');
  assert.equal((note.match(/← next/g) ?? []).length, 1);
  assert.match(note, /- vat: effective/);
  assert.match(note, /Open question on screen: opening, answers next \| later\. .*"kind":"setupAnswer","question":"opening"/);
  assert.match(note, /company: Muster GmbH/);
  assert.match(note, /closed through: 2026-06-30/);
  assert.match(setupNote(p, facts(), wordsIn('en').t), /by hand: Company › VAT/, 'places in the person\'s language');
});

test('answers on disk keep what they know and drop an unknown question, value or broken undo, instead of failing to open', () => {
  const p = parseProgress({ answers: { vat: { value: 'none', at: AT, kept: { before: EFFECTIVE_QUARTERLY, at: AT } }, start: { value: 'someday', at: AT }, payroll: { value: 'x', at: AT }, bank: { value: 'later' } } });
  assert.deepEqual(Object.keys(p.answers), ['vat']);
  assert.equal(p.answers.vat?.kept?.before.registered, true);
  const broken = parseProgress({ answers: { vat: { value: 'none', at: AT, kept: { before: { registered: 'maybe' }, at: AT } } } });
  assert.equal(broken.answers.vat?.kept, undefined, 'an undo that does not parse is dropped, the answer kept');
});

test('the AI answers the open question with `setupAnswer`: checked against the question\'s answers, recorded, and undone to the answer before', () => {
  const block = (c: unknown[]) => `Gut.\n\`\`\`vanilla-changes\n${JSON.stringify(c)}\n\`\`\``;
  assert.deepEqual(changesIn(block([{ kind: 'setupAnswer', question: 'vat', value: 'net-rate' }])), [{ kind: 'setupAnswer', question: 'vat', value: 'net-rate' }]);
  assert.throws(() => changesIn(block([{ kind: 'setupAnswer', question: 'payroll', value: 'x' }])), ChangesError);
  assert.throws(() => changesIn(block([{ kind: 'setupAnswer', question: 'vat', value: 'maybe' }])), ChangesError);
  assert.throws(() => changesIn(block([{ kind: 'setupAnswer', question: 'vat', value: null }])), ChangesError, 'null only in an undo');
  const ws = tempWorkspace('onboarding-');
  const applied = applyWorkspaceChange(ws, { journalEntries: [] } as never, { kind: 'setupAnswer', question: 'vat', value: 'net-rate' });
  assert.equal(readProgress(ws).answers.vat?.value, 'net-rate');
  assert.deepEqual(applied.undo, { kind: 'setupAnswer', question: 'vat', value: null });
  applyWorkspaceChange(ws, { journalEntries: [] } as never, applied.undo!);
  assert.equal(readProgress(ws).answers.vat, undefined, 'the undo takes the answer back');
});

let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/fresh-books-index.json'); });
after(async () => { await api?.stop(); });

test('the API: the view carries the facts, the states and the steps\' answers; an answer is checked and kept, `kept` only for the VAT question', async () => {
  let r = await api.send('GET', '/api/onboarding');
  assert.equal(r.status, 200);
  const view = r.json as { facts: SetupFacts; states: Record<string, string>; progress: SetupProgress };
  assert.equal(view.facts.company.name, api.ws.company.name);
  assert.equal(view.states.firm, 'done', 'the firm as the settings have it: nothing asked');
  r = await api.send('PUT', '/api/onboarding/answers/company', { value: 'ok' });
  assert.equal(r.status, 200);
  assert.equal(readProgress(api.ws).answers.company?.value, 'ok', 'written to the workspace');
  assert.equal((await api.send('PUT', '/api/onboarding/answers/payroll', { value: 'x' })).status, 404);
  assert.equal((await api.send('PUT', '/api/onboarding/answers/filed', { value: '2' })).status, 404, 'a question the setup no longer asks');
  assert.equal((await api.send('PUT', '/api/onboarding/answers/vat', { value: 'maybe' })).status, 400);
  assert.equal((await api.send('PUT', '/api/onboarding/answers/bank', { value: 'later', kept: NOT_REGISTERED })).status, 400, 'kept belongs to the VAT question');
  assert.equal((await api.send('PUT', '/api/onboarding/answers/vat', { value: 'none', kept: { registered: 'maybe' } })).status, 400, 'a setup that does not parse');
  r = await api.send('PUT', '/api/onboarding/answers/vat', { value: 'none', kept: EFFECTIVE_QUARTERLY });
  assert.deepEqual(readProgress(api.ws).answers.vat?.kept?.before, EFFECTIVE_QUARTERLY);
  await api.send('PUT', '/api/onboarding/answers/vat', { value: 'none' });
  assert.ok(readProgress(api.ws).answers.vat?.kept, 'the same answer again keeps what it kept');
  await api.send('PUT', '/api/onboarding/answers/vat', { value: 'effective' });
  assert.equal(readProgress(api.ws).answers.vat?.kept, undefined, 'a new answer drops the old one\'s undo');
  await api.send('PUT', '/api/onboarding/answers/vat', { value: null });
  assert.equal(readProgress(api.ws).answers.vat, undefined, 'null takes the answer back');
});
