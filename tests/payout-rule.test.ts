/**
 * «bei SumUp immer so» (corner-39): a rule books a card terminal's payout as gross sales at the
 * firm's rate and the provider's fees apart (`then.fees`), the figures read from the payout report
 * linked to it. Without the report nothing is booked: the payout waits for the person as a
 * question under Aufgaben (workflows/ask), with the whole payout as sales for «Übernehmen», and
 * the question closes by itself once the report is linked (r4c-21, r5h-12).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifyTransactions, loadClassifyContext, type ClassifyDeps } from '../src/booking/classify.js';
import { parseRule, ruleWords, type RuleFacts } from '../src/booking/rules.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadBooks, PERSON, saveBooks, update, type Books } from '../src/books/store.js';
import { closeAsksWithoutRule } from '../src/workflows/held.js';
import { openEngine } from '../src/workflows/engine.js';
import { loadWorkflows } from '../src/workflows/load.js';
import { fillTask, taskOf } from '../src/workflows/model.js';
import { draftDir } from '../src/saving/changes.js';
import { draftRules } from '../src/saving/rules.js';
import { initRepository } from '../src/workspace/git.js';
import { APP_FOLDER, APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import { wordsIn } from '../src/export/texts.js';
import type { BankTransaction, JournalEntry, Receipt } from '../src/types/index.js';
import { DEMO_ROOT } from './support/workspace.js';
import './support/jurisdiction.js';

process.env.VANILLA_RUNS_DIR = mkdtempSync(join(tmpdir(), 'payout-runs-'));

const GUIDE = 'knowledge/rules/booking.guide.yaml';
const QUESTION = 'Auszahlungsbericht fehlt: Bericht verknüpfen, oder die ganze Auszahlung als Umsatz buchen?';
const SUMUP = `      - id: sumup-umsatz
        when: { text: "SumUp" }
        then: { account: "3400", vat: V81, fees: { account: "6840", vat: I0 } }
        source: wish 2026-10-16
`;
const RULES = `process: booking\nsteps:\n  classify:\n    rules:\n${SUMUP}`;
/** What the model drafted in corner-39: a rule in English sentences, which nothing carries out. */
const PROSE = `process: booking\nsteps:\n  classify:\n    rules:\n      - id: sumup-umsatz-mwst
        when: a SumUp payout report is linked to an incoming SumUp payment
        then: the turnover is booked gross with the standard VAT rate, the fees apart without VAT
        source: wish 2026-10-16
`;

function company(rules = RULES): Workspace {
  const dir = mkdtempSync(join(tmpdir(), 'payout-rule-'));
  cpSync(DEMO_ROOT, dir, { recursive: true });
  mkdirSync(join(dir, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(dir, GUIDE), rules);
  return workspaceAt(dir);
}

const payout = (ref: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-08-14', amount: 1412.35, currency: 'CHF', direction: 'CRDT', description: 'SumUp Payments Ltd SumUp Auszahlung PO-88213' });

function booksOf(txs: BankTransaction[], report?: string): Books {
  const receipts = report ? [{ id: 'po', filename: 'po.pdf', extractedText: 'SumUp Auszahlungsbericht PO-88213: Kartenzahlungen 1480.00, Rückerstattung -40.00, Gebühren -27.65' } as Receipt] : [];
  return {
    transactions: txs, receipts, mappings: report ? [{ transactionRef: report, receiptId: 'po' }] : [],
    bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' },
  } as unknown as Books;
}

/** The model reads the report as corner-38 saw it: sales at V0, the refund and the fees apart. */
const reading: NonNullable<ClassifyDeps['ask']> = async (prompt) => {
  const refs = [...prompt.matchAll(/^### Transaction \d+: (\S+)/gm)].map((m) => m[1]);
  return JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, {
    reason: 'ohne MWST-Angabe gilt V0',
    entries: [
      { accountDebit: '', accountCredit: '3200', amount: 1480, vatCode: 'V0', description: 'SumUp Kartenzahlungen' },
      { accountDebit: '3200', accountCredit: '', amount: 40, vatCode: 'V0', description: 'SumUp Rückerstattung' },
      { accountDebit: '6800', accountCredit: '', amount: 27.65, vatCode: 'I81', description: 'SumUp Gebühren' },
    ],
  }])));
};

