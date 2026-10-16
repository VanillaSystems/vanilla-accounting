/**
 * The company's rules the app carries out (src/booking/rules.ts): a rule that books books the next
 * matching payment in code, without the model; a rule that asks holds the payment and the inbox run
 * turns it into a question in Automatisierung (workflows/ask), never a booking, until the person
 * takes the proposal. A rule written as sentences loads as a note and decides nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { parseRule, ruleFor, ruleWords, type PlacedRule, type RuleFacts } from '../src/booking/rules.js';
import { companyRules, factsOf, chartNames } from '../src/booking/rule-book.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadBooks, saveBooks, type Books } from '../src/books/store.js';
import { askedBy, closeAsksWithoutRule, CLOSED_REASON } from '../src/workflows/held.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { openEngine } from '../src/workflows/engine.js';
import { taskOf, fillTask } from '../src/workflows/model.js';
import { loadWorkflows } from '../src/workflows/load.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'rules-runs-'));

const RULES = `process: booking
steps:
  classify:
    rules:
      - id: cash-ask
        when: { text: "Bargeldbezug|Bancomat", direction: out, amount: { over: 500 } }
        then: { ask: "Wofür war der Barbezug?", account: "2451", vat: none }
        source: wish 2026-10-15
      - id: fuel
        when: { text: "Tankstelle" }
        then: { account: "6200", vat: I81 }
        source: wish 2026-10-15
      - id: old-note
        when: coffee for the office
        then: 6570 when the receipt shows Swiss VAT
        source: decision 2026-01-15, owner
`;

/** The demo with the rules above and, when given, a statement in the inbox. */
function company(rules = RULES): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'rules-ws-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  mkdirSync(join(dir, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'rules', 'booking.guide.yaml'), rules);
  return workspaceAt(dir);
}

const tx = (t: Partial<BankTransaction> & Pick<BankTransaction, 'ref'>): BankTransaction =>
  ({ bank: 'Raiffeisen', date: '2026-08-14', amount: 50, currency: 'CHF', direction: 'DBIT', description: 'Bank text', ...t });

function booksOf(txs: BankTransaction[], receipts: Array<Partial<Receipt> & { id: string; ref: string }> = []): Books {
  return {
    transactions: txs,
    receipts: receipts.map(({ ref, ...r }) => ({ filename: `${r.id}.pdf`, extractedText: 'Beleg mit genug Text', ...r }) as Receipt),
    mappings: receipts.map((r) => ({ transactionRef: r.ref, receiptId: r.id })),
    bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' },
  } as unknown as Books;
}

/** A model that books everything on 6570 and counts the payments it was asked about. */
function model() {
  const asked: string[] = [];
  const ask: NonNullable<ClassifyDeps['ask']> = async (prompt) => {
    const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
    asked.push(...refs);
    return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, { entries: [{ accountDebit: '6570', accountCredit: '', amount: 300, vatCode: 'I0', description: 'Model' }] }])));
  };
  return { ask, asked };
}

test('a rule that books books the next matching payment in code: its account, its VAT code only with Swiss VAT on the receipt, the model never asked', async () => {
  const ws = company();
  const context = loadClassifyContext(ws);
  const books = booksOf([
    tx({ ref: 'FUEL-1', description: 'Tankstelle Wil Ost', amount: 74.2 }),
    tx({ ref: 'FUEL-2', description: 'Tankstelle Wil Ost', amount: 60 }),
  ], [{ id: 'r1', ref: 'FUEL-1', hasSwissVat: true }]);
  const m = model();
  const out = await classifyTransactions(books, books.transactions, { ask: m.ask, fx: loadFxResolver(), context });
  assert.deepEqual(m.asked, [], 'no model call for a payment a rule decides');
  assert.deepEqual(out.classified.sort(), ['FUEL-1', 'FUEL-2']);
  const by = (ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '', e.rule]);
  assert.deepEqual(by('FUEL-1'), [['6200', '1021', 74.2, 'I81', 'fuel']]);
  assert.deepEqual(by('FUEL-2'), [['6200', '1021', 60, 'I0', 'fuel']], 'no receipt with Swiss VAT: the zero code');
  assert.match(books.journalEntries[0].reason ?? '', /^Regel: Text enthält «Tankstelle» → Konto 6200 Fahrzeugaufwand, MWST I81$/);
});

