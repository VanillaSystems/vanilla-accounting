/**
 * The first statement of a new firm with staff (issue #340): the bank's own fee row and the wages
 * need no receipt, so the run does not hold them back for one. The statement is the one of the
 * persona tests (.claude/skills/verify/persona-files.mjs): a made-up painting firm, a camt.053
 * with a bank transaction code on every entry, the fee row with the code for charges. A row is
 * never taken as the bank's fee by a part of the bank's name, and a wage's wording never ends the
 * search for a receipt: both would book a purchase with VAT without its input tax, silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyStep } from '../src/intake/classify.js';
import { readCamt, transactionsOf } from '../src/providers/camt053/camt053.js';
import { isBankFee } from '../src/booking/separate-fee.js';
import { checkAnswers } from '../src/workspace/create.js';
import { PRESETS, employs, type Answers } from '../src/workspace/setup.js';
import { noReceiptOfItsOwn, parseReceiptApply, receiptKnowledge, receiptWait, type WaitContext } from '../src/booking/receipt-wait.js';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { loadKnowledge } from '../src/knowledge/layers.js';
import { ACTIONS } from '../src/workflows/actions.js';
import { applyPlan, planWorkspace } from '../src/workspace/scaffold.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_FOLDER, APP_ROOT, workspaceAt, type Uid, type Workspace } from '../src/workspace/workspace.js';
import type { Books } from '../src/books/store.js';
import type { BankTransaction, Receipt } from '../src/types/index.js';
import type { NetRate } from '../src/workspace/vat-setup.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { bankChargesOf } from '../src/booking/bank-fee.js';
import './support/jurisdiction.js';

/** `code`: the entry's bank transaction code as domain/family/sub-family; absent: a credit transfer out or in. `iban`: the other party's account. */
type Row = [date: string, direction: 'DBIT' | 'CRDT', amount: number, who: string, text: string, code?: string, iban?: string];
const CARD = 'PMNT/CCRD/POSD';
const ROWS: Row[] = [
  ['2026-07-02', 'CRDT', 4860.00, 'Familie Keller', 'Rechnung 2026-028 Malerarbeiten Wohnzimmer'],
  ['2026-07-03', 'DBIT', 1243.55, 'Farbmix AG', 'Rechnung FM-77812'],
  ['2026-07-25', 'DBIT', 5200.00, 'Marco Rossi', 'Lohn Juli 2026'],
  ['2026-07-25', 'DBIT', 4800.00, 'Sandra Huber', 'Lohn Juli 2026'],
  ['2026-08-15', 'DBIT', 89.00, 'Swisscom (Schweiz) AG', 'Rechnung August Natel'],
  ['2026-08-25', 'DBIT', 5200.00, 'Marco Rossi', 'Lohn August 2026'],
  ['2026-09-30', 'DBIT', 12.00, 'Raiffeisenbank', 'Kontoführung Q3', 'ACMT/MDOP/FEES'],
];
const BANK = 'Raiffeisenbank Wil und Umgebung';

/** The persona's statement: a code on every entry, the party under RltdPties, the bank named in full under Svcr. */
function statement(rows: Row[] = ROWS, bank = BANK, currency = 'CHF'): string {
  return chfStatement(rows, bank).replaceAll('Ccy="CHF"', `Ccy="${currency}"`).replace('<Ccy>CHF</Ccy>', `<Ccy>${currency}</Ccy>`);
}

