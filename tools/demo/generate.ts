/**
 * npm run demo:generate -- [--seed N] [--out DIR]
 *
 * Writes the demo workspace (Muster Kaffee GmbH, synthetic) from tools/demo/scenario.ts:
 * books.json, receipts/ as text PDFs, bank-statements/ as camt053 XML plus monthly PDFs,
 * the as-filed Q1 return under filings/, accounts.json, counterparties/ and the manifest.
 * The same seed always gives the same bytes; the output directory is replaced as a whole.
 *
 * The filed return is produced by the real `vat-xml` CLI on the books as they stood when
 * Q1 was filed (without the later correction), then frozen with a fixed generation time.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BankStatement, BankTransaction, Index, JournalEntry, Mapping, Receipt, StatementClosingBalance } from '../../src/types/index.js';
import { parseCamt053, assignUniqueRefs } from '../../src/parsers/camt053.js';
import { figuresFromBooks } from '../../src/accounting/return-figures.js';
import { loadFxResolver } from '../../src/accounting/fx-rates.js';
import { camt053Xml, type CamtEntry } from './camt053.js';
import { textPdf } from './pdf.js';
import {
  ACCOUNTS, BANKS, CLOSED_THROUGH, COMPANY, chf, FILED, OPENING_OTHER, YEAR, scenario,
  type BankId, type Doc, type Payment,
} from './scenario.js';

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const r2 = (n: number) => Math.round(n * 100) / 100;
const hashId = (s: string | Buffer) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const json = (x: unknown) => JSON.stringify(x, null, 2) + '\n';

type Tree = Map<string, string | Buffer>;

interface Booked {
  ref: string;
  payment: Payment;
  amount: number;
  direction: 'CRDT' | 'DBIT';
}

const QUARTERS = [['2026-01-01', '2026-03-31'], ['2026-04-01', '2026-06-30'], ['2026-07-01', '2026-09-30']] as const;
const MONTH_ENDS = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30'];
const WISE_ACCOUNT_ID = '10000001';

const fx = loadFxResolver();
function fxRate(currency: string, date: string): number | undefined {
  if (currency === 'CHF') return undefined;
  const rate = fx.daily(currency, date);
  if (rate === undefined) throw new Error(`no ESTV ${currency} rate for ${date} in reference/estv-daily-rates-${YEAR}.json`);
  return rate;
}

/** Orders the payments, gives each its bank reference and turns its legs into journal entries. */
function book(payments: Payment[]): { booked: Booked[]; entries: JournalEntry[]; keys: Map<string, string> } {
  const sorted = payments.map((p, i) => ({ p, i })).sort((a, b) => a.p.date.localeCompare(b.p.date) || a.i - b.i).map((x) => x.p);
  const seq = { raiffeisen: 0, card: 0, transfer: 0 };
  const booked: Booked[] = [];
  const entries: JournalEntry[] = [];
  const keys = new Map<string, string>();
  for (const payment of sorted) {
    const signed = r2(payment.parts.flatMap((p) => p.legs).reduce((s, l) => s + l.amount, 0));
    if (signed === 0) throw new Error(`payment on ${payment.date} "${payment.text}" moves nothing`);
    const ref = payment.bank === 'raiffeisen'
      ? `9${String(++seq.raiffeisen).padStart(10, '0')}`
      : payment.text.startsWith('Card') ? `CARD-${7000000 + ++seq.card}` : `TRANSFER-${8000000 + ++seq.transfer}`;
    booked.push({ ref, payment, amount: Math.abs(signed), direction: signed > 0 ? 'CRDT' : 'DBIT' });

    const bank = BANKS[payment.bank];
    payment.parts.forEach((part, pi) => part.legs.forEach((leg, li) => {
      const id = hashId(`${ref}#${pi}#${li}`);
      if (leg.key) keys.set(leg.key, id);
      const rate = fxRate(bank.currency, payment.date);
      entries.push({
        id,
        transactionRef: ref,
        date: payment.date,
        accountDebit: leg.amount > 0 ? bank.account : leg.account,
        accountCredit: leg.amount > 0 ? leg.account : bank.account,
        amount: Math.abs(leg.amount),
        ...(leg.vatCode ? { vatCode: leg.vatCode } : {}),
        description: leg.text,
        ...(rate !== undefined ? { exchangeCurrency: bank.currency, exchangeRate: rate } : {}),
      });
    }));
  }
  return { booked, entries, keys };
}

