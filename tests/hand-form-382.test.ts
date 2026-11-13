/**
 * #382: what the hand form proposes for money in and for a wage, without an AI. A payment that
 * names the number of the firm's own invoice in the books proposes from that invoice (its amount
 * need not be read, its Swiss VAT or its place of supply abroad decides the code, an unclear one
 * proposes none and the form asks the sale question), never the domestic default; money from
 * abroad without a document proposes no code; a wage is proposed on the wage account without a
 * code; the account list ranks by the receipt's words, and «Spesen» finds Bankspesen first.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { bookingDraft, type DraftKnowledge } from '../src/accounting/manual-booking.js';
import { placeOfSupply } from '../src/accounting/sale-document.js';
import { rankAccounts, type AccountContext } from '../src/app/lib/account-filter.js';
import { loadBooks, saveBooks, type Books as ClassifyBooks } from '../src/books/store.js';
import { classifyTransactions, loadClassifyContext } from '../src/booking/classify.js';
import { loadFxResolver } from '../src/accounting/fx-rates.js';
import { workspaceAt } from '../src/workspace/workspace.js';
import { DEMO_ROOT } from './support/workspace.js';
import { saleQuestionLine } from '../src/intake/sale-questions.js';
import { appendQuestionLine } from '../src/questions/store.js';
import { setJurisdiction } from '../src/engines/index.js';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { APP_FOLDER, APP_ROOT, type LedgerBankAccount } from '../src/workspace/workspace.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, type VatSetup } from '../src/workspace/vat-setup.js';
import { loadChart } from '../src/workspace/chart.js';
import type { BankTransaction, Index, JournalEntry, Receipt } from '../src/types/index.js';
import { startApi, type ApiServer } from './support/api-server.js';
import type { HandStart } from '../src/saving/hand-rule.js';
import './support/jurisdiction.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Malerei', activityId: '99901' }] };
const KINDS: Array<[string, VatSetup]> = [['effective', EFFECTIVE_QUARTERLY], ['net-rate', NET_RATE], ['not registered', NOT_REGISTERED]];

function on<T>(setup: VatSetup, fn: () => T): T {
  setJurisdiction(ch, setup);
  try { return fn(); } finally { setJurisdiction(ch, EFFECTIVE_QUARTERLY); }
}

const BANK = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen CHF', role: 'bank' }] as unknown as LedgerBankAccount[];
const UID = 'CHE-111.222.333';
const KNOWN: DraftKnowledge = { defaults: { sales: '3400', purchase: '4000' }, chart: ['1020', '1100', '3400'], ownUid: UID, firmName: 'Malerei Huber GmbH' };
type Books = Pick<Index, 'transactions' | 'journalEntries' | 'mappings' | 'receipts'>;
const books = (over: Partial<Books>): Books => ({ transactions: [], journalEntries: [], mappings: [], receipts: [], ...over });
const tx = (ref: string, amount: number, description: string, over: Partial<BankTransaction> = {}): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date: '2026-10-12', direction: 'CRDT', amount, currency: 'CHF', counterparty: 'Bauer Michael', description, ...over }) as unknown as BankTransaction;
const receipt = (id: string, text: string, over: Partial<Receipt> = {}): Receipt =>
  ({ id, filename: `${id}.pdf`, date: '2026-09-25', location: 'archived', extractedText: text, extractionMethod: 'pdftotext', ...over }) as unknown as Receipt;
const head = `Malerei Huber GmbH\nIndustriestrasse 14, 9500 Wil SG\nMWST-Nr. ${UID} MWST\n\nFamilie Bauer\nSeestrasse 4\n78462 Konstanz, Deutschland\n\nRechnung 2026-031\nDatum: 25.09.2026\n`;
// The invoice of round 2 (55-r031.png): no VAT line, the place of supply abroad, the amount not read.
const ABROAD = receipt('r031', `${head}Leistung Betrag CHF\nMalerarbeiten Wohnung Seestrasse 4, Konstanz 3200.00\nTotal CHF 3200.00\nLeistungsort Deutschland: nicht der schweizerischen MWST unterstellt.`);
const DOMESTIC = receipt('r032', `${head.replace('Konstanz, Deutschland', 'Wil SG').replace('2026-031', '2026-032')}Malerarbeiten 2960.04\nMWST 8.1 % 239.76\nTotal CHF 3199.80`);
const UNCLEAR = receipt('r033', `${head.replace('2026-031', '2026-033')}Malerarbeiten 3200.00\nTotal CHF 3200.00`);
const bauer = tx('RB', 3200, 'Rechnung 2026-031 Malerarbeiten Konstanz');
const sideOf = (l: { accountDebit: string; accountCredit: string; vat: string }) => [l.accountDebit, l.accountCredit, l.vat];

test('the payment that names her own invoice 2026-031 proposes from it: abroad, never V81 «keine Rechnung verknüpft», on every kind of firm', () => {
  const expected: Record<string, string> = { effective: 'V0-E', 'net-rate': 'V0-E', 'not registered': '' };
  for (const [kind, setup] of KINDS) {
    on(setup, () => {
      const d = bookingDraft(books({ transactions: [bauer], receipts: [ABROAD] }), 'RB', BANK, [], KNOWN)!;
      assert.deepEqual(d.ownInvoice, { id: 'r031', number: '2026-031', file: 'r031.pdf', links: ['r031'], from: 'invoice' }, kind);
      assert.deepEqual(d.lines.map(sideOf), [['1020', '3400', expected[kind]]], kind);
      assert.deepEqual(d.lines[0].source?.vat, expected[kind] ? { from: 'abroad' } : undefined, kind);
      assert.ok(!d.notes.some((n) => n.kind === 'sale'), `${kind}: her invoice says it is a sale, nothing is assumed`);
      assert.deepEqual(d.receipts, [], `${kind}: linked only by her click`);
    });
  }
});

test('her own invoice that shows the Swiss VAT by its own arithmetic gives the rate; on the net tax rate method F1', () => {
  const expected: Record<string, string> = { effective: '8.1', 'net-rate': 'F1', 'not registered': '' };
  for (const [kind, setup] of KINDS) {
    on(setup, () => {
      const d = bookingDraft(books({ transactions: [tx('RD', 3199.8, 'Zahlung Rechnung 2026-032')], receipts: [DOMESTIC] }), 'RD', BANK, [], KNOWN)!;
      assert.equal(d.ownInvoice?.id, 'r032', kind);
      assert.equal(d.lines[0].vat, expected[kind], kind);
    });
  }
});

test('her own invoice whose VAT is unclear proposes no code and asks the sale question, on the net tax rate method too', () => {
  on(EFFECTIVE_QUARTERLY, () => {
    const d = bookingDraft(books({ transactions: [tx('RU', 3200, 'Rechnung 2026-033')], receipts: [UNCLEAR] }), 'RU', BANK, [], KNOWN)!;
    assert.equal(d.ownInvoice?.id, 'r033');
    assert.deepEqual(d.lines.map(sideOf), [['1020', '3400', '']]);
    assert.deepEqual(d.notes.find((n) => n.kind === 'saleVat'), { kind: 'saleVat', why: 'notRead' });
    // Words of a place beside a Swiss rate nothing read: unclear, not abroad.
    const mixed = receipt('r034', `${head.replace('2026-031', '2026-034')}Leistungsort: Wil SG\nMalerarbeiten 3200.00 inkl. MWST 8.1 %\nTotal CHF 3200.00`);
    const m = bookingDraft(books({ transactions: [tx('RM', 3200, 'Rechnung 2026-034')], receipts: [mixed] }), 'RM', BANK, [], KNOWN)!;
    assert.equal(m.lines[0].vat, '');
    assert.ok(m.notes.some((n) => n.kind === 'saleVat'));
  });
  on(NET_RATE, () => assert.equal(bookingDraft(books({ transactions: [tx('RU', 3200, 'Rechnung 2026-033')], receipts: [UNCLEAR] }), 'RU', BANK, [], KNOWN)!.lines[0].vat, ''));
});

test('her own invoice is found by the firm\'s name when it has no UID; never another firm\'s; a named invoice she set aside, or several that do not add up, ask instead of the domestic default', () => {
  const byName = receipt('n1', 'Malerei Huber GmbH\nIndustriestrasse 14\n\nRechnung 2026-031\nLeistungsort Deutschland: nicht der schweizerischen MWST unterstellt.');
  assert.equal(bookingDraft(books({ transactions: [bauer], receipts: [byName] }), 'RB', BANK, [], { ...KNOWN, ownUid: undefined })!.ownInvoice?.id, 'n1');
  const supplier = receipt('s1', `Farbmix AG\nMWST CHE-999.888.777 MWST\nRechnung 2026-031\nTotal 3200.00`);
  const other = bookingDraft(books({ transactions: [bauer], receipts: [supplier] }), 'RB', BANK, [], KNOWN)!;
  assert.deepEqual([other.ownInvoice, other.lines.map(sideOf)], [undefined, [['1020', '3400', 'V81']]], 'another firm\'s invoice is no invoice of hers');
  const asks = (b: Books, known: DraftKnowledge = KNOWN, ref = 'RB') => {
    const d = bookingDraft(b, ref, BANK, [], known)!;
    assert.equal(d.lines[0].vat, '', 'never V81 «keine Rechnung verknüpft» when the text names her invoice');
    assert.deepEqual(d.notes.find((n) => n.kind === 'saleVat'), { kind: 'saleVat', why: 'namedInvoice' });
  };
  asks(books({ transactions: [bauer], receipts: [ABROAD] }), { ...KNOWN, notOwnInvoice: 'r031' });
  const r030 = receipt('r030', `${head.replace('2026-031', '2026-030')}Total CHF 900.00`, { amount: 900 });
  asks(books({ transactions: [tx('TWO', 3200, 'Rechnung 2026-031 und 2026-030')], receipts: [{ ...ABROAD, amount: 3200 }, r030] }), KNOWN, 'TWO');
});

test('two of her invoices that add up to the payment: a line each, with the VAT each proves, and both linked', () => {
  const r030 = receipt('r030', `${head.replace('2026-031', '2026-030').replace('Konstanz, Deutschland', 'Wil SG')}Malerarbeiten 832.56\nMWST 8.1 % 67.44\nTotal CHF 900.00`, { amount: 900 });
  const d = bookingDraft(books({ transactions: [tx('TWO', 4100, 'Rechnung 2026-031 und 2026-030')], receipts: [{ ...ABROAD, amount: 3200 }, r030] }), 'TWO', BANK, [], KNOWN)!;
  assert.deepEqual(d.lines.map((l) => [l.amount, l.vat]).sort(), [[3200, 'V0-E'], [900, '8.1']].sort());
  assert.deepEqual(d.ownInvoice?.links.sort(), ['r030', 'r031']);
});

test('an instalment: her invoice linked to the first payment proves the VAT of the second, up to what is open of it, and is not linked again', () => {
  const first = tx('P1', 1200, 'Rechnung 2026-031 Anzahlung', { date: '2026-10-01', counterparty: 'Bauer M.' });
  const second = tx('P2', 2500, 'Rest Rechnung 2026-031', { counterparty: 'Michael Bauer' });
  const d = bookingDraft(books({ transactions: [first, second], receipts: [{ ...ABROAD, amount: 3200 }], mappings: [{ transactionRef: 'P1', receiptId: 'r031' }] }), 'P2', BANK, [], KNOWN)!;
  assert.deepEqual(d.lines.map(sideOf), [['1020', '3400', 'V0-E'], ['1020', '', '']]);
  assert.deepEqual(d.lines.map((l) => l.amount), [2000, 500], 'revenue up to what is open, the rest a line without an account');
  assert.deepEqual(d.notes.find((n) => n.kind === 'ownInvoiceSurplus'), { kind: 'ownInvoiceSurplus', number: '2026-031', surplus: 500 });
  assert.deepEqual([d.ownInvoice?.links, d.ownInvoice?.earlier], [[], '2026-10-01']);
});

test('over- and partial payment of her read invoice: revenue up to what is open, the rest its own line and a note; a part payment is all revenue', () => {
  const read = { ...ABROAD, amount: 3200 };
  const over = bookingDraft(books({ transactions: [tx('O', 3500, 'Rechnung 2026-031')], receipts: [read] }), 'O', BANK, [], KNOWN)!;
  assert.deepEqual(over.lines.map((l) => [l.accountCredit, l.amount, l.vat]), [['3400', 3200, 'V0-E'], ['', 300, '']]);
  assert.ok(over.notes.some((n) => n.kind === 'ownInvoiceSurplus'));
  const part = bookingDraft(books({ transactions: [tx('T', 1000, 'Rechnung 2026-031')], receipts: [read] }), 'T', BANK, [], KNOWN)!;
  assert.deepEqual(part.lines.map((l) => [l.accountCredit, l.amount, l.vat]), [['3400', 1000, 'V0-E']]);
  assert.ok(!part.notes.some((n) => n.kind === 'ownInvoiceSurplus'));
});

test('a place-of-supply label at home, a bare label, an included-VAT wording, a statement alone or reverse charge alone never propose the abroad code', () => {
  const cases = {
    home: 'Leistungsort: Wil SG\nMalerarbeiten\nTotal CHF 3200.00 inkl. MwSt.',
    bare: 'Leistungsort\nMalerarbeiten\nTotal CHF 3200.00',
    included: 'Leistungsort Deutschland\nTotal CHF 3200.00 inkl. MwSt.',
    inclusiveWords: 'Total CHF 3200.00, inkl. 8.1 Prozent MWST',
    statement: 'Nicht der schweizerischen MWST unterstellt.\nTotal CHF 3200.00',
    reverse: 'Reverse charge\nTotal CHF 3200.00',
  };
  for (const [name, body] of Object.entries(cases)) {
    for (const over of [{}, { hasSwissVat: false, vatSummary: [] }]) {
      const doc = receipt('rx', `${head.replace('Konstanz, Deutschland', 'Wil SG')}${body}`, over as Partial<Receipt>);
      const d = bookingDraft(books({ transactions: [bauer], receipts: [doc] }), 'RB', BANK, [], KNOWN)!;
      assert.equal(d.lines[0].vat, '', `${name} ${JSON.stringify(over)}`);
      assert.ok(d.notes.some((n) => n.kind === 'saleVat'), `${name}: the sale question asks`);
    }
  }
  // A place of supply in Liechtenstein is at home too.
  const li = receipt('li', `${head}Leistungsort Liechtenstein\nTotal CHF 3200.00`);
  assert.equal(bookingDraft(books({ transactions: [bauer], receipts: [li] }), 'RB', BANK, [], KNOWN)!.lines[0].vat, '');
});

test('a mixed invoice: a line per VAT group, the zero group at the abroad code only where the invoice proves it', () => {
  const groups = [{ ratePercent: 8.1, net: 1000, vat: 81, gross: 1081 }, { ratePercent: 0, net: 2000, vat: 0, gross: 2000 }];
  const proved = receipt('mx', `${head}Malerarbeiten Wil 1081.00\nMalerarbeiten Konstanz 2000.00\nLeistungsort Deutschland`, { hasSwissVat: true, vatSummary: groups, amount: 3081 } as Partial<Receipt>);
  const d = bookingDraft(books({ transactions: [tx('MX', 3081, 'Rechnung 2026-031')], receipts: [proved] }), 'MX', BANK, [], KNOWN)!;
  assert.deepEqual(d.lines.map((l) => [l.amount, l.vat]), [[1081, '8.1'], [2000, 'V0-E']]);
  const unproved = { ...proved, extractedText: `${head}Malerarbeiten 1081.00\nMaterial 2000.00` };
  const u = bookingDraft(books({ transactions: [tx('MX', 3081, 'Rechnung 2026-031')], receipts: [unproved] }), 'MX', BANK, [], KNOWN)!;
  assert.deepEqual(u.lines.map((l) => [l.amount, l.vat]), [[1081, '8.1'], [2000, '']]);
  assert.ok(u.notes.some((n) => n.kind === 'saleZeroPart'));
});

test('a foreign VAT on her invoice is asked, never the abroad code on the gross', () => {
  const de = receipt('de', `${head}Malerarbeiten 2689.08\nMwSt. 19 % 510.92\nGesamt EUR 3200.00\nLeistungsort Deutschland`);
  const d = bookingDraft(books({ transactions: [bauer], receipts: [de] }), 'RB', BANK, [], KNOWN)!;
  assert.equal(d.lines[0].vat, '');
  assert.deepEqual(d.notes.find((n) => n.kind === 'saleVat'), { kind: 'saleVat', why: 'foreignVat' });
});

test('the banner says what is true: under a rule\'s proposal and from the owner it does not claim the invoice, across periods on the agreed basis it only links', () => {
  const rule: DraftKnowledge = { ...KNOWN, rule: { id: 'bauer', lines: [{ account: '3400', vat: 'V81', amount: 3200 }] } };
  assert.equal(bookingDraft(books({ transactions: [bauer], receipts: [ABROAD] }), 'RB', BANK, [], rule)!.ownInvoice?.from, 'other');
  const owner: DraftKnowledge = { ...KNOWN, nature: { kind: 'owner', account: '2850' } };
  assert.equal(bookingDraft(books({ transactions: [bauer], receipts: [ABROAD] }), 'RB', BANK, [], owner)!.ownInvoice?.from, 'other');
  on({ registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' }, () => {
    const d = bookingDraft(books({ transactions: [bauer], receipts: [ABROAD] }), 'RB', BANK, [], KNOWN)!;
    assert.deepEqual([d.ownInvoice?.from, d.ownInvoice?.links, d.lines[0].accountCredit], ['taxPoint', ['r031'], '']);
  });
});

test('the same number as an app invoice and as a dropped PDF: the app invoice decides, the PDF is not offered', () => {
  const invoice = { id: 'i31', status: 'issued', kind: 'invoice', deleted: false, number: '2026-031', reference: 'RF', currency: 'CHF', date: '2026-09-25', payments: [], lines: [{ text: 'Malerarbeiten', quantity: 1, price: 3200, vatRate: 0 }], customer: { name: 'Bauer' } } as unknown as Parameters<typeof bookingDraft>[3] extends readonly (infer I)[] | undefined ? I : never;
  const d = bookingDraft(books({ transactions: [bauer], receipts: [ABROAD] }), 'RB', BANK, [invoice], { ...KNOWN, invoiceRevenue: '3400' })!;
  assert.equal(d.invoice?.number, '2026-031');
  assert.equal(d.ownInvoice, undefined);
});

test('a customer whose last sale was booked V81 does not carry V81 onto her invoice that is abroad', () => {
  const last = { id: 'e1', transactionRef: 'OLD', date: '2026-07-01', accountDebit: '1020', accountCredit: '3200', amount: 500, vatCode: 'V81', description: 'Bauer', origin: 'manual' } as JournalEntry;
  const d = bookingDraft(books({ transactions: [bauer, tx('OLD', 500, 'Anzahlung', { date: '2026-07-01' })], receipts: [ABROAD], journalEntries: [last] }), 'RB', BANK, [], KNOWN)!;
  assert.deepEqual(d.lines.map(sideOf), [['1020', '3200', 'V0-E']]);
  assert.equal(d.lines[0].source?.account?.from, 'precedent');
});

test('money from abroad without a document proposes no code and asks; a domestic payment keeps its proposal', () => {
  const abroad = tx('DE', 800, 'Malerarbeiten', { counterpartyIban: 'DE00370400440532013000' });
  const home = tx('CH', 800, 'Malerarbeiten', { counterpartyIban: 'CH0000762011623852957' });
  const eur = tx('EU', 800, 'Malerarbeiten', { currency: 'EUR' });
  const domestic: Record<string, string> = { effective: 'V81', 'net-rate': 'F1', 'not registered': '' };
  for (const [kind, setup] of KINDS) {
    on(setup, () => {
      for (const t of [abroad, eur]) {
        const d = bookingDraft(books({ transactions: [t] }), t.ref, [...BANK, { ...BANK[0], currency: 'EUR', account: '1021' }] as LedgerBankAccount[], [], KNOWN)!;
        assert.equal(d.lines[0].vat, '', `${kind} ${t.ref}`);
        assert.equal(d.notes.some((n) => n.kind === 'saleVat' && n.why === 'payerAbroad'), setup.registered, `${kind} ${t.ref}`);
      }
      const d = bookingDraft(books({ transactions: [home] }), 'CH', BANK, [], KNOWN)!;
      assert.equal(d.lines[0].vat, domestic[kind], kind);
    });
  }
});

test('a wage follows her own last booking of it before the wage account; books with deductions get no account', () => {
  const sept = { id: 'w9', transactionRef: 'L9', date: '2026-09-25', accountDebit: '5200', accountCredit: '1020', amount: 4200, description: 'Lohn September', origin: 'manual' } as JournalEntry;
  const t9 = tx('L9', 4200, 'Lohn September 2026', { direction: 'DBIT', counterparty: 'Max Muster', date: '2026-09-25' });
  const t10 = tx('L10', 4200, 'Lohn Oktober 2026', { direction: 'DBIT', counterparty: 'Max Muster' });
  const d = bookingDraft(books({ transactions: [t9, t10], journalEntries: [sept] }), 'L10', BANK, [], { ...KNOWN, nature: { kind: 'wage', account: '5000' } })!;
  assert.deepEqual(d.lines.map(sideOf), [['5200', '1020', '']]);
  const w = bookingDraft(books({ transactions: [t10] }), 'L10', BANK, [], { ...KNOWN, nature: { kind: 'wage', deductions: '2270' } })!;
  assert.deepEqual([w.lines.map(sideOf), w.notes], [[['', '1020', '']], [{ kind: 'wageDeductions', account: '2270' }]]);
});

test('a wage is proposed on the wage account, gross, without a VAT code, on every kind of firm', () => {
  const wage = tx('L1', 4200, 'Lohn Juli 2026', { direction: 'DBIT', counterparty: 'Max Muster' });
  for (const [kind, setup] of KINDS) {
    on(setup, () => {
      const d = bookingDraft(books({ transactions: [wage] }), 'L1', BANK, [], { ...KNOWN, nature: { kind: 'wage', account: '5000' } })!;
      assert.deepEqual(d.lines.map(sideOf), [['5000', '1020', '']], kind);
      assert.deepEqual(d.lines[0].source, { account: { from: 'wage' } }, kind);
    });
  }
});

test('a supplier payment with a read receipt proposes no account, and hands the receipt\'s words to the account list', () => {
  const paint = receipt('fm', 'Farbmix AG\nRechnung FM-79010\nFarbe weiss 10 l 1200.00\nMWST 8.1 %', { hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 1421.62, vat: 115.15, gross: 1536.77 }] } as Partial<Receipt>);
  const pay = tx('FM', 1536.77, 'Farbmix FM-79010', { direction: 'DBIT', counterparty: 'Farbmix AG' });
  const d = bookingDraft(books({ transactions: [pay], receipts: [paint], mappings: [{ transactionRef: 'FM', receiptId: 'fm' }] }), 'FM', BANK, [], KNOWN)!;
  assert.deepEqual(d.lines.map(sideOf), [['', '1020', '8.1']]);
  assert.ok(d.words?.includes('Farbe'));
});

const chartAccounts = loadChart().accounts.map((a) => ({ number: a.number, name: a.name, hints: a.hints }));
const typeOf = (n: string) => loadChart().accounts.find((a) => a.number === n)?.type;
const ctx = (over: Partial<AccountContext> = {}): AccountContext => ({ typeOf, prefer: 'expense', defaults: ['4000', '3400'], words: { expense: ['aufwand', 'spesen'], revenue: ['ertrag'] }, hints: (n) => chartAccounts.find((a) => a.number === n)?.hints, ...over });

test('«Spesen» lists Bankspesen before the default Materialaufwand; «Farbe» finds the material account', () => {
  const spesen = rankAccounts(chartAccounts, 'Spesen', ctx()).map((m) => m.account.number);
  assert.ok(spesen.indexOf('6940') < spesen.indexOf('4000'), spesen.slice(0, 6).join(' '));
  assert.equal(rankAccounts(chartAccounts, 'Farbe', ctx())[0]?.account.number, '4000');
});

test('before anything is typed, the accounts the receipt\'s words name come first', () => {
  const plain = rankAccounts(chartAccounts, '', ctx());
  const said = rankAccounts(chartAccounts, '', ctx({ defaults: ['3400'], suggest: ['Telefon', 'Abo', 'Natel'] }));
  assert.notEqual(plain[0].account.number, '6510');
  assert.equal(said[0].account.number, '6510');
});

const servers: ApiServer[] = [];
const dirs: string[] = [];
after(async () => { await Promise.all(servers.map((s) => s.stop())); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The demo's manifest with a painter's setup that employs staff. */
function employerManifest(): string {
  const dir = mkdtempSync(join(tmpdir(), 'employer-manifest-'));
  dirs.push(dir);
  const demo = readFileSync(join(APP_ROOT, 'demo', APP_FOLDER, 'belege.workspace.yaml'), 'utf8');
  writeFileSync(join(dir, 'belege.workspace.yaml'), `${demo.trimEnd()}\nprofile:\n  preset: trades\n  fiscalYear: calendar\n  start: new\n  sells: both\n  foreignCustomers: no\n  imports: no\n  employees: staff\n  ownerPaysPrivately: yes\n  privateUse: [car, phone]\n  payouts: no\n  goods: [made]\n`);
  return dir;
}

