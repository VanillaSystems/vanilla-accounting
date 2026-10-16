/**
 * The AI sidebar says what the app holds (persona round 4, w08, w25, x08): its message lists what
 * waits under Aufgaben with each question's text and buttons as their cards show them; a question
 * the app has open already stands instead of a second one, and a question offers only answers a
 * card has; an answer whose change the app refused keeps everything that did not depend on it.
 * On the real API server with the claude stub, on a temp copy of tests/fixtures/sale-vat-index.json.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { loadBooks, moduleActor } from '../src/books/store.js';
import { openWork } from '../src/server/open-work.js';
import { classifyStep } from '../src/intake/classify.js';
import { runIntake, storePort } from '../src/intake/pipeline.js';
import { readQuestions } from '../src/questions/store.js';
import { questionChoices } from '../src/questions/model.js';
import { changesIn } from '../src/assistant/changes.js';
import { ANSWER_START } from '../src/assistant/conversations.js';
import { markdownBlocks } from '../src/app/assistant/markdown.js';
import { payerNames } from '../src/knowledge/payer.js';
import { ruleWords } from '../src/booking/rules.js';
import { assistantSystem } from '../src/assistant/claude.js';
import { appMap } from '../src/server/app-map.js';
import type { AssistantEvent, Conversation, Turn } from '../src/types/assistant.js';
import './support/jurisdiction.js';

const REPO = process.cwd();
const log = mkdtempSync(join(tmpdir(), 'assistant-honesty-'));
const CHANGES = join(log, 'changes.json');
const TEXT = join(log, 'text.txt');
const PROMPTS = join(log, 'prompts.txt');

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/sale-vat-index.json', {
    PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: CHANGES, CLAUDE_STUB_TEXT: TEXT, CLAUDE_STUB_PROMPTS: PROMPTS,
  });
  await runIntake({ ws: api.ws, books: storePort(api.ws, moduleActor('intake')), steps: [['classify', classifyStep()]] });
});
after(() => { api?.stop(); rmSync(log, { recursive: true, force: true }); });

/** One message whose answer says `text` first and asks for `changes`; the events, the stored AI turn, the prompt the model got. */
async function wish(changes: unknown[] | undefined, text = '') {
  if (changes) writeFileSync(CHANGES, JSON.stringify(changes)); else rmSync(CHANGES, { force: true });
  if (text) writeFileSync(TEXT, text); else rmSync(TEXT, { force: true });
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'mach die mwst-abrechnung fürs dritte quartal bereit', language: 'de', context: [] }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  const id = (events[0] as { id: string }).id;
  const turn = ((await api.send('GET', `/api/assistant/${id}`)).json as unknown as Conversation).turns.at(-1) as Extract<Turn, { role: 'ai' }>;
  const prompts = existsSync(PROMPTS) ? readFileSync(PROMPTS, 'utf8').split('\n\0\n').filter((p) => p.trim()) : [];
  return { events, turn, prompts };
}

const saleQuestion = (ref: string) => readQuestions(api.ws).find((q) => q.topic === 'saleVat' && q.on.id === ref)!;