test('a rule that asks holds the payment: not booked, its question and proposal returned; a smaller withdrawal goes to the model', async () => {
  const ws = company();
  const books = booksOf([
    tx({ ref: 'CASH-800', description: 'Bargeldbezug Bancomat Wil', amount: 800 }),
    tx({ ref: 'CASH-300', description: 'Bargeldbezug Bancomat Wil', amount: 300 }),
  ]);
  const m = model();
  const out = await classifyTransactions(books, books.transactions, { ask: m.ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual(books.journalEntries.filter((e) => e.transactionRef === 'CASH-800'), [], 'the 800 withdrawal is not booked');
  assert.deepEqual(out.asked.map((a) => [a.ref, a.rule, a.question, a.entries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode])]),
    [['CASH-800', 'cash-ask', 'Wofür war der Barbezug?', [['2451', '1021', 800, undefined]]]]);
  assert.deepEqual(m.asked, ['CASH-300']);
  assert.deepEqual(out.classified, ['CASH-300']);
});

test('a rule switched off decides nothing; a rule written as sentences loads as a note and decides nothing', async () => {
  const ws = company(RULES.replace('source: wish 2026-10-15\n      - id: fuel', 'source: wish 2026-10-15\n        off: true\n      - id: fuel'));
  const rows = companyRules(ws, factsOf(chartNames(loadClassifyContext(ws).chartOfAccounts), new Set()));
  assert.deepEqual(rows.filter((r) => r.file === 'knowledge/rules/booking.guide.yaml').map((r) => [r.id, r.kind, r.off]), [['cash-ask', 'rule', true], ['fuel', 'rule', false], ['old-note', 'note', false]]);
  const books = booksOf([tx({ ref: 'CASH-800', description: 'Bargeldbezug Bancomat', amount: 800 })]);
  const m = model();
  const out = await classifyTransactions(books, books.transactions, { ask: m.ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual([out.asked, m.asked], [[], ['CASH-800']]);
});

test('a business\'s own rule holds only for a payment that routes to that business', () => {
  const facts: RuleFacts = { account: () => true, vat: () => true, counterparty: () => true };
  const parsed = parseRule({ id: 'post', then: { account: '6513', vat: 'I81' } }, facts, true);
  assert.ok(parsed.ok);
  const rules: PlacedRule[] = [{ rule: parsed.rule, business: 'swiss-post' }];
  const p = { tx: tx({ ref: 'x' }), bankAccount: '1021', amount: 50 };
  assert.equal(ruleFor(rules, { ...p, counterparty: 'swiss-post' })?.rule.id, 'post');
  assert.equal(ruleFor(rules, { ...p, counterparty: 'other' }), undefined);
  assert.equal(ruleFor(rules, p), undefined);
});

test('what a rule cannot carry out is refused, each with its reason', () => {
  const facts: RuleFacts = { account: (n) => ['6200', '2451'].includes(n), vat: (c) => ['I81'].includes(c), counterparty: (id) => id === 'swisscom' };
  const why = (raw: Record<string, unknown>, inBusiness = false) => { const r = parseRule(raw, facts, inBusiness); return r.ok ? 'ok' : r.refusal.code; };
  assert.equal(why({ id: 'a', when: 'cash over 500', then: 'ask the owner first' }), 'prose');
  assert.equal(why({ id: 'a', when: { text: 'x' }, then: { schedule: 'weekly' } }), 'field');
  assert.equal(why({ id: 'a', then: { account: '6200', vat: 'I81' } }), 'noCondition', 'a general rule needs a condition');
  assert.equal(why({ id: 'a', then: { account: '6200', vat: 'I81' } }, true), 'ok', 'a business\'s rule has its business');
  assert.equal(why({ id: 'a', when: { text: 'x' }, then: { account: '9999', vat: 'I81' } }), 'account');
  assert.equal(why({ id: 'a', when: { text: 'x' }, then: { account: '6200', vat: 'Q7' } }), 'vat');
  assert.equal(why({ id: 'a', when: { text: 'x' }, then: { account: '6200' } }), 'vat', 'a booking names its VAT code, or none');
  assert.equal(why({ id: 'a', when: { text: '(' }, then: { account: '6200', vat: 'I81' } }), 'pattern');
  assert.equal(why({ id: 'a', when: { amount: { over: 500, under: 100 } }, then: { ask: 'Wofür?' } }), 'amount');
  assert.equal(why({ id: 'a', when: { counterparty: 'nobody' }, then: { ask: 'Wofür?' } }), 'counterparty');
  assert.equal(why({ id: 'a', when: { text: 'x' }, then: { ask: '' } }), 'question');
  assert.equal(why({ id: 'a', when: { amount: { over: 500 }, direction: 'out' }, then: { ask: 'Wofür?', account: '2451', vat: 'none' } }), 'ok');
});

test('a rule reads in one plain line', () => {
  const facts: RuleFacts = { account: () => true, vat: () => true, counterparty: () => true };
  const r = parseRule({ id: 'a', when: { text: 'Bargeldbezug|Bancomat', direction: 'out', amount: { over: 500 } }, then: { ask: 'Wofür?', account: '2451', vat: 'none' } }, facts);
  assert.ok(r.ok);
  const words = (k: string, v: Record<string, string>) => `${k.split('.').pop()}(${Object.values(v).join(';')})`;
  const names = { account: (n: string) => (n === '2451' ? 'Kontokorrent' : undefined), business: () => undefined, money: (n: number) => `CHF ${n}` };
  assert.equal(ruleWords({ rule: r.rule }, names, words as never).line, 'text(«Bargeldbezug»or()«Bancomat»), out(), over(CHF 500) → askWith(Wofür?;bookNoVat(2451 Kontokorrent))');
});

/** A camt.053 of the demo's Raiffeisen account: a cash withdrawal of 800 and one of 300. */
const STATEMENT = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>R-1</MsgId><CreDtTm>2026-10-16T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>R-1</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">800.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-15</Dt></BookgDt><AcctSvcrRef>REF-CASH-800</AcctSvcrRef><AddtlNtryInf>Bargeldbezug Bancomat Wil</AddtlNtryInf></Ntry>
<Ntry><Amt Ccy="CHF">300.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-10-15</Dt></BookgDt><AcctSvcrRef>REF-CASH-300</AcctSvcrRef><AddtlNtryInf>Bargeldbezug Bancomat Wil</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

test('an ask rule turns the next matching payment into a task «Frag: …», not a booking; one click on «accept» books the proposal, stamped with the rule', async () => {
  const ws = company();
  writeFileSync(join(ws.paths.root, 'transactional-data/2026/bank-statements/Raiffeisen/oktober.xml'), STATEMENT);
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const started = await engine.start('receipt-intake', { kind: 'company', id: 'inbox' }, { kind: 'manual' });
  assert.ok(started.ok, JSON.stringify(started));
  await engine.idle();
  const booked = (ref: string) => loadBooks(ws).journalEntries.filter((e) => e.transactionRef === ref);
  assert.deepEqual(booked('REF-CASH-800'), [], 'the 800 withdrawal is not booked');

  const workflows = loadWorkflows(APP_ROOT, ws.paths.root).workflows;
  const asks = engine.runs().filter((r) => r.workflow === 'ask');
  assert.deepEqual(asks.map((r) => [r.item.id, r.state.status, 'at' in r.state ? r.state.at : '']), [['REF-CASH-800', 'waiting', 'ask']]);
  const task = taskOf(workflows.find((w) => w.id === 'ask')!, asks[0])!;
  assert.equal(fillTask(task.title.de!, task.item, task.reads), 'Frag: Wofür war der Barbezug?');
  assert.deepEqual(task.outcomes, ['accept', 'byHand']);
  assert.deepEqual((task.reads?.entries as Array<{ accountDebit: string; accountCredit: string; amount: number }>).map((e) => [e.accountDebit, e.accountCredit, e.amount]), [['2451', '1021', 800]]);

  // A second inbox run finds the payment still unbooked and asks nothing new.
  await engine.start('receipt-intake', { kind: 'company', id: 'inbox' }, { kind: 'manual' });
  await engine.idle();
  assert.equal(engine.runs().filter((r) => r.workflow === 'ask').length, 1);

  assert.deepEqual(await engine.command({ kind: 'answer', run: asks[0].id, outcome: 'accept' }), { ok: true, run: asks[0].id });
  await engine.idle();
  assert.deepEqual(booked('REF-CASH-800').map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.rule]), [['2451', '1021', 800, undefined, 'cash-ask']]);
  assert.equal(engine.run(asks[0].id)!.state.status, 'done');
});

