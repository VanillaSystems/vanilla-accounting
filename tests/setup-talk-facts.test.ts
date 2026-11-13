/**
 * The setup conversation keeps to the app's facts (#496, round-8 walks r6-5..r6-7), with the AI
 * stubbed: a reply that names an opening other than 1.1. / 31.12. is not shown as said, the app's
 * sentence stands instead; a typed correction of the starting point sets `profile.start` and is shown
 * as hers, never «angenommen», without asking the VAT method or the sales again; a typed sentence adds
 * to the bank accounts the form holds and never drops an IBAN she typed there. Each test names the
 * wrong behaviour it catches.
 */
import './support/demo-workspace.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptToOpening, openingFact, strayOpening } from '../src/onboarding/opening-claim.js';
import { applyTalk, talkPrompt, type TalkOutput } from '../src/onboarding/draft-talk.js';
import { draftSteps, newDraft, withPatch, type SetupDraft } from '../src/onboarding/draft.js';
import { checkPatch } from '../src/onboarding/draft-store.js';
import { setupThread, topicStates } from '../src/onboarding/conversation.js';
import { emptyProgress, withAnswer, type Answer, type QuestionId, type SetupProgress } from '../src/onboarding/model.js';
import { setupNote, setupSpecialist } from '../src/onboarding/prompt.js';
import type { SetupFacts } from '../src/onboarding/facts.js';
import { readProgress } from '../src/onboarding/store.js';
import { changesIn } from '../src/assistant/changes.js';
import { applyWorkspaceChange } from '../src/server/workspace-edits.js';
import { wordsIn } from '../src/export/texts.js';
import { EFFECTIVE_QUARTERLY } from '../src/workspace/vat-setup.js';
import { MANIFEST_FILE, workspaceAt } from '../src/workspace/workspace.js';
import { tempWorkspace } from './support/workspace.js';
import { startApi, type ApiServer } from './support/api-server.js';
import { testIban } from './support/iban.js';
import type { AssistantEvent, Conversation, Turn } from '../src/types/assistant.js';

const de = wordsIn('de').t;
const IBAN = testIban('00787000012345678');

// The two replies of the round-8 walks, word for word as the findings quote them.
const WEBSHOP = 'Dann ist die Zwischenbilanz vom 30.6.2026 die richtige. Seine Endsalden vom 30. Juni sind also deine Anfangssalden. Du trägst sie in Firma › Eröffnung ein. Die Bilanz vom 31.12.2025 brauchst du dafür nicht.';
const CONSULTING = 'Die Bücher hier beginnen mit dem ersten Kontoauszug im Juli. Die Eröffnungssalden per 1. Juli trägst du von Hand ein.';

test('r6-5, r6-7: a reply that ties the opening to a day other than 1.1. or 31.12. is caught, in any of the app\'s languages', () => {
  assert.deepEqual(strayOpening(WEBSHOP), [
    'Dann ist die Zwischenbilanz vom 30.6.2026 die richtige.',
    'Seine Endsalden vom 30. Juni sind also deine Anfangssalden.',
    'Die Bilanz vom 31.12.2025 brauchst du dafür nicht.',
  ], 'the interim balance sheet, the Endsalden of 30 June, and the year-end balance sheet called not needed; «Du trägst sie in Firma › Eröffnung ein» stays');
  assert.deepEqual(strayOpening(CONSULTING), ['Die Eröffnungssalden per 1. Juli trägst du von Hand ein.']);
  for (const wrong of [
    'The opening balances are as at 30 June 2026.',
    'Les soldes d’ouverture valent au 1er juillet.',
    'I saldi di apertura valgono al 30.06.2026.',
    'Opening as of 2026-07-01.',
    'Die Eröffnungssalden nimmst du aus der Bilanz per Ende Juni.',
    'Die Eröffnung gilt per Mitte Jahr.',
  ]) assert.ok(strayOpening(wrong).length, wrong);
});