test('the server names a wage on a firm that pays wages, with the chart\'s wage account', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json', {}, { manifestOf: employerManifest() });
  servers.push(api);
  // A chart without a wage account (the demo's): nothing is proposed; with it, the wage account.
  assert.equal(((await api.send('GET', '/api/rules/hand?payment=L1')).json.start as unknown as HandStart).nature, undefined);
  const chartFile = api.ws.paths.accounts;
  mkdirSync(dirname(chartFile), { recursive: true });
  writeFileSync(chartFile, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  const start = (await api.send('GET', '/api/rules/hand?payment=L1')).json.start as unknown as HandStart;
  assert.deepEqual(start.nature, { kind: 'wage', account: '5000' });
  const print = (await api.send('GET', '/api/rules/hand?payment=LA')).json.start as unknown as HandStart;
  assert.equal(print.nature, undefined, '«Lohnausweis Druck» is no wage');
});

test('«Verknüpfen und buchen» links her own invoice in the same write, and its entries record it', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json');
  servers.push(api);
  await api.rest();
  const b = loadBooks(api.ws);
  const k1 = b.transactions.find((t) => t.ref === 'K1')!;
  b.receipts.push(receipt('own', `${head.replace('2026-031', '2026-029').replace(UID, api.ws.company.uid)}Total CHF ${k1.amount}`) as never);
  b.receipts.push(receipt('theirs', `Farbmix AG\nMWST CHE-999.888.777 MWST\nRechnung FM-1\nTotal CHF 10.00`) as never);
  saveBooks(api.ws, b);
  const bank = api.ws.bankAccounts.find((a) => a.label === k1.bank || a.bank === k1.bank)!.account;
  const res = await api.send('POST', '/api/transactions/K1/entries', { lines: [{ accountDebit: bank, accountCredit: '3400', amount: k1.amount, vatCode: 'V81', description: k1.description }], links: ['own'] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const after = loadBooks(api.ws);
  assert.ok(after.mappings.some((m) => m.transactionRef === 'K1' && m.receiptId === 'own'));
  assert.deepEqual(after.journalEntries.filter((e) => e.transactionRef === 'K1').map((e) => e.receipts), [['own']]);
  const bad = await api.send('POST', '/api/transactions/K2/entries', { lines: [{ accountDebit: bank, accountCredit: '2451', amount: 1, description: 'x' }], links: [1] });
  assert.equal(bad.status, 400);
  // The server checks again what the form saw: a receipt linked already, or someone else's, is refused and nothing is booked.
  const k2 = after.transactions.find((t) => t.ref === 'K2')!;
  for (const id of ['own', 'theirs']) {
    const taken = await api.send('POST', '/api/transactions/K2/entries', { lines: [{ accountDebit: bank, accountCredit: '2451', amount: k2.amount, description: 'x' }], links: [id] });
    assert.deepEqual([taken.status, taken.json.code], [409, 'ownInvoiceTaken'], id);
  }
  assert.equal(loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === 'K2').length, 0);
});

