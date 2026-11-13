/**
 * Words typed in the setup before the books exist (#145, src/onboarding/draft-talk.ts), with the
 * model stubbed: one message fills several answers, code refuses what createWorkspace would refuse
 * or what the person never wrote (a UID, an IBAN) and says why, a question gets an answer and
 * changes nothing, a model that answers no JSON or fails changes nothing. Each test names the
 * wrong behaviour it catches.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import git from 'isomorphic-git';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';
import { assumedOf, draftProgress, draftSteps, newDraft, withPatch, type SetupDraft } from '../src/onboarding/draft.js';
import { draftFile, readDraft, writeDraft } from '../src/onboarding/draft-store.js';
import { applyTalk, parseTalk, talkPrompt, type Ask } from '../src/onboarding/draft-talk.js';
import { PRESETS, PRESET_NAMES, QUESTIONS, QUESTION_ORDER, VAT_QUESTIONS, hasWhere, unsureOf, withoutUnsteered, unusualPeriod, type QuestionKey } from '../src/workspace/setup.js';
import type { AskOptions } from '../src/llm/ask.js';
import { APP_FOLDER, MANIFEST_FILE } from '../src/workspace/workspace.js';
import { testIban } from './support/iban.js';
import type { Locale } from '../src/app/i18n/types.js';

const NOW = '2026-10-23T09:00:00.000Z';
const UID = 'CHE-153.004.184';
const IBAN = testIban('00762011623852957');
const IBAN_SPACED = IBAN.replace(/(.{4})(?!$)/g, '$1 ');
const SCHREINEREI = 'Wir sind die Muster Schreinerei GmbH in Bern, Inhaberin Anna Muster, zwei Angestellte, MWST-pflichtig mit Saldosteuersatz 4.5 %, Konto bei der Raiffeisen.';

const home = mkdtempSync(join(tmpdir(), 'vanilla-talk-'));
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

/** The model's answers in turn, and what each call was asked. */
let answers: Array<string | Error> = [];
const asked: Array<{ prompt: string; opts: AskOptions }> = [];
const stub: Ask = async (prompt, opts) => {
  asked.push({ prompt, opts });
  const next = answers.shift();
  if (next instanceof Error) throw next;
  return next ?? '';
};

async function start() {
  const desktop = desktopServer({ stateFile: join(home, 'desktop.json'), demoRoot: join(home, 'Demo'), booksHome: home, dist, aiAvailable: async () => true, ask: stub });
  const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  desktop.allowHost(`127.0.0.1:${port}`);
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => undefined) };
  };
}

async function folder(name: string) {
  const call = await start();
  const root = join(home, name);
  await call('POST', '/api/desktop/setup', { root, language: 'de' });
  const talk = (text: string, model: string | Error, history: unknown[] = []) => {
    answers = [model];
    return call('POST', '/api/desktop/setup/talk', { root, text, history });
  };
  return { call, root, talk };
}