test('a reply that keeps to the facts is not caught: a statement date beside the opening, a negated interim balance sheet, an account opened, a due date', () => {
  for (const right of [
    'Die Eröffnung gilt per 01.01.2026: nimm alle Zahlen aus der Bilanz per 31.12.2025.',
    'Die Eröffnungssalden per 1. Januar kommen aus der Bilanz vom 31. Dezember 2025.',
    'The opening holds as at 1 January, from the balance sheet as at December 31.',
    'Die erste Abrechnung ist am 30.11. fällig.',
    'Die MWST beträgt 8.1 %, die Eröffnung erfasst du unter Firma › Eröffnung.',
    'Die Eröffnung bleibt per 1. Januar, lies die Kontoauszüge ab dem 1. Juli ein.',
    'Nimm nicht die Zwischenbilanz, sondern die Bilanz per 31.12.2025.',
    'Die Kontoeröffnung bei der UBS war am 15.03.2026.',
    'L’ouverture du compte Wise date du 3 mars.',
    'Erfasse die Eröffnung bis zum 30.11., dann ist die Abrechnung fällig.',
    'Der Eröffnungssaldo, den die Bank vor dem Auszug vom 01.07.2026 nennt, ist kein Saldo per 1.1.',
    'Die alten Kontoauszüge brauchst du nicht, nur die Bilanz per 31.12.2025.',
  ]) assert.deepEqual(strayOpening(right), [], right);
});

test('the app\'s sentence stands in place of the stray sentences only, in the person\'s language, with the year\'s dates; a right reply is shown as said', () => {
  const kept = keptToOpening(WEBSHOP, de, '2026');
  assert.equal(kept.withdrawn, WEBSHOP, 'what the model said is kept, not shown');
  assert.equal(kept.text, `${openingFact(de, '2026')} Du trägst sie in Firma › Eröffnung ein.`);
  assert.equal(openingFact(de, '2026'), 'Die Eröffnung gilt in der App immer per 01.01.2026: alle Zahlen kommen aus der Bilanz per 31.12.2025, nie aus einer Zwischenbilanz, auch wenn die Firma im Lauf des Jahres wechselt. Du trägst sie unter Firma › Eröffnung ein.');
  const mixed = keptToOpening('Gute Frage. Die Eröffnungssalden per 1. Juli trägst du von Hand ein.\n\nDie Belege holst du per Mail.', de, '2026');
  assert.equal(mixed.text, `Gute Frage. ${openingFact(de, '2026')}\n\nDie Belege holst du per Mail.`, 'the reply\'s other sentences stay');
  assert.match(openingFact(wordsIn('en').t, '2027'), /as at 01\.01\.2027: every figure comes from the balance sheet as at 31\.12\.2026/);
  assert.deepEqual(keptToOpening('Lies den Kontoauszug ein.', de, '2026'), { text: 'Lies den Kontoauszug ein.' });
});

