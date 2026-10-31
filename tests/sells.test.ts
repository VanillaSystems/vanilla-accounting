/**
 * #46: one setup question «Was verkauft ihr?» with any combination of products made, goods traded
 * and services. The defaults follow (purchases 4000 or 4200, sales 3000, 3200, 3400), the classifier
 * reads them, the manifest keeps the answer as it always did (sells: services | goods | both) with
 * which goods beside it, so old manifests read unchanged; the setup form, the init flags and the
 * onboarding conversation ask it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { SALES_KINDS, kindsOf, profileOf, type SalesKind } from '../src/workspace/setup.js';
import { payoutSales, salesDefaults } from '../src/workspace/sells.js';
import { setup } from '../src/engines/index.js';
import { parseManifest } from '../src/workspace/manifest.js';
import { patchManifestText } from '../src/workspace/manifest-write.js';
import { checkAnswers, SetupError } from '../src/workspace/create.js';
import { buildBatchClassifyPrompt } from '../src/llm/prompts.js';
import { setupThread, topicStates, type SetupStep } from '../src/onboarding/conversation.js';
import { emptyProgress, withAnswer, type Answer, type QuestionId, type SetupProgress } from '../src/onboarding/model.js';
import type { SetupFacts } from '../src/onboarding/facts.js';
import { EFFECTIVE_QUARTERLY } from '../src/workspace/vat-setup.js';
import { PRESETS, type Answers } from '../src/workspace/setup.js';
import { startApi, type ApiServer } from './support/api-server.js';
import './support/jurisdiction.js';

const combos: SalesKind[][] = [['made'], ['traded'], ['services'], ['made', 'traded'], ['made', 'services'], ['traded', 'services'], ['made', 'traded', 'services']];

test('each combination gives its default accounts: purchases 4000 / 4200, sales 3000 / 3200 / 3400, payouts on the one kind\'s revenue', () => {
  const got = combos.map((k) => {
    const d = salesDefaults(k, setup().sells);
    return [k.join('+'), d.purchase.map((p) => p.account).join(','), d.sales.map((s) => s.account).join(','), payoutSales(k, setup().sells, setup().answers.payouts.sales.otherwise)];
  });
  assert.deepEqual(got, [
    ['made', '4000', '3000', '3000'],
    ['traded', '4200', '3200', '3200'],
    ['services', '', '3400', '3400'],
    ['made+traded', '4000,4200', '3000,3200', '3400'],
    ['made+services', '4000', '3000,3400', '3400'],
    ['traded+services', '4200', '3200,3400', '3400'],
    ['made+traded+services', '4000,4200', '3000,3200,3400', '3400'],
  ]);
});

const MANIFEST = (profile: string) => `schema: 1
company: { name: Beispiel GmbH, uid: CHE-153.004.184, owner: Anna Muster, legalForm: GmbH, vat: { registered: true, method: effective, reporting: received, period: quarterly } }
bankAccounts:
  - { bank: UBS, currency: CHF, account: "1020", label: UBS CHF }
profile:
  preset: custom
  fiscalYear: calendar
  start: new
${profile}
  foreignCustomers: no
  imports: no
  employees: none
  ownerPaysPrivately: no
  privateUse: []
  payouts: yes
`;

test('an old manifest reads unchanged: services, goods (traded, as a webshop) and both, with the same payout account as before', () => {
  const read = (sells: string) => parseManifest(MANIFEST(`  sells: ${sells}`), 'm.yaml').profile!;
  assert.deepEqual(['services', 'goods', 'both'].map((s) => read(s).sells), [['services'], ['traded'], ['traded', 'services']]);
  assert.deepEqual(['services', 'goods', 'both'].map((s) => payoutSales(read(s).sells, setup().sells, setup().answers.payouts.sales.otherwise)), ['3400', '3200', '3400'], 'goods → 3200, otherwise 3400, as payouts.sales said');
});

test('the manifest keeps the answer as before plus which goods; written and read back it is the same combination', () => {
  for (const kinds of combos) {
    const { text, manifest } = patchManifestText(MANIFEST('  sells: services'), { sells: kinds }, 'm.yaml');
    const profile = (parse(text) as { profile: { sells: string; goods?: string[] } }).profile;
    assert.equal(profile.sells, profileOf(kinds), kinds.join('+'));
    assert.deepEqual(profile.goods ?? [], kinds.filter((k) => k !== 'services'));
    assert.deepEqual(manifest.profile!.sells, kinds);
    assert.deepEqual(kindsOf(profileOf(kinds), profile.goods as never), kinds);
  }
  assert.throws(() => parseManifest(MANIFEST('  sells: goods\n  goods: [shoes]'), 'm.yaml'), /profile\.goods must be a list of made, traded/);
});

test('the setup form and init take any combination but none; one value from an older form is a list of one', () => {
  const base = { ...PRESETS.consultant.answers } as unknown as Answers;
  assert.deepEqual(checkAnswers({ ...base, sells: ['made', 'services'] } as Answers).answers.sells, ['made', 'services']);
  assert.deepEqual(checkAnswers({ ...base, sells: 'services' } as unknown as Answers).answers.sells, ['services']);
  assert.throws(() => checkAnswers({ ...base, sells: [] } as unknown as Answers), (e: Error) => e instanceof SetupError && /What you sell: an answer is needed \(--sells: made, traded, services\)/.test(e.message));
  assert.deepEqual(PRESETS.trades.answers.sells, ['made', 'services'], 'a trades firm makes what it sells');
});

test('the classifier reads what the firm sells and the default accounts', () => {
  const prompt = buildBatchClassifyPrompt([], { companyName: 'Beispiel GmbH', chartOfAccounts: '', historicEntries: '', sells: salesDefaults(['made', 'services'], setup().sells) });
  assert.match(prompt, /## What the company sells\nproducts it makes itself, services\. Default accounts, unless a rule, the receipt or the prior year says otherwise: material for its own products → 4000; sales of products it makes itself → 3000; sales of services → 3400\./);
  assert.doesNotMatch(buildBatchClassifyPrompt([], { companyName: 'X', chartOfAccounts: '', historicEntries: '' }), /What the company sells/, 'not answered: nothing said');
});

const ACCOUNTS = { made: { purchase: '4000', sales: '3000' }, traded: { purchase: '4200', sales: '3200' }, services: { sales: '3400' } };
const facts = (kinds: SalesKind[] | undefined): SetupFacts => ({
  today: '2026-10-21', year: '2026',
  company: { name: 'Muster GmbH', uid: 'CHE-123.456.789', owner: 'Anna Muster', legalForm: 'GmbH', vat: EFFECTIVE_QUARTERLY },
  banks: [], sources: [], opening: [], books: { payments: 0, receipts: 0, entries: 0 }, partners: { clear: [], mixed: [], rare: [], ruled: 0 }, rules: 0,
  ...(kinds ? { sells: { kinds, accounts: ACCOUNTS } } : {}),
});
const answered = (pairs: Partial<Record<QuestionId, string>>): SetupProgress =>
  Object.entries(pairs).reduce((acc, [q, value], i) => withAnswer(acc, q as QuestionId, { value, at: `2026-10-21T09:0${i}:00.000Z` } as Answer), emptyProgress());
const step = (steps: SetupStep[], id: string) => steps.find((s) => s.id === id)!;

test('the onboarding conversation asks it after the VAT, as three toggles started from the profile; the answer\'s card shows the defaults', () => {
  const asked = setupThread(answered({ company: 'ok', vat: 'effective' }), facts(['services']));
  const s = asked.at(-1)!;
  assert.deepEqual([s.id, s.multi, s.choices.map((c) => c.value), s.choices.filter((c) => c.primary).map((c) => c.value)], ['sells', true, [...SALES_KINDS], ['services']]);
  const other = answered({ company: 'ok', vat: 'effective', sells: 'made+services' });
  const card = step(setupThread(other, facts(['services'])), 'sells').reply?.card;
  assert.deepEqual(card, { kind: 'sells', kinds: ['made', 'services'], state: 'proposed', purchase: [{ kind: 'made', account: '4000' }], sales: [{ kind: 'made', account: '3000' }, { kind: 'services', account: '3400' }] });
  assert.equal(topicStates(other, facts(['services'])).firm, 'open', 'an answer the profile does not say yet leaves the firm open');
  assert.equal(topicStates(other, facts(['made', 'services'])).firm, 'done', 'taken over: done');
  assert.equal(step(setupThread(other, facts(['made', 'services'])), 'sells').reply?.card?.kind === 'sells' && (step(setupThread(other, facts(['made', 'services'])), 'sells').reply!.card as { state: string }).state, 'kept');
  assert.equal(setupThread(answered({ company: 'ok', vat: 'effective' }), facts(undefined)).at(-1)!.id, 'start', 'a workspace without a profile is not asked');
});

let api: ApiServer | undefined;
after(() => api?.stop());

test('«Weiter» saves the answer into the profile through PATCH /api/workspace; a workspace without a profile refuses it', async () => {
  api = await startApi('tests/fixtures/sale-vat-index.json');
  const refused = await api.send('PATCH', '/api/workspace', { sells: ['made'] });
  assert.equal(refused.status, 400, 'no profile');
  const manifest = join(api.root, 'belege.workspace.yaml');
  writeFileSync(manifest, `${readFileSync(manifest, 'utf8').trimEnd()}\nprofile:\n  preset: webshop\n  fiscalYear: calendar\n  start: new\n  sells: goods\n  foreignCustomers: yes\n  imports: no\n  employees: none\n  ownerPaysPrivately: yes\n  privateUse: []\n  payouts: yes\n`);
  assert.equal((await api.send('PATCH', '/api/workspace', { sells: ['shoes'] })).status, 400);
  const r = await api.send('PATCH', '/api/workspace', { sells: ['made', 'traded'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const profile = (parse(readFileSync(manifest, 'utf8')) as { profile: { sells: string; goods: string[] } }).profile;
  assert.deepEqual([profile.sells, profile.goods], ['goods', ['made', 'traded']]);
  const view = (await api.send('GET', '/api/onboarding')).json as unknown as { facts: SetupFacts };
  assert.deepEqual(view.facts.sells?.kinds, ['made', 'traded'], 'the conversation sees it');
});