function chfStatement(rows: Row[], bank: string): string {
  const entries = rows.map(([date, d, amount, who, text, code = d === 'CRDT' ? 'PMNT/RCDT/DMCT' : 'PMNT/ICDT/DMCT', iban], i) => {
    const [domain, family, sub] = code.split('/');
    const account = iban ? `<${d === 'CRDT' ? 'DbtrAcct' : 'CdtrAcct'}><Id><IBAN>${iban}</IBAN></Id></${d === 'CRDT' ? 'DbtrAcct' : 'CdtrAcct'}>` : '';
    return `
<Ntry><Amt Ccy="CHF">${amount.toFixed(2)}</Amt><CdtDbtInd>${d}</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt>
<BkTxCd><Domn><Cd>${domain}</Cd><Fmly><Cd>${family}</Cd><SubFmlyCd>${sub}</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls><Refs><AcctSvcrRef>RB-2026-${String(i + 1).padStart(4, '0')}</AcctSvcrRef></Refs><Amt Ccy="CHF">${amount.toFixed(2)}</Amt><CdtDbtInd>${d}</CdtDbtInd>
<RltdPties>${d === 'CRDT' ? `<Dbtr><Nm>${who}</Nm></Dbtr>` : `<Cdtr><Nm>${who}</Nm></Cdtr>`}${account}</RltdPties><RmtInf><Ustrd>${text}</Ustrd></RmtInf></TxDtls></NtryDtls>
<AddtlNtryInf>${d === 'CRDT' ? 'Gutschrift' : 'Belastung'} ${who}</AddtlNtryInf></Ntry>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>RB-STMT-Q3</Id>
<Acct><Ccy>CHF</Ccy><Ownr><Nm>Malerei Beispiel GmbH</Nm></Ownr><Svcr><FinInstnId><Nm>${bank}</Nm></FinInstnId></Svcr></Acct>${entries}
</Stmt></BkToCstmrStmt></Document>`;
}

const parse = (xml: string): BankTransaction[] => readCamt(xml).statements.flatMap((s) => transactionsOf(s, { bank: 'Raiffeisen', statements: 'camt053' }));

/** New books of a trades firm as the setup makes them: effective method, quarterly; `employees` as answered; `vatAnswers` and `netRates` another kind of firm. */
function firm(employees: Answers['employees'] = 'staff', vatAnswers: Partial<Answers> = {}, netRates: NetRate[] = [], banks = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020' }]): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'first-statement-'));
  const given = { ...PRESETS.trades.answers, employees, ...vatAnswers } as Record<string, unknown>;
  if (given.vatRegistered === 'no') for (const k of ['vatMethod', 'basis', 'period']) delete given[k];
  const { answers, vat } = checkAnswers(given as Answers, netRates);
  applyPlan(root, planWorkspace({ name: 'Malerei Beispiel GmbH', uid: 'CHE-153.004.184' as Uid, owner: 'Sandra Huber', preset: 'trades', answers, vat, banks }, loadChart(), '2026'));
  return workspaceAt(join(root, APP_FOLDER));
}

/**
 * The statement as the bank's export in the workspace's bank-statements/Raiffeisen/, and books holding
 * its payments: code reads from the file which fee rows the bank coded as its charges (#359).
 */
function onFile(ws: Workspace, xml: string, name = 'q3.xml'): Books {
  const dir = join(ws.paths.transactional, '2026', 'bank-statements', 'Raiffeisen');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), xml);
  return booksOf(parse(xml));
}