test('the setup prompts state where the books begin and the opening facts, and nothing the app does not do', () => {
  for (const prompt of [setupSpecialist(de), talkPrompt(withPatch(newDraft('de', '2026-11-13T09:00:00.000Z'), { step: 'firm', value: { name: 'Muster GmbH', owner: 'Anna Muster' } }), 'x', [], 'CHF')]) {
    assert.match(prompt, /the filing period of its first payment is the first one here, and what lies before stays in their old program/);
    assert.match(prompt, /always per 1 January/);
    assert.match(prompt, /never from an interim balance sheet/);
    assert.match(prompt, /differs from the bank's balance by what was paid before the first statement/, 'the consequence of a later first statement');
    assert.doesNotMatch(prompt, /statements of those first months are read in|compared with the returns as filed and closed/, 'setup reads in no earlier quarter and closes none');
  }
  assert.match(setupSpecialist(de), /"question":"startingPoint"/, 'the AI can record her correction of the starting point');
});

// Before the books: the draft's typed conversation (src/onboarding/draft-talk.ts).
const banksDraft = (): SetupDraft => withPatch(newDraft('de', '2026-11-13T09:00:00.000Z'), checkPatch({ step: 'banks', value: [{ bank: 'Zuger Kantonalbank', currency: 'CHF', iban: IBAN }] }));
const out = (o: Partial<TalkOutput>): TalkOutput => ({ say: '', answers: {}, ...o });
const PHONE = 's Gschäftshandy bruuch ich au privat, öppe d Hälfti. Und en Kunde in Berlin zahlt in Euro uf mis Wise-Konto.';

const banksOf = (d: SetupDraft) => d.banks?.map((b) => [b.bank, b.currency, b.iban]);
const reasons = (r: ReturnType<typeof applyTalk>) => (r.reply.kind === 'read' ? r.reply.refused.map((x) => x.refusal.reason) : []);

test('r6-6: a typed sentence adds Wise to the bank accounts of the form and keeps the IBAN she typed there, refusing nothing', () => {
  const d = banksDraft();
  assert.equal(d.banks?.[0].iban, IBAN);
  const whole = applyTalk(d, out({ banks: [{ bank: 'Zuger Kantonalbank', currency: 'CHF', iban: IBAN }, { bank: 'Wise', currency: 'EUR' }] }), [PHONE], 'CHF', '2026');
  assert.deepEqual(reasons(whole), [], 'was «Die IBAN … steht nicht in deinen Worten»: the IBAN is hers, from the form');
  assert.deepEqual(banksOf(whole.draft), [['Zuger Kantonalbank', 'CHF', IBAN], ['Wise', 'EUR', undefined]]);
  // The model leaves out the IBAN, or the bank: the form's values stay.
  const bare = applyTalk(d, out({ banks: [{ bank: 'Zuger Kantonalbank', currency: 'CHF' }, { bank: 'Wise', currency: 'EUR' }] }), [PHONE], 'CHF', '2026');
  assert.equal(bare.draft.banks?.[0].iban, IBAN, 'an IBAN the model dropped is not taken away');
  const only = applyTalk(d, out({ banks: [{ bank: 'Wise', currency: 'EUR' }] }), [PHONE], 'CHF', '2026');
  assert.deepEqual(only.draft.banks?.map((b) => b.bank), ['Zuger Kantonalbank', 'Wise'], 'a bank account of the form is never removed by a sentence');
  // An IBAN in neither her words nor the form is still refused.
  const made = applyTalk(d, out({ banks: [{ bank: 'Wise', currency: 'EUR', iban: testIban('00762011623852957') }] }), [PHONE], 'CHF', '2026');
  assert.deepEqual(reasons(made), ['notStated']);
  assert.equal(made.draft.banks?.find((b) => b.bank === 'Wise')?.iban, undefined);
});

test('the bank merge matches by IBAN first: a second account of the same bank is never dropped silently, the form\'s IBAN never overwritten nor lent to another bank', () => {
  const d = withPatch(newDraft('de', '2026-11-13T09:00:00.000Z'), checkPatch({ step: 'banks', value: [{ bank: 'UBS', currency: 'CHF', iban: IBAN }] }));
  const B = testIban('00762011623852957');
  const second = `noch ein zweites UBS-Konto, ${B}`;
  // [UBS A, UBS B]: the books keep one account per bank and currency, so B is refused and said why, never dropped while «say» claims it.
  const both = applyTalk(d, out({ say: 'Ich habe das zweite Konto ergänzt.', banks: [{ bank: 'UBS', currency: 'CHF', iban: IBAN }, { bank: 'UBS', currency: 'CHF', iban: B }] }), [second], 'CHF', '2026');
  assert.deepEqual(reasons(both), ['bankTwice']);
  assert.equal(both.reply.kind === 'read' && both.reply.say, '', 'the model\'s claim is not shown beside the refusal');
  assert.deepEqual(banksOf(both.draft), [['UBS', 'CHF', IBAN]]);
  // The order the model writes them in changes nothing: [UBS B, UBS A] keeps A and refuses B, as [UBS A, UBS B] does.
  const turned = applyTalk(d, out({ banks: [{ bank: 'UBS', currency: 'CHF', iban: B }, { bank: 'UBS', currency: 'CHF', iban: IBAN }] }), [second], 'CHF', '2026');
  assert.deepEqual(reasons(turned), ['bankTwice'], 'was: B overwrote A by the correction rule, then A was refused');
  assert.deepEqual(banksOf(turned.draft), [['UBS', 'CHF', IBAN]]);
  // [UBS B] alone, B not in her words: A is not overwritten.
  const alone = applyTalk(d, out({ banks: [{ bank: 'UBS', currency: 'CHF', iban: B }] }), ['noch ein UBS-Konto'], 'CHF', '2026');
  assert.deepEqual(banksOf(alone.draft), [['UBS', 'CHF', IBAN]], 'was: A replaced by B');
  assert.deepEqual(reasons(alone), ['notStated']);
  // Wise EUR with the form's UBS IBAN: that IBAN is UBS's, not Wise's.
  const lent = applyTalk(d, out({ banks: [{ bank: 'UBS', currency: 'CHF', iban: IBAN }, { bank: 'Wise', currency: 'EUR', iban: IBAN }] }), ['und Wise in Euro'], 'CHF', '2026');
  assert.deepEqual(reasons(lent), ['notStated'], 'was: accepted because the form holds it for another account');
  assert.deepEqual(banksOf(lent.draft), [['UBS', 'CHF', IBAN], ['Wise', 'EUR', undefined]]);
  // A second UBS account in another currency is added.
  const eur = applyTalk(d, out({ banks: [{ bank: 'UBS', currency: 'CHF', iban: IBAN }, { bank: 'UBS', currency: 'EUR' }] }), ['und ein UBS-Konto in Euro'], 'CHF', '2026');
  assert.deepEqual(banksOf(eur.draft), [['UBS', 'CHF', IBAN], ['UBS', 'EUR', undefined]]);
});

test('an IBAN her words state for the one account of a bank and currency corrects the one typed in the form; the other accounts are not touched', () => {
  const B = testIban('00762011623852957');
  const d = withPatch(newDraft('de', '2026-11-13T09:00:00.000Z'), checkPatch({ step: 'banks', value: [{ bank: 'UBS', currency: 'CHF', iban: IBAN }, { bank: 'UBS', currency: 'EUR' }, { bank: 'Wise', currency: 'USD' }] }));
  const fixed = applyTalk(d, out({ banks: [{ bank: 'UBS', currency: 'CHF', iban: B }] }), [`die IBAN ist falsch, richtig ist ${B}`], 'CHF', '2026');
  assert.deepEqual(reasons(fixed), [], 'was: refused as bankTwice');
  assert.deepEqual(banksOf(fixed.draft), [['UBS', 'CHF', B], ['UBS', 'EUR', undefined], ['Wise', 'USD', undefined]]);
  // A malformed IBAN in her words is refused by the click's check, and the form's stays.
  const bad = applyTalk(d, out({ banks: [{ bank: 'UBS', currency: 'CHF', iban: 'CH12 3456' }] }), ['richtig ist CH12 3456'], 'CHF', '2026');
  assert.deepEqual(reasons(bad), ['iban']);
  assert.equal(bad.draft.banks?.[0].iban, IBAN);
});

test('in the books an IBAN is never required either: a bank account without one sets up the bank topic and counts in the summary', () => {
  const noIban = [{ label: 'UBS', bank: 'UBS', currency: 'CHF', account: '1020' }, { label: 'Wise', bank: 'Wise', currency: 'EUR', account: '1021' }];
  const f = facts({ banks: noIban });
  assert.equal(topicStates(emptyProgress(), f).bank, 'done', 'was: open until «Später» while no account had an IBAN');
  const steps = setupThread(answered([['opening', 'later'], ['receipts', 'later']]), f);
  assert.ok(!ids(steps).includes('bank'), 'the bank step is not walked through');
  const card = steps.at(-1)?.card;
  assert.ok(card?.kind === 'summary' && card.items.some((i) => i.what.key === 'onboarding.sum.banks' && i.what.params?.n === 2), 'every bank account counts');
  assert.equal(de('onboarding.sum.banks', { n: 2 }), '2 Bankkonten', 'no «mit IBAN»');
  assert.equal(topicStates(emptyProgress(), facts()).bank, 'open', 'no bank account at all: asked');
  assert.doesNotMatch(setupSpecialist(de), /bank accounts with their IBAN/);
});

test('an IBAN is never required: two banks without one complete the setup, and a sentence adds a bank without one', () => {
  let d = withPatch(withPatch(newDraft('de', '2026-11-13T09:00:00.000Z'), { step: 'firm', value: { name: 'Muster GmbH', owner: 'Anna Muster' } }), { step: 'preset', value: 'consultant' });
  for (const [key, value] of [['vatRegistered', 'yes'], ['vatMethod', 'effective'], ['basis', 'received'], ['period', 'quarterly']] as const) d = withPatch(d, { step: 'question', key, value });
  d = withPatch(d, checkPatch({ step: 'banks', value: [{ bank: 'UBS', currency: 'CHF' }, { bank: 'Wise', currency: 'EUR' }] }));
  assert.equal(draftSteps(d).at(-1)?.id, 'review', 'two banks without an IBAN: the setup is complete');
  const more = applyTalk(d, out({ banks: [{ bank: 'UBS', currency: 'CHF' }, { bank: 'Wise', currency: 'EUR' }, { bank: 'PostFinance', currency: 'CHF' }] }), ['und noch ein Konto bei der PostFinance'], 'CHF', '2026');
  assert.deepEqual(reasons(more), [], 'nothing refused, nothing asks for an IBAN');
  assert.deepEqual(banksOf(more.draft), [['UBS', 'CHF', undefined], ['Wise', 'EUR', undefined], ['PostFinance', 'CHF', undefined]]);
  assert.equal(draftSteps(more.draft).at(-1)?.id, 'review');
  // An IBAN she writes for an account without one fills it.
  const filled = applyTalk(d, out({ banks: [{ bank: 'UBS', currency: 'CHF', iban: IBAN }] }), [`die UBS hat ${IBAN}`], 'CHF', '2026');
  assert.deepEqual(banksOf(filled.draft), [['UBS', 'CHF', IBAN], ['Wise', 'EUR', undefined]]);
});

test('before the books: «d Firma isch nöd neu» sets the starting point from her words, and a reply that names a mid-year opening shows the app\'s sentence', () => {
  const d = withPatch(withPatch(newDraft('de', '2026-11-13T09:00:00.000Z'), { step: 'firm', value: { name: 'Teegarten GmbH', owner: 'Corinne Muster' } }), { step: 'preset', value: 'webshop' });
  assert.ok(d.assumed?.includes('start'), 'the kind of firm assumed «neue Firma»');
  const r = applyTalk(d, out({ say: CONSULTING, answers: { start: 'switching' } }), ['nei, d Firma isch nöd neu, bis Juni het de Treuhänder d Buechhaltig gmacht'], 'CHF', '2026');
  assert.equal(r.draft.answers.start, 'switching');
  assert.ok(!r.draft.assumed?.includes('start'), 'hers now, no longer «angenommen»');
  assert.ok(r.draft.fromText?.includes('start'), 'marked «aus deiner Nachricht»');
  assert.equal(r.reply.kind === 'read' && r.reply.say, `Die Bücher hier beginnen mit dem ersten Kontoauszug im Juli. ${openingFact(de, '2026')}`, 'not «per 1. Juli»: that sentence alone gives way');
});

// In the books: the setup conversation (src/onboarding/conversation.ts, the AI's setupAnswer).
const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  today: '2026-11-13', year: '2026',
  company: { name: 'Muster GmbH', owner: 'Anna Muster', legalForm: 'GmbH', vat: EFFECTIVE_QUARTERLY },
  banks: [], sources: [], opening: [], books: { payments: 0, receipts: 0, entries: 0 },
  partners: { clear: [], mixed: [], rare: [], ruled: 0 }, rules: 0,
  sells: { kinds: ['services'], accounts: { made: { purchase: '4000', sales: '3000' }, traded: { purchase: '4200', sales: '3200' }, services: { sales: '3400' } } },
  start: 'new', assumed: { by: 'consultant', answers: [{ key: 'start', value: 'new' }] },
  ...over,
});
const answered = (pairs: Array<[QuestionId, string]>, p: SetupProgress = emptyProgress()): SetupProgress =>
  pairs.reduce((acc, [q, value], i) => withAnswer(acc, q, { value, at: `2026-11-13T09:0${i}:00.000Z` } as Answer), p);