const lines = (books: Books, ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref)
  .map((e: JournalEntry) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']);

test('a payout rule parses, says itself in plain words, and is refused with a private share, as a question or without the fees\' code', () => {
  const facts: RuleFacts = { account: () => true, vat: (c) => ['V81', 'I0'].includes(c), counterparty: () => true };
  const r = parseRule({ id: 's', when: { text: 'SumUp' }, then: { account: '3400', vat: 'V81', fees: { account: '6840', vat: 'I0' } } }, facts);
  assert.ok(r.ok);
  assert.deepEqual(r.rule.then, { kind: 'book', booking: { account: '3400', vat: 'V81', fees: { account: '6840', vat: 'I0' } } });
  const names = { account: (n: string) => ({ 3400: 'Dienstleistungsertrag', 6840: 'Bankspesen' } as Record<string, string>)[n], business: () => undefined, money: (n: number) => `CHF ${n}` };
  assert.equal(ruleWords({ rule: r.rule }, names, wordsIn('de').t as never).line,
    'Text enthält «SumUp» → Konto 3400 Dienstleistungsertrag, MWST V81, die Gebühren laut Auszahlungsbericht auf Konto 6840 Bankspesen, MWST I0');

  const why = (then: Record<string, unknown>) => { const p = parseRule({ id: 's', when: { text: 'SumUp' }, then }, facts); return p.ok ? 'ok' : p.refusal.code; };
  assert.equal(why({ account: '3400', vat: 'V81', private: 50, fees: { account: '6840', vat: 'I0' } }), 'fees');
  assert.equal(why({ ask: 'Wie?', account: '3400', vat: 'V81', fees: { account: '6840', vat: 'I0' } }), 'fees');
  assert.equal(why({ fees: { account: '6840', vat: 'I0' } }), 'fees', 'the sales\' account and code first');
  assert.equal(why({ account: '3400', vat: 'V81', fees: { account: '6840' } }), 'vat');
  assert.equal(why({ account: '3400', vat: 'V81', fees: '6840' }), 'fees');
});

test('with its report linked, the payout is booked gross at the rule\'s rate, the refund at its minus and the fees apart, in the reading\'s figures', async () => {
  const ws = company();
  const books = booksOf([payout('PO')], 'PO');
  const out = await classifyTransactions(books, books.transactions, { ask: reading, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, out.failed], [['PO'], []]);
  assert.deepEqual(lines(books, 'PO'), [
    ['1021', '3400', 1480, 'V81'],
    ['3400', '1021', 40, '-V81'],
    ['6840', '1021', 27.65, 'I0'],
  ]);
  const [sale] = books.journalEntries;
  assert.deepEqual([sale.by, sale.rule], [{ kind: 'rule', rule: 'sumup-umsatz' }, 'sumup-umsatz']);
  assert.match(sale.reason!, /^Regel: .*; die Beträge hat Claude aus dem Auszahlungsbericht gelesen$/);
});

test('without its report the payout is held for the person, nothing booked: the question names the missing report, the proposal is the whole payout at the rule\'s rate; with the report and no model it waits', async () => {
  const ws = company();
  const alone = booksOf([payout('PO')]);
  const out = await classifyTransactions(alone, alone.transactions, { fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, out.unasked, out.failed, alone.journalEntries], [[], [], [], []]);
  const [held] = out.asked;
  assert.deepEqual([out.asked.length, held.ref, held.rule, held.question], [1, 'PO', 'sumup-umsatz', QUESTION]);
  assert.deepEqual(held.entries.map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '']), [['1021', '3400', 1412.35, 'V81']]);
  assert.match(held.entries[0].reason!, /^Regel: .*; ohne Auszahlungsbericht: die ganze Auszahlung als Umsatz, auf deine Übernahme hin$/);
  assert.deepEqual(held.entries[0].receipts, [], 'a report linked later books it again');

  const withReport = booksOf([payout('PO')], 'PO');
  const waits = await classifyTransactions(withReport, withReport.transactions, { fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual([waits.classified, waits.asked, waits.unasked, withReport.journalEntries], [[], [], ['PO'], []]);
});

/** A camt.053 of the demo's Raiffeisen account: one SumUp payout without its report. */
const STATEMENT = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>
<GrpHdr><MsgId>R-PO</MsgId><CreDtTm>2026-10-16T06:00:00</CreDtTm></GrpHdr>
<Stmt><Id>R-PO</Id><Acct><Id><IBAN>CH6580808000000000001</IBAN></Id><Ccy>CHF</Ccy></Acct>
<Ntry><Amt Ccy="CHF">1412.35</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-10-15</Dt></BookgDt><AcctSvcrRef>REF-PO-88213</AcctSvcrRef><AddtlNtryInf>SumUp Payments Ltd SumUp Auszahlung PO-88213</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

/** The inbox run on a company with the SumUp rule and the statement above: the payout's ask run. */
async function heldPayout() {
  const ws = company();
  writeFileSync(join(ws.paths.root, 'transactional-data/2026/bank-statements/Raiffeisen/oktober.xml'), STATEMENT);
  const engine = openEngine(ws, { appRoot: APP_ROOT });
  const started = await engine.start('receipt-intake', { kind: 'company', id: 'inbox' }, { kind: 'manual' });
  assert.ok(started.ok, JSON.stringify(started));
  await engine.idle();
  const asks = engine.runs().filter((r) => r.workflow === 'ask');
  assert.deepEqual(asks.map((r) => [r.item.id, r.state.status, 'at' in r.state ? r.state.at : '']), [['REF-PO-88213', 'waiting', 'ask']]);
  return { ws, engine, ask: asks[0] };
}

const booked = (ws: Workspace) => loadBooks(ws).journalEntries.filter((e) => e.transactionRef === 'REF-PO-88213').map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode, e.rule]);

