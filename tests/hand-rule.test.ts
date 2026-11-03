/**
 * A rule made by hand in Firma › Regeln, without the AI (r8k-4): the form's rule is drafted into
 * its file for the same card the AI's draft gets (its preview, «Behalten»), kept with one click,
 * listed as made by hand, and books the next payment it matches. A VAT code the firm's form does
 * not take is refused with its reason, and nothing is drafted.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startApi, type ApiServer } from './support/api-server.js';
import { APP_FOLDER, APP_ROOT } from '../src/workspace/workspace.js';
import { loadBooks } from '../src/books/store.js';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { draftDir } from '../src/saving/changes.js';
import type { BankTransaction } from '../src/types/index.js';
import type { DraftView, RulesView } from '../src/saving/rules.js';
import { emptyForm, handRuleOf } from '../src/app/areas/company/hand-rule-model.js';

const GUIDE = 'knowledge/rules/booking.guide.yaml';
const IBAN = 'CH00 0076 2011 6238 5295 7';
const servers: ApiServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); });
async function start(manifestOf?: string): Promise<ApiServer> {
  const api = await startApi('demo', {}, manifestOf ? { manifestOf: join(APP_ROOT, manifestOf, APP_FOLDER) } : {});
  servers.push(api);
  return api;
}

test('a rule made by hand is drafted for the card, kept with one click, and books the next payment of that payer', async () => {
  const api = await start();
  const made = await api.send('POST', '/api/rules/hand', { match: { kind: 'payer', payer: IBAN }, direction: 'out', account: '6570', vat: 'I81' });
  assert.deepEqual([made.status, made.json], [200, { path: GUIDE }], JSON.stringify(made.json));
  assert.ok(!existsSync(join(api.root, GUIDE)) || !readFileSync(join(api.root, GUIDE), 'utf8').includes('CH0000762011623852957'), 'nothing is kept before «Behalten»');

  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(GUIDE)}`)).json as unknown as DraftView;
  assert.deepEqual([card.added.map((r) => [r.rule?.when, r.rule?.then, r.origin]), card.keepable, card.preview.length],
    [[[{ payer: 'CH0000762011623852957', direction: 'out' }, { kind: 'book', booking: { account: '6570', vat: 'I81' } }, 'hand']], true, 1]);
  const kept = await api.send('POST', '/api/rules/draft', { kind: 'keep', path: GUIDE, basis: card.basis, confirm: card.confirm });
  assert.equal(kept.json.ok, true, JSON.stringify(kept.json));

  const rule = (parse(readFileSync(join(api.root, GUIDE), 'utf8')).steps.classify.rules as Array<{ id: string; source: string }>).at(-1)!;
  assert.match(rule.source, /^hand \d{4}-\d{2}-\d{2}$/);
  const listed = ((await api.send('GET', '/api/rules')).json as unknown as RulesView).rules.find((r) => r.id === rule.id);
  assert.equal(listed?.origin, 'hand', 'Firma › Regeln says the rule was made by hand');

  const books = loadBooks(api.ws);
  const next: BankTransaction = { ref: 'HAND-NEXT', bank: 'Raiffeisen', date: '2026-11-20', amount: 64.5, currency: 'CHF', direction: 'DBIT', description: 'Abo November', counterparty: 'Beispiel Hosting GmbH', counterpartyIban: IBAN };
  books.transactions.push(next);
  await classifyTransactions(books, [next], { fx: loadFxResolver(), context: loadClassifyContext(api.ws) });
  assert.deepEqual(books.journalEntries.filter((e) => e.transactionRef === 'HAND-NEXT').map((e) => [e.accountDebit, e.vatCode, e.rule]), [['6570', 'I0', rule.id]],
    'the next payment of that payer is booked by the rule (the zero code: no receipt shows Swiss VAT)');
});

test('a firm not registered for VAT: a hand-made rule with a VAT code is refused as codeNotTaken, and nothing is drafted', async () => {
  const api = await start('demo-coiffeur');
  const refused = await api.send('POST', '/api/rules/hand', { match: { kind: 'text', text: 'Coiffeurbedarf' }, account: '6570', vat: 'M81' });
  assert.deepEqual([refused.status, refused.json.code, refused.json.params], [400, 'codeNotTaken', { code: 'M81', method: 'none' }], JSON.stringify(refused.json));
  assert.ok(!existsSync(join(draftDir(api.ws), GUIDE)), 'no draft is written');
  const ok = await api.send('POST', '/api/rules/hand', { match: { kind: 'text', text: 'Coiffeurbedarf' }, account: '6570', vat: null });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('a hand-made rule the app cannot carry out is refused with its reason as a typed code', async () => {
  const api = await start();
  const refused = await api.send('POST', '/api/rules/hand', { match: { kind: 'text', text: 'Hosting' }, account: '9999', vat: 'I81' });
  assert.deepEqual([refused.status, refused.json.code, (refused.json.params as { refusal: { code: string } }).refusal.code], [400, 'rule', 'account'], JSON.stringify(refused.json));
});

test('a hand-made rule with a private share as own use is drafted as such, and refused where no input tax is claimed', async () => {
  const api = await start();
  const made = await api.send('POST', '/api/rules/hand', { match: { kind: 'text', text: 'Videoabo' }, account: '6570', vat: 'I81', private: { share: 50, ownUse: true } });
  assert.deepEqual([made.status, made.json], [200, { path: GUIDE }], JSON.stringify(made.json));
  assert.match(readFileSync(join(draftDir(api.ws), GUIDE), 'utf8'), /then: \{ account: "6570", vat: I81, private: \{ share: 50, as: own-use \} \}/);
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(GUIDE)}`)).json as unknown as DraftView;
  assert.deepEqual(card.added.map((r) => r.rule?.then), [{ kind: 'book', booking: { account: '6570', vat: 'I81', private: 50, ownUse: true } }]);
  const none = await api.send('POST', '/api/rules/hand', { match: { kind: 'text', text: 'Videoabo' }, account: '6570', vat: null, private: { share: 50, ownUse: true } });
  assert.deepEqual([none.status, none.json.code, (none.json.params as { refusal: { code: string } }).refusal.code], [400, 'rule', 'ownUse'], JSON.stringify(none.json));
  const bad = await api.send('POST', '/api/rules/hand', { match: { kind: 'text', text: 'Videoabo' }, account: '6570', vat: 'I81', private: { share: 'half' } });
  assert.equal(bad.status, 400);
});

test('the form makes the rule the person typed, or names the first field it still needs', () => {
  const form = { ...emptyForm(), text: 'Hostpoint', direction: 'out' as const, over: "1'000.50", account: '6570 Informatikaufwand', vat: 'I81' };
  assert.deepEqual(handRuleOf(form), { ok: true, rule: { match: { kind: 'text', text: 'Hostpoint' }, direction: 'out', amount: { over: 1000.5 }, account: '6570', vat: 'I81' } });
  assert.deepEqual(handRuleOf({ ...form, vat: '' }), { ok: true, rule: { match: { kind: 'text', text: 'Hostpoint' }, direction: 'out', amount: { over: 1000.5 }, account: '6570' } }, 'no code chosen: code takes it from the receipts, or the card asks');
  assert.deepEqual(handRuleOf({ ...form, text: ' ' }), { ok: false, missing: 'text' });
  assert.deepEqual(handRuleOf({ ...form, under: '500' }), { ok: false, missing: 'amount' }, '«over» must be less than «under»');
  assert.deepEqual(handRuleOf({ ...form, over: 'viel' }), { ok: false, missing: 'amount' });
  assert.deepEqual(handRuleOf({ ...form, account: '' }), { ok: false, missing: 'account' });
  assert.deepEqual(handRuleOf({ ...form, share: '50 %', ownUse: true }), { ok: true, rule: { match: { kind: 'text', text: 'Hostpoint' }, direction: 'out', amount: { over: 1000.5 }, account: '6570', vat: 'I81', private: { share: 50, ownUse: true } } });
  assert.deepEqual(handRuleOf({ ...form, share: '100' }), { ok: false, missing: 'share' });
  assert.deepEqual(emptyForm({ match: { kind: 'business', id: 'swiss-post' }, direction: 'out', name: 'Post CH' }).business, 'swiss-post', 'started from a payment: its business');
});

test('the form started from a payment names its business or payer, and its direction', async () => {
  const api = await start();
  const tx = loadBooks(api.ws).transactions.find((t) => t.description.startsWith('Infomaniak'));
  assert.ok(tx, 'the demo pays Infomaniak');
  const { json } = await api.send('GET', `/api/rules/hand?payment=${encodeURIComponent(tx.ref)}`);
  const begun = json.start as { match: { kind: string }; direction: string };
  assert.ok(begun && ['business', 'payer'].includes(begun.match.kind), JSON.stringify(json));
  assert.equal(begun.direction, tx.direction === 'CRDT' ? 'in' : 'out');
  assert.equal((await api.send('GET', '/api/rules/hand?payment=none')).json.start, null);
});
