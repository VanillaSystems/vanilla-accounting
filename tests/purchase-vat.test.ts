/**
 * The business files and the receipt rules decide a purchase line's input-tax code in code (issue
 * #45): an app business file's `apply:` states a fact, a company file's `apply:` the company's
 * choice for an unread receipt, and the receipt rules of booking.guide.yaml#purchase_vat. The
 * company's own word for a business goes first, a rule that leaves a choice stays the model's, and a firm on the net
 * tax rate method or not registered books per its setup. Synthetic business files, no real vendor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTransactions, type ClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { parseApply, businessVat } from '../src/booking/purchase-vat.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { setJurisdiction } from '../src/engines/index.js';
import { APP_ROOT } from '../src/workspace/workspace.js';
import type { Books } from '../src/books/store.js';
import type { ClassifyEntry } from '../src/llm/prompts.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import type { VatSetup } from '../src/workspace/vat-setup.js';
import './support/jurisdiction.js';

const fx = loadFxResolver();
const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;

const PLATFORM = `id: platform
name: Plattform
match: { tx: [ "plattform" ] }
steps:
  booking.guide.yaml#purchase_vat:
    rules:
      - id: pv-platform-fees
        when: the fees inside a payout
        then: no input tax at the payout; the monthly bill proves it
        apply: { inputTax: none, direction: in }
        source: test fixture
`;
const STATION = `id: station
name: Tankstelle Muster
match: { tx: [ "tankstelle muster" ] }
facts:
  - id: station-vat
    fact: registered for Swiss VAT, mostly 8.1 %
    source: test fixture
`;
/** The company's choice, not a fact of the business: its unread receipt counts as 8.1 %. */
const STATION_HOUSE = `id: station
steps:
  booking.guide.yaml#purchase_vat:
    rules:
      - id: station-unread
        when: a receipt that stays unreadable
        then: charged at 8.1
        apply: { unreadReceipt: 8.1 }
        source: decision 2026-10-21
`;
const CLOUD = `id: cloud
name: Cloudservice
match: { tx: [ "cloudservice" ] }
steps:
  booking.guide.yaml#purchase_vat:
    rules:
      - id: pv-cloud-choice
        when: the invoice is in hand
        then: Swiss MWST with a CHE number → I81; none → B81-1
        source: test fixture
`;

function knowledgeWith(company: Record<string, string> = {}) {
  const app = mkdtempSync(join(tmpdir(), 'pv-app-'));
  const ws = mkdtempSync(join(tmpdir(), 'pv-ws-'));
  mkdirSync(join(app, 'processes', 'suppliers'), { recursive: true });
  for (const [id, text] of Object.entries({ platform: PLATFORM, station: STATION, cloud: CLOUD })) writeFileSync(join(app, 'processes', 'suppliers', `${id}.yaml`), text);
  mkdirSync(join(ws, 'knowledge', 'suppliers'), { recursive: true });
  for (const [id, text] of Object.entries(company)) writeFileSync(join(ws, 'knowledge', 'suppliers', `${id}.yaml`), text);
  return loadKnowledge(app, ws);
}

function contextOf(k: ReturnType<typeof loadKnowledge>, vat?: VatSetup): ClassifyContext {
  return {
    companyName: 'Test GmbH', chartOfAccounts: '', historicEntries: '',
    bankAccounts: [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Bank', role: 'bank' }],
    counterparties: k.counterparties, purchaseVat: businessVat(k), ...(vat && { vat }),
  };
}

const pay = (description: string, direction: 'DBIT' | 'CRDT', amount: number): BankTransaction =>
  ({ ref: 'P1', bank: 'Raiffeisen', date: '2026-10-17', amount, currency: 'CHF', direction, description });

const receipt = (r: Partial<Receipt>): Receipt => ({ id: 'r1', filename: 'beleg.pdf', extractedText: 'Beleg', currency: 'CHF', ...r }) as Receipt;

const model = (entries: ClassifyEntry[]): ClassifyDeps['ask'] => async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries, reason: 'Die Lesung des Modells.' }])));
};

async function book(tx: BankTransaction, receipts: Receipt[], entries: ClassifyEntry[], context: ClassifyContext): Promise<JournalEntry[]> {
  const books = {
    transactions: [tx], receipts, mappings: receipts.map((r) => ({ transactionRef: tx.ref, receiptId: r.id })),
    bankStatements: [], journalEntries: [], config: { closedThrough: '2026-09-30' },
  } as unknown as Books;
  const { classified, failed } = await classifyTransactions(books, [tx], { ask: model(entries), fx, context });
  assert.deepEqual([classified, failed.map((f) => f.reason)], [[tx.ref], []]);
  return books.journalEntries;
}

const line = (accountDebit: string, accountCredit: string, amount: number, vatCode: string): ClassifyEntry => ({ accountDebit, accountCredit, amount, vatCode, description: 'Test' });
const fields = (e: JournalEntry) => [e.accountDebit, e.vatCode ?? '', e.by];
const MODEL = { kind: 'model', model: 'sonnet' };
const CODE = { kind: 'code', check: 'purchaseVat' };