test('a read receipt and her last booking of the business: the form proposes that account with the receipt\'s rate and says whose booking it was; nothing is booked without her click; the model\'s booking is never said to be hers', async () => {
  const context = loadClassifyContext(workspaceAt(DEMO_ROOT));
  const bank = context.bankAccounts[0];
  const pay = (ref: string, date: string, amount: number) => tx(ref, amount, 'Gerüstbau Thurtal Rechnung', { direction: 'DBIT', date, bank: bank.bank, counterparty: 'Gerüstbau Thurtal GmbH' });
  const read = receipt('g', 'Gerüstbau Thurtal GmbH', { amount: 1120, currency: 'CHF', kind: 'invoice', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, net: 1036.08, vat: 83.92, gross: 1120 }] } as Partial<Receipt>);
  const earlier = (id: string, ref: string, date: string, account: string, over: Partial<JournalEntry>) => ({ id, transactionRef: ref, date, accountDebit: account, accountCredit: bank.account, amount: 900, vatCode: 'I81', description: 'Gerüst', ...over }) as JournalEntry;
  const now = pay('NEW', '2026-08-02', 1120);
  const make = (entries: JournalEntry[]) => ({ transactions: [pay('OLD', '2026-07-01', 900), pay('OLDER', '2026-06-01', 900), now], receipts: [read], mappings: [{ transactionRef: 'NEW', receiptId: 'g' }], bankStatements: [], journalEntries: entries, config: { closedThrough: '2026-05-31' } }) as unknown as ClassifyBooks;
  const hers = earlier('p1', 'OLDER', '2026-06-01', '6100', { origin: 'manual' });
  const model = earlier('m1', 'OLD', '2026-07-01', '6570', { origin: 'classify', by: { kind: 'model', model: 'sonnet' } });

  // Hers comes before the model's newer one, and the form says so.
  const d = bookingDraft(make([hers, model]), 'NEW', context.bankAccounts, [], {})!;
  assert.deepEqual(d.lines.map(sideOf), [['6100', bank.account, '8.1']]);
  assert.deepEqual(d.lines[0].source?.account, { from: 'precedent', date: '2026-06-01', yours: true, name: 'Gerüstbau Thurtal GmbH' });
  // Only the model's: a proposal still, never said to be hers.
  assert.equal((bookingDraft(make([model]), 'NEW', context.bankAccounts, [], {})!.lines[0].source?.account as { yours?: true }).yours, undefined);
  // A booking code made by itself (a sales report's, an invoice's event) is no booking of hers either.
  const code = earlier('c1', 'OLDER', '2026-06-01', '6100', { origin: 'classify', by: { kind: 'code', check: 'purchaseVat' } });
  assert.equal((bookingDraft(make([code]), 'NEW', context.bankAccounts, [], {})!.lines[0].source?.account as { yours?: true }).yours, undefined);

  // Without a model the run books nothing: the payment waits for her click on the form.
  const b = make([hers]);
  const out = await classifyTransactions(b, [now], { fx: loadFxResolver(), context });
  assert.deepEqual([out.unasked, out.classified, b.journalEntries.filter((e) => e.transactionRef === 'NEW').length], [['NEW'], [], 0]);
});