const ids = (steps: ReturnType<typeof setupThread>) => steps.map((s) => s.id);

test('r6-7: «Etwas ändern», then «mir sind kei neui Firma»: the starting point is the one answer that changes; the VAT method and the sales are not asked again', () => {
  const fix = answered([['company', 'fix']]);
  assert.deepEqual(ids(setupThread(fix, facts())), ['company', 'vat'], 'before her words: «Etwas ändern» asks the VAT');
  const corrected = answered([['company', 'fix'], ['startingPoint', 'switching']]);
  // The app reads the profile again after the answer: the starting point is the manifest's now.
  const after = facts({ start: 'switching', assumed: undefined });
  const steps = setupThread(corrected, after);
  assert.deepEqual(ids(steps), ['company', 'opening'], 'was: the VAT method asked again, then the sales');
  assert.deepEqual(steps[0].reply?.lines.map((l) => l.key), ['onboarding.r.startingPoint.switching']);
  assert.equal(steps[1].say[0].key, 'onboarding.s.openingNoneSwitching', 'the opening step speaks of the old books\' balance sheet per 31.12.');
  assert.equal(topicStates(corrected, after).firm, 'done');
});

test('r6-6: the starting point she typed is in the summary as her answer, and «neue Firma … angenommen» is gone', () => {
  const p = answered([['opening', 'later'], ['bank', 'later'], ['receipts', 'later'], ['startingPoint', 'switching']]);
  // Whatever the profile reads now, the assumed line goes once she said it.
  for (const f of [facts({ start: 'switching', assumed: undefined }), facts()]) {
    const summary = setupThread(p, f).at(-1)!;
    assert.equal(summary.id, 'summary');
    const card = summary.card?.kind === 'summary' ? summary.card : undefined;
    assert.ok(card?.items.some((i) => i.what.key === 'onboarding.sum.startingPoint.switching' && i.origin === 'answer'));
    assert.ok(!card?.assumed?.answers.some((a) => a.key === 'start'), 'not also «angenommen»');
  }
  const note = setupNote(answered([['startingPoint', 'switching']]), facts({ start: 'switching', assumed: undefined }), de);
  assert.match(note, /starting point \(Ausgangslage\): switching from other bookkeeping \(said by the person\)/);
  assert.match(setupNote(emptyProgress(), facts(), de), /starting point \(Ausgangslage\): new firm, empty books \(assumed by the kind of firm, not said by the person\)/, 'the AI knows it is only assumed');
});