/** The demo with a customer file whose rule books every payment of that customer (wishes3-1). */
function withCustomer(match: string): Workspace {
  const ws = company();
  mkdirSync(join(ws.paths.root, 'knowledge', 'customers'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'knowledge', 'customers', 'bauer-michael.yaml'), `id: bauer-michael
name: Michael Bauer
match: ${match}
steps:
  booking.guide.yaml#classify:
    rules:
      - id: bauer-export
        then: { account: "3400", vat: V0 }
        source: wish 2026-10-16
`);
  return ws;
}

test('a business\'s rule fires when the bank names the business only in the counterparty field, not in the text (wishes3-1)', async () => {
  const ws = withCustomer('{ tx: ["bauer michael"] }');
  const books = booksOf([tx({ ref: 'BAUER-1', direction: 'CRDT', amount: 6800, description: 'Rechnung 2026-033 Malerarbeiten Konstanz', counterparty: 'Bauer Michael' })]);
  const m = model();
  await classifyTransactions(books, books.transactions, { ask: m.ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual(m.asked, [], 'the rule decides, not the model');
  assert.deepEqual(books.journalEntries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.rule]), [['1021', '3400', 6800, 'V0', 'bauer-export']]);
});

test('a business\'s rule fires on the payer\'s IBAN alone, when neither the text nor a name says who paid', async () => {
  const ws = withCustomer('{ iban: ["DE00 3704 0044 0532 0130 00"] }');
  const books = booksOf([
    tx({ ref: 'BAUER-2', direction: 'CRDT', amount: 3200, description: 'Gutschrift', counterpartyIban: 'DE00370400440532013000' }),
    tx({ ref: 'OTHER-1', direction: 'CRDT', amount: 3200, description: 'Gutschrift', counterpartyIban: 'DE00120300000000202051' }),
  ]);
  const m = model();
  await classifyTransactions(books, books.transactions, { ask: m.ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual(books.journalEntries.filter((e) => e.rule).map((e) => [e.transactionRef, e.accountCredit, e.vatCode]), [['BAUER-2', '3400', 'V0']]);
  assert.deepEqual(m.asked, ['OTHER-1'], 'another IBAN is not that customer');
});

test('a rule with a private share books two lines that add up to the payment: the business part with its VAT code, the owner\'s part on the owner\'s account without VAT (wishes3-6)', async () => {
  const ws = company(RULES.replace('      - id: old-note', `      - id: natel-half
        when: { text: "Natel" }
        then: { account: "6570", vat: I81, private: 50 }
        source: correction 2026-10-16
      - id: old-note`));
  const books = booksOf([
    tx({ ref: 'NATEL-1', description: 'Rechnung November Natel', amount: 89 }),
    tx({ ref: 'NATEL-2', description: 'Rechnung Dezember Natel', amount: 89.05 }),
  ], [{ id: 'r1', ref: 'NATEL-1', hasSwissVat: true }]);
  const m = model();
  await classifyTransactions(books, books.transactions, { ask: m.ask, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual(m.asked, []);
  const by = (ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);
  assert.deepEqual(by('NATEL-1'), [['6570', '1021', 44.5, 'I81'], ['2451', '1021', 44.5, '']]);
  assert.deepEqual(by('NATEL-2'), [['6570', '1021', 44.52, 'I0'], ['2451', '1021', 44.53, '']], 'the Rappen add up; no receipt: the zero code');
  const reason = books.journalEntries.find((e) => e.transactionRef === 'NATEL-2')!.reason;
  assert.equal(reason, 'Regel: Text enthält «Natel» → Konto 6570 Informatik, Hosting, Software, MWST I81, 50 % privat; gebucht mit I0: kein Beleg zeigt Schweizer MWST');
});

test('a private share that is no percent is refused', () => {
  const facts: RuleFacts = { account: () => true, vat: () => true, counterparty: () => true };
  const why = (then: Record<string, unknown>) => { const r = parseRule({ id: 'a', when: { text: 'x' }, then }, facts); return r.ok ? r.rule.then : r.refusal.code; };
  assert.deepEqual(why({ account: '6570', vat: 'I81', private: '50 %' }), { kind: 'book', booking: { account: '6570', vat: 'I81', private: 50 } });
  assert.equal(why({ account: '6570', vat: 'I81', private: 100 }), 'share');
  assert.equal(why({ account: '6570', vat: 'I81', private: 'half' }), 'share');
  assert.equal(why({ ask: 'Wofür?', private: 50 }), 'share', 'a share needs the booking it splits');
});

/** The demo with the statement in the inbox, after one inbox run: the 800 waits as «Frag: …». */
async function heldWithdrawal() {
  const ws = company();
  writeFileSync(join(ws.paths.root, 'transactional-data/2026/bank-statements/Raiffeisen/oktober.xml'), STATEMENT);
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  await engine.start('receipt-intake', { kind: 'company', id: 'inbox' }, { kind: 'manual' });
  await engine.idle();
  const [ask] = engine.runs().filter((r) => r.workflow === 'ask');
  assert.equal(ask.state.status, 'waiting');
  return { ws, engine, ask };
}

test('a removed ask rule closes its open question; the question records which rule asked (wishes3-7, wishes3-12)', async () => {
  const { ws, engine, ask } = await heldWithdrawal();
  assert.equal(askedBy(ask), 'cash-ask');
  assert.deepEqual(await closeAsksWithoutRule(engine, ws), [], 'the rule still asks: the question stays');
  writeFileSync(join(ws.paths.root, 'knowledge', 'rules', 'booking.guide.yaml'), RULES.replace(/      - id: cash-ask[\s\S]*?(?=      - id: fuel)/, ''));
  assert.deepEqual(await closeAsksWithoutRule(engine, ws), [ask.id]);
  const state = engine.run(ask.id)!.state as { status: string; reason?: string };
  assert.deepEqual([state.status, state.reason], ['discarded', CLOSED_REASON]);
});

test('«Übernehmen» books the accepted proposal even when the app booked the payment meanwhile, replacing the app\'s booking and recording it (wishes3-7)', async () => {
  const { ws, engine, ask } = await heldWithdrawal();
  const books = loadBooks(ws);
  books.journalEntries.push({ id: 'auto-800', transactionRef: 'REF-CASH-800', date: '2026-10-15', accountDebit: '1000', accountCredit: '1021', amount: 800, vatCode: 'I0', origin: 'classify' });
  saveBooks(ws, books);
  assert.equal((await engine.command({ kind: 'answer', run: ask.id, outcome: 'accept' })).ok, true);
  await engine.idle();
  const booked = loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'REF-CASH-800');
  assert.deepEqual(booked.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.rule]), [['2451', '1021', 800, 'cash-ask']]);
  const effect = engine.run(ask.id)!.steps.flatMap((s) => s.effects).find((e) => e.effect === 'ledger.book')!;
  assert.deepEqual([effect.applied, effect.replaced], [true, ['auto-800']]);
});

test('«Übernehmen» never replaces a booking a person made', async () => {
  const { ws, engine, ask } = await heldWithdrawal();
  const books = loadBooks(ws);
  books.journalEntries.push({ id: 'mine-800', transactionRef: 'REF-CASH-800', date: '2026-10-15', accountDebit: '6570', accountCredit: '1021', amount: 800, origin: 'manual' });
  saveBooks(ws, books);
  await engine.command({ kind: 'answer', run: ask.id, outcome: 'accept' });
  await engine.idle();
  assert.deepEqual(loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'REF-CASH-800').map((e) => e.id), ['mine-800']);
});