/** A model that books whatever it is asked about on 6900 without a code, and records the refs. */
function recorder(books: Books) {
  const asked: string[] = [];
  const ask = async (prompt: string) => {
    const answers: Record<string, unknown> = {};
    for (const [, ref] of prompt.matchAll(/^### Transaction \d+: (\S+)$/gm)) {
      asked.push(ref);
      const tx = books.transactions.find((t) => t.ref === ref)!;
      answers[ref] = { entries: [tx.direction === 'CRDT' ? { accountDebit: '', accountCredit: '6900', amount: tx.amount, vatCode: '', description: tx.description } : { accountDebit: '6900', accountCredit: '', amount: tx.amount, vatCode: '', description: tx.description }], reason: 'Modell' };
    }
    return JSON.stringify(answers);
  };
  return { asked, ask };
}

const booksOf = (transactions: BankTransaction[]): Books => ({ transactions, receipts: [], mappings: [], bankStatements: [], journalEntries: [], config: { closedThrough: '2026-06-30' } }) as unknown as Books;

/** The model: a wage on 5000, the bank's fee on 6940, anything else an expense with input tax (which the wait holds back). */
const model = async (prompt: string) => {
  const answers: Record<string, unknown> = {};
  for (const [, ref] of prompt.matchAll(/^### Transaction \d+: (RB-2026-\d{4})$/gm)) {
    const [, direction, amount, , text] = ROWS[Number(ref.slice(-4)) - 1];
    const account = /Lohn/.test(text) ? '5000' : /Kontoführung/.test(text) ? '6940' : '6500';
    answers[ref] = { entries: [direction === 'CRDT' ? { accountDebit: '', accountCredit: '3400', amount, vatCode: 'V81', description: text } : { accountDebit: account, accountCredit: '', amount, vatCode: '', description: text }], reason: text };
  }
  return JSON.stringify(answers);
};

async function run(ws: Workspace, books: Books, ask?: typeof model) {
  const port = { read: () => structuredClone(books), update: <T>(fn: (b: Books) => T) => fn(books) };
  return (await classifyStep()({ ws, books: port, ask, progress: () => {}, log: () => {} })).notes;
}

const waiting = (books: Books) => books.transactions.filter((t) => t.waitsForReceipt).map((t) => t.description);
const booked = (books: Books) => books.transactions.filter((t) => books.journalEntries.some((e) => e.transactionRef === t.ref)).map((t) => t.description);

test('the bank\'s fee row is one by its code for charges; a part of the bank\'s name, a card payment and a row with an account are none', () => {
  assert.deepEqual(parse(statement()).filter(isBankFee).map((t) => t.description), ['Kontoführung Q3']);
  const day = '2026-09-30';
  const none = (rows: Row[], bank: string, why: string) => assert.deepEqual(parse(statement(rows, bank)).filter(isBankFee).map((t) => t.description), [], why);
  none([[day, 'DBIT', 12, 'Raiffeisenbank', 'Kontoführung Q3']], BANK, 'the first word of the bank\'s name under a payment\'s code: no fee row by a part of the name');
  none([[day, 'DBIT', 180, 'Raiffeisenbank', 'Schrankfachmiete inkl. 8.1% MWST']], BANK, 'a safe-deposit box with VAT');
  none([[day, 'DBIT', 64.3, 'Migros', 'Karte 5412 Einkauf', CARD]], 'Migros Bank AG', 'a card purchase at a merchant called like the bank');
  none([[day, 'DBIT', 64.3, 'Migros Bank AG', 'Karte 5412', CARD]], 'Migros Bank AG', 'a card payment is no fee row even under the bank\'s whole name');
  none([[day, 'DBIT', 980, 'Baloise', 'Betriebshaftpflicht 2026/27']], 'Baloise Bank AG', 'an insurer');
  none([[day, 'DBIT', 30, 'Bank', 'Zahlung']], 'Bank Cler AG', 'one common word');
  none([[day, 'DBIT', 412, 'UBS', 'Kreditkartenabrechnung']], 'UBS Switzerland AG', 'a card\'s bill');
  none([[day, 'DBIT', 55, 'Zürcher', 'Karte 5412', CARD]], 'Zürcher Kantonalbank', 'a merchant with the bank\'s first word');
  none([[day, 'DBIT', 500, BANK, 'Amortisation', undefined, 'BE00967000000002']], BANK, 'a debit to an account at the bank, under its whole name');
  none([[day, 'DBIT', 15, 'Beispiel AG', 'Zahlung mit Spesen', 'PMNT/ICDT/CHRG', 'BE00967000000002']], BANK, 'a charge paid to another party\'s account');
  none([[day, 'CRDT', 3, BANK, 'Zins']], BANK, 'money in');
  assert.deepEqual(parse(statement([[day, 'DBIT', 15, BANK, 'Kontoführung Oktober']])).filter(isBankFee).length, 1, 'as before: a debit to the bank under its whole name and a payment\'s code is its fee row');
});

test('without an AI: the fee row and the wages do not wait for a receipt; the supplier payments do', async () => {
  const books = booksOf(parse(statement()));
  const notes = await run(firm(), books);
  assert.deepEqual(waiting(books), ['Rechnung FM-77812', 'Rechnung August Natel']);
  assert.deepEqual(notes.filter((n) => n.code === 'waitingReceipt').map((n) => (n as { count: number }).count), [2]);
});

/** The fee row's entries as [debit, credit, amount, code, by, reason]. */
const feeLines = (books: Books) => books.journalEntries.filter((e) => books.transactions.find((t) => t.ref === e.transactionRef)?.type === 'bank-fee')
  .map((e) => [e.accountDebit, e.accountCredit, e.amount, e.vatCode ?? '', e.by?.kind === 'code' ? e.by.check : e.by?.kind ?? '', e.description]);

test('without an AI: code books the bank\'s fee row on the bank-charges account without a VAT code, the wages and the sale wait for the person (#359)', async () => {
  const ws = firm();
  const books = onFile(ws, statement());
  const notes = await run(ws, books);
  assert.deepEqual(booked(books), ['Kontoführung Q3'], '1 of the 7 rows booked by the app, none by a model');
  assert.deepEqual(feeLines(books), [['6940', '1020', 12, '', 'purchaseVat', 'Raiffeisenbank, Kontoführung Q3']]);
  const [fee] = books.journalEntries;
  assert.equal(fee.origin, 'classify', 'the app booked it: «ohne dich» counts it');
  assert.match(fee.reason ?? '', /^Gebühr der Bank laut Kontoauszug: auf 6940 Bankspesen, ohne MWST/);
  assert.deepEqual(notes.filter((n) => n.code === 'noModel').map((n) => (n as { waiting: number }).waiting), [4], 'the sale and the three wages: tasks for the person, wages stay a proposal (owner, 2026-11-12)');
  assert.equal(books.journalEntries.some((e) => e.accountDebit === '5000'), false, 'no wage booked by code');

  // A second run books nothing again.
  await run(ws, books);
  assert.equal(books.journalEntries.length, 1);
});

test('with an AI: the fee row is booked by code, not by the model', async () => {
  const ws = firm();
  const books = onFile(ws, statement());
  const asked: string[] = [];
  await run(ws, books, async (prompt: string) => { asked.push(...[...prompt.matchAll(/^### Transaction \d+: (RB-2026-\d{4})$/gm)].map((m) => m[1])); return model(prompt); });
  assert.equal(asked.includes('RB-2026-0007'), false, 'the fee row never reaches the model');
  assert.deepEqual(feeLines(books).map((l) => l.slice(0, 5)), [['6940', '1020', 12, '', 'purchaseVat']]);
});

test('a fee the bank pays back is booked the other way, without a VAT code', async () => {
  const ws = firm();
  const books = onFile(ws, statement([['2026-09-30', 'CRDT', 5, 'Raiffeisenbank', 'Rückerstattung Kontoführung', 'ACMT/MDOP/FEES']]));
  assert.equal(books.transactions[0].type, 'bank-fee');
  await run(ws, books);
  assert.deepEqual(feeLines(books).map((l) => l.slice(0, 5)), [['1020', '6940', 5, '', 'purchaseVat']]);
  assert.match(books.journalEntries[0].reason ?? '', /zurückzahlt/);
});

test('only a fee row the bank coded as its charge is booked by code: a loan or interest under the bank\'s name, and a custody fee, go to the model or the person', async () => {
  const day = '2026-09-30';
  const rows: Row[] = [
    [day, 'DBIT', 2500, BANK, 'Amortisation Darlehen 4711'],
    [day, 'DBIT', 830, BANK, 'Hypothekarzins Q3'],
    [day, 'DBIT', 45, 'Raiffeisenbank', 'Depotgebühr 2026', 'SECU/CUST/CHRG'],
  ];
  const ws = firm();
  const books = onFile(ws, statement(rows));
  assert.deepEqual(books.transactions.map((t) => t.type), ['bank-fee', 'bank-fee', 'bank-fee'], 'the reader marks all three as before (receipt-wait and matching unchanged)');
  const notes = await run(ws, books);
  assert.deepEqual(books.journalEntries, [], 'without an AI: none booked by code');
  assert.deepEqual(notes.filter((n) => n.code === 'noModel').map((n) => (n as { waiting: number }).waiting), [3], 'each a task for the person');

  const ws2 = firm();
  const again = onFile(ws2, statement(rows));
  const model2 = recorder(again);
  await run(ws2, again, model2.ask);
  assert.deepEqual(model2.asked.sort(), ['RB-2026-0001', 'RB-2026-0002', 'RB-2026-0003'], 'with an AI: the model reads their text, as before #359');
  assert.equal(again.journalEntries.length, 3);
  assert.equal(again.journalEntries.every((e) => e.by?.kind === 'model'), true);
});

test('a card\'s annual fee coded PMNT/CCRD/FEES is booked by code', async () => {
  const ws = firm();
  const books = onFile(ws, statement([['2026-09-30', 'DBIT', 50, 'Raiffeisenbank', 'Jahresgebühr Debitkarte', 'PMNT/CCRD/FEES']]));
  await run(ws, books);
  assert.deepEqual(feeLines(books).map((l) => l.slice(0, 5)), [['6940', '1020', 50, '', 'purchaseVat']]);
});

test('a fee on a EUR account is booked in francs at the day\'s ESTV rate, stamped on the entry', async () => {
  const ws = firm('staff', {}, [], [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020' }, { bank: 'Raiffeisen', currency: 'EUR', account: '1021' }]);
  const books = onFile(ws, statement([['2026-09-30', 'DBIT', 8, 'Raiffeisenbank', 'Kontoführung EUR Q3', 'ACMT/MDOP/FEES']], BANK, 'EUR'));
  await run(ws, books);
  const [e] = books.journalEntries;
  assert.deepEqual([e?.accountDebit, e?.accountCredit, e?.amount, e?.vatCode ?? '', e?.exchangeCurrency], ['6940', '1021', 8, '', 'EUR']);
  assert.ok((e?.exchangeRate ?? 0) > 0, 'a rate stamp');
});

test('a company rule that asks matches the fee row: it still asks, code books nothing', async () => {
  const ws = firm();
  mkdirSync(join(ws.paths.root, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'knowledge', 'rules', 'booking.guide.yaml'), `
steps:
  classify:
    rules:
      - id: bank-frag
        when: { text: "Kontoführung" }
        then: { ask: "Welche Bankgebühr ist das?", account: "6940", vat: none }
        source: wish 2026-11-13
`);
  const books = onFile(ws, statement());
  const notes = await run(ws, books);
  assert.deepEqual(feeLines(books), []);
  assert.deepEqual(notes.filter((n) => n.code === 'asked').map((n) => (n as { count: number }).count), [1]);
});

test('«Neu klassifizieren» on a fee the model booked on another account gives code\'s booking', async () => {
  const ws = firm();
  const books = onFile(ws, statement());
  const fee = books.transactions.find((t) => t.type === 'bank-fee')!;
  books.journalEntries.push({ id: 'm1', transactionRef: fee.ref, date: fee.date, accountDebit: '6900', accountCredit: '1020', amount: 12, description: 'Bank', origin: 'classify', by: { kind: 'model', model: 'x' } } as never);
  // What POST /api/journal-entries/classify/:ref does: the payment's entries out, classifyTransactions on it, with the AI there.
  books.journalEntries = books.journalEntries.filter((e) => e.transactionRef !== fee.ref);
  const { classified } = await classifyTransactions(books, [fee], { ask: model, fx: loadFxResolver(), context: loadClassifyContext(ws) });
  assert.deepEqual(classified, [fee.ref]);
  assert.deepEqual(feeLines(books).map((l) => l.slice(0, 5)), [['6940', '1020', 12, '', 'purchaseVat']]);
});

test('a firm whose 6940 is no expense account gets the «Konto fehlt» note, never fees on it', async () => {
  assert.deepEqual(bankChargesOf([{ number: '6940', type: 'asset' }]), { missing: { account: '6940', name: 'Bankspesen' } });
  assert.deepEqual(bankChargesOf([{ number: '6940', type: 'expense' }]), { account: '6940' });
  const ws = firm();
  const accounts = JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as Array<{ number: string; type: string }>;
  writeFileSync(ws.paths.accounts, JSON.stringify(accounts.map((a) => (a.number === '6940' ? { ...a, type: 'asset' } : a))));
  const books = onFile(ws, statement());
  await run(ws, books);
  assert.deepEqual(feeLines(books), []);
});

test('the fee\'s text: «bank, text», or the bank alone when the row has no text of its own', async () => {
  const ws = firm();
  const books = onFile(ws, statement([['2026-09-30', 'DBIT', 3, '', '', 'ACMT/MDOP/FEES']]));
  books.transactions[0].description = '';
  delete books.transactions[0].counterparty;
  await run(ws, books);
  assert.deepEqual(books.journalEntries.map((e) => e.description), ['Raiffeisen']);
});

test('each kind of firm: the fee row without a VAT code on the effective method, on the net tax rate method and without VAT registration', async () => {
  const kinds: Array<[string, Workspace]> = [
    ['effective', firm()],
    ['net-rate', firm('staff', { vatMethod: 'net-rate', period: 'half-yearly' } as Partial<Answers>, [{ rate: 6.5, label: 'Malerei' }])],
    ['not registered', firm('staff', { vatRegistered: 'no' } as Partial<Answers>)],
  ];
  for (const [kind, ws] of kinds) {
    const books = onFile(ws, statement());
    await run(ws, books);
    assert.deepEqual(feeLines(books).map((l) => l.slice(0, 4)), [['6940', '1020', 12, '']], kind);
  }
});

test('a chart without the bank-charges account: the fee row is not booked, and its form says which account is missing', async () => {
  const ws = firm();
  const accounts = JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as Array<{ number: string; type: string }>;
  writeFileSync(ws.paths.accounts, JSON.stringify(accounts.filter((a) => a.number !== '6940')));
  const books = onFile(ws, statement());
  const notes = await run(ws, books);
  assert.deepEqual(booked(books), []);
  assert.deepEqual(notes.filter((n) => n.code === 'noModel').map((n) => (n as { waiting: number }).waiting), [5], 'a task like the wages, «von Hand buchen»');
  assert.deepEqual(loadClassifyContext(ws).bankCharges, { missing: { account: '6940', name: 'Bankspesen' } });
  const charges = bankChargesOf(accounts.filter((a) => a.number !== '6940'));
  assert.deepEqual(charges, { missing: { account: '6940', name: 'Bankspesen' } });

  const fee = books.transactions.find((t) => t.type === 'bank-fee')!;
  const bank = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen', role: 'bank' as const }];
  const missing = bookingDraft(books, fee.ref, bank, [], { nature: { kind: 'bankFee', missing: { account: '6940', name: 'Bankspesen' } } })!;
  assert.deepEqual(missing.notes, [{ kind: 'bankChargesMissing', account: '6940', name: 'Bankspesen' }]);
  assert.deepEqual(missing.lines.map((l) => [l.accountDebit, l.accountCredit]), [['', '1020']]);
  const named = bookingDraft(books, fee.ref, bank, [], { nature: { kind: 'bankFee', account: '6940' } })!;
  assert.deepEqual(named.lines.map((l) => [l.accountDebit, l.accountCredit, l.amount, l.vat, l.source?.account]), [['6940', '1020', 12, '', { from: 'bankFee' }]]);
});

test('a company rule that matches the fee row decides it; code books only when none does', async () => {
  const ws = firm();
  mkdirSync(join(ws.paths.root, 'knowledge', 'rules'), { recursive: true });
  writeFileSync(join(ws.paths.root, 'knowledge', 'rules', 'booking.guide.yaml'), `
steps:
  classify:
    rules:
      - id: bank-finanzaufwand
        when: { text: "Kontoführung" }
        then: { account: "6900", vat: none }
        source: wish 2026-11-12
`);
  const books = onFile(ws, statement());
  await run(ws, books);
  assert.deepEqual(feeLines(books).map((l) => l.slice(0, 5)), [['6900', '1020', 12, '', 'rule']]);
});

test('a fee row of a filed period is never booked; a person\'s own booking of it is never replaced', async () => {
  const ws1 = firm();
  const filed = onFile(ws1, statement([['2026-06-30', 'DBIT', 12, 'Raiffeisenbank', 'Kontoführung Q2', 'ACMT/MDOP/FEES']]));
  await run(ws1, filed);
  assert.deepEqual(filed.journalEntries, [], 'dated on or before closedThrough');

  const ws2 = firm();
  const hers = onFile(ws2, statement());
  const fee = hers.transactions.find((t) => t.type === 'bank-fee')!;
  hers.journalEntries.push({ id: 'h1', transactionRef: fee.ref, date: fee.date, accountDebit: '6900', accountCredit: '1020', amount: 12, description: 'Bank', origin: 'manual' } as never);
  await run(ws2, hers);
  assert.deepEqual(hers.journalEntries.filter((e) => e.transactionRef === fee.ref).map((e) => [e.id, e.accountDebit]), [['h1', '6900']]);
});

test('with an AI: the fee row and the wages are booked in the first run, the supplier payments wait for their receipts', async () => {
  const books = booksOf(parse(statement()));
  await run(firm(), books, model);
  assert.deepEqual(booked(books), ['Rechnung 2026-028 Malerarbeiten Wohnzimmer', 'Lohn Juli 2026', 'Lohn Juli 2026', 'Lohn August 2026', 'Kontoführung Q3']);
  assert.deepEqual(waiting(books), ['Rechnung FM-77812', 'Rechnung August Natel']);
  const wage = books.journalEntries.find((e) => e.accountDebit === '5000')!;
  assert.deepEqual([wage.accountCredit, wage.amount, wage.vatCode ?? ''], ['1020', 5200, '']);
});

test('a firm that says it has no employees: a payment worded as a wage waits like any other', async () => {
  const books = booksOf(parse(statement()));
  await run(firm('none'), books);
  assert.deepEqual(waiting(books), ['Rechnung FM-77812', 'Lohn Juli 2026', 'Lohn Juli 2026', 'Rechnung August Natel', 'Lohn August 2026']);
});

test('the shipped wage wording: a wage by the payment\'s own text, in any language, on a firm that pays wages; never a purchase that names wages', () => {
  const ws = firm();
  const k = loadKnowledge(APP_ROOT, ws.paths.root);
  const { wages, wordings } = receiptKnowledge(k, ws);
  const wage = (s: string) => wages.some((w) => w.test(s));
  for (const s of ['Lohn Juli 2026', 'LOHNZAHLUNG 09/2026', 'Löhne September', '13. Monatslohn', 'Nettolohn August', 'Salär Oktober', 'Gehalt Juli', 'Salaire septembre', 'Salaire juillet 2026', 'Stipendio luglio', 'Stipendi settembre 2026', 'Salary July', 'Zahlung Lohn 2026', 'Lohn']) assert.ok(wage(s), s);
  for (const s of [
    'Lohn Aushilfe KW 36 Rechnung 88121 Adecco', 'Lohn- und Finanzbuchhaltung Q3 Treuhand', 'bexio Lohn Abo', 'Landi Lohn SH', 'Peter Lohn Elektro', 'Lohn AG Rechnung 12',
    'Gestion des salaires facture 2026-118', 'BVG Beiträge Lohn Juli', 'AHV Lohn Juli 2026', 'Quellensteuer Lohn August',
    'Lohnbuchhaltung Treuhand Beispiel AG Rechnung 4411', 'Lohnausweis Software Abo', 'Lohnsoftware Lizenz 2026', 'Rechnung FM-77812', 'Salaris Restaurant', 'Belohnung Wettbewerb', 'Material Lohn', 'Lohn GmbH',
  ]) assert.equal(wage(s), false, s);
  assert.equal(wordings.some((w) => w.test('Lohn Juli 2026')), false, 'no wording that ends the search for a receipt');
  assert.deepEqual(receiptKnowledge(k, firm('none')).wages, [], 'a firm without employees');
  assert.equal(employs(undefined), false, 'books without the setup\'s answers have not said so');

  const ctx: WaitContext = { free: new Set(), wordings, wages, assumesUnread: new Set(), ownIbans: new Set(), settles: () => false, inputTax: true };
  const out = (description: string, counterparty: string): BankTransaction => ({ ref: 'W', bank: 'Raiffeisen', date: '2026-07-25', amount: 5200, currency: 'CHF', direction: 'DBIT', description, counterparty });
  assert.deepEqual(receiptWait(out('Lohn Juli 2026', 'Marco Rossi'), { linked: 'none' }, ctx), { wait: false, why: 'wage' });
  assert.deepEqual(receiptWait(out('Zahlung 4411', 'Lohn AG'), { linked: 'none' }, ctx), { wait: true }, 'the counterparty\'s name is never read: a firm, a place or a surname may be called so');
  assert.deepEqual(receiptWait(out('Montage Juli', 'Peter Lohn Elektro'), { linked: 'none' }, ctx), { wait: true });

  assert.deepEqual(parseReceiptApply({ receipt: 'none', text: 'Lohn', not: 'Rechnung', firm: 'employer' }, 'guide'), { ok: true, text: 'Lohn', not: 'Rechnung', firm: 'employer' });
  assert.match((parseReceiptApply({ receipt: 'none', text: 'Lohn', firm: 'gmbh' }, 'guide') as { problem: string }).problem, /apply\.firm must be employer/);
  assert.match((parseReceiptApply({ receipt: 'none', text: 'Lohn', not: '(' }, 'guide') as { problem: string }).problem, /apply\.not/);
  assert.match((parseReceiptApply({ receipt: 'none', firm: 'employer' }) as { problem: string }).problem, /apply\.firm is for a guide/);
});

test('a wage is freed from the wait only: it stays a candidate for a receipt, and one linked later books it again with what it shows', async () => {
  const ws = firm();
  const [, , wage] = parse(statement());
  const withdrawal: BankTransaction = { ...wage, ref: 'ATM-1', description: 'Bancomat Bezug Wil' };
  const books = booksOf([wage, withdrawal]);
  const none = () => noReceiptOfItsOwn(books, loadClassifyContext(ws), receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws), loadFxResolver());
  assert.equal(none()(withdrawal), true, 'a cash withdrawal has no receipt of its own');
  assert.equal(none()(wage), false, 'the matching chain still pairs a receipt with a payment worded as a wage');

  // A temp agency's bill worded as a wage: booked at once without input tax, then again from its receipt.
  const wageModel = async () => JSON.stringify({ [wage.ref]: { entries: [{ accountDebit: '5000', accountCredit: '', amount: wage.amount, vatCode: '', description: 'Lohn' }], reason: 'Lohn' } });
  const billModel = async () => JSON.stringify({ [wage.ref]: { entries: [{ accountDebit: '4400', accountCredit: '', amount: wage.amount, vatCode: 'I81', description: 'Temporärpersonal' }], reason: 'Rechnung Personalverleih' } });
  await run(ws, books, wageModel);
  assert.deepEqual(books.journalEntries.filter((e) => e.transactionRef === wage.ref).map((e) => [e.accountDebit, e.vatCode ?? '']), [['5000', '']]);
  assert.equal(none()(wage), false, 'booked by the app without a receipt: still a candidate');
  books.receipts.push({ id: 'bill', filename: '20260725-personalverleih.pdf', location: 'archived', kind: 'invoice', date: '2026-07-25', amount: wage.amount, currency: 'CHF', extractedText: 'Rechnung Personalverleih inkl. 8.1% MWST', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, gross: wage.amount, vat: 389.64 }] } as Receipt);
  books.mappings.push({ transactionRef: wage.ref, receiptId: 'bill' });
  await run(ws, books, billModel);
  assert.deepEqual(books.journalEntries.filter((e) => e.transactionRef === wage.ref && e.accountDebit !== '').map((e) => [e.accountDebit, e.vatCode ?? '']), [['4400', 'M81']], 'booked again from the receipt, with its input tax (the account gives the code)');
});

test('«Braucht keinen Beleg» on a waiting payment: the booking step books it in the same go with an AI; without one it says that no model was there', async () => {
  const ws = firm();
  const [, supplier] = parse(statement());
  const marked = { ...supplier, noReceiptNeeded: true };
  const step = (tx: BankTransaction, ask?: typeof model) => ACTIONS['accounting.expenses.classification'].run!({ books: booksOf([tx]), transaction: tx }, {}, { ws, ask } as never);
  const withAi = await step(marked, model);
  assert.equal(withAi.outcome, 'decided');
  assert.deepEqual((withAi.output!.entries as Array<{ accountDebit: string; accountCredit: string; amount: number }>).map((e) => [e.accountDebit, e.accountCredit, e.amount]), [['6500', '1020', 1243.55]]);
  assert.deepEqual(await step(marked), { outcome: 'undecided', output: { why: 'noModel' } });
  const held = await step(supplier, model);
  assert.deepEqual([held.outcome, held.output], ['held', { why: 'waitsForReceipt' }], 'unmarked, it is the receipt it waits for');
});