const PROFILE = '\nprofile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: "yes"\n  imports: "no"\n  employees: owner\n  ownerPaysPrivately: "yes"\n  privateUse: []\n  payouts: "no"\n';

test('the AI\'s setupAnswer startingPoint writes the profile\'s start, and its undo puts back the one before', () => {
  const ws0 = tempWorkspace('setup-facts-');
  writeFileSync(ws0.paths.manifest, readFileSync(ws0.paths.manifest, 'utf8') + PROFILE);
  let ws = workspaceAt(ws0.paths.root);
  assert.equal(ws.profile?.start, 'new');
  const [change] = changesIn('```vanilla-changes\n[{"kind":"setupAnswer","question":"startingPoint","value":"switching"}]\n```');
  assert.equal(change.kind, 'setupAnswer', 'the block parses: the question exists');
  const applied = applyWorkspaceChange(ws, { journalEntries: [] } as never, change as never);
  ws = workspaceAt(ws0.paths.root);
  assert.equal(ws.profile?.start, 'switching', 'was: `profile.start: new` kept');
  assert.equal(readProgress(ws).answers.startingPoint?.value, 'switching');
  assert.deepEqual(applied.undo, { kind: 'setupAnswer', question: 'startingPoint', value: null, start: 'new' });
  applyWorkspaceChange(ws, { journalEntries: [] } as never, applied.undo!);
  ws = workspaceAt(ws0.paths.root);
  assert.equal(ws.profile?.start, 'new', 'the undo puts back the starting point');
  assert.equal(readProgress(ws).answers.startingPoint, undefined);
  assert.equal(readFileSync(join(ws0.paths.root, MANIFEST_FILE), 'utf8').includes('start: new'), true);
});