test('the sale question answered on the form books what the card\'s answer books, and leaves the answered question on the payment', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json');
  servers.push(api);
  await api.rest();
  const b = loadBooks(api.ws);
  const k1 = b.transactions.find((t) => t.ref === 'K1')!;
  const k4 = b.transactions.find((t) => t.ref === 'K4')!;
  const bank = api.ws.bankAccounts.find((a) => a.label === k1.bank || a.bank === k1.bank)!.account;
  const line = (t: BankTransaction) => ({ accountDebit: bank, accountCredit: '3400', amount: t.amount, description: t.description });
  const shape = (ref: string) => loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === ref).map((e) => [e.accountCredit, e.vatCode ?? '', e.origin]).sort();
  // The demo's chart: the foreign tax's account 2200 is in it.
  mkdirSync(dirname(api.ws.paths.accounts), { recursive: true });
  writeFileSync(api.ws.paths.accounts, readFileSync(join(APP_ROOT, 'demo', APP_FOLDER, 'master-data/accounts.json')));
  const cases = [['saleDomestic', undefined], ['saleAbroad', { rate: 19, account: '2200' }]] as const;
  for (const [choice, foreignTax] of cases) {
    for (const ref of ['K1', 'K4']) for (const e of loadBooks(api.ws).journalEntries.filter((x) => x.transactionRef === ref)) await api.send('DELETE', `/api/journal-entries/${e.id}`);
    // On the form: one call books her lines and answers.
    const form = await api.send('POST', '/api/transactions/K1/sale', { by: 'Anna', choice, ...(foreignTax && { foreignTax }), lines: [line(k1)], links: [] });
    assert.equal(form.status, 200, JSON.stringify(form.json));
    assert.equal(form.json.status, 'answered');
    // On the card: her booking by hand first, then the app's question about it answered.
    assert.equal((await api.send('POST', '/api/transactions/K4/entries', { lines: [line(k4)] })).status, 200);
    // The app's question about the sale, as the run asks it after a booking (src/intake/sale-questions.ts).
    const asked = saleQuestionLine(api.ws, k4, new Date().toISOString());
    appendQuestionLine(api.ws, asked, undefined);
    const card = await api.send('POST', `/api/questions/${asked.id}/answer`, { by: 'Anna', choice, ...(foreignTax && { foreignTax }) });
    assert.equal(card.status, 200, JSON.stringify(card.json));
    assert.deepEqual(shape('K1'), shape('K4'), choice);
  }
});

