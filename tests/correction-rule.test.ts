/**
 * Every correction teaches (MISSION; r9k-5): when a person corrects a booking a rule made, the
 * app offers to change the rule, without the AI. Code reads the correction (the account, and the
 * code when she changed it), drafts the rule's new `then` into its file, and shows it on the rule's
 * card: what changes, the payments it would book differently, «Behalten» or «Verwerfen». Nothing
 * is kept until the click; the next payment the rule matches is booked the corrected way.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { startApi, type ApiServer } from './support/api-server.js';
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { correctionOffer } from '../src/saving/correction-rule.js';
import type { CorrectionOffer } from '../src/saving/correction-rule.js';
import type { BankTransaction } from '../src/types/index.js';
import type { DraftView } from '../src/saving/rules.js';
import './support/jurisdiction.js';

const GUIDE = 'knowledge/rules/booking.guide.yaml';
const servers: ApiServer[] = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); });

const payment = (ref: string, date: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount: 64.5, currency: 'CHF', direction: 'DBIT', description: 'Werkzeugmiete Monat', counterparty: 'Beispiel Mietwerk AG' });

/** Books `tx` as the company's rules would, in the server's workspace. */
async function bookByRule(api: ApiServer, tx: BankTransaction) {
  const ws = api.ws;
  const scratch = loadBooks(ws);
  scratch.transactions.push(tx);
  await classifyTransactions(scratch, [tx], { fx: loadFxResolver(), context: loadClassifyContext(ws) });
  const made = scratch.journalEntries.filter((e) => e.transactionRef === tx.ref);
  const books = loadBooks(ws);
  update(books, PERSON, (b) => { b.transactions.push(tx); b.journalEntries.push(...made); });
  saveBooks(ws, books);
  return made;
}