test('a payout of a business whose file says its fees claim no input tax: the fee line is booked I0 by code, naming the rule', async () => {
  const k = knowledgeWith();
  const [sale, fee] = await book(pay('Plattform Auszahlung', 'CRDT', 95), [receipt({ kind: 'sales-record', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 7.5, gross: 100 }] })],
    [line('', '3400', 100, 'V81'), line('6580', '1020', 5, 'I81')], contextOf(k));
  assert.deepEqual(fields(fee), ['6580', 'I0', CODE]);
  assert.match(fee.reason ?? '', /pv-platform-fees/);
  assert.match(fee.reason ?? '', /Plattform/);
  assert.equal(sale.vatCode, 'V81');
});

test('the same business\'s monthly bill paid out, with an invoice showing 8.1 % on the whole amount, keeps I81: the fact holds for payouts only', async () => {
  const k = knowledgeWith();
  const [e] = await book(pay('Plattform Monatsrechnung', 'DBIT', 108.1), [receipt({ kind: 'invoice', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 8.1, gross: 108.1 }] })],
    [line('6580', '', 108.1, 'I81')], contextOf(k));
  assert.deepEqual(fields(e), ['6580', 'I81', MODEL]);
});

test('the company\'s own rule for the business goes first: its payout fee keeps the model\'s code', async () => {
  const k = knowledgeWith({ platform: `id: platform
steps:
  booking.guide.yaml#purchase_vat:
    rules:
      - id: platform-house
        when: our fees
        then: the house way
        source: decision 2026-10-01
` });
  const [, fee] = await book(pay('Plattform Auszahlung', 'CRDT', 95), [], [line('', '3400', 100, 'V81'), line('6580', '1020', 5, 'I81')], contextOf(k));
  assert.deepEqual(fields(fee), ['6580', 'I81', MODEL]);
});

test('an unread receipt of a business whose company file counts it as 8.1 %: the model\'s I0 becomes I81 by code, naming the company\'s rule', async () => {
  const k = knowledgeWith({ station: STATION_HOUSE });
  const [e] = await book(pay('Tankstelle Muster Dorf', 'DBIT', 80), [receipt({ amount: 80, needsVisionReview: true })], [line('6200', '', 80, 'I0')], contextOf(k));
  assert.deepEqual(fields(e), ['6200', 'I81', CODE]);
  assert.match(e.reason ?? '', /station-unread der Firma/);
});

test('an unread receipt without a company rule is no evidence, also of a business the app knows charges VAT: the model\'s code stands either way', async () => {
  const k = knowledgeWith();
  for (const who of ['Kiosk Ecke', 'Tankstelle Muster Dorf']) {
    const [zero] = await book(pay(who, 'DBIT', 80), [receipt({ amount: 80, needsVisionReview: true })], [line('6200', '', 80, 'I0')], contextOf(k));
    assert.deepEqual(fields(zero), ['6200', 'I0', MODEL], who);
    const [rated] = await book(pay(who, 'DBIT', 80), [receipt({ amount: 80, needsVisionReview: true })], [line('6200', '', 80, 'I81')], contextOf(k));
    assert.deepEqual(fields(rated), ['6200', 'I81', MODEL], who);
  }
});

test('a linked Swiss receipt showing 8.1 % on the whole amount: the model\'s zero code becomes the rate code of the account (pv-charged)', async () => {
  const k = knowledgeWith();
  const vat81 = receipt({ hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 8.1, gross: 108.1 }] });
  const [office] = await book(pay('Bürohaus AG', 'DBIT', 108.1), [vat81], [line('6500', '', 108.1, 'I0')], contextOf(k));
  assert.deepEqual(fields(office), ['6500', 'I81', CODE]);
  assert.match(office.reason ?? '', /8\.1 %/);
  const [goods] = await book(pay('Bürohaus AG', 'DBIT', 108.1), [vat81], [line('4200', '', 108.1, 'M0')], contextOf(k));
  assert.deepEqual(fields(goods), ['4200', 'M81', CODE]);
});

test('a receipt that taxes only part of the payment, or a split into several lines, stays the model\'s (a customs invoice, a mixed cart)', async () => {
  const k = knowledgeWith();
  const part = receipt({ hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 1.62, gross: 21.62 }] });
  const [one] = await book(pay('Kurier AG', 'DBIT', 150), [part], [line('4020', '', 150, 'M0')], contextOf(k));
  assert.deepEqual(fields(one), ['4020', 'M0', MODEL]);
  const split = await book(pay('Kurier AG', 'DBIT', 150), [part], [line('4020', '', 100, 'M0'), line('4030', '', 28.38, ''), line('4040', '', 21.62, 'M81')], contextOf(k));
  assert.deepEqual(split.map(fields), [['4020', 'M0', MODEL], ['4030', '', MODEL], ['4040', 'M81', MODEL]]);
});