test('review 2: a place of supply is abroad only when the place itself is a foreign country named in full; every other wording asks', () => {
  const asks = [
    'Leistungsort: Bahnhofstrasse 4 in Wil',
    'Leistungsort: Seestrasse 8 im Garten, Wil',
    'Leistungsort: Wil, 12.09.2026 am Bau',
    'Lieu de la prestation: Rue 12 de Lausanne',
    'Luogo della prestazione: Via Roma 3 al Lago, Lugano',
    'Leistungsort 3 so wie vereinbart',
    'Leistungsort: Zürich, Kunde aus Deutschland',
    'Leistungsort Zürich (nicht Deutschland)',
    'Leistungsort: Hotel Jersey Chur',
    'Leistungsort: Restaurant Indien Zürich',
    'Leistungsort: Vaduz, Liechtenstein',
    'Leistungsort: Schweiz',
  ];
  for (const t of asks) assert.notEqual(placeOfSupply(t), 'abroad', t);
  const abroad = [
    'Leistungsort Deutschland',
    'Leistungsort Deutschland: nicht der schweizerischen MWST unterstellt.',
    'Lieu de la prestation : Allemagne',
    'Luogo della prestazione: Germania',
    'Place of supply: Germany',
    'Leistungsort: Österreich',
    'Leistungsort: Vereinigte Staaten',
    'Leistungsort:\nDeutschland',
    'Leistungsort: Konstanz, Deutschland',
    'Leistungsort: Konstanz (Deutschland)',
  ];
  for (const t of abroad) assert.equal(placeOfSupply(t), 'abroad', t);
  // On the form: each probe asks, never the abroad code.
  for (const t of asks) {
    const doc = receipt('rp', `${head.replace('Konstanz, Deutschland', 'Wil SG')}${t}\nTotal CHF 3200.00`);
    assert.equal(bookingDraft(books({ transactions: [bauer], receipts: [doc] }), 'RB', BANK, [], KNOWN)!.lines[0].vat, '', t);
  }
});