test('the message lists the open questions with their text and the buttons their cards have, and that a correction of the sale answers the app\'s own (1c, 2)', async () => {
  assert.equal(saleQuestion('S-CH').status, 'open', 'the booking step asked about the sale');
  const { prompts } = await wish(undefined);
  const prompt = prompts.at(-1)!;
  assert.match(prompt, /under «Automatisierung › Aufgaben» now[^\n]*complete: what is not listed does not wait/);
  const line = prompt.split('\n').find((l) => l.includes('the payment S-CH'))!;
  assert.ok(line, 'the open question on S-CH is in the message');
  assert.match(line, /«Beispiel Kunde AG hat CHF 1081\.00 am 10\.08\.2026 bezahlt, ohne Rechnung in den Büchern\. War das ein Verkauf mit MWST\?»/, 'its text as the card says it, not the stored one');
  assert.match(line, /its buttons «mit MWST \(8\.1 %\)», «ohne MWST \(Ausland\)», «keine MWST darauf/, 'its buttons as they read');
  assert.match(line, /booked meanwhile with V0/);
  assert.match(line, /a change of the VAT code of this sale's booking in your block answers it/, 'the model knows its own correction closes it (w25)');
  assert.doesNotMatch(prompt, /Verkauf im Inland/, 'no label the card does not have');
  assert.match(prompt, /Open questions \(3\):/);
});

test('the map names the question cards\' real buttons in the person\'s language (2)', () => {
  const de = appMap('de');
  assert.match(de, /«privat» \/ «geschäftlich»/);
  assert.match(de, /«mit MWST \(8\.1 %\)» \/ «ohne MWST \(Ausland\)» \/ «keine MWST darauf/);
  assert.match(appMap('fr'), /«avec TVA \(8\.1 %\)» \/ «sans TVA \(étranger\)»/);
  assert.doesNotMatch(de, /\{rate\}/);
});

test('a question offers the answers of one kind a card has, or none; any other is refused in plain words (1a)', () => {
  assert.deepEqual(questionChoices(['saleDomestic', 'saleAbroad', 'notSale']), ['saleDomestic', 'saleAbroad', 'notSale']);
  assert.deepEqual(questionChoices(['private', 'business', 'private']), ['private', 'business']);
  assert.deepEqual(questionChoices([]), []);
  assert.equal(questionChoices(['private', 'saleAbroad']), undefined, 'no card mixes the kinds');
  assert.equal(questionChoices(['mit MWST', 'ohne MWST']), undefined);
  const block = (choices: unknown) => `\`\`\`vanilla-changes\n${JSON.stringify([{ kind: 'question', on: { kind: 'payment', id: 'S-CH' }, text: 'Mit MWST?', choices }])}\n\`\`\``;
  assert.deepEqual((changesIn(block(['saleDomestic', 'saleAbroad'])) as Array<{ choices?: string[] }>)[0].choices, ['saleDomestic', 'saleAbroad']);
  assert.throws(() => changesIn(block(['mit MWST', 'ohne MWST'])), (e: { refusal?: { code: string } }) => e.refusal?.code === 'questionChoices');
});

test('a question open already on the payment stands instead of a second one: on the payment or on its booking, no undo, nothing asked (1a, w08)', async () => {
  const before = readQuestions(api.ws).length;
  const open = saleQuestion('S-EU');
  for (const on of [{ kind: 'payment', id: 'S-EU' }, { kind: 'entry', id: 'e-eu' }]) {
    const { events, turn } = await wish([{ kind: 'question', on, text: 'War das mit MWST?', choices: ['saleDomestic', 'saleAbroad', 'notSale'] }]);
    assert.equal(events.find((e) => e.type === 'refused'), undefined, 'not a refusal');
    const [made] = turn.changes!;
    assert.equal(made.note?.question?.id, open.id, 'the card shows the open question');
    assert.equal(made.note?.question?.open?.topic, 'saleVat');
    assert.equal(made.undo, undefined, 'nothing to take back');
  }
  assert.equal(readQuestions(api.ws).length, before, 'nothing asked twice');
});

test('the AI asks about a sale with the sale\'s buttons: the app\'s own question, which the app never asks again (1a)', async () => {
  const { events, turn } = await wish([{ kind: 'question', on: { kind: 'payment', id: 'S-DOC' }, text: 'War das mit MWST?', choices: ['saleDomestic', 'saleAbroad'] }]);
  assert.equal(events.find((e) => e.type === 'refused'), undefined, JSON.stringify(events.find((e) => e.type === 'refused')));
  const q = readQuestions(api.ws).find((x) => x.id === turn.changes![0].note?.question?.id)!;
  assert.deepEqual([q.topic, q.choices, q.origin], ['saleVat', ['saleDomestic', 'saleAbroad'], 'assistant']);
});

test('an answer whose one change the app refused keeps all it said that did not depend on it; the rewrite gets the whole answer (1b, w08)', async () => {
  const check = [
    'Q3 ist fast bereit. Ich habe alle Zahlungen von Juli bis September durchgesehen.',
    '- 2 Kundenzahlungen sind ohne MWST gebucht\n- 1 Zahlung hat keinen Beleg',
    'Einreichen kannst du unter MWST › 2026-Q3.',
  ].join('\n\n');
  const { events, turn, prompts } = await wish([{ kind: 'question', on: { kind: 'payment', id: 'S-GEN' }, text: 'Mit MWST?', choices: ['mit MWST', 'ohne MWST'] }], check);
  const refused = events.find((e) => e.type === 'refused') as Extract<AssistantEvent, { type: 'refused' }>;
  assert.equal(refused.refusal?.code, 'questionChoices', 'refused with a code the sidebar says in plain words');
  const rewrite = prompts.at(-1)!;
  assert.ok(rewrite.includes(ANSWER_START), 'the rewrite gets the answer as it was');
  for (const part of check.split('\n\n')) assert.ok(rewrite.includes(part), `the rewrite prompt holds «${part.slice(0, 30)}»`);
  assert.match(rewrite, /only what it said about those changes corrected[\s\S]*Keep every other part as it was, word for word/);
  for (const part of check.split('\n\n')) assert.ok(turn.text.includes(part), `the answer kept «${part.slice(0, 30)}»`);
  assert.doesNotMatch(turn.text, /Stub-Antwort/, 'its claim of the change is gone');
  assert.match(turn.text, /nicht gemacht/);
});

test('when nothing waits, the message says so plainly (1c)', async () => {
  for (const q of readQuestions(api.ws).filter((x) => x.status === 'open')) await api.send('POST', `/api/questions/${q.id}/close`, { by: 'Anna Muster', how: 'withdrawn' });
  const { prompts } = await wish(undefined);
  assert.match(prompts.at(-1)!, /Nothing waits: no open question, no task, no payment without a booking, no booking against its receipt, no possible duplicate\./);
});

test('an answer\'s bold, lists and paragraphs are data, never markup; an unpaired ** stays as written (3)', () => {
  assert.deepEqual(markdownBlocks('Das Gerüst hat **CHF 1\'120.00** gekostet.\nZweite Zeile\n\n- eins\n- **zwei**\n\n1. a\n2. b'), [
    { kind: 'p', lines: [[{ text: 'Das Gerüst hat ' }, { text: 'CHF 1\'120.00', bold: true }, { text: ' gekostet.' }], [{ text: 'Zweite Zeile' }]] },
    { kind: 'ul', items: [[{ text: 'eins' }], [{ text: 'zwei', bold: true }]] },
    { kind: 'ol', items: [[{ text: 'a' }], [{ text: 'b' }]] },
  ]);
  assert.deepEqual(markdownBlocks('5 ** 2 <b>x</b>'), [{ kind: 'p', lines: [[{ text: '5 ** 2 <b>x</b>' }]] }], 'HTML is text');
  assert.deepEqual(markdownBlocks('### Offen'), [{ kind: 'p', lines: [[{ text: 'Offen', bold: true }]] }]);
});

test('a payer rule reads with the payer\'s name, not its key (3, r4w-8)', () => {
  const names = payerNames([{ description: 'Gutschrift', counterparty: 'Familie Keller' }, { description: 'Gutschrift', counterparty: 'Bauer Michael', counterpartyIban: 'DE00 3704 0044 0532 0130 00' }]);
  assert.equal(names.familiekeller, 'Familie Keller');
  assert.equal(names.DE00370400440532013000, 'Bauer Michael');
  const said = ruleWords({ rule: { id: 'sale-x', when: { payer: 'familiekeller', direction: 'in' }, then: { kind: 'book', booking: { account: '3400', vat: 'V81' } } } as never },
    { account: () => undefined, business: () => undefined, payer: (k) => names[k], money: String }, (k, v) => `${k}:${JSON.stringify(v)}`);
  assert.match(said.when, /"payer":"Familie Keller"/);
});

test('the invoice texts are quoted as they read, with the company\'s term, never with an unfilled {days} (3, w16)', () => {
  const prompt = assistantSystem('de', '2451 Kontokorrent', '', 10);
  assert.match(prompt, /registered from a date inside the year .* charges VAT on every invoice and owes it from that date on/, 'a registration inside the year rules from its date (r6f-11)');
  assert.match(prompt, /never tell such a person that they show no VAT or owe none after their registration date/);
  assert.match(prompt, /as they read with the company's term of 10 days: [^\n]*Zahlbar innert 10 Tagen/);
  const quoted = prompt.slice(prompt.indexOf('as they read with'), prompt.indexOf('and keep the rest of it'));
  assert.doesNotMatch(quoted, /\{days\}/);
});

test('a workflow\'s task is in the message with the rule that held its payment, so the model knows an ask rule did its work (1c, w24)', () => {
  const task = { run: 'r-1', workflow: 'ask', step: 'decide', item: { kind: 'transaction', id: 'S-GEN' }, title: { de: 'Frag: {question}', en: 'Ask: {question}' }, since: '2026-10-15T08:00:00Z', outcomes: ['booked'], reads: { question: 'Wofür war der Barbezug?' }, rule: 'cash-ask' } as const;
  const note = openWork(api.ws, loadBooks(api.ws), [task as never], 'de');
  assert.match(note, /Tasks of the workflows \(1\):\n- «Frag: Wofür war der Barbezug\?» on the transaction S-GEN, since 15\.10\.2026, held by the rule cash-ask/);
});

test('the app map says a mailbox is connected in Firma › Quellen by the person, with the page\'s own words (r5h-27)', () => {
  const de = appMap('de');
  assert.match(de, /«Postfach verbinden»/);
  assert.match(de, /«Verbindung prüfen»/);
  assert.match(de, /never ask for or take a password in the chat/);
});