test('r4c-21: the inbox run books no payout without its report; it asks «Frag: Auszahlungsbericht fehlt …» with the whole payout as the proposal, and «Übernehmen» books that, stamped with the rule', async () => {
  const { ws, engine, ask } = await heldPayout();
  assert.deepEqual(booked(ws), [], 'nothing booked: no sale question can be asked about it either');
  const task = taskOf(loadWorkflows(APP_ROOT, ws.paths.root).workflows.find((w) => w.id === 'ask')!, ask)!;
  assert.equal(fillTask(task.title.de!, task.item, task.reads), `Frag: ${QUESTION}`);
  assert.deepEqual(task.outcomes, ['accept', 'byHand']);
  assert.deepEqual((task.reads?.entries as Array<{ accountDebit: string; accountCredit: string; amount: number; vatCode?: string }>).map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode]), [['1021', '3400', 1412.35, 'V81']]);

  assert.deepEqual(await engine.command({ kind: 'answer', run: ask.id, outcome: 'accept' }), { ok: true, run: ask.id });
  await engine.idle();
  assert.deepEqual(booked(ws), [['1021', '3400', 1412.35, 'V81', 'sumup-umsatz']]);
  assert.equal(engine.run(ask.id)!.state.status, 'done');
});

test('r5h-12: the report linked while the payout waits closes its question; the next run books the split from the report', async () => {
  const { ws, engine, ask } = await heldPayout();
  assert.deepEqual(await closeAsksWithoutRule(engine, ws), [], 'no report yet: the question stays');
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    b.receipts.push({ id: 'po', filename: 'po.pdf', extractedText: 'SumUp Auszahlungsbericht PO-88213: Kartenzahlungen 1480.00, Rückerstattung -40.00, Gebühren -27.65' } as Receipt);
    b.mappings.push({ transactionRef: 'REF-PO-88213', receiptId: 'po' });
  });
  saveBooks(ws, books);
  assert.deepEqual(await closeAsksWithoutRule(engine, ws), [ask.id]);
  assert.equal(engine.run(ask.id)!.state.status, 'discarded');
  assert.deepEqual(booked(ws), [], 'the split needs the model to read the report: nothing booked without one');
});

test('a reading that is no payout is refused, the payment stays unbooked', async () => {
  const ws = company();
  const books = booksOf([payout('PO')], 'PO');
  const offBank: ClassifyDeps['ask'] = async () => JSON.stringify({ PO: { entries: [{ accountDebit: '1093', accountCredit: '3400', amount: 1412.35, vatCode: 'V81', description: 'x' }] } });
  const out = await classifyTransactions(books, books.transactions, { ask: offBank, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual([out.classified, out.failed.map((f) => f.ref), books.journalEntries], [[], ['PO'], []]);
});

test('corner-39: the AI\'s «immer so» in sentences cannot be kept; the same wish as a payout rule can, and its card speaks German', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'payout-keep-'));
  cpSync(DEMO_ROOT, join(repo, APP_FOLDER), { recursive: true });
  await initRepository(repo, 'Workspace set up');
  const ws = workspaceAt(join(repo, APP_FOLDER));
  const draft = (text: string) => { mkdirSync(dirname(join(draftDir(ws), GUIDE)), { recursive: true }); writeFileSync(join(draftDir(ws), GUIDE), text); };

  draft(PROSE);
  const prose = draftRules(ws, GUIDE)!;
  assert.deepEqual([prose.refused.map((r) => r.kind), prose.keepable], [['note'], false]);

  // A payout booked today as corner-38 saw it: split right, but the sales at V0.
  const books = loadBooks(ws);
  update(books, PERSON, (b) => {
    b.transactions.push({ ...payout('PO'), date: '2026-09-14' });
    b.receipts.push({ id: 'po', filename: 'po.pdf', extractedText: 'SumUp Auszahlungsbericht' } as Receipt);
    b.mappings.push({ transactionRef: 'PO', receiptId: 'po' });
    const e = (id: string, accountDebit: string, accountCredit: string, amount: number, vatCode: string): JournalEntry => ({ id, transactionRef: 'PO', date: '2026-09-14', accountDebit, accountCredit, amount, vatCode, origin: 'classify' });
    b.journalEntries.push(e('po-1', '1021', '3200', 1480, 'V0'), e('po-2', '3200', '1021', 40, 'V0'), e('po-3', '6800', '1021', 27.65, 'I81'));
  });
  saveBooks(ws, books);

  draft(RULES);
  const rule = draftRules(ws, GUIDE)!;
  assert.deepEqual([rule.added.map((r) => r.id), rule.refused, rule.keepable], [['sumup-umsatz'], [], true]);
  const [example] = rule.preview[0].examples;
  assert.deepEqual(example.would, { kind: 'book', lines: [{ account: '3400', vat: 'V81', amount: 1480 }, { account: '3400', vat: '-V81', amount: 40 }, { account: '6840', vat: 'I0', amount: 27.65 }] }, 'the card shows today\'s split on the rule\'s accounts and codes');
});
