/**
 * Three kinds of firm on one engine (src/workspace/vat-setup.ts): not registered for VAT, the
 * effective method by quarter, the net tax rate method by half year. The manifest parses each
 * setup, the engines compute its form, its codes and its filing length, the seals and the period
 * lock count by that length, and the electronic return round-trips. Every figure is worked out by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadJurisdiction } from '../src/core/modules/load.js';
import { filing, registration, setJurisdiction, vat, vatSetup } from '../src/engines/index.js';
import { parseManifest } from '../src/workspace/manifest.js';
import { EFFECTIVE_QUARTERLY, NOT_REGISTERED, changesMethod, parseVatSetup, vatSetupYaml, type VatSetup, type VatSetupRefusal } from '../src/workspace/vat-setup.js';
import { QUESTIONS, asked, firstMissing, firstUnsupported, vatSetupOf, type Answers } from '../src/workspace/setup.js';
import { checkAnswers, SetupError } from '../src/workspace/create.js';
import { planWorkspace } from '../src/workspace/scaffold.js';
import { loadChart } from '../src/workspace/chart.js';
import { patchManifestText } from '../src/workspace/manifest-write.js';
import { asQuarter, closesTheYear, nextQuarter, periodKeyOf, sealFile } from '../src/books/seal.js';
import { entriesForReturn } from '../src/accounting/declarations.js';
import { bookingDraft } from '../src/accounting/manual-booking.js';
import { domesticSale } from '../src/accounting/sales-without-vat.js';
import { booksOpenPeriod, isFilingKey } from '../src/accounting/periods.js';
import { parseFiledReturn } from '../src/accounting/filed-return.js';
import { ech0217Xml } from '../src/providers/ech0217/xml.js';
import { APP_ROOT, workspacePaths, type Uid } from '../src/workspace/workspace.js';
import type { JournalEntry } from '../src/types/index.js';

const ch = loadJurisdiction(APP_ROOT, 'ch').jurisdiction;
const NET_RATE: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '99901' }] };
const TWO_RATES: VatSetup = { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5 }, { rate: 6.2, label: 'Handel' }] };
const fail = (msg: string, refusal?: VatSetupRefusal): never => { throw Object.assign(new Error(msg), { refusal }); };

const manifest = (vat: string) => `schema: 1
company: { name: Beispiel Test GmbH, uid: CHE-153.004.184, owner: Erika Beispiel, vat: ${vat} }
bankAccounts: [{ bank: UBS, currency: CHF, account: "1020", label: UBS CHF }]
`;

test('the manifest parses each kind of firm, and older manifests mean the effective method by quarter', () => {
  assert.deepEqual(parseManifest(manifest('{ method: effective, reporting: received }'), 'm.yaml').company.vat, EFFECTIVE_QUARTERLY);
  assert.deepEqual(parseManifest(manifest('{ registered: false }'), 'm.yaml').company.vat, NOT_REGISTERED);
  assert.deepEqual(
    parseManifest(manifest('{ registered: true, method: net-rate, reporting: received, period: half-yearly, rates: [{ rate: 4.5, label: Schreinerei, activityId: "99901" }] }'), 'm.yaml').company.vat,
    NET_RATE,
  );
  assert.deepEqual(parseVatSetup({ method: 'net-rate', reporting: 'received', rates: [4.5, 6.2] }, fail), { ...TWO_RATES, period: 'quarterly', rates: [{ rate: 4.5 }, { rate: 6.2 }] });
});

test('the manifest refuses what no firm can be', () => {
  const refused = (vat: unknown, why: RegExp) => assert.throws(() => parseVatSetup(vat, fail), why);
  refused({ registered: false, method: 'effective' }, /takes no other key/);
  refused({ method: 'net-rate', reporting: 'received' }, /one or two approved net tax rates/);
  refused({ method: 'net-rate', reporting: 'received', rates: [1, 2, 3] }, /one or two/);
  refused({ method: 'net-rate', reporting: 'received', rates: [{ rate: 0 }] }, /above 0 and below 100/);
  refused({ method: 'net-rate', reporting: 'received', rates: [{ rate: 4.5, activityId: '12' }] }, /five-character activity code/);
  // What a person can type into the Firma form carries a typed reason, so the page refuses in her language (r7f-30).
  const reason = (vat: unknown) => { try { parseVatSetup(vat, fail); } catch (e) { return (e as { refusal?: VatSetupRefusal }).refusal; } return undefined; };
  assert.deepEqual(reason({ method: 'net-rate', reporting: 'received', rates: [{ rate: 4.5 }, { rate: 6.2, activityId: '4105' }] }), { reason: 'activityId', rate: 2 });
  assert.deepEqual(reason({ method: 'net-rate', reporting: 'received', rates: [{ rate: 4.5 }, { rate: 4.5 }] }), { reason: 'sameRate', rate: 2 });
  assert.deepEqual(reason({ method: 'net-rate', reporting: 'received', rates: [{ rate: 0 }] }), { reason: 'rate', rate: 1 });
  assert.deepEqual(reason({ method: 'net-rate', reporting: 'received', rates: [] }), { reason: 'rates', rate: 0 });
  assert.equal(reason({ method: 'flat' }), undefined, 'a shape no form sends has no typed reason');
  refused({ method: 'effective', reporting: 'received', rates: [{ rate: 4.5 }] }, /net tax rate method only/);
  refused({ method: 'effective', reporting: 'received', period: 'monthly' }, /quarterly, half-yearly/);
  refused({ method: 'effective', reporting: 'invoiced' }, /received, agreed/);
  refused({ method: 'effective' }, /received, agreed/);
  refused({ method: 'flat' }, /effective, net-rate/);
});

test('the manifest writes the setup back as one explicit block, and the method rule sees what counts as a change', () => {
  assert.deepEqual(vatSetupYaml(NOT_REGISTERED), { registered: false });
  assert.deepEqual(vatSetupYaml(NET_RATE), { registered: true, method: 'net-rate', reporting: 'received', period: 'half-yearly', rates: [{ rate: 4.5, label: 'Schreinerei', activityId: '99901' }] });
  const { text, manifest: written } = patchManifestText(manifest('{ method: effective, reporting: received }'), { vat: NET_RATE }, 'm.yaml');
  assert.deepEqual(written.company.vat, NET_RATE);
  assert.match(text, /vat: \{ registered: true, method: net-rate/);
  assert.equal(changesMethod(EFFECTIVE_QUARTERLY, { registered: true, method: 'effective', reporting: 'received', period: 'half-yearly' }), true);
  assert.equal(changesMethod(NET_RATE, { ...NET_RATE, rates: [{ rate: 4.5, label: 'Möbel', activityId: '99902' }] }), false, 'a label or an activity code may change any time');
  assert.equal(changesMethod(NET_RATE, { ...NET_RATE, rates: [{ rate: 5.3 }] }), true);
  const agreed: VatSetup = { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' };
  assert.equal(changesMethod(EFFECTIVE_QUARTERLY, agreed), true, 'the basis holds for a whole tax period (MWSTG Art. 39 Abs. 3)');
  assert.deepEqual(parseVatSetup({ method: 'effective', reporting: 'agreed' }, fail), agreed);
  assert.deepEqual(vatSetupYaml(agreed), { registered: true, method: 'effective', reporting: 'agreed', period: 'quarterly' });

});

test('the setup questions skip the method, basis and period of a firm that is not registered', () => {
  const freelancer: Partial<Answers> = { legalForm: 'Einzelfirma', vatRegistered: 'no', fiscalYear: 'calendar', start: 'new', sells: ['services'], foreignCustomers: 'no', imports: 'no', employees: 'none', ownerPaysPrivately: 'yes', privateUse: [], payouts: 'no' };
  assert.equal(asked('vatMethod', freelancer), false);
  assert.equal(asked('vatMethod', { ...freelancer, vatRegistered: 'yes' }), true);
  assert.equal(firstUnsupported(freelancer), undefined);
  assert.equal(firstMissing(freelancer), undefined);
  assert.equal(firstMissing({ ...freelancer, vatRegistered: 'yes' }), 'vatMethod');
  assert.equal('unsupported' in QUESTIONS.vatRegistered.options.find((o) => o.value === 'no')!, false);
  assert.deepEqual(vatSetupOf({ vatRegistered: 'no' }), NOT_REGISTERED);
  assert.deepEqual(vatSetupOf({ vatRegistered: 'yes', vatMethod: 'net-rate', basis: 'received', period: 'half-yearly' }, [{ rate: 4.5 }]), { ...TWO_RATES, rates: [{ rate: 4.5 }] });
  assert.equal(vatSetupOf({ vatRegistered: 'yes', vatMethod: 'net-rate', basis: 'received', period: 'half-yearly' }), null, 'no rates, no setup');

  const registered = { ...freelancer, legalForm: 'GmbH', vatRegistered: 'yes', vatMethod: 'net-rate', basis: 'received', period: 'half-yearly' } as Answers;
  assert.throws(() => checkAnswers(registered), (e: Error) => e instanceof SetupError && e.refusal.reason === 'netRates' && /--net-rate/.test(e.message));
  assert.deepEqual(checkAnswers(registered, [{ rate: 4.5, label: 'Schreinerei' }]).vat, { ...NET_RATE, rates: [{ rate: 4.5, label: 'Schreinerei' }] });
  assert.throws(() => checkAnswers({ ...registered, vatMethod: 'effective' }, [{ rate: 4.5 }]), /net tax rate method only/);
  assert.throws(() => checkAnswers({ ...registered, period: undefined } as unknown as Answers), (e: Error) => e instanceof SetupError && e.refusal.reason === 'missing');

  const plan = planWorkspace({ name: 'Salon Beispiel', uid: 'CHE-153.004.184' as Uid, owner: 'Bella Beispiel', preset: 'freelancer', answers: checkAnswers(freelancer as Answers).answers, vat: NOT_REGISTERED, banks: [{ bank: 'UBS', currency: 'CHF', account: '1020' }] }, loadChart(), '/tmp/x', APP_ROOT);
  const yaml = plan.files.find(([p]) => p.endsWith('belege.workspace.yaml'))![1];
  assert.match(yaml, /vat:\n\s+registered: false\n/);
  assert.doesNotMatch(yaml, /vatMethod|basis|period|method:/);
});

const sale = (id: string, date: string, amount: number, vatCode?: string, account = '3400'): JournalEntry => ({ id, transactionRef: id, date, accountDebit: '1020', accountCredit: account, amount, ...(vatCode ? { vatCode } : {}) });
const buy = (id: string, date: string, amount: number, vatCode?: string): JournalEntry => ({ id, transactionRef: id, date, accountDebit: '6000', accountCredit: '1020', amount, ...(vatCode ? { vatCode } : {}) });
const boxes = (entries: JournalEntry[], key: string) => Object.fromEntries(vat().report(entries, key, []).ziffern.filter((z) => z.amount !== 0).map((z) => [z.number, z.amount]));

test('the net tax rate method: half years, the approved rate on the gross turnover, no input tax, Bezugsteuer without a deduction', () => {
  setJurisdiction(ch, NET_RATE);
  assert.equal(vatSetup(), NET_RATE);
  assert.equal(filing().length, 'half');
  const f1 = vat().codes.parse('F1')!;
  assert.deepEqual([f1.rate, f1.revenueZiffer, f1.flatOnGross, f1.amountIs], [4.5, '323', true, 'gross']);
  assert.equal(vat().codes.parse('F2'), null, 'one approved rate: no second code');
  for (const code of ['V81', 'V26', 'I81', 'I0', 'M81', 'M0', 'K81-B']) assert.equal(vat().codes.parse(code), null, `${code} is not a code of this form`);
  const b81 = vat().codes.parse('B81')!;
  assert.deepEqual([b81.acquisitionZiffer, b81.inputTaxZiffer], ['383', undefined], 'Bezugsteuer owed, not deducted');
  assert.deepEqual(vat().codes.parse('V0')!.deductionZiffer, '220');
  assert.equal(vat().codes.netRateCode(1), 'F1');
  assert.equal(vat().codes.saleAt(8.1), undefined);
  assert.deepEqual(vat().rateRows.map((r) => [r.ziffer, r.kind, r.rate, r.activityId]), [['323', 'net-rate', 4.5, '99901'], ['383', 'acquisition', 8.1, undefined], ['382', 'acquisition', 7.7, undefined]]);
  assert.equal(vat().rateRows[0].name, '1. Saldosteuersatz (Schreinerei)');
  assert.equal(vat().isDomesticRate(8.1), true, 'a receipt at the statutory rate is domestic for this firm too');

  const entries = [
    sale('s1', '2026-02-10', 10000, 'F1'),
    sale('s2', '2026-05-03', 2000, 'V0'),
    buy('p1', '2026-03-01', 1081, 'I81'),
    buy('p2', '2026-04-01', 500),
    buy('b1', '2026-06-01', 1000, 'B81-1'),
    sale('s3', '2026-08-01', 4000, 'F1'),
    { ...sale('k1', '2026-07-15', 1000, 'F1'), corrects: '2026-H1' as const },
  ];
  // H1: 200 = 10000 + 2000 (+ the correction booked in July, declared here), 220 = 2000, 323 = 11000 gross, tax 4.5 % = 495, Bezugsteuer 8.1 % of 1000 = 81.
  assert.deepEqual(boxes(entries, '2026-H1'), { 200: 13000, 220: 2000, 289: 2000, 299: 11000, 323: 11000, 383: 81, 399: 576, 500: 576 });
  assert.deepEqual(boxes(entries, '2026-H2'), { 200: 4000, 299: 4000, 323: 4000, 399: 180, 500: 180 });
  assert.deepEqual(entriesForReturn(entries, '2026-H2', filing().length).map((e) => e.id), ['s3']);
  const figures = vat().figures(entries, '2026-H1', []);
  assert.deepEqual([figures.ziffern['323'], figures.ziffern['383'], figures.payable], [11000, 1000, 576]);
  assert.equal(vat().vatLine(entries[2]), null, 'an input-tax code on a purchase declares nothing for this firm');
});

test('two approved rates: a second row and code, each taxed at its own rate', () => {
  setJurisdiction(ch, TWO_RATES);
  assert.deepEqual(vat().rateRows.filter((r) => r.kind === 'net-rate').map((r) => [r.ziffer, r.rate, r.name]), [['323', 4.5, '1. Saldosteuersatz'], ['333', 6.2, '2. Saldosteuersatz (Handel)']]);
  assert.deepEqual(boxes([sale('a', '2026-02-01', 1000, 'F1'), sale('b', '2026-02-02', 1000, 'F2')], '2026-H1'), { 200: 2000, 299: 2000, 323: 1000, 333: 1000, 399: 107, 500: 107 });
});

test('a firm that is not registered knows no code: every entry is gross, the return is empty, the bookkeeping period stays the quarter', () => {
  setJurisdiction(ch, NOT_REGISTERED);
  assert.equal(filing().length, 'quarter');
  for (const code of ['V81', 'V0', 'I81', 'I0', 'F1', 'B81']) assert.equal(vat().codes.parse(code), null, code);
  assert.deepEqual(vat().codes.named, []);
  assert.deepEqual(boxes([sale('s', '2026-02-01', 5000, 'V81'), buy('p', '2026-02-02', 300, 'I81')], '2026-Q1'), {});
  assert.equal(registration()?.turnoverThreshold, 100000);
});

test('the effective method is as it was: quarters, every catalogue code, no net-rate code', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  assert.equal(filing().length, 'quarter');
  assert.equal(vat().codes.parse('F1'), null);
  assert.ok(!vat().codes.named.includes('F1') && vat().codes.named.includes('V81') && vat().codes.named.includes('I0'));
  assert.deepEqual([vat().codes.parse('B81')!.inputTaxZiffer, vat().codes.parse('B81')!.acquisitionZiffer], ['405', '383']);
  assert.deepEqual(boxes([sale('s', '2026-02-01', 1081, 'V81')], '2026-Q1'), { 200: 1081, 299: 1081, 303: 1000, 399: 81, 500: 81 });
  setJurisdiction(ch, { registered: true, method: 'effective', reporting: 'received', period: 'half-yearly' });
  assert.equal(filing().length, 'half', 'the period is the firm\'s, not the method\'s');
});

test('the period lock and the seals count by the firm\'s length: half years for a half-yearly firm', () => {
  const ws = { filingLength: 'half' as const, paths: workspacePaths('/tmp/books') };
  assert.equal(asQuarter('2026-H1', 'half'), '2026-H1');
  assert.equal(asQuarter('2026-Q1', 'half'), undefined);
  assert.equal(asQuarter('2026-Q1', 'quarter'), '2026-Q1');
  assert.equal(periodKeyOf('2026-08-14', 'half'), '2026-H2');
  assert.equal(nextQuarter('2026-H1'), '2026-H2');
  assert.equal(nextQuarter('2026-H2'), '2027-H1');
  assert.equal(nextQuarter('2026-Q4'), '2027-Q1');
  assert.deepEqual([closesTheYear('2026-H2'), closesTheYear('2026-H1'), closesTheYear('2026-Q4'), closesTheYear('2026-Q3')], [true, false, true, false]);
  assert.equal(sealFile(ws as never, '2026-H1'), join('/tmp/books/transactional-data/2026/filings', 'seal-H1.json'));
  assert.equal(isFilingKey('2026-Q3', 'half'), false, 'a quarter is no return of a half-yearly firm');
  assert.equal(booksOpenPeriod({ config: { closedThrough: '2026-06-30' }, transactions: [] }, '2026-10-16', 'half').token, '2026-H2');
  assert.equal(booksOpenPeriod({ config: { closedThrough: '2026-06-30' }, transactions: [] }, '2026-10-16', 'quarter').token, '2026-Q3');
});

test('the electronic return of a net-rate firm names each rate by its activity code and reads back to the same figures; without the code it refuses', () => {
  setJurisdiction(ch, NET_RATE);
  const entries = [sale('s1', '2026-02-10', 10000, 'F1'), sale('s2', '2026-05-03', 2000, 'V0'), buy('b1', '2026-06-01', 1000, 'B81-1')];
  const figures = vat().figures(entries, '2026-H1', []);
  const input = { uid: 'CHE-153.004.184', organisationName: 'Beispiel Test GmbH', period: { key: '2026-H1', from: '2026-01-01', to: '2026-06-30' }, ziffern: figures.ziffern, payable: figures.payable, form: vat().form, rateRows: vat().rateRows, method: 'net-rate' as const, generationTime: '2026-07-20T10:00:00' };
  const { xml, warnings } = ech0217Xml(input);
  assert.deepEqual(warnings, []);
  assert.match(xml, /<eCH-0217:simpleTaxRateMethod>\s*<eCH-0217:suppliesPerTaxRate>\s*<eCH-0217:activityId>99901<\/eCH-0217:activityId>\s*<eCH-0217:taxRate>4.5<\/eCH-0217:taxRate>\s*<eCH-0217:turnover>10000.00/);
  assert.match(xml, /<eCH-0217:acquisitionTax>\s*<eCH-0217:taxRate>8.1<\/eCH-0217:taxRate>\s*<eCH-0217:turnover>1000.00/);
  assert.match(xml, /<eCH-0217:reportingPeriodTill>2026-06-30</);
  assert.doesNotMatch(xml, /effectiveReportingMethod|grossOrNet/);
  const back = parseFiledReturn(xml);
  assert.equal(back.period, '2026-H1');
  assert.deepEqual([back.ziffern['200'], back.ziffern['220'], back.ziffern['323'], back.ziffern['383'], back.ziffern['399'], back.ziffern['500']], [12000, 2000, 10000, 1000, 531, 531]);

  setJurisdiction(ch, { ...NET_RATE, rates: [{ rate: 4.5 }] });
  assert.throws(() => ech0217Xml({ ...input, rateRows: vat().rateRows }), /activity code of this rate is missing/);
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
});

test('the sale question names what «mit MWST» books for each kind of firm: the normal rate, the firm\'s net rate and code, or nothing', () => {
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  assert.deepEqual(domesticSale(), { code: 'V81', rate: 8.1, net: false });
  setJurisdiction(ch, NET_RATE);
  assert.deepEqual(domesticSale(), { code: 'F1', rate: 4.5, net: true });
  setJurisdiction(ch, NOT_REGISTERED);
  assert.equal(domesticSale(), undefined);
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
});

test('r8f-50: the hand form of a firm without input tax never prefills a receipt\'s rate: no code can come of it', () => {
  const books = {
    transactions: [{ ref: 'T1', bank: 'Raiffeisen', date: '2026-08-14', amount: 2131.1, currency: 'CHF', direction: 'DBIT' as const, description: 'Holzhandel' }],
    receipts: [{ id: 'r1', filename: 'a.pdf', originalFilename: 'a.pdf', extractedText: '', extractionMethod: 'pdftotext' as const, fileSize: 1, indexedAt: '', location: 'archived' as const, currency: 'CHF', vatId: 'CHE-123.456.789', hasSwissVat: true, vatSummary: [{ ratePercent: 8.1, vat: 159.7, gross: 2131.1 }], description: 'Holzhandel, Eiche' }],
    mappings: [{ transactionRef: 'T1', receiptId: 'r1' }],
    journalEntries: [],
  };
  const accounts = [{ bank: 'Raiffeisen', currency: 'CHF', account: '1020', label: 'Raiffeisen', role: 'bank' as const }];
  setJurisdiction(ch, NET_RATE);
  assert.equal(bookingDraft(books, 'T1', accounts)!.lines[0].vat, '', 'net tax rate: no input tax, the field stays empty');
  setJurisdiction(ch, NOT_REGISTERED);
  assert.equal(bookingDraft(books, 'T1', accounts)!.lines[0].vat, '', 'not registered: no codes at all');
  setJurisdiction(ch, EFFECTIVE_QUARTERLY);
  assert.equal(bookingDraft(books, 'T1', accounts)!.lines[0].vat, '8.1', 'effective method: the rate waits for the account');
});