test('a rate code with no receipt, or with only a receipt showing no Swiss VAT, falls to the zero code by code (pv-no-receipt, pv-otherwise)', async () => {
  const k = knowledgeWith();
  const [none] = await book(pay('Bürohaus AG', 'DBIT', 50), [], [line('6500', '', 50, 'I81')], contextOf(k));
  assert.deepEqual(fields(none), ['6500', 'I0', CODE]);
  const [foreign] = await book(pay('Bürohaus AG', 'DBIT', 50), [receipt({ hasSwissVat: false })], [line('4200', '', 50, 'M81')], contextOf(k));
  assert.deepEqual(fields(foreign), ['4200', 'M0', CODE]);
});

test('a business file whose rule leaves a choice: the model decides, also Bezugsteuer', async () => {
  const k = knowledgeWith();
  const [e] = await book(pay('Cloudservice Inc', 'DBIT', 40), [receipt({ hasSwissVat: false })], [line('6570', '', 40, 'B81-1')], contextOf(k));
  assert.deepEqual(fields(e), ['6570', 'B81-1', MODEL]);
});

test('a firm on the net tax rate method books its purchases without a code, whatever the business file says', async () => {
  const netRate: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '99901' }] };
  setJurisdiction(ch, netRate);
  try {
    const k = knowledgeWith({ station: STATION_HOUSE });
    const [fuel] = await book(pay('Tankstelle Muster Dorf', 'DBIT', 80), [receipt({ amount: 80, needsVisionReview: true })], [line('6200', '', 80, 'I0')], contextOf(k, netRate));
    assert.deepEqual(fields(fuel), ['6200', '', MODEL]);
    const [, fee] = await book(pay('Plattform Auszahlung', 'CRDT', 95), [], [line('', '3400', 100, 'F1'), line('6580', '1020', 5, 'I81')], contextOf(k, netRate));
    assert.deepEqual(fields(fee), ['6580', '', MODEL]);
  } finally { setJurisdiction(ch); }
});

test('a firm not registered for VAT books every line without a code', async () => {
  const unregistered: VatSetup = { registered: false };
  setJurisdiction(ch, unregistered);
  try {
    const k = knowledgeWith({ station: STATION_HOUSE });
    const [fuel] = await book(pay('Tankstelle Muster Dorf', 'DBIT', 80), [receipt({ amount: 80, needsVisionReview: true })], [line('6200', '', 80, 'I81')], contextOf(k, unregistered));
    assert.deepEqual(fields(fuel), ['6200', '', MODEL]);
  } finally { setJurisdiction(ch); }
});

test('apply: takes inputTax none in an app file and an unread receipt\'s rate in a company file, with an optional direction; anything else is refused with what to write', () => {
  assert.deepEqual(parseApply({ inputTax: 'none', direction: 'in' }, 'app'), { ok: true, fact: { kind: 'noInputTax' }, direction: 'in' });
  assert.deepEqual(parseApply({ unreadReceipt: 8.1 }, 'workspace'), { ok: true, fact: { kind: 'unreadReceipt', rate: 8.1 } });
  assert.match((parseApply({ unreadReceipt: 8.1 }, 'app') as { problem: string }).problem, /company's choice.*knowledge\//);
  assert.match((parseApply({ inputTax: 'none' }, 'workspace') as { problem: string }).problem, /processes\//);
  for (const bad of [{ inputTax: 'I0' }, { unreadReceipt: 'acht' }, { inputTax: 'none', unreadReceipt: 8.1 }, { account: '6200' }, { inputTax: 'none', direction: 'both' }, 'I0']) {
    assert.equal(parseApply(bad, 'app').ok, false, JSON.stringify(bad));
    assert.equal(parseApply(bad, 'workspace').ok, false, JSON.stringify(bad));
  }
});

test('an unread receipt\'s rate written in an app business file is no fact: the loader skips it', () => {
  const k = knowledgeWith();
  const station = k.counterpartyFiles.find((f) => f.layer === 'app' && f.body.id === 'station')!;
  station.body.steps = { 'booking.guide.yaml#purchase_vat': { rules: [{ id: 'pv-station-unread', when: 'unreadable', then: 'I81', source: 'x', apply: { unreadReceipt: 8.1 } }] } };
  assert.equal(businessVat(k).facts.has('station'), false);
});

test('the shipped business files carry their facts (pv-shopify-fees); Coop Pronto\'s states facts only, no rate for an unread receipt', () => {
  const k = loadKnowledge(APP_ROOT, mkdtempSync(join(tmpdir(), 'pv-ws-')));
  const facts = businessVat(k).facts;
  assert.deepEqual(facts.get('shopify'), [{ rule: 'pv-shopify-fees', business: 'shopify', direction: 'in', fact: { kind: 'noInputTax' } }]);
  assert.equal(facts.has('coop-pronto'), false);
});