test('review 2: two invoices with a line each and a code each: no sale question; one without a code: the question is about that line only', () => {
  const r030 = receipt('r030', `${head.replace('2026-031', '2026-030').replace('Konstanz, Deutschland', 'Wil SG')}Malerarbeiten 832.56\nMWST 8.1 % 67.44\nTotal CHF 900.00`, { amount: 900 });
  const proved = bookingDraft(books({ transactions: [tx('TWO', 4100, 'Rechnung 2026-031 und 2026-030')], receipts: [{ ...ABROAD, amount: 3200 }, r030] }), 'TWO', BANK, [], KNOWN)!;
  assert.ok(!proved.notes.some((n) => n.kind === 'saleVat'), JSON.stringify(proved.notes));
  const unclear = { ...UNCLEAR, extractedText: UNCLEAR.extractedText!.replace('2026-033', '2026-031'), amount: 3200 };
  const one = bookingDraft(books({ transactions: [tx('TWO', 4100, 'Rechnung 2026-031 und 2026-030')], receipts: [unclear, r030] }), 'TWO', BANK, [], KNOWN)!;
  assert.deepEqual(one.lines.map((l) => [l.amount, l.vat]).sort(), [[3200, ''], [900, '8.1']].sort());
  assert.ok(one.notes.some((n) => n.kind === 'saleVat'));
});