test('one message fills every answer it states, through the click\'s checks, each marked as taken from the words', async () => {
  const { call, root, talk } = await folder('Schreinerei');
  const model = '```json\n' + JSON.stringify({
    say: 'Wie lautet die UID der Firma?',
    firm: { name: 'Muster Schreinerei GmbH', owner: 'Anna Muster' },
    preset: 'trades',
    answers: { legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'net-rate', employees: 'staff' },
    netRates: [{ rate: 4.5, label: 'Schreinerei' }],
    banks: [{ bank: 'Raiffeisen' }],
  }) + '\n```';
  const res = await talk(SCHREINEREI, model);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const { reply, view } = res.json;
  assert.equal(reply.kind, 'read');
  assert.deepEqual(reply.filled, ['preset', 'legalForm', 'vatRegistered', 'vatMethod', 'employees', 'netRates', 'banks'], 'every stated answer is saved and marked, those the preset it names gives too');
  assert.deepEqual(reply.firm, { name: 'Muster Schreinerei GmbH', owner: 'Anna Muster' }, 'a firm short of its UID is not saved; its card starts with what was said');
  assert.equal(view.draft.firm, undefined);
  assert.deepEqual(view.draft.said, { name: 'Muster Schreinerei GmbH', owner: 'Anna Muster' }, 'what was said of it is kept in the draft, so only the UID is asked (#345)');
  assert.deepEqual(view.draft.banks, [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020' }], 'a bank without a currency gets the jurisdiction\'s, its account as a click would');
  assert.equal(view.draft.answers.period, undefined, 'what the words do not say stays open');
  const disk = readDraft(root)!;
  assert.deepEqual(disk.fromText, reply.filled, 'the marks are saved with the draft');
  assert.deepEqual(disk.said, view.draft.said, 'and what was said of the firm, over a restart');
  assert.equal(disk.netRates?.[0].rate, 4.5);

  const [call1] = asked.slice(-1);
  assert.equal(call1.opts.step, 'setup-conversation', 'the call names its step, so the resolver picks the configured provider');
  assert.equal(call1.opts.ledger, join(root, APP_FOLDER, 'data', 'llm-ledger.jsonl'), 'it is ledgered in the folder that becomes the books');
  assert.ok(call1.prompt.includes(SCHREINEREI) && call1.prompt.includes('right below your words: firm\n'), 'the model reads the words with the step waiting');
  assert.ok(call1.prompt.includes('"net-rate" (Saldosteuersatz') && call1.prompt.includes('"monthly" (monthly; not supported'), 'and every value code accepts');

  // The tester's case: the model answers the UID alone, without repeating the name and the owner given six messages before.
  const uid = await talk(`Die UID ist ${UID}.`, JSON.stringify({ say: '', firm: { uid: UID } }));
  const call2 = asked.at(-1)!.prompt;
  assert.ok(call2.includes(`person: ${SCHREINEREI}`) && call2.includes(`you: ${reply.say}`), 'the server keeps the turns, so the next message is read with them');
  assert.ok(call2.includes('Of the firm the person already said, and the app keeps it: {"name":"Muster Schreinerei GmbH","owner":"Anna Muster"}') && call2.includes('firm: only uid is missing'), 'the model is told what is held and what alone is missing');
  assert.deepEqual(uid.json.reply.filled, ['firm'], 'the UID alone completes the firm: code joins it to what was said');
  assert.deepEqual(uid.json.view.draft.firm, { name: 'Muster Schreinerei GmbH', uid: UID, owner: 'Anna Muster' });
  assert.equal(uid.json.view.draft.said, undefined, 'saved whole: nothing waits');
  const open = draftSteps(uid.json.view.draft).at(-1)!;
  assert.ok(open.id === 'question' && open.key === 'basis', 'the conversation stands at the first answer still open');

  const changed = await call('PUT', '/api/desktop/setup', { root, patch: { step: 'question', key: 'vatMethod', value: 'effective' } });
  assert.ok(!changed.json.draft.fromText.includes('vatMethod'), 'an answer the person changes is theirs, no longer marked');
  assert.ok(changed.json.draft.fromText.includes('firm'), 'the other marks stay');
});

test('code refuses what createWorkspace would refuse or the person never wrote, says why, and saves none of it', async () => {
  const { root, talk } = await folder('Abgelehnt');
  const before = readFileSync(draftFile(root), 'utf8');
  const res = await talk('Muster AG, UID CHE-123.456.789, Inhaber Max Muster. Wir rechnen pauschal und monatlich ab. Bank UBS.', JSON.stringify({
    say: 'Danke, die UID habe ich übernommen.',
    firm: { name: 'Muster AG', uid: 'CHE-123.456.789', owner: 'Max Muster' },
    answers: { vatMethod: 'pauschal', period: 'monthly' },
    banks: [{ bank: 'UBS', currency: 'CHF', iban: IBAN }],
  }));
  const { reply, view } = res.json;
  assert.deepEqual(reply.refused.map((r: { step: string; refusal: { reason: string } }) => [r.step, r.refusal.reason]), [
    ['firm', 'uid'], ['vatMethod', 'notAnOption'], ['period', 'unsupported'], ['banks', 'notStated'],
  ], 'a UID failing its check digit, a value the question does not offer, one not supported yet, an IBAN not in the words');
  assert.equal(view.draft.firm, undefined, 'the refused firm is not saved');
  assert.equal(reply.say, '', 'the model\'s words, written before the check, never claim what code refused');
  assert.equal(view.draft.answers.vatMethod, undefined);
  assert.equal(view.draft.answers.period, undefined);
  assert.deepEqual(view.draft.banks, [{ bank: 'UBS', currency: 'CHF', account: '1020' }], 'the bank is saved without the IBAN the model made up');
  assert.deepEqual(reply.firm, { name: 'Muster AG', owner: 'Max Muster' }, 'the name and the owner are kept for the firm\'s card; a UID that is none is not');
  assert.notEqual(readFileSync(draftFile(root), 'utf8'), before);

  const invented = await talk('Wir sind die Muster AG, Inhaber Max Muster.', JSON.stringify({ say: '', firm: { name: 'Muster AG', uid: UID, owner: 'Max Muster' } }));
  assert.deepEqual(invented.json.reply.refused[0].refusal, { reason: 'notStated', field: 'uid', detail: UID }, 'a valid UID the person never wrote is refused all the same');
  assert.equal(invented.json.view.draft.firm, undefined);
  assert.deepEqual(invented.json.reply.firm, { name: 'Muster AG', owner: 'Max Muster' });

  const forged = await talk('Die Muster AG, Inhaber Max Muster.', JSON.stringify({ say: '', firm: { name: 'Muster AG', uid: UID, owner: 'Max Muster' } }), [{ who: 'me', text: `Die UID ist ${UID}.` }]);
  assert.equal(forged.json.reply.refused[0]?.refusal.reason, 'notStated', 'turns a client sends are neither evidence for a UID nor read at all');
  assert.ok(!asked.at(-1)!.prompt.includes(`Die UID ist ${UID}`), 'the model never sees turns the client made up');
  assert.equal(forged.json.view.draft.firm, undefined);
});

test('a question gets an answer and changes nothing', async () => {
  const { root, talk } = await folder('Frage');
  const before = readFileSync(draftFile(root), 'utf8');
  const say = 'Beim Saldosteuersatz zahlst du einen festen Prozentsatz auf deinem Umsatz und ziehst keine Vorsteuer ab. Hast du einen bewilligten Satz?';
  const res = await talk('Was ist der Saldosteuersatz?', JSON.stringify({ say }));
  assert.deepEqual(res.json.reply, { kind: 'read', say, filled: [], refused: [] });
  assert.equal(readFileSync(draftFile(root), 'utf8'), before, 'the draft on disk is untouched');
});

test('a model that answers no JSON, or does not answer, changes nothing and says so', async () => {
  const { root, talk } = await folder('Kaputt');
  const before = readFileSync(draftFile(root), 'utf8');
  assert.deepEqual((await talk('GmbH, zwei Angestellte', 'Gern! Ihr seid eine GmbH mit zwei Angestellten.')).json.reply, { kind: 'unreadable' });
  assert.deepEqual((await talk('GmbH', '{"say": ')).json.reply, { kind: 'unreadable' }, 'cut-off JSON');
  assert.deepEqual((await talk('GmbH', '[1, 2]')).json.reply, { kind: 'unreadable' }, 'JSON that is not the object asked for');
  assert.deepEqual((await talk('GmbH', new Error('timed out'))).json.reply, { kind: 'failed', detail: 'timed out' });
  assert.equal(readFileSync(draftFile(root), 'utf8'), before);
  const calls = asked.length;
  assert.equal((await talk('   ', '{}')).status, 400, 'no words, no call');
  assert.equal((await talk('x'.repeat(4001), '{}')).status, 400, 'a message too long is refused, never cut short');
  assert.equal(asked.length, calls);
});

test('answers the words give leave the kind of firm open for its buttons, and whichever is picked keeps them; a preset the words name comes first', () => {
  const d = newDraft('de', NOW);
  const said = applyTalk(d, parseTalk(JSON.stringify({ say: '', answers: { employees: 'staff', imports: 'yes' } }))!, ['x'], 'CHF');
  assert.equal(said.draft.preset, undefined, 'the tester\'s «Etwas anderes · aus deiner Nachricht» came from code, not from her words: no kind of firm is made up (#345)');
  assert.deepEqual([said.draft.answers.employees, said.draft.answers.imports], ['staff', 'yes']);
  const trades = withPatch(said.draft, { step: 'preset', value: 'trades' });
  assert.deepEqual([trades.answers.employees, trades.answers.imports, trades.answers.sells], ['staff', 'yes', ['made', 'services']], 'her words hold, the preset fills the rest: material and work');
  assert.deepEqual(trades.fromText, ['imports', 'employees'], 'and stay marked as taken from her words');
  const preset = applyTalk(d, parseTalk(JSON.stringify({ say: '', preset: 'consultant', answers: { employees: 'staff' } }))!, ['x'], 'CHF');
  assert.deepEqual([preset.draft.preset, preset.draft.answers.employees], ['consultant', 'staff'], 'the preset is applied before the answers, which win over it');
  const clicked = withPatch(withPatch(d, { step: 'preset', value: 'consultant' }), { step: 'preset', value: 'webshop' });
  assert.deepEqual(clicked.answers.sells, ['traded'], 'answers a preset gave are replaced by the next preset\'s');
});

test('«d Farb verrechned mer mit»: the model is told that a trade is the trades preset and that material charged with the work is sold too', () => {
  const prompt = talkPrompt(newDraft('de', NOW), 'Mir sind e Malerei, d Farb verrechned mer mit.', [], 'CHF');
  assert.match(prompt, /- trades: Trades \/ construction GmbH \(a trade: painter, carpenter/);
  assert.match(prompt, /a trade is "trades"/);
  assert.match(prompt, /charges material with its work .* sells "made" and "services"/);
  assert.match(prompt, /"made" \(what you make or build yourself, and work you charge with its material/);
  assert.match(prompt, /Do not greet the person by a name/);
});

test('the model is given the answered set and the open one, and is not asked to ask: code shows the step waiting', () => {
  let d = newDraft('de', NOW);
  d = withPatch(d, { step: 'firm', value: { name: 'Malerei Huber GmbH', uid: UID, owner: 'Thomas Huber' } });
  d = withPatch(d, { step: 'preset', value: 'custom' });
  for (const [key, value] of [['legalForm', 'GmbH'], ['vatRegistered', 'yes'], ['vatMethod', 'effective'], ['basis', 'received']] as const) d = withPatch(d, { step: 'question', key, value });
  // The tester's turns: the AI asked the basis, she answered it with a button, then typed the bank.
  const prompt = talkPrompt(d, 'nur eis, bi de Raiffeisen', [{ who: 'ai', text: 'Vereinbart oder vereinnahmt?' }], 'CHF');
  assert.match(prompt, /Answered, by a button or by the person's words \(never ask about these again.*\): firm, preset, answers\.legalForm, answers\.vatRegistered, answers\.vatMethod, answers\.basis\n/);
  assert.match(prompt, /Still open, in the order the app asks them: answers\.period, /);
  assert.match(prompt, /The step waiting now, which the app shows with its buttons right below your words: answers\.period\n/);
  assert.match(prompt, /Do not ask the next question/);
  assert.doesNotMatch(prompt, /ask back once, briefly, for what is still missing/);
});

test('the model is told the buttons of the step waiting word for word, the list the conversation draws them from, at every question; no «weiss nicht» where none stands, no recommendation on the VAT questions (#398)', async () => {
  const { offeredAnswers, offeredLabel } = await import('../src/workspace/setup.js');
  const { formatIn } = await import('../src/app/i18n/core.js');
  const de = (await import('../src/app/i18n/locales/de.js')).default;
  const say = (key: string, vars: Record<string, string> = {}) => formatIn({ code: 'de', ...de }, key as never, vars);
  const buttons = (prompt: string) => /Its buttons, exactly these and no others: ([^\n]*?)\. Name no other answer/.exec(prompt)?.[1];
  let d = newDraft('de', NOW);
  assert.equal(buttons(talkPrompt(d, 'hallo', [], 'CHF')), '«Weiter»', 'the firm\'s card: its one button');
  d = withPatch(d, { step: 'firm', value: { name: 'Malerei Huber GmbH', uid: UID, owner: 'Thomas Huber' } });
  assert.equal(buttons(talkPrompt(d, 'hallo', [], 'CHF')), PRESET_NAMES.map((p) => `«${say(`desktop.q.preset.${p}`)}»`).join(', '), 'the kinds of firm');
  d = withPatch(d, { step: 'preset', value: 'custom' });
  const seen: QuestionKey[] = [];
  for (let open = draftSteps(d).at(-1)!; open.id === 'question'; open = draftSteps(d).at(-1)!) {
    const key = open.key;
    const prompt = talkPrompt(d, 'weiss nöd, was heisst das?', [], 'CHF');
    const labels = offeredAnswers(key).map((a) => `«${offeredLabel(say, key, a)}»`);
    assert.match(prompt, new RegExp(`Its buttons, exactly these and no others: ${labels.join(', ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`), `${key}: the buttons as the screen shows them`);
    if (!offeredAnswers(key).some((a) => a.kind === 'unsure')) assert.doesNotMatch(prompt.split('Its buttons')[1].split('\n')[0], /«Weiss nicht/, `${key}: no «Weiss nicht» named where none stands`);
    if ('multi' in QUESTIONS[key]) assert.ok(labels.includes('«Weiter»'), `${key}: a question of several answers has its «Weiter» in the list`);
    if (key === 'vatMethod' || key === 'basis') {
      assert.doesNotMatch(prompt, /provides by default|what the law provides/, 'no fact that reads as a recommendation (#398 review)');
      assert.ok(labels.includes('«Wir rechnen keine MWST ab»'), 'the third answer is named, as it stands');
      assert.match(prompt, /never recommend an answer and never call one usual, likely or the default for her/);
      assert.match(prompt, /a firm whose accountant \(Treuhand\) fills in its VAT returns is registered/);
    }
    seen.push(key);
    const first = offeredAnswers(key).find((a) => a.kind === 'option')!;
    const value = key === 'vatRegistered' ? 'yes' : 'multi' in QUESTIONS[key] ? [(first as { value: string }).value] : (first as { value: string }).value;
    d = withPatch(d, { step: 'question', key, value: value as string });
  }
  assert.ok(seen.includes('vatMethod') && seen.includes('basis') && seen.length >= 6, `every question asked: ${seen.join(', ')}`);
  const ui = readFileSync('src/app/onboarding/DraftConversation.tsx', 'utf8');
  assert.match(ui, /\{offeredAnswers\(key\)\.map\(\(a\) => \{\n\s+const label = offeredLabel\(say, key, a\);/, 'the conversation draws its buttons from the same list and words');
  assert.doesNotMatch(ui, /QUESTIONS\[key\]\.options\.map/, 'no second list of buttons');
  const form = readFileSync('src/app/desktop/StartScreen.tsx', 'utf8');
  assert.match(form, /offeredAnswers\(key, 'form'\)\.map/, 'the form draws from the same list');
  assert.doesNotMatch(form, /QUESTIONS\[key\]\.options\.map|unsteered\(key\) \? <button/, 'and has no second one');
  // The steps after the questions: the banks' card and the review.
  while (draftSteps(d).at(-1)!.id !== 'review') {
    const open = draftSteps(d).at(-1)!;
    if (open.id === 'banks') { assert.equal(buttons(talkPrompt(d, 'x', [], 'CHF')), '«Weiter»'); d = withPatch(d, { step: 'banks', value: [{ bank: 'Raiffeisen', currency: 'CHF' }] }); }
    else if (open.id === 'netRates') d = withPatch(d, { step: 'netRates', value: [{ rate: 4.5 }] });
    else break;
  }
  if (draftSteps(d).at(-1)!.id === 'review') assert.equal(buttons(talkPrompt(d, 'x', [], 'CHF')), `«${say('desktop.create')}»`, 'the review: its one button');
});

test('«Wir rechnen keine MWST ab» never stands without the line that says whom it is for: under every question that offers it, on the form and in the conversation (#398)', async () => {
  const { offeredAnswers, noVatHint } = await import('../src/workspace/setup.js');
  const offering = QUESTION_ORDER.filter((k) => offeredAnswers(k).some((a) => a.kind === 'noVat'));
  assert.deepEqual(offering, ['vatMethod', 'basis']);
  assert.deepEqual(QUESTION_ORDER.filter((k) => noVatHint(k)), offering, 'a line under each question that offers the answer, none elsewhere');
  assert.deepEqual(offering.map(noVatHint), ['full', 'short'], 'whole the first time, short the second');
  for (const f of ['src/app/onboarding/DraftConversation.tsx', 'src/app/desktop/StartScreen.tsx']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /\{noVatHint\(key\) \? <p className="[^"]+" data-no-vat-hint=\{noVatHint\(key\)\}>/, `${f}: the line follows the answer`);
    assert.doesNotMatch(src, /key === 'vatMethod' \? <p[^>]*data-no-vat-hint/, `${f}: not under the method only`);
  }
});

test('a filing period the tax authority grants only on request is not taken from loose words: the reply says what is usual, the question keeps its buttons', () => {
  const d = newDraft('de', NOW);
  // «Mir rechned alli halb Jahr ab» on the effective method.
  const odd = applyTalk(d, parseTalk(JSON.stringify({ say: 'Dänn gah i vo halbjährlich us.', answers: { vatRegistered: 'yes', vatMethod: 'effective', period: 'half-yearly' } }))!, ['x'], 'CHF');
  assert.equal(odd.draft.answers.period, undefined, 'not saved');
  assert.deepEqual([odd.draft.answers.vatRegistered, odd.draft.answers.vatMethod], ['yes', 'effective'], 'the rest of the message is');
  assert.deepEqual(odd.reply.kind === 'read' && odd.reply.refused, [{ step: 'period', refusal: { reason: 'unusualPeriod', method: 'effective', value: 'half-yearly', usual: 'quarterly' } }]);
  assert.deepEqual(odd.reply.kind === 'read' && [odd.reply.filled, odd.reply.say], [['vatRegistered', 'vatMethod'], ''], 'the model\'s «then half-yearly it is» is left out');
  assert.ok(!odd.draft.fromText?.includes('period'));
  const usual = applyTalk(d, parseTalk(JSON.stringify({ say: '', answers: { vatRegistered: 'yes', vatMethod: 'effective', period: 'quarterly' } }))!, ['x'], 'CHF');
  assert.equal(usual.draft.answers.period, 'quarterly');
  const net = applyTalk(d, parseTalk(JSON.stringify({ say: '', answers: { vatRegistered: 'yes', vatMethod: 'net-rate', period: 'half-yearly' } }))!, ['x'], 'CHF');
  assert.equal(net.draft.answers.period, 'half-yearly', 'half-yearly is the usual one on the net tax rate');
  // The method named after the period: the period from the words goes when the two no longer fit.
  const later = applyTalk(usual.draft, parseTalk(JSON.stringify({ say: '', answers: { vatMethod: 'net-rate' } }))!, ['x'], 'CHF');
  assert.equal(later.draft.answers.period, undefined);
  // A click is the person's own: granted on request, it stands, and the conversation says what is usual (unusualPeriod).
  let clicked = withPatch(d, { step: 'question', key: 'vatRegistered', value: 'yes' });
  clicked = withPatch(clicked, { step: 'question', key: 'vatMethod', value: 'effective' });
  clicked = withPatch(clicked, { step: 'question', key: 'period', value: 'half-yearly' });
  assert.deepEqual(unusualPeriod(clicked.answers), { method: 'effective', period: 'half-yearly', usual: 'quarterly' });
  const kept = applyTalk(clicked, parseTalk(JSON.stringify({ say: '', answers: { employees: 'staff' } }))!, ['x'], 'CHF');
  assert.equal(kept.draft.answers.period, 'half-yearly', 'a later message does not take a clicked period away');
  assert.equal(unusualPeriod({ vatRegistered: 'no', vatMethod: 'effective', period: 'half-yearly' }), undefined);
});

test('a period the person clicked stands when the model repeats an unusual one from earlier words; the same refusal is said once', () => {
  let d = newDraft('de', NOW);
  d = withPatch(d, { step: 'question', key: 'vatRegistered', value: 'yes' });
  d = withPatch(d, { step: 'question', key: 'vatMethod', value: 'effective' });
  const again = () => parseTalk(JSON.stringify({ say: 'Halbjährlich also.', answers: { period: 'half-yearly' } }))!;
  // She clicked «quartalsweise»; the model reads «alli halb Jahr» out of the turns before once more.
  const clicked = withPatch(d, { step: 'question', key: 'period', value: 'quarterly' });
  const kept = applyTalk(clicked, again(), ['x'], 'CHF');
  assert.equal(kept.draft.answers.period, 'quarterly', 'was deleted: the refusal patched it to null');
  assert.ok(!kept.draft.fromText?.includes('period'), 'and stays hers, not «aus deiner Nachricht»');
  assert.equal(kept.reply.kind === 'read' && kept.reply.refused.length, 1);
  // Nothing answered yet: refused once, then silently.
  const first = applyTalk(d, again(), ['x'], 'CHF');
  assert.equal(first.reply.kind === 'read' && first.reply.refused[0]?.refusal.reason, 'unusualPeriod');
  assert.equal(first.draft.refusedPeriod, 'half-yearly');
  const second = applyTalk(first.draft, again(), ['x'], 'CHF');
  assert.deepEqual(second.reply.kind === 'read' && [second.reply.refused, second.reply.filled, second.reply.say], [[], [], ''], 'the same value is not refused again, and the model\'s claim is still left out');
  assert.equal(second.draft.answers.period, undefined);
  const answered = withPatch(first.draft, { step: 'question', key: 'period', value: 'quarterly' });
  assert.equal(answered.refusedPeriod, undefined, 'answered: nothing is remembered');
});

test('the model cannot rename a firm: a name or an owner the app holds is replaced only by one in the person\'s latest words', () => {
  let d = newDraft('de', NOW);
  d = withPatch(d, { step: 'firm', value: { name: 'Malerei Huber GmbH', uid: UID, owner: 'Thomas Huber' } });
  const renamed = applyTalk(d, parseTalk(JSON.stringify({ say: '', firm: { name: 'Huber Malerei AG', owner: 'Sandra Huber' } }))!, ['nur eis, bi de Raiffeisen'], 'CHF');
  assert.deepEqual(renamed.draft.firm, d.firm, 'a partial firm from the model was joined onto the saved one');
  assert.ok(renamed.reply.kind === 'read' && !renamed.reply.filled.includes('firm'));
  const said = applyTalk(d, parseTalk(JSON.stringify({ say: '', firm: { owner: 'Sandra Huber' } }))!, ['x', 'D Inhaberin isch nöd de Thomas, sondern  sandra huber.'], 'CHF');
  assert.equal(said.draft.firm?.owner, 'Sandra Huber', 'she wrote it now: taken, case and spacing aside');
  assert.equal(said.draft.firm?.name, 'Malerei Huber GmbH');
  const earlier = applyTalk(d, parseTalk(JSON.stringify({ say: '', firm: { owner: 'Sandra Huber' } }))!, ['Sandra Huber', 'und d Bank isch Raiffeisen'], 'CHF');
  assert.equal(earlier.draft.firm?.owner, 'Thomas Huber', 'words of an earlier message do not replace what she typed since');
  // What was only said, not saved: the same.
  const partial = { ...newDraft('de', NOW), said: { name: 'Malerei Huber GmbH', owner: 'Thomas Huber' } };
  const joined = applyTalk(partial, parseTalk(JSON.stringify({ say: '', firm: { name: 'Huber AG', uid: UID } }))!, [`d UID isch ${UID}`], 'CHF');
  assert.deepEqual(joined.draft.firm, { name: 'Malerei Huber GmbH', uid: UID, owner: 'Thomas Huber' });
});

test('the person sees how far she is: four parts, the same for every firm, so the count never jumps or shrinks (#364)', () => {
  // Round 1 saw «0 von 14», «1 von 4», «4 von 8», «von 7»: the total followed the questions her answers opened.
  const counts: string[] = [];
  const seen = (d: SetupDraft) => { const p = draftProgress(d); counts.push(`${p.done}/${p.of}`); return p; };
  let d = newDraft('de', NOW);
  assert.deepEqual(seen(d), { done: 0, of: 4, phases: { firm: false, kind: false, vat: false, banks: false }, next: 'firm' });
  d = withPatch(d, { step: 'firm', value: { name: 'Malerei Huber GmbH', uid: UID, owner: 'Thomas Huber' } });
  assert.equal(seen(d).next, 'kind');
  d = withPatch(d, { step: 'preset', value: 'trades' });
  assert.equal(seen(d).next, 'vat', 'the kind of firm answers the rest of its part');
  d = withPatch(d, { step: 'question', key: 'vatRegistered', value: 'yes' });
  seen(d);
  d = withPatch(d, { step: 'question', key: 'vatMethod', value: 'net-rate' });
  seen(d);
  d = withPatch(d, { step: 'question', key: 'basis', value: 'received' });
  d = withPatch(d, { step: 'question', key: 'period', value: 'half-yearly' });
  assert.equal(seen(d).phases.vat, false, 'the rates are part of the VAT');
  d = withPatch(d, { step: 'netRates', value: [{ rate: 4.5 }] });
  assert.equal(seen(d).phases.vat, true);
  d = withPatch(d, { step: 'banks', value: [{ bank: 'Raiffeisen', currency: 'CHF' }] });
  assert.deepEqual(seen(d), { done: 4, of: 4, phases: { firm: true, kind: true, vat: true, banks: true } });
  assert.deepEqual(counts, ['0/4', '1/4', '2/4', '2/4', '2/4', '2/4', '3/4', '4/4']);
});

test('the VAT method and basis are never proposed: no preset answer drawn as the suggestion, in any kind of firm (#364, #347)', () => {
  for (const preset of ['consultant', 'webshop', 'trades'] as const) {
    let d = withPatch(newDraft('de', NOW), { step: 'firm', value: { name: 'Malerei Huber GmbH', uid: UID, owner: 'Thomas Huber' } });
    d = withPatch(d, { step: 'preset', value: preset });
    d = withPatch(d, { step: 'question', key: 'vatRegistered', value: 'yes' });
    const method = draftSteps(d).at(-1)!;
    assert.ok(method.id === 'question' && method.key === 'vatMethod' && !('suggested' in method), `${preset}: no method suggested`);
    d = withPatch(d, { step: 'question', key: 'vatMethod', value: 'effective' });
    const basis = draftSteps(d).at(-1)!;
    assert.ok(basis.id === 'question' && basis.key === 'basis' && !('suggested' in basis), `${preset}: no basis suggested`);
  }
  assert.deepEqual(Object.keys(withoutUnsteered({ ...PRESETS.trades.answers })).filter((k) => k === 'vatMethod' || k === 'basis'), [], 'the form takes neither from a preset');
});

test('answers the kind of firm gave and she never said are marked as assumed, until she answers them herself (#364)', () => {
  let d = withPatch(newDraft('de', NOW), { step: 'firm', value: { name: 'Malerei Huber GmbH', uid: UID, owner: 'Thomas Huber' } });
  d = withPatch(d, { step: 'preset', value: 'trades' });
  assert.ok(assumedOf(d).includes('start') && assumedOf(d).includes('foreignCustomers'), 'the preset filled «Ausgangslage» and «Kundschaft im Ausland»');
  assert.ok(!assumedOf(d).some((k) => (VAT_QUESTIONS as readonly string[]).includes(k)), 'the VAT is always asked, never assumed');
  d = withPatch(d, { step: 'question', key: 'start', value: null });
  d = withPatch(d, { step: 'question', key: 'start', value: 'switching' });
  assert.ok(!assumedOf(d).includes('start'), 'answered by her: no longer assumed');
  assert.ok(assumedOf(d).includes('foreignCustomers'), 'the others the kind of firm gave stay marked after it became «Etwas anderes»');
  assert.equal(d.preset, 'custom');
  assert.equal(d.assumedBy, 'trades', 'and the kind of firm that assumed them is kept, to be named on the review');
  // Taken from her words: hers, not assumed.
  const words = withPatch(d, { step: 'question', key: 'foreignCustomers', value: 'yes' });
  assert.ok(!assumedOf(words).includes('foreignCustomers'));
  // Kept in the folder: a setup broken off shows the same marks when opened again.
  const root = mkdtempSync(join(tmpdir(), 'assumed-'));
  mkdirSync(join(root, APP_FOLDER), { recursive: true });
  writeDraft(root, d);
  assert.deepEqual(assumedOf(readDraft(root)!), assumedOf(d));
  assert.equal(readDraft(root)!.assumedBy, 'trades');
});

test('the questions that need accounting knowledge say where the answer stands and what a wrong pick costs, in her words, without a law citation (#364)', async () => {
  const where = QUESTION_ORDER.filter((k) => hasWhere(k));
  assert.deepEqual(where, ['vatMethod', 'basis', 'start']);
  for (const lang of ['de', 'en', 'fr', 'it']) {
    const m = (await import(`../src/app/i18n/locales/${lang}.js`) as { default: Locale }).default.messages as unknown as Record<string, string>;
    for (const k of where) assert.ok(m[`desktop.q.${k}.where`], `${lang}: desktop.q.${k}.where`);
    for (const k of QUESTION_ORDER) {
      for (const text of [m[`desktop.q.${k}.why`], m[`desktop.q.${k}.where`]].filter(Boolean)) {
        assert.doesNotMatch(text, /Art\. \d|art\. \d|MWSTG|LTVA|LIVA|auf Gesuch|on request|sur demande|su richiesta/, `${lang} ${k}: no citation, no «auf Gesuch»`);
        assert.doesNotMatch(text, /Schreiben|letter|lettre|lettera/, `${lang} ${k}: no place the repo does not confirm`);
      }
    }
  }
  const de = (await import('../src/app/i18n/locales/de.js') as { default: Locale }).default.messages as unknown as Record<string, string>;
  for (const k of ['vatMethod', 'basis']) {
    if (k === 'vatMethod') assert.match(de[`desktop.q.${k}.where`], /beantragt/, `${k}: only what the repo confirms: approved on the firm's request`);
    assert.doesNotMatch(de[`desktop.q.${k}.where`], /ist es (die effektive Methode|vereinbart)|nie beantragt|nie darum gebeten/, `${k}: the fact, not a conclusion about her`);
    assert.match(de[`desktop.q.${k}.where`], /Treuhand/, `${k}: who knows`);
    assert.match(de[`desktop.q.${k}.where`], /Firma › MWST änderst du es, solange dieses Jahr keine Buchungen hat/, `${k}: what a wrong pick costs (vatMethodHeld)`);
  }
  assert.match(de['desktop.q.vatMethod.where'], /beantragt hat und der die ESTV einen Satz bewilligt hat.*Formular 0553/s);
  assert.match(de['desktop.q.basis.where'], /vereinbart oder vereinnahmt/, 'the basis: both named, side by side');
  assert.doesNotMatch(de['desktop.q.vatMethod.why'], /Übliche/, 'no method called the usual one');
  assert.match(de['desktop.q.start.where'], /kann .* abweichen/, 'a firm with nothing on 1 January sees no difference');
  assert.doesNotMatch(de['desktop.q.start.why'], /einbezahlte Kapital/, 'capital paid in during the year arrives as a payment: never told to enter it as an opening');
  assert.match(de['desktop.q.start.why'], /Beides legt dieselben Bücher an/, 'what each answer changes');
});

test('the basis and the method say where she finds them herself, the ESTV portal\'s own words in each language, and the basis names none as the likely one (#423)', async () => {
  // Where the ESTV says the firm's current basis and method stand: the portal, «Neue Geschäfte», the firm, its «Abrechnungsmodalitäten»
  // (estv.admin.ch «MWST Abrechnungsmodalitäten anpassen», in fr «Nouvelles opérations», in it «Nuove operazioni»).
  const portal: Record<string, RegExp> = {
    de: /ESTV-Portal.*«Neue Geschäfte».*«Abrechnungsmodalitäten»/s,
    en: /ESTV portal.*«Neue Geschäfte».*«Abrechnungsmodalitäten»/s,
    fr: /portail de l’AFC.*«Nouvelles opérations».*«Modalités de décompte»/s,
    it: /portale dell’AFC.*«Nuove operazioni».*modalità del rendiconto/s,
  };
  // A basis named as the one that applies unless …: the hint that steered an unsure owner to «vereinbart» (round 4, webshop-ai-r2-2).
  const steers = /Gesetz|sieht .* vor|gilt, (wenn|ausser)|law|applies (when|unless)|loi|prévoit|vaut si|legge|prevede|vale se/i;
  for (const lang of ['de', 'en', 'fr', 'it']) {
    const m = (await import(`../src/app/i18n/locales/${lang}.js`) as { default: Locale }).default.messages as unknown as Record<string, string>;
    for (const k of ['vatMethod', 'basis']) assert.match(m[`desktop.q.${k}.where`], portal[lang], `${lang} ${k}: where she looks it up herself`);
    assert.doesNotMatch(m['desktop.q.basis.where'], steers, `${lang}: no basis named as the one that applies`);
  }
  // What the AI is given to explain the basis: the same place, and no default.
  let d = withPatch(newDraft('de', NOW), { step: 'firm', value: { name: 'Malerei Huber GmbH', uid: UID, owner: 'Thomas Huber' } });
  d = withPatch(d, { step: 'preset', value: 'trades' });
  d = withPatch(d, { step: 'question', key: 'vatRegistered', value: 'yes' });
  d = withPatch(d, { step: 'question', key: 'vatMethod', value: 'effective' });
  const open = draftSteps(d).at(-1)!;
  assert.ok(open.id === 'question' && open.key === 'basis', 'the basis waits');
  const prompt = talkPrompt(d, 'weiss nöd, was heisst das? ich verchaufe Tee im Webshop', [], 'CHF');
  const facts = prompt.split('explain in her words from these facts only:')[1].split('\n')[0];
  assert.match(facts, portal.de, 'the model is told where she looks it up');
  assert.doesNotMatch(facts, steers, 'and no basis as the one that applies');
  assert.match(prompt, /does not know its method or basis finds both where the line of those questions says .*, or asks its accountant/, 'the accountant is not the only way');
});

test('the words never make a registered firm unregistered: her «ja», her method and her rates stay, the question keeps its buttons (#347)', () => {
  let d = withPatch(newDraft('de', NOW), { step: 'firm', value: { name: 'Malerei Huber GmbH', uid: UID, owner: 'Thomas Huber' } });
  d = withPatch(d, { step: 'preset', value: 'trades' });
  d = withPatch(d, { step: 'question', key: 'vatRegistered', value: 'yes' });
  d = withPatch(d, { step: 'question', key: 'vatMethod', value: 'net-rate' });
  d = withPatch(d, { step: 'netRates', value: [{ rate: 4.5 }] });
  const words = 'd Treuhand macht d MWST, mir rechned nüt ab';
  for (const out of [{ say: 'Ok.', answers: { vatRegistered: 'no' } }, { say: '', answers: { vatMethod: 'no-vat' } }, { say: '', answers: { basis: 'no-vat' } }]) {
    const { draft, reply } = applyTalk(d, parseTalk(JSON.stringify(out))!, [words], 'CHF');
    assert.equal(draft.answers.vatRegistered, 'yes', `${JSON.stringify(out.answers)}: her click stands`);
    assert.equal(draft.answers.vatMethod, 'net-rate');
    assert.deepEqual(draft.netRates, [{ rate: 4.5 }], 'her rate stays');
    assert.ok(reply.kind === 'read' && reply.refused.some((r) => r.refusal.reason === 'noVat'), 'the reply says why, and that the answer is a button');
    assert.equal(reply.kind === 'read' && reply.say, '', 'beside a refusal the model\'s words do not stand');
    assert.equal(draftSteps(draft).at(-1)!.id === 'question' && (draftSteps(draft).at(-1) as { key: string }).key, 'basis', 'the question waiting keeps its buttons');
  }
  const prompt = talkPrompt(d, words, [], 'CHF');
  assert.match(prompt, /vatRegistered: never give "no"/, 'the prompt says only that it is never chosen for her');
  assert.doesNotMatch(prompt, /we file no VAT returns/, 'and does not advertise the button');
});

test('a firm not registered by her click keeps no method, basis, period or rates from the words, so a later «ja» asks them (#347, #369)', () => {
  let d = withPatch(newDraft('de', NOW), { step: 'firm', value: { name: 'Malerei Huber GmbH', uid: UID, owner: 'Thomas Huber' } });
  d = withPatch(d, { step: 'preset', value: 'trades' });
  d = withPatch(d, { step: 'question', key: 'vatRegistered', value: 'no' });
  const { draft } = applyTalk(d, parseTalk(JSON.stringify({ say: '', answers: { vatMethod: 'effective', basis: 'received', period: 'quarterly' }, netRates: [{ rate: 4.5 }] }))!, ['effektiv, vereinnahmt, pro Quartal'], 'CHF');
  for (const k of ['vatMethod', 'basis', 'period'] as const) assert.equal(draft.answers[k], undefined, `${k} not kept`);
  assert.equal(draft.netRates, undefined);
  assert.ok(!(draft.fromText ?? []).some((m) => ['vatMethod', 'basis', 'period', 'netRates'].includes(m)), 'no marks for them');
  assert.equal(draft.refusedPeriod, undefined);
  const yes = withPatch(draft, { step: 'question', key: 'vatRegistered', value: 'yes' });
  const next = draftSteps(yes).at(-1)!;
  assert.ok(next.id === 'question' && next.key === 'vatMethod' && !('answer' in next), '«ja» asks the method, answered by nobody');
});

test('the typed setup knows that «not registered» is her click only, and the hint names the threshold of registration.yaml (#347)', async () => {
  // The threshold the hint names is the one of modules/ch/registration.yaml.
  const yaml = readFileSync('modules/ch/registration.yaml', 'utf8');
  const threshold = Number(/turnoverThreshold:\s*([\d.e]+)/.exec(yaml)![1]);
  for (const lang of ['de', 'en', 'fr', 'it']) {
    const m = (await import(`../src/app/i18n/locales/${lang}.js`) as { default: Locale }).default.messages as unknown as Record<string, string>;
    assert.ok(m['desktop.q.noVat.hint'].replace(/[’']/g, '').includes(String(threshold)), `${lang}: the hint names CHF ${threshold}`);
    assert.ok(m['desktop.q.vatRegistered.why'].replace(/[’']/g, '').includes(String(threshold)), `${lang}: the registration question too`);
  }

  const de = (await import('../src/app/i18n/locales/de.js') as { default: Locale }).default.messages as unknown as Record<string, string>;
  assert.match(de['desktop.q.noVat.hint'], /Füllt eure Treuhand die MWST-Abrechnungen aus, ist die Firma eingetragen/, 'a firm whose Treuhand files is registered');
  // What a wrong pick costs stands once on the question (its help line above the answers), not again under them (#398).
  assert.match(de['desktop.q.vatMethod.where'], /Falsch gewählt\? Unter Firma › MWST änderst du es, solange dieses Jahr keine Buchungen hat/, 'what a wrong pick costs');
  assert.doesNotMatch(de['desktop.q.noVat.hint'], /Falsch gewählt/, 'said once');
  assert.match(de['desktop.q.vatRegistered.why'], /freiwillig eintragen und ist dann eingetragen/, 'below the threshold one can be registered voluntarily');
});

test('«Weiss nicht» exists only where assuming does no harm, and never on a question that decides the VAT return', () => {
  const unsure = QUESTION_ORDER.filter((k) => unsureOf(k));
  assert.deepEqual(unsure, ['foreignCustomers', 'ownerPaysPrivately', 'payouts'], 'not imports: nothing offers the import accounts when such a payment comes');
  for (const k of unsure) assert.ok((QUESTIONS[k as QuestionKey].options as ReadonlyArray<{ value: string }>).some((o) => o.value === unsureOf(k)), `${k}: the assumed answer is one of its own`);
});

test('books created from a talked draft carry no marks and no draft; the folder\'s ledger stays out of git', async () => {
  const { call, root, talk } = await folder('Angelegt');
  await talk(`Muster GmbH, ${UID}, Inhaberin Anna Muster; Beratung, nicht MWST-pflichtig, Konto bei der UBS IBAN ${IBAN_SPACED}.`, JSON.stringify({
    say: '', firm: { name: 'Muster GmbH', uid: UID, owner: 'Anna Muster' }, preset: 'consultant',
    answers: { vatRegistered: 'no' }, banks: [{ bank: 'UBS', currency: 'CHF', iban: IBAN_SPACED }],
  }));
  assert.equal(readDraft(root)!.answers.vatRegistered, undefined, '«not registered» is never taken from words (#347)');
  // Her click, as on the button «nein» or «Wir rechnen keine MWST ab».
  await call('PUT', '/api/desktop/setup', { root, patch: { step: 'question', key: 'vatRegistered', value: 'no' } });
  const d = readDraft(root)!;
  assert.equal(draftSteps(d).at(-1)!.id, 'review', 'one message and one click took the setup to its summary');
  assert.equal(d.banks?.[0].iban, IBAN, 'an IBAN the person wrote is taken, in its compact form');
  mkdirSync(join(root, APP_FOLDER, 'data'), { recursive: true });
  writeFileSync(join(root, APP_FOLDER, 'data', 'llm-ledger.jsonl'), '{"step":"setup.conversation"}\n');
  writeDraft(root, d);
  const created = await call('POST', '/api/desktop/setup/create', { root });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.ok(existsSync(join(root, APP_FOLDER, MANIFEST_FILE)) && !existsSync(draftFile(root)));
  assert.ok(!readFileSync(join(root, APP_FOLDER, MANIFEST_FILE), 'utf8').includes('fromText'));
  const tracked = await git.listFiles({ fs, dir: root });
  assert.ok(!tracked.some((f) => f.includes('llm-ledger')), 'the setup\'s ledger is the books\' own data/, never committed');
});
