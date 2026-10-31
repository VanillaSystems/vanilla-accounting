/**
 * The sidebar's words about what it did come from the app, not from the model's guess (r8f-47,
 * r8f-48): once an answer's changes are made at once, the app itself closes the answer with how
 * many it made, each with «Rückgängig», streamed to the sidebar as the answer's text. The prompt
 * tells the model that whether a block is made at once or held for «Übernehmen» is the app's call,
 * and that a wish about a payer's or supplier's payments in general holds for every payment of the
 * open period. On the real API server with the claude stub, on tests/fixtures/sale-vat-index.json.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, type ApiServer } from './support/api-server.js';
import { assistantSystem } from '../src/assistant/claude.js';
import type { AssistantEvent, Conversation, Turn } from '../src/types/assistant.js';
import './support/jurisdiction.js';

const REPO = process.cwd();
const log = mkdtempSync(join(tmpdir(), 'assistant-applied-'));
const CHANGES = join(log, 'changes.json');
const TEXT = join(log, 'text.txt');

let api: ApiServer;
before(async () => {
  api = await startApi('tests/fixtures/sale-vat-index.json', { PATH: `${join(REPO, 'tests/support/stub-bin')}:${process.env.PATH}`, CLAUDE_STUB_CHANGES: CHANGES, CLAUDE_STUB_TEXT: TEXT });
});
after(() => { api?.stop(); rmSync(log, { recursive: true, force: true }); });

async function wish(changes: unknown[], text: string, language = 'de') {
  writeFileSync(CHANGES, JSON.stringify(changes));
  writeFileSync(TEXT, text);
  const res = await api.fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'buch die Miete richtig', language, context: [] }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as AssistantEvent);
  const id = (events[0] as { id: string }).id;
  const turn = ((await api.send('GET', `/api/assistant/${id}`)).json as unknown as Conversation).turns.at(-1) as Extract<Turn, { role: 'ai' }>;
  return { events, turn };
}

test('r8f-47: changes made at once end the answer with the app\'s own line, streamed to the sidebar, whatever the model claimed', async () => {
  const claim = 'Weil das mehr als drei Zahlungen sind, zeigt die App sie dir als Vorschlag. Es ändert sich nichts, bevor du «Übernehmen» drückst.';
  const { events, turn } = await wish([
    { kind: 'account', number: '6001', name: 'Miete Salon' },
    { kind: 'entry', id: 'e-eu', set: { description: 'Exemple SARL, Beratung' } },
  ], claim);
  assert.equal(turn.held, undefined, 'an account and one booking\'s text are no rebooking: made at once');
  assert.equal(turn.changes?.length, 2);
  const last = turn.text.trim().split('\n\n').at(-1);
  // The model named «Übernehmen» for changes made at once: the app's line says so too (r10f-11).
  assert.equal(last, 'Gemacht: 2 Änderungen, je mit «Rückgängig». Es gibt nichts zu «Übernehmen»: was die KI darüber schreibt, gilt nicht.', 'the app says what it did, after the model\'s words');
  assert.ok(turn.text.includes(claim), 'the model\'s own words stay (the app does not rewrite them)');
  const replaced = events.filter((e): e is Extract<AssistantEvent, { type: 'replace' }> => e.type === 'replace').at(-1);
  assert.equal(replaced?.text, turn.text, 'the sidebar gets the whole text with the line');
});

test('r8f-47: one change, in the person\'s language', async () => {
  const { turn } = await wish([{ kind: 'entry', id: 'e-doc', set: { description: 'Rechnung 12, bezahlt' } }], 'Fait.', 'fr');
  assert.equal(turn.text.trim().split('\n\n').at(-1), 'Fait : 1 modification, avec « Annuler ».');
});

test('r8f-47, r8f-48: the prompt leaves made-or-held to the app and makes a general wish hold for every payment of the open period', () => {
  const prompt = assistantSystem('de', '2850', '');
  assert.doesNotMatch(prompt, /Write such an answer as a proposal/, 'the model no longer guesses whether the app will hold its block');
  assert.match(prompt, /the app's decision[^.]*says which under your answer/);
  assert.match(prompt, /never that it is done, never that nothing changes before «Übernehmen», and never name «Übernehmen» or a confirmation at all/);
  assert.match(prompt, /Also what you say while you read or search is in German, never a sentence in another language/, 'the answer is in the person\'s language from the first word (r10f-36)');
  assert.match(prompt, /every booking of the open period the wish holds for/);
  assert.match(prompt, /Say that a payment is not booked only after you read its bookings/);
});

test('an English chat is told to answer in English: the German examples are said in English, no rule forbids English, buttons carry their English names', () => {
  const prompt = assistantSystem('en', '2850', '');
  assert.match(prompt, /Also what you say while you read or search is in English, never a sentence in another language/);
  assert.match(prompt, /The examples in these instructions and in the guides are quoted in German: say what they mean in English/);
  assert.doesNotMatch(prompt, /never an English sentence/, 'a German-minded rule told the English chat to avoid English, so it answered in German');
  assert.doesNotMatch(prompt, /«Freigegeben»|«Eingereicht»|«Zurück»|under Aufgaben|booking in Buchungen/, 'buttons and places by their English names');
});