function receiptOf(doc: Doc, pdf: Buffer, indexedOn: string): Receipt {
  const at = `${indexedOn}T18:00:00.000Z`;
  return {
    id: hashId(pdf),
    filename: doc.file,
    originalFilename: doc.file,
    extractedText: doc.lines.join('\n'),
    extractionMethod: 'pdftotext',
    fileSize: pdf.length,
    indexedAt: at,
    location: 'archived',
    date: doc.date,
    description: doc.description,
    amount: doc.total,
    currency: doc.currency,
    ...(doc.vatId ? { vatId: doc.vatId } : {}),
    hasSwissVat: doc.vat.some((g) => g.ratePercent > 0),
    vatSummary: doc.vat,
    vatExtractedAt: at,
    kind: doc.kind,
  };
}

const dmy = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;

/** The bank statement files of one account: a camt053 per quarter and a PDF per month. */
function statements(bankId: BankId, booked: Booked[], tree: Tree): { balances: StatementClosingBalance[]; pdfs: BankStatement[] } {
  const bank = BANKS[bankId];
  const mine = booked.filter((b) => b.payment.bank === bankId);
  const balanceAt = (date: string) => r2(mine.filter((b) => b.payment.date <= date)
    .reduce((s, b) => s + (b.direction === 'CRDT' ? b.amount : -b.amount), bank.opening));
  const before = (date: string) => balanceAt(new Date(Date.parse(`${date}T12:00:00Z`) - 864e5).toISOString().slice(0, 10));
  const dir = `bank-statements/${bank.bank}`;

  for (const [from, to] of QUARTERS) {
    const created = `${new Date(Date.parse(`${to}T12:00:00Z`) + 864e5).toISOString().slice(0, 10)}T06:00:00`;
    const entries: CamtEntry[] = mine.filter((b) => b.payment.date >= from && b.payment.date <= to).map((b) => ({
      ref: b.ref, date: b.payment.date, amount: b.amount, direction: b.direction, text: b.payment.text,
      details: b.payment.parts.map((p) => ({
        amount: r2(Math.abs(p.legs.reduce((s, l) => s + l.amount, 0))), counterparty: p.counterparty, reference: p.reference, text: p.text,
      })),
    }));
    const xml = camt053Xml({
      id: `STM-${bank.bank.toUpperCase()}-${from.slice(0, 7)}`, created, iban: bank.iban, currency: bank.currency,
      owner: COMPANY.name, institution: bank.institution, from, to, opening: before(from), closing: balanceAt(to), entries,
    });
    const file = bankId === 'raiffeisen'
      ? `uuid_camt053_001_08_${bank.iban.toLowerCase()}_${created.replace(/\D/g, '')}.xml`
      : `uuid_statement_${WISE_ACCOUNT_ID}_${bank.currency}_${from}_${to}.xml`;
    tree.set(`${dir}/${file}`, xml);
  }

  const balances: StatementClosingBalance[] = [];
  const pdfs: BankStatement[] = [];
  for (const to of MONTH_ENDS) {
    const from = `${to.slice(0, 8)}01`;
    const file = bankId === 'raiffeisen'
      ? `Kontoauszug ${dmy(from)} - ${dmy(to)} - ${bank.iban} - ${to}.pdf`
      : `statement_${WISE_ACCOUNT_ID}_${bank.currency}_${from}_${to}.pdf`;
    const closing = balanceAt(to);
    const lines = [
      bank.institution, `Kontoauszug ${dmy(from)} - ${dmy(to)}`, `${COMPANY.name}, ${COMPANY.address.join(', ')}`,
      `IBAN ${bank.iban}, Währung ${bank.currency}`, '',
      `Anfangssaldo ${dmy(from)}: ${chf(before(from))}`,
      ...mine.filter((b) => b.payment.date >= from && b.payment.date <= to).map((b) =>
        `${dmy(b.payment.date)} | ${b.payment.text} | ${chf(b.direction === 'CRDT' ? b.amount : -b.amount)} | Ref. ${b.ref}`),
      `Schlusssaldo ${dmy(to)}: ${chf(closing)}`,
    ];
    tree.set(`${dir}/${file}`, textPdf(lines));
    balances.push({ account: bank.account, bank: bank.bank, currency: bank.currency, date: to, amount: closing, source: 'pdf', sourceFile: file });
    pdfs.push({ bank: bank.bank, filename: file, fromDate: from, toDate: to, ...(bank.bank === 'Wise' ? { currency: bank.currency } : {}) });
  }
  return { balances, pdfs };
}