// The whole way: the API server with the claude stub, a setup conversation.
const log = mkdtempSync(join(tmpdir(), 'setup-facts-'));
const TEXT = join(log, 'text.txt');
const CHANGES = join(log, 'changes.json');
let api: ApiServer;
before(async () => { api = await startApi('tests/fixtures/fresh-books-index.json', { PATH: `${join(process.cwd(), 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_TEXT: TEXT, CLAUDE_STUB_CHANGES: CHANGES }); });
after(async () => { await api?.stop(); rmSync(log, { recursive: true, force: true }); });

async function say(text: string, purpose?: 'onboarding') {
  writeFileSync(TEXT, text);
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'ich han zwei Bilanze, vom 31.12.2025 und vom 30.6.2026', language: 'de', context: [], ...(purpose ? { purpose } : {}) }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  const id = (events[0] as { id: string }).id;
  const turn = ((await api.send('GET', `/api/assistant/${id}`)).json as unknown as Conversation).turns.at(-1) as Extract<Turn, { role: 'ai' }>;
  return { events, turn };
}

test('r6-5 in the app: the setup conversation shows the app\'s sentence instead of «die Zwischenbilanz vom 30.6.2026 ist die richtige», and keeps what the model said', async () => {
  const { events, turn } = await say(WEBSHOP, 'onboarding');
  const year = String(new Date().getFullYear());
  assert.ok(turn.withdrawn?.includes('Zwischenbilanz vom 30.6.2026'), 'the model\'s words are kept, withdrawn');
  assert.ok(!turn.text.includes('Zwischenbilanz vom 30.6.2026'), 'and not shown');
  assert.match(turn.text, /per 01\.01\.\d{4}: alle Zahlen kommen aus der Bilanz per 31\.12\.\d{4}/);
  assert.ok(turn.text.includes(`per 01.01.${year}`) || turn.text.includes(`per 01.01.${Number(year) - 1}`), 'the books\' open year');
  const replaced = events.filter((e): e is Extract<AssistantEvent, { type: 'replace' }> => e.type === 'replace').at(-1);
  assert.equal(replaced?.text, turn.text, 'the sidebar gets the app\'s sentence');
  // Only the setup's words are held to it: an ordinary conversation is shown as the model said it.
  const plain = await say(WEBSHOP);
  assert.equal(plain.turn.withdrawn, undefined);
  assert.ok(plain.turn.text.includes('Zwischenbilanz vom 30.6.2026'));
});

test('an answer whose change the app refused is said again within the same facts, and what the model first said stays withdrawn', async () => {
  writeFileSync(CHANGES, JSON.stringify([{ kind: 'setupAnswer', question: 'startingPoint', value: 'someday' }]));
  try {
    const { turn } = await say(CONSULTING, 'onboarding');
    assert.ok(turn.refused, 'the change does not parse: refused');
    assert.ok(turn.withdrawn?.includes('Die Eröffnungssalden per 1. Juli'), 'was: overwritten by the text already kept');
    assert.ok(!turn.text.includes('per 1. Juli'), 'the answer said again does not bring it back');
    assert.match(turn.text, /Die Eröffnung gilt in der App immer per 01\.01\./);
  } finally { rmSync(CHANGES, { force: true }); }
});