test('a person\'s correction of a rule booking offers the rule\'s change; kept, the rule books the next payment the corrected way', async () => {
  const api = await startApi('demo');
  servers.push(api);
  // The test workspace's chart holds only the history stub's accounts: the firm's chart gets both accounts first (Firma › Kontenplan).
  for (const [number, name] of [['6570', 'Informatikaufwand'], ['6513', 'Werkzeuge und Geräte']]) assert.equal((await api.send('PUT', `/api/accounts/${number}`, { name })).status, 200);
  const made = await api.send('POST', '/api/rules/hand', { match: { kind: 'text', text: 'Werkzeugmiete' }, direction: 'out', account: '6570', vat: 'I0' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const card = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(GUIDE)}`)).json as unknown as DraftView;
  assert.equal((await api.send('POST', '/api/rules/draft', { kind: 'keep', path: GUIDE, basis: card.basis, confirm: card.confirm })).json.ok, true);
  const ruleId = card.added[0].id;

  const [entry] = await bookByRule(api, payment('CORR-1', '2026-11-03'));
  assert.deepEqual([entry.accountDebit, entry.by?.kind], ['6570', 'rule'], 'the rule booked it');
  assert.equal(correctionOffer(api.ws, loadBooks(api.ws), 'CORR-1'), undefined, 'nothing to teach while the booking is the rule\'s');

  const corrected = await api.send('PATCH', `/api/journal-entries/${entry.id}`, { accountDebit: '6513' });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.json));
  const offer = (await api.send('GET', '/api/rules/correction?ref=CORR-1')).json.offer as CorrectionOffer | null;
  assert.ok(offer, 'the correction offers the rule\'s change');
  assert.deepEqual([offer.rule, offer.path, offer.from, offer.to], [ruleId, GUIDE, { account: '6570', vat: 'I0' }, { account: '6513', vat: 'I0' }], JSON.stringify(offer));

  const drafted = await api.send('POST', '/api/rules/correction', { ref: 'CORR-1' });
  assert.deepEqual([drafted.status, drafted.json], [200, { path: GUIDE }]);
  assert.equal((parse(readFileSync(join(api.root, GUIDE), 'utf8')).steps.classify.rules as Array<{ id: string; then: { account: string } }>).find((r) => r.id === ruleId)?.then.account, '6570', 'nothing is kept before «Behalten»');
  const change = (await api.send('GET', `/api/rules/draft?path=${encodeURIComponent(GUIDE)}`)).json as unknown as DraftView;
  assert.deepEqual(change.changed.map((r) => [r.id, r.rule?.then]), [[ruleId, { kind: 'book', booking: { account: '6513', vat: 'I0' } }]], `the card shows the rule as it would be: ${JSON.stringify({ changed: change.changed, refused: change.refused, broken: change.broken, added: change.added.length })}`);
  assert.deepEqual(change.before.map((r) => r.rule?.then), [{ kind: 'book', booking: { account: '6570', vat: 'I0' } }], 'and as it was');
  assert.ok(change.preview.length, 'with the payments it would book differently');
  assert.equal((await api.send('POST', '/api/rules/draft', { kind: 'keep', path: GUIDE, basis: change.basis, confirm: change.confirm })).json.ok, true);
  const kept = (parse(readFileSync(join(api.root, GUIDE), 'utf8')).steps.classify.rules as Array<{ id: string; then: { account: string }; source: string }>).find((r) => r.id === ruleId)!;
  assert.equal(kept.then.account, '6513');
  assert.match(kept.source, /^correction \d{4}-\d{2}-\d{2}$/, 'the rule says a correction made it so');

  const [next] = await bookByRule(api, payment('CORR-2', '2026-12-03'));
  assert.deepEqual([next.accountDebit, next.by], ['6513', { kind: 'rule', rule: ruleId }], 'the next payment is booked the corrected way');
  assert.equal((await api.send('GET', '/api/rules/correction?ref=CORR-1')).json.offer, null, 'nothing more to teach from that correction');
});

test('r10f-35: a filed sale corrected to «kein Verkauf» in the open period offers the payer rule\'s change: to the account the correction credits, without a code', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { tempWorkspace, writeIndex } = await import('./support/workspace.js');
  const { workspaceAt } = await import('../src/workspace/workspace.js');
  const { filingKeyOf } = await import('../src/accounting/periods.js');
  const iban = 'CH0000762011623852958';
  const closed = '2026-06-30';
  const filed: BankTransaction = { ref: 'SALE-F', bank: 'Raiffeisen', date: '2026-05-10', amount: 4380, currency: 'CHF', direction: 'CRDT', description: 'Peter Beispiel', counterparty: 'Peter Beispiel', counterpartyIban: iban };
  const w0 = tempWorkspace('correction-filed-');
  mkdirSync(join(w0.paths.root, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(w0.paths.root, GUIDE), `process: booking\nsteps:\n  classify:\n    rules:\n      - id: sale-q-1\n        when: { payer: ${iban}, direction: in }\n        then: { account: "3400", vat: V81 }\n        source: correction 2026-05-02\n`);
  mkdirSync(w0.paths.masterData, { recursive: true });
  writeFileSync(w0.paths.accounts, JSON.stringify([['1020', 'Bank'], ['2451', 'Kontokorrent'], ['3400', 'Dienstleistungsertrag']].map(([number, name]) => ({ number, name }))));
  writeIndex(w0, {
    transactions: [filed], receipts: [], mappings: [], bankStatements: [], config: { closedThrough: closed },
    journalEntries: [
      { id: 'sale-f', transactionRef: 'SALE-F', date: filed.date, accountDebit: '1020', accountCredit: '3400', amount: 4380, vatCode: 'V81', description: 'Peter Beispiel', origin: 'classify', by: { kind: 'rule', rule: 'sale-q-1' }, rule: 'sale-q-1' },
      { id: 'corr-f', transactionRef: 'SALE-F', date: '2026-08-01', accountDebit: '3400', accountCredit: '2451', amount: 4380, vatCode: '-V81', description: 'Korrektur sale-f: kein Verkauf', origin: 'manual', corrects: filingKeyOf(filed.date, w0.filingLength), by: { kind: 'person', at: '2026-08-01T10:00:00Z' } },
    ],
  });
  const ws = workspaceAt(w0.paths.root);
  const offer = correctionOffer(ws, loadBooks(ws), 'SALE-F');
  assert.ok(offer, 'the correction of a filed sale teaches the payer rule');
  assert.deepEqual([offer.rule, offer.entry, offer.from, offer.to], ['sale-q-1', 'corr-f', { account: '3400', vat: 'V81' }, { account: '2451', vat: null }]);
});