/** The Q1 return exactly as `npm run vat-xml` wrote it on the day of filing. */
function filedReturn(books: Index): string {
  const dir = mkdtempSync(join(tmpdir(), 'belege-demo-filing-'));
  try {
    symlinkSync(join(APP_ROOT, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'belege.workspace.yaml'), manifest());
    writeFileSync(join(dir, 'books.json'), JSON.stringify(books));
    const out = join(dir, 'filed.xml');
    execFileSync(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'src/cli/vat-ech0217.ts'), FILED.period, out], {
      cwd: dir, env: { ...process.env, BELEGE_WORKSPACE: dir }, stdio: 'pipe',
    });
    return readFileSync(out, 'utf8').replace(/<eCH-0217:generationTime>[^<]*</, `<eCH-0217:generationTime>${FILED.generationTime}<`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function manifest(): string {
  const accounts = Object.values(BANKS).map((b) =>
    `  - { bank: ${b.bank}, currency: ${b.currency}, account: "${b.account}", label: ${b.label}, statements: camt053 }`);
  return `# The demo company: synthetic data, generated by tools/demo/generate.ts. Do not edit by hand.
schema: 1
company:
  name: ${COMPANY.name}
  uid: ${COMPANY.uid}
  owner: ${COMPANY.owner}
  vat: { method: effective, reporting: received }
bankAccounts:
${accounts.join('\n')}
  - { bank: manual, currency: CHF, account: "2451", label: Kontokorrent ${COMPANY.owner} }
`;
}

const COUNTERPARTIES: Record<string, string> = {
  // A binding of a public vendor: only what is true for this company.
  'swiss-post.yaml': `# Binding of the public vendor processes/counterparties/swiss-post.yaml to Muster Kaffee's chart.
id: swiss-post
accounts: ["6513"]

steps:
  booking.guide.yaml#classify:
    rules:
      - id: demo-post-parcels
        when: the monthly Post CH invoice for webshop parcels
        then: '6513 Porti und Versand, I81; description "Post CH, Pakete Webshop <Monat>"'
        source: decision 2026-01-20
    precedents: []
`,
  // A private counterparty with no public twin carries its own name and match signals.
  'gruenkaffee-muster.yaml': `# A private supplier: no public vendor file, so this binding is the whole counterparty.
id: gruenkaffee-muster
name: Grünkaffee Muster AG
match:
  tx: ["gruenkaffee muster"]
  uid: ["CHE-999.888.777"]
  file: ['^\\d{8}-gruenkaffee-muster']
accounts: ["4000"]

steps:
  booking.guide.yaml#classify:
    rules:
      - id: demo-gruenkaffee-green-coffee
        when: a Grünkaffee Muster invoice for green coffee
        then: '4000 Rohkaffee, M26 (green coffee is food, reduced rate 2.6%); one entry per invoice'
        source: decision 2026-01-25
    precedents: []
`,
};

function build(seed: number): Tree {
  const tree: Tree = new Map();
  const sc = scenario(seed);

  // The tax payment of Q1 needs Q1's figure, so the books are made once without it.
  const draft = book(sc.payments);
  const q1 = figuresFromBooks(draft.entries, FILED.period, []);
  if (q1.payable <= 0) throw new Error(`Q1 must have tax to pay, got ${q1.payable}`);
  const { booked, entries, keys } = book([...sc.payments, sc.taxPayment(q1.payable)]);

  for (const m of sc.manual) {
    const id = hashId(m.ref);
    keys.set(m.key, id);
    entries.push({
      id, transactionRef: m.ref, date: m.date, accountDebit: m.debit, accountCredit: m.credit, amount: m.amount, vatCode: m.vatCode,
      description: m.text.replace(/\{id:([\w-]+)\}/g, (_, k: string) => keys.get(k) ?? `{unknown key ${k}}`),
      ...(m.corrects ? { corrects: m.corrects } : {}),
    });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.transactionRef.localeCompare(b.transactionRef) || a.id.localeCompare(b.id));
  const idOf = (k: string) => { const id = keys.get(k); if (!id) throw new Error(`unknown entry key ${k}`); return id; };

  const receipts: Receipt[] = [];
  const mappings: Mapping[] = [];
  const addDoc = (doc: Doc, ref: string, indexedOn: string) => {
    const pdf = textPdf(doc.lines);
    tree.set(`receipts/${doc.file}`, pdf);
    const receipt = receiptOf(doc, pdf, indexedOn);
    receipts.push(receipt);
    mappings.push({ transactionRef: ref, receiptId: receipt.id });
  };
  for (const b of booked) for (const p of b.payment.parts) if (p.doc) addDoc(p.doc, b.ref, b.payment.date);
  for (const m of sc.manual) if (m.doc) addDoc(m.doc, m.ref, m.date);

  const stmts = (Object.keys(BANKS) as BankId[]).map((id) => statements(id, booked, tree));

  // The transactions are what our own parser reads from the statements just written.
  const parsed: BankTransaction[] = assignUniqueRefs([...tree].filter(([path]) => path.endsWith('.xml') && path.startsWith('bank-statements/'))
    .flatMap(([path, xml]) => parseCamt053(String(xml), path.split('/').pop())));
  if (parsed.length !== booked.length) throw new Error(`parser read ${parsed.length} transactions, ${booked.length} were written`);
  const transactions = parsed.map((tx) => {
    const b = booked.find((x) => x.ref === tx.ref);
    if (!b || b.amount !== tx.amount || b.direction !== tx.direction) throw new Error(`transaction ${tx.ref} does not read back as written`);
    const why = b.payment.parts.length === 1 ? b.payment.parts[0].noReceipt : undefined;
    return why ? { ...tx, remarks: why, noReceiptNeeded: true } : tx;
  }).sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));

  const eurOpening = BANKS['wise-eur'].opening;
  const assets = { '1021': BANKS.raiffeisen.opening, '1023': r2(eurOpening * fxRate('EUR', '2025-12-31')!), '1510': OPENING_OTHER['1510'], '1520': OPENING_OTHER['1520'] };
  const assetTotal = r2(Object.values(assets).reduce((s, v) => s + v, 0));

  const books: Index = {
    receipts: receipts.sort((a, b) => a.filename.localeCompare(b.filename)),
    transactions,
    mappings,
    bankStatements: stmts.flatMap((s) => s.pdfs).sort((a, b) => a.fromDate.localeCompare(b.fromDate) || a.bank.localeCompare(b.bank)),
    journalEntries: entries,
    config: {
      closedThrough: CLOSED_THROUGH,
      openingBalances: { [YEAR]: { ...assets, '2800': OPENING_OTHER['2800'], '2970': r2(assetTotal - OPENING_OTHER['2800']) } },
      openingBalancesNative: { [YEAR]: { '1023': { amount: eurOpening, currency: 'EUR' } } },
      vatAdjustments: [],
      correctionCases: sc.correctionCases.map((c) => ({ ...c, originalEntryIds: c.originalEntryIds.map(idOf), correctionEntryIds: c.correctionEntryIds.map(idOf) })),
    },
    statementBalances: stmts.flatMap((s) => s.balances).sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account)),
  };

  // As filed: the books on filing day knew nothing of the later correction, and Q1 was still open.
  const asFiled: Index = { ...books, journalEntries: entries.filter((e) => !e.corrects), config: { ...books.config, closedThrough: undefined } };
  tree.set(`filings/${YEAR}/mwst-ech0217-${FILED.period}.xml`, filedReturn(asFiled));

  tree.set('books.json', json(books));
  tree.set('accounts.json', json(ACCOUNTS.map(([number, name]) => ({ number, name }))));
  tree.set('belege.workspace.yaml', manifest());
  for (const [file, yaml] of Object.entries(COUNTERPARTIES)) tree.set(`counterparties/${file}`, yaml);
  tree.set('.gitignore', 'data/\n.env\nbeleg-import/\n');
  return tree;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const seed = Number(opt('--seed') ?? 1);
  if (!Number.isInteger(seed)) throw new Error(`--seed must be an integer, got ${opt('--seed')}`);
  const out = resolve(opt('--out') ?? join(APP_ROOT, 'demo'));

  const tree = build(seed);
  // Write next to the target, then swap, so a crash never leaves a half-written workspace.
  const staging = `${out}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  for (const [path, content] of [...tree].sort(([a], [b]) => a.localeCompare(b))) {
    mkdirSync(dirname(join(staging, path)), { recursive: true });
    writeFileSync(join(staging, path), content);
  }
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  renameSync(staging, out);
  console.log(`✓ ${out}: ${tree.size} files (seed ${seed})`);
}

main();
