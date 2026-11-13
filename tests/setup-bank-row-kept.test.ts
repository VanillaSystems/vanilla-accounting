/**
 * A bank row typed in the setup's card is never lost to a typed sentence (#496, round-9 walk r7-6),
 * with the model stubbed. The walk's order: the bank card filled (Zuger Kantonalbank and his IBAN),
 * not sent; then a sentence about the phone and Wise; the model returns only the new bank. Before the
 * fix the sentence answered the bank step from its words alone: the row and its IBAN were gone without
 * a word and the books held only Wise. Now the card's rows go with the words, are taken as «Weiter»
 * takes them, and the sentence adds to them; a row code refuses is said, and the model's banks then
 * wait with the card. Each test names the wrong behaviour it catches.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopServer } from '../src/desktop/server.js';
import { parseTalkRequest, type Ask } from '../src/onboarding/draft-talk.js';
import { draftSteps, unsentForm } from '../src/onboarding/draft.js';
import { testIban } from './support/iban.js';

const IBAN = testIban('00787000012345678');
const SENTENCE = 's Gschäftshandy bruuch ich au privat, öppe d Hälfti. Und en Kunde in Berlin zahlt in Euro uf mis Wise-Konto.';
/** What the model answered in the walk: the phone, and only the bank the sentence names. */
const MODEL = JSON.stringify({ say: 'Gut, s Gschäftshandy und s Wise-Konto in Euro sind da.', answers: { privateUse: ['phone'] }, banks: [{ bank: 'Wise', currency: 'EUR' }] });

const home = mkdtempSync(join(tmpdir(), 'vanilla-bankrow-'));
const dist = join(home, 'dist');
mkdirSync(dist);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

let answers: string[] = [];
const prompts: string[] = [];
const stub: Ask = async (prompt) => { prompts.push(prompt); return answers.shift() ?? ''; };

async function atBanks(name: string) {
  const desktop = desktopServer({ stateFile: join(home, `${name}.json`), demoRoot: join(home, 'Demo'), booksHome: home, dist, aiAvailable: async () => true, ask: stub });
  const server: Server = await new Promise((resolve) => { const s = desktop.app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  desktop.allowHost(`127.0.0.1:${port}`);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => undefined) };
  };
  const root = join(home, name);
  await call('POST', '/api/desktop/setup', { root, language: 'de' });
  for (const patch of [
    { step: 'firm', value: { name: 'Kälin Advisory GmbH', owner: 'Matthias Kälin' } },
    { step: 'preset', value: 'consultant' },
    { step: 'question', key: 'vatRegistered', value: 'yes' },
    { step: 'question', key: 'vatMethod', value: 'effective' },
    { step: 'question', key: 'basis', value: 'received' },
    { step: 'question', key: 'period', value: 'quarterly' },
  ]) assert.equal((await call('PUT', '/api/desktop/setup', { root, patch })).status, 200, JSON.stringify(patch));
  const view = (await call('POST', '/api/desktop/setup', { root, language: 'de' })).json;
  assert.equal(draftSteps(view.view.draft).at(-1)?.id, 'banks', 'the bank card is open, nothing of it sent');
  return { call, root };
}

test('r7-6: the bank row typed in the card and not sent stays, with its IBAN, when a sentence adds Wise and the model returns only Wise', async () => {
  const { call, root } = await atBanks('Kaelin');
  answers = [MODEL];
  const r = await call('POST', '/api/desktop/setup/talk', { root, text: SENTENCE, form: { banks: [{ bank: 'Zuger Kantonalbank', currency: 'CHF', iban: IBAN }, { bank: '', currency: 'CHF' }] } });
  assert.equal(r.status, 200);
  const { view, reply } = r.json;
  assert.deepEqual(view.draft.banks.map((b: { bank: string; currency: string; iban?: string }) => [b.bank, b.currency, b.iban]), [['Zuger Kantonalbank', 'CHF', IBAN], ['Wise', 'EUR', undefined]], 'was: only Wise, the typed row gone without a word');
  assert.deepEqual(reply.refused, [], 'nothing refused: the IBAN is hers, from the card');
  assert.equal(draftSteps(view.draft).at(-1)?.id, 'review');
  assert.ok(prompts.at(-1)!.includes('Zuger Kantonalbank'), 'the model sees the typed row as given, so it does not answer the bank step without it');
});

test('a row of the card code refuses is said, and the sentence\'s banks wait with the card: nothing of hers is replaced', async () => {
  const { call, root } = await atBanks('Refused');
  answers = [MODEL];
  const r = await call('POST', '/api/desktop/setup/talk', { root, text: SENTENCE, form: { banks: [{ bank: 'Zuger Kantonalbank', currency: 'CHF', iban: 'CH12 3456' }] } });
  const { view, reply } = r.json;
  assert.deepEqual(reply.refused.map((x: { step: string; refusal: { reason: string } }) => [x.step, x.refusal.reason]), [['banks', 'iban']], 'the refusal is shown');
  assert.equal(reply.say, '', 'the model\'s words are not shown beside it');
  assert.equal(view.draft.banks, undefined, 'the bank step stays open with her rows in the card');
  assert.deepEqual(view.draft.answers.privateUse, ['phone'], 'the rest of the sentence is taken');
});

test('the screen sends the card\'s typed rows with her words while the bank step waits, and nothing once it is answered', () => {
  const rows = [{ bank: 'Zuger Kantonalbank', currency: 'CHF', iban: IBAN }, { bank: ' ', currency: 'CHF' }];
  assert.deepEqual(unsentForm([{ id: 'firm', answer: { name: 'X', owner: 'Y' } }, { id: 'banks' }], rows), { banks: [rows[0]] }, 'was: only the words were sent');
  assert.equal(unsentForm([{ id: 'banks', answer: [{ bank: 'UBS', currency: 'CHF' }] }], rows), undefined, 'an answered step has no card');
  assert.equal(unsentForm([{ id: 'preset' }], rows), undefined, 'another step waits');
  assert.equal(unsentForm([{ id: 'banks' }], [{ bank: '', currency: 'CHF' }]), undefined, 'an empty card sends nothing');
});

test('without rows in the card a sentence answers the bank step as before; rows without a bank\'s name are not sent; a failed model saves nothing of the card', async () => {
  const { call, root } = await atBanks('Words');
  answers = [MODEL];
  const r = await call('POST', '/api/desktop/setup/talk', { root, text: SENTENCE });
  assert.deepEqual(r.json.view.draft.banks.map((b: { bank: string }) => b.bank), ['Wise']);
  assert.deepEqual(parseTalkRequest({ text: 'x', form: { banks: [{ bank: ' ', currency: 'CHF' }] } }), { text: 'x' });
  const other = await atBanks('Failed');
  answers = ['no json'];
  const failed = await other.call('POST', '/api/desktop/setup/talk', { root: other.root, text: SENTENCE, form: { banks: [{ bank: 'Zuger Kantonalbank', currency: 'CHF', iban: IBAN }] } });
  assert.equal(failed.json.reply.kind, 'unreadable');
  assert.equal(failed.json.view.draft.banks, undefined, 'her «Weiter» is still hers to click');
});