test('review 2: on the net tax rate method F1 only for what the document proves domestic; unclear and foreign VAT ask', () => {
  on(NET_RATE, () => {
    const u = bookingDraft(books({ transactions: [tx('RU', 3200, 'Rechnung 2026-033')], receipts: [UNCLEAR] }), 'RU', BANK, [], KNOWN)!;
    assert.deepEqual([u.lines[0].vat, u.notes.some((n) => n.kind === 'saleVat')], ['', true]);
    const de = receipt('de', `${head}Malerarbeiten 2689.08\nUSt 19 % 510.92\nGesamt EUR 3200.00`);
    const f = bookingDraft(books({ transactions: [bauer], receipts: [de] }), 'RB', BANK, [], KNOWN)!;
    assert.deepEqual([f.lines[0].vat, f.notes.some((n) => n.kind === 'saleVat')], ['', true]);
    const d = bookingDraft(books({ transactions: [tx('RD', 3199.8, 'Zahlung Rechnung 2026-032')], receipts: [DOMESTIC] }), 'RD', BANK, [], KNOWN)!;
    assert.equal(d.lines[0].vat, 'F1');
  });
});

test('review 2: the sale question answered on the form for a payment whose linked document is her own invoice books with the link kept; another receipt linked is refused and nothing is asked', async () => {
  const api = await startApi('tests/fixtures/by-hand-index.json');
  servers.push(api);
  await api.rest();
  const b = loadBooks(api.ws);
  const k1 = b.transactions.find((t) => t.ref === 'K1')!;
  const k4 = b.transactions.find((t) => t.ref === 'K4')!;
  b.receipts.push(receipt('own', `${head.replace('2026-031', '2026-029').replace(UID, api.ws.company.uid)}Total CHF ${k1.amount}`) as never);
  b.receipts.push(receipt('theirs', `Farbmix AG\nMWST CHE-999.888.777 MWST\nRechnung FM-1\nTotal CHF ${k4.amount}`) as never);
  b.mappings.push({ transactionRef: 'K1', receiptId: 'own' }, { transactionRef: 'K4', receiptId: 'theirs' });
  saveBooks(api.ws, b);
  const bank = api.ws.bankAccounts.find((a) => a.label === k1.bank || a.bank === k1.bank)!.account;
  const line = (t: BankTransaction) => ({ accountDebit: bank, accountCredit: '3400', amount: t.amount, description: t.description });
  const ok = await api.send('POST', '/api/transactions/K1/sale', { by: 'Anna', choice: 'saleDomestic', lines: [line(k1)], links: [] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const after = loadBooks(api.ws);
  assert.deepEqual(after.journalEntries.filter((e) => e.transactionRef === 'K1').map((e) => [e.accountCredit, e.vatCode, e.receipts]), [['3400', 'V81', ['own']]]);
  assert.ok(after.mappings.some((m) => m.transactionRef === 'K1' && m.receiptId === 'own'), 'the link stays');
  const asked = (await api.send('GET', '/api/questions')).json.questions as Array<{ on: { id: string } }>;
  const before = asked.length;
  const refused = await api.send('POST', '/api/transactions/K4/sale', { by: 'Anna', choice: 'saleDomestic', lines: [line(k4)], links: [] });
  assert.notEqual(refused.status, 200);
  assert.equal(((await api.send('GET', '/api/questions')).json.questions as unknown[]).length, before, 'nothing appended');
  assert.equal(loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === 'K4').length, 0);
  // The answer sets the code of the lines the form left without one, never over a code the document proved.
  const k2 = loadBooks(api.ws).transactions.find((t) => t.ref === 'K2')!;
  const half = Math.round(k2.amount * 50) / 100;
  const two = await api.send('POST', '/api/transactions/K2/sale', { by: 'Anna', choice: 'saleAbroad', lines: [{ ...line(k2), amount: half, vatCode: 'V81' }, { ...line(k2), amount: Math.round((k2.amount - half) * 100) / 100 }], links: [] });
  assert.equal(two.status, 200, JSON.stringify(two.json));
  assert.deepEqual(loadBooks(api.ws).journalEntries.filter((e) => e.transactionRef === 'K2').map((e) => e.vatCode).sort(), ['V0', 'V81']);
});
