/**
 * The setup conversation as code draws it (docs/0.4.0/onboarding.md, src/onboarding/conversation.ts):
 * the steps from the answers and the facts, the topics as the app sees them, the partner bins, the
 * words every step can say in each language, the answers over HTTP, and the AI's `setupAnswer`.
 * Each test names the wrong behaviour it catches.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { setupThread, topicStates, typedChoice, askedAt, openStep, vatLine, type Line, type SetupStep } from '../src/onboarding/conversation.js';
import { emptyProgress, parseProgress, withAnswer, withTopic, QUESTIONS, type Answer, type QuestionId, type SetupProgress } from '../src/onboarding/model.js';
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
const ALL = { company: 'ok', vat: 'effective', start: 'year', filed: '0', program: 'bexio', entry: 'double', access: 'me', needs: 'ok', opening: 'next', bank: 'next', receipts: 'next', partners: 'next' } as const;

test('a fresh setup draws its first turn from what the app knows, with no AI: the greeting, the company card and two answers', () => {
  const steps = setupThread(emptyProgress(), facts());
  assert.deepEqual(ids(steps), ['company']);
  const s = steps[0];
  assert.equal(s.answer, undefined);
  assert.equal(s.say[0].key, 'onboarding.s.hello');
  assert.deepEqual(s.say[0].params, { owner: 'Anna' }, 'greets the owner by first name');
  assert.equal(s.card?.kind, 'company');
  assert.deepEqual(s.choices.map((c) => c.value), ['ok', 'fix']);
  assert.equal(setupThread(emptyProgress(), facts({ company: { ...facts().company, owner: '' } }))[0].say[0].key, 'onboarding.s.helloNoName');
});

test('the steps stop at the first open question and go on in the prototype\'s order once each is answered', () => {
  let p = emptyProgress();
  const seen: string[] = [];
  for (const [q, v] of Object.entries(ALL)) {
    const open = last(setupThread(p, facts()));
    assert.equal(open.id, q, `${q} is asked after ${seen.at(-1) ?? 'the start'}`);
    assert.ok(open.choices.some((c) => c.value === v), `${q} offers ${v}`);
    seen.push(q);
    p = answered({ [q]: v }, p);
  }
  const steps = setupThread(p, facts());
  assert.equal(last(steps).id, 'summary', 'all answered: the summary closes the conversation');
  assert.equal(openStep(steps), undefined, 'the summary is no question');
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

test('which returns were filed is asked only of a registered firm, with only the periods already over, and a filed quarter waits for the import', () => {
  const p = answered({ company: 'ok', vat: 'effective', start: 'during' });
  const filed = last(setupThread(p, facts()));
  assert.equal(filed.id, 'filed');
  assert.deepEqual(filed.choices.map((c) => c.label.key), ['onboarding.q.filed.0', 'onboarding.q.filed.q1', 'onboarding.q.filed.q2', 'onboarding.q.filed.q3'], 'Q4 is not over on 21 October');
  assert.equal(last(setupThread(answered({ company: 'ok', vat: 'none', start: 'year' }), facts({ company: { ...facts().company, vat: NOT_REGISTERED } }))).id, 'program', 'a firm without VAT files nothing');
  assert.equal(last(setupThread(answered({ company: 'ok', vat: 'effective', start: 'year' }), facts({ today: '2026-02-10' }))).id, 'program', 'no quarter over yet: nothing to ask');
  const half = last(setupThread(answered({ company: 'ok', vat: 'net-rate', start: 'during' }), facts()));
  assert.deepEqual(half.choices.map((c) => c.label.key), ['onboarding.q.filed.0', 'onboarding.q.filed.h1'], 'the net tax rate files half years');

  const two = answered({ company: 'ok', vat: 'effective', start: 'during', filed: '2' });
  assert.equal(setupThread(two, facts()).find((s) => s.id === 'filed')!.reply?.lines[0].key, 'onboarding.r.filedLater', 'no comparison in the app yet: said so');
  assert.equal(topicStates(two, facts()).periods, 'skipped');
  assert.equal(topicStates(two, facts({ closedThrough: '2026-06-30' })).periods, 'done', 'sealed through Q2: done');
  assert.equal(setupThread(two, facts({ closedThrough: '2026-06-30' })).find((s) => s.id === 'filed')!.reply?.lines[0].key, 'onboarding.r.filedSealed');
});

test('the old program decides what is asked: a new firm has no history, an accountant\'s books need no login, the needs card says the import is a later step', () => {
  const base = { company: 'ok', vat: 'effective', start: 'year', filed: '0' } as const;
  assert.equal(last(setupThread(answered({ ...base, program: 'new' }), facts())).id, 'opening');
  assert.equal(topicStates(answered({ ...base, program: 'new' }), facts()).history, 'done');
  assert.deepEqual(ids(setupThread(answered({ ...base, program: 'accountant', entry: 'double' }), facts())).slice(-1), ['needs'], 'no question who has the login');
  const needs = last(setupThread(answered({ ...base, program: 'bexio', entry: 'single', access: 'accountant' }), facts()));
  assert.equal(needs.card?.kind, 'needs');
  if (needs.card?.kind !== 'needs') return;
  assert.ok(!needs.card.items.some((i) => i.what.key === 'onboarding.needs.chart'), 'single entry: no chart to bring');
  assert.ok(needs.card.items.every((i) => i.who.key !== 'onboarding.needs.who.export' ), 'the accountant brings it');
  assert.equal(needs.card.note.key, 'onboarding.needs.later', 'no fake import: the card says it is a later step');
  assert.equal(topicStates(answered({ ...base, program: 'bexio', entry: 'double', access: 'me', needs: 'ok' }), facts()).history, 'skipped', 'history left for the import, not done');
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

test('the summary says what the app knows and where from, and lists what is still open with its place by hand', () => {
  const p = answered(ALL);
  const sum = last(setupThread(p, facts({ banks: [{ label: 'Bank', bank: 'b', currency: 'CHF', account: '1020', iban: 'CH93' }] })));
  assert.equal(sum.card?.kind, 'summary');
  if (sum.card?.kind !== 'summary') return;
  const origin = (key: string) => sum.card?.kind === 'summary' && sum.card.items.find((i) => i.what.key === key)?.origin;
  assert.equal(origin('onboarding.sum.company'), 'answer');
  assert.equal(origin('onboarding.sum.banks'), 'app');
  assert.equal(origin('onboarding.sum.program'), 'later', 'the import from Bexio is a later step');
  assert.equal(origin('onboarding.sum.openingNone'), 'open');
  assert.deepEqual(sum.card.open.map((o) => o.topic), ['history', 'opening', 'receipts'], 'open or skipped topics, each with its place');
  assert.deepEqual(sum.card.open.find((o) => o.topic === 'opening')?.go, { area: 'company', section: 'opening' });
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
  const step = setupThread(answered({ company: 'ok' }), facts()).at(-1)!;
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
  for (const vat of vats) for (const today of ['2026-10-21', '2027-01-15']) for (const program of answersOf('program')) for (const v of answersOf('vat')) for (const start of answersOf('start')) for (const filed of answersOf('filed')) for (const entry of answersOf('entry')) for (const access of answersOf('access')) {
    const f = facts({ today, company: { ...facts().company, vat }, opening: program === 'banana' ? [{ account: '1020', name: 'Bank', amount: 1 }] : [], partners: { clear: [], mixed: [], rare: program === 'excel' ? [{ id: 'x', name: 'X', n: 1 }] : [], ruled: 1 } });
    const p = answered({ company: 'fix', vat: v, start, filed, program, entry, access, needs: 'ok', opening: 'later', bank: 'later', receipts: 'later', partners: 'next' });
    walk(setupThread(p, f));
    walk(setupThread(withAnswer(p, 'vat', { value: v as never, at: AT, kept: { before: EFFECTIVE_QUARTERLY, at: AT } }), f));
  }
  walk(vats.map(vatLine));
  for (const q of Object.keys(QUESTIONS)) keys.add(`onboarding.question.${q}`);
  for (const k of ['form', 'answer', 'app', 'later', 'open']) keys.add(`onboarding.origin.${k}`);
  for (const k of ['none', 'effective', 'net-rate']) keys.add(`onboarding.vatCard.to.${k}`);
  assert.ok(keys.size > 120, `the walk reached the conversation (${keys.size} keys)`);
  for (const { code, messages } of locales) {
    const missing = [...keys].filter((k) => !(k in messages));
    assert.deepEqual(missing, [], `${code} has every line`);
  }
});

test('the message note tells the AI the checklist as the app sees it, the answers given and the question on screen', () => {
  const p = withTopic(answered({ company: 'ok', vat: 'effective' }), 'firm', 'done', AT);
  const note = setupNote(p, facts({ closedThrough: '2026-06-30' }), wordsIn('de').t);
  assert.match(note, /- firm: done 2026-10-21 · by hand: Firma › MWST/);
  assert.match(note, /- periods: open ← next · by hand: Firma › /);
  assert.match(note, /- history: open · by hand: no place of its own/);
  assert.equal((note.match(/← next/g) ?? []).length, 1);
  assert.match(note, /- vat: effective/);
  assert.match(note, /Open question on screen: start, answers year \| during\. .*"kind":"setupAnswer","question":"start"/);
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
  assert.equal(view.states.firm, 'open');
  r = await api.send('PUT', '/api/onboarding/answers/company', { value: 'ok' });
  assert.equal(r.status, 200);
  assert.equal(readProgress(api.ws).answers.company?.value, 'ok', 'written to the workspace');
  assert.equal((await api.send('PUT', '/api/onboarding/answers/payroll', { value: 'x' })).status, 404);
  assert.equal((await api.send('PUT', '/api/onboarding/answers/vat', { value: 'maybe' })).status, 400);
  assert.equal((await api.send('PUT', '/api/onboarding/answers/start', { value: 'year', kept: NOT_REGISTERED })).status, 400, 'kept belongs to the VAT question');
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
