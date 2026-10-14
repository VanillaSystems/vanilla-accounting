/**
 * npm run demo:generate -- [--demo DIR] [--seed N] [--out DIR]
 *
 * Writes every demo workspace in DEMOS (synthetic companies, see tools/demo/kit.ts), or only
 * --demo's: books.json, receipts/ as text PDFs, bank-statements/ as camt053 XML plus monthly
 * PDFs, the as-filed Q1 return under filings/, accounts.json, knowledge/ and the manifest.
 * Each lands in <app>/<demo.dir> unless --out names another directory (only with --demo).
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
import { assignUniqueRefs, readCamt, transactionsOf } from '../../src/providers/camt053/camt053.js';
import { bankKind } from '../../src/workspace/banks.js';
import { loadFxResolver } from '../../src/accounting/fx-rates.js';
import { sealOf } from '../../src/books/seal.js';
import { BOOKS_SCHEMA } from '../../src/workspace/schema.js';
import { camt053Xml, type CamtEntry } from './camt053.js';
import { textPdf } from './pdf.js';
import { chf, PAID_PRIVATELY, uidChecksumValid, YEAR, type Demo, type Doc, type Payment, type StatementBank } from './kit.js';
import { invoiceFiles, playInvoicing, withSeededIds, type DemoPayment } from './invoices.js';
import { loadInvoices, readPdf } from '../../src/invoices/store.js';
import { matchPayments } from '../../src/invoices/payments.js';
import { kaffee } from './kaffee.js';
import { consulting } from './consulting.js';
import { setJurisdiction, vat } from '../../src/engines/index.js';
import { loadJurisdiction } from '../../src/core/modules/load.js';

/** Every demo workspace `npm run demo:generate` writes. */
const DEMOS: readonly Demo[] = [kaffee, consulting];

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// The demos are written before any workspace opens: they book with the shipped jurisdiction.
setJurisdiction(loadJurisdiction(APP_ROOT, 'ch').jurisdiction);

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

/** The account a payment books its bank side on: its statement bank's, or the owner's for PAID_PRIVATELY. */
function bankOf(demo: Demo, payment: Payment): StatementBank | { bank: 'manual'; currency: 'CHF'; account: string } {
  if (payment.bank === PAID_PRIVATELY) return { bank: 'manual', currency: 'CHF', account: demo.ownerAccount.account };
  const bank = demo.banks[payment.bank];
  if (!bank) throw new Error(`${demo.dir}: payment on ${payment.date} "${payment.text}" names unknown bank ${payment.bank}`);
  return bank;
}

/** Orders the payments, gives each its bank reference and turns its legs into journal entries. */
function book(demo: Demo, payments: Payment[]): { booked: Booked[]; entries: JournalEntry[]; keys: Map<string, string> } {
  const sorted = payments.map((p, i) => ({ p, i })).sort((a, b) => a.p.date.localeCompare(b.p.date) || a.i - b.i).map((x) => x.p);
  const seq = { raiffeisen: 0, card: 0, transfer: 0, manual: 0 };
  const booked: Booked[] = [];
  const entries: JournalEntry[] = [];
  const keys = new Map<string, string>();
  for (const payment of sorted) {
    const signed = r2(payment.parts.flatMap((p) => p.legs).reduce((s, l) => s + l.amount, 0));
    if (signed === 0) throw new Error(`payment on ${payment.date} "${payment.text}" moves nothing`);
    const bank = bankOf(demo, payment);
    const ref = bank.bank === 'manual' ? `M${YEAR}-${String(++seq.manual).padStart(3, '0')}`
      : bank.bank === 'Raiffeisen' ? `9${String(++seq.raiffeisen).padStart(10, '0')}`
        : payment.text.startsWith('Card') ? `CARD-${7000000 + ++seq.card}` : `TRANSFER-${8000000 + ++seq.transfer}`;
    booked.push({ ref, payment, amount: Math.abs(signed), direction: signed > 0 ? 'CRDT' : 'DBIT' });

    // A part that pays an invoice is booked by the invoice matcher, after the books are read back (build).
    payment.parts.forEach((part, pi) => part.invoice ? undefined : part.legs.forEach((leg, li) => {
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
function statements(demo: Demo, bankId: string, booked: Booked[], tree: Tree): { balances: StatementClosingBalance[]; pdfs: BankStatement[] } {
  const bank = demo.banks[bankId];
  const { company } = demo;
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
      owner: company.name, institution: bank.institution, from, to, opening: before(from), closing: balanceAt(to), entries,
    });
    const file = bank.bank === 'Raiffeisen'
      ? `uuid_camt053_001_08_${bank.iban.toLowerCase()}_${created.replace(/\D/g, '')}.xml`
      : `uuid_statement_${WISE_ACCOUNT_ID}_${bank.currency}_${from}_${to}.xml`;
    tree.set(`${dir}/${file}`, xml);
  }

  const balances: StatementClosingBalance[] = [];
  const pdfs: BankStatement[] = [];
  for (const to of MONTH_ENDS) {
    const from = `${to.slice(0, 8)}01`;
    const file = bank.bank === 'Raiffeisen'
      ? `Kontoauszug ${dmy(from)} - ${dmy(to)} - ${bank.iban} - ${to}.pdf`
      : `statement_${WISE_ACCOUNT_ID}_${bank.currency}_${from}_${to}.pdf`;
    const closing = balanceAt(to);
    const lines = [
      bank.institution, `Kontoauszug ${dmy(from)} - ${dmy(to)}`, `${company.name}, ${company.address.join(', ')}`,
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
function filedReturn(demo: Demo, books: Index): string {
  const dir = mkdtempSync(join(tmpdir(), 'belege-demo-filing-'));
  try {
    symlinkSync(join(APP_ROOT, 'node_modules'), join(dir, 'node_modules'));
    writeFileSync(join(dir, 'belege.workspace.yaml'), manifest(demo));
    writeFileSync(join(dir, 'books.json'), JSON.stringify(books));
    const out = join(dir, 'filed.xml');
    execFileSync(process.execPath, ['--import', 'tsx', join(APP_ROOT, 'src/cli/vat-ech0217.ts'), demo.filed.period, out], {
      cwd: dir, env: { ...process.env, VANILLA_WORKSPACE: dir }, stdio: 'pipe',
    });
    return readFileSync(out, 'utf8').replace(/<eCH-0217:generationTime>[^<]*</, `<eCH-0217:generationTime>${demo.filed.generationTime}<`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function manifest(demo: Demo): string {
  const { company } = demo;
  const inv = demo.invoicing;
  // An invoice prints the IBAN of the account it is paid to, so a demo that invoices names its IBANs.
  const accounts = Object.values(demo.banks).map((b) =>
    `  - { bank: ${b.bank}, currency: ${b.currency}, account: "${b.account}", label: ${b.label}, statements: ${bankKind(b.bank).statements}${inv ? `, iban: ${b.iban}` : ''} }`);
  const address = inv ? `  address: { street: ${inv.address.street}, number: "${inv.address.number}", postcode: "${inv.address.postcode}", town: ${inv.address.town}, country: ${inv.address.country} }\n` : '';
  return `# The demo company: synthetic data, generated by tools/demo/generate.ts. Do not edit by hand.
schema: 1
company:
  name: ${company.name}
  uid: ${company.uid}
  owner: ${company.owner}
${address}  vat: { method: effective, reporting: received }
bankAccounts:
${accounts.join('\n')}
  - { bank: manual, currency: CHF, account: "${demo.ownerAccount.account}", label: ${demo.ownerAccount.label} }
${inv ? inv.manifest : ''}`;
}

/** A demo may name a real company only when it marks it public; every other UID must fail its check digit. */
function assertFictionalUids(demo: Demo): void {
  const customers = Object.values(demo.invoicing?.customers ?? {}).map((c) => ({ name: c.name, uid: c.vatId?.startsWith('CHE-') ? c.vatId.slice(0, 15) : undefined }));
  const named = [{ name: demo.company.name, uid: demo.company.uid }, ...Object.values(demo.vendors).filter((v) => !v.public), ...customers];
  for (const { name, uid } of named) {
    if (uid && uidChecksumValid(uid)) throw new Error(`${demo.dir}: ${name} has the valid UID ${uid}; invented UIDs need a wrong check digit`);
  }
}

async function build(demo: Demo, seed: number): Promise<Tree> {
  assertFictionalUids(demo);
  const tree: Tree = new Map();
  const sc = demo.scenario(seed);

  // The tax payment of Q1 needs Q1's figure, so the books are made once without it.
  const draft = book(demo, sc.payments);
  const q1 = vat().figures(draft.entries, demo.filed.period, []);
  if (q1.payable <= 0) throw new Error(`${demo.dir}: Q1 must have tax to pay, got ${q1.payable}`);
  // The Korrekturabrechnung: Q1 as today's books declare it, corrections included, less what was filed.
  const corrections: JournalEntry[] = sc.manual.filter((m) => m.corrects).map((m) => ({
    id: m.key, transactionRef: m.key, date: m.date, accountDebit: m.debit, accountCredit: m.credit, amount: m.amount,
    ...(m.vatCode ? { vatCode: m.vatCode } : {}), description: m.text, corrects: m.corrects,
  }));
  const difference = r2(vat().figures([...draft.entries, ...corrections], demo.filed.period, []).payable - q1.payable);
  const correctionPayment = sc.correctionPayment && difference !== 0 ? [sc.correctionPayment(difference)] : [];
  const { booked, entries, keys } = book(demo, [...sc.payments, sc.taxPayment(q1.payable), ...correctionPayment]);

  const privately = booked.filter((b) => b.payment.bank === PAID_PRIVATELY).length;
  const manualEntries = sc.manual.map((m, i) => ({ ...m, ref: `M${YEAR}-${String(privately + i + 1).padStart(3, '0')}` }));
  for (const m of manualEntries) {
    const id = hashId(m.ref);
    keys.set(m.key, id);
    entries.push({
      id, transactionRef: m.ref, date: m.date, accountDebit: m.debit, accountCredit: m.credit, amount: m.amount, ...(m.vatCode ? { vatCode: m.vatCode } : {}),
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
    if (tree.has(`receipts/${doc.file}`)) throw new Error(`${demo.dir}: two receipts are named ${doc.file}`);
    tree.set(`receipts/${doc.file}`, pdf);
    const receipt = receiptOf(doc, pdf, indexedOn);
    receipts.push(receipt);
    mappings.push({ transactionRef: ref, receiptId: receipt.id });
  };
  for (const b of booked) for (const p of b.payment.parts) if (p.doc) addDoc(p.doc, b.ref, b.payment.date);
  for (const m of manualEntries) if (m.doc) addDoc(m.doc, m.ref, m.date);

  const stmts = Object.keys(demo.banks).map((id) => statements(demo, id, booked, tree));

  // The bank transactions are what our own parser reads from the statements just written.
  const viaBank = booked.filter((b) => b.payment.bank !== PAID_PRIVATELY);
  const parsed: BankTransaction[] = assignUniqueRefs([...tree].filter(([path]) => path.endsWith('.xml') && path.startsWith('bank-statements/'))
    .flatMap(([path, xml]) => {
      const bank = path.split('/')[1];
      return readCamt(String(xml)).statements.flatMap((s) => transactionsOf(s, { bank, statements: bankKind(bank).statements! }));
    }));
  if (parsed.length !== viaBank.length) throw new Error(`parser read ${parsed.length} transactions, ${viaBank.length} were written`);
  // Paid privately: the manual transaction the app records for an Auslage.
  const paidPrivately: BankTransaction[] = booked.filter((b) => b.payment.bank === PAID_PRIVATELY).map((b) => ({
    ref: b.ref, bank: 'manual', source: 'manual', date: b.payment.date, amount: b.amount, currency: 'CHF', direction: b.direction, description: b.payment.text,
  }));
  const transactions = [...parsed, ...paidPrivately].map((tx) => {
    const b = booked.find((x) => x.ref === tx.ref);
    if (!b || b.amount !== tx.amount || b.direction !== tx.direction) throw new Error(`transaction ${tx.ref} does not read back as written`);
    const why = b.payment.parts.length === 1 ? b.payment.parts[0].noReceipt : undefined;
    // As `npm run extract` keeps them (mergeIndex): a filed quarter's transactions carry no parts or reference.
    const { parts, reference, ...filed } = tx;
    const kept = tx.date <= demo.closedThrough ? filed : tx;
    return why ? { ...kept, remarks: why, noReceiptNeeded: true } : kept;
  }).sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));

  // Opening balances: the banks (foreign ones at the 31.12 rate) and the other assets on the
  // debit side, the liabilities and equity on the credit side, 2970 the difference.
  const banks = Object.values(demo.banks);
  const assets: Record<string, number> = Object.fromEntries([
    ...banks.map((b) => [b.account, b.currency === 'CHF' ? b.opening : r2(b.opening * fxRate(b.currency, '2025-12-31')!)] as const),
    ...Object.entries(demo.openingOther).filter(([account]) => account.startsWith('1')),
  ]);
  const liabilities = Object.fromEntries(Object.entries(demo.openingOther).filter(([account]) => !account.startsWith('1')));
  const assetTotal = r2(Object.values(assets).reduce((s, v) => s + v, 0));
  const liabilityTotal = r2(Object.values(liabilities).reduce((s, v) => s + v, 0));

  const books: Index = {
    schema: BOOKS_SCHEMA,
    receipts: receipts.sort((a, b) => a.filename.localeCompare(b.filename)),
    transactions,
    mappings,
    bankStatements: stmts.flatMap((s) => s.pdfs).sort((a, b) => a.fromDate.localeCompare(b.fromDate) || a.bank.localeCompare(b.bank)),
    journalEntries: entries,
    config: {
      closedThrough: demo.closedThrough,
      openingBalances: { [YEAR]: { ...assets, ...liabilities, '2970': r2(assetTotal - liabilityTotal) } },
      openingBalancesNative: { [YEAR]: Object.fromEntries(banks.filter((b) => b.currency !== 'CHF').map((b) => [b.account, { amount: b.opening, currency: b.currency }])) },
      vatAdjustments: [],
      correctionCases: sc.correctionCases.map((c) => ({ ...c, originalEntryIds: c.originalEntryIds.map(idOf), correctionEntryIds: c.correctionEntryIds.map(idOf) })),
    },
    statementBalances: stmts.flatMap((s) => s.balances).sort((a, b) => a.date.localeCompare(b.date) || a.account.localeCompare(b.account)),
  };

  if (demo.invoicing) {
    const paidByInvoice = booked.flatMap((b) => b.payment.parts.filter((p) => p.invoice).map((p) => ({
      number: p.invoice!, transactionRef: b.ref, date: b.payment.date, amount: r2(p.legs.reduce((s, l) => s + l.amount, 0)),
    })));
    await withSeededIds(seed, () => invoicing(demo, books, tree, paidByInvoice));
  }

  // As filed: the books on filing day knew nothing of the later correction, and Q1 was still open.
  const asFiled: Index = { ...books, journalEntries: entries.filter((e) => !e.corrects), config: { ...books.config, closedThrough: undefined } };
  tree.set(`filings/${YEAR}/mwst-ech0217-${demo.filed.period}.xml`, filedReturn(demo, asFiled));

  tree.set('books.json', json(books));
  tree.set(`filings/${YEAR}/seal-${demo.filed.period.slice(5)}.json`, json(sealOf(books, demo.filed.period, demo.filed.generationTime.slice(0, 10))));
  tree.set('accounts.json', json(demo.accounts.map(([number, name]) => ({ number, name }))));
  tree.set('belege.workspace.yaml', manifest(demo));
  for (const [file, yaml] of Object.entries(demo.knowledge)) tree.set(`knowledge/${file}`, yaml);
  tree.set('.gitignore', 'data/\n.env\nbeleg-import/\n');
  return tree;
}

/**
 * The demo's invoices, played through the app's invoicing service (tools/demo/invoices.ts), and
 * their payments booked by the app's payment matcher from the transactions read back above.
 */
async function invoicing(demo: Demo, books: Index, tree: Tree, payments: DemoPayment[]): Promise<void> {
  const ws = await playInvoicing(demo.invoicing!, manifest(demo), demo.company.owner, payments);
  try {
    const book = loadInvoices(ws);
    const full = { ...books, journalEntries: books.journalEntries!, config: books.config! };
    const paid = matchPayments(full, book, {
      bankAccounts: ws.bankAccounts, revenueAccount: ws.invoicing!.revenueAccount, fx,
      pdfOf: (inv) => readPdf(ws, inv.pdf), receiptId: hashId, indexedAt: (tx) => `${tx.date}T18:00:00.000Z`,
    });
    const expected = demo.invoicing!.steps.filter((s) => s.do === 'issue' && s.paid).length;
    if (paid.paid.filter((p) => p.booked).length !== expected || paid.questions.length) {
      throw new Error(`${demo.dir}: ${expected} invoice payments should book by their reference: ${JSON.stringify(paid)}`);
    }
    books.journalEntries!.sort((a, b) => a.date.localeCompare(b.date) || a.transactionRef.localeCompare(b.transactionRef) || a.id.localeCompare(b.id));
    books.receipts.sort((a, b) => a.filename.localeCompare(b.filename));
    for (const f of paid.files) tree.set(`receipts/${f.filename}`, f.pdf);
    for (const [path, bytes] of invoiceFiles(ws)) tree.set(path, bytes);
    tree.set('invoices.json', json(book));
  } finally {
    rmSync(ws.paths.root, { recursive: true, force: true });
  }
}

async function write(demo: Demo, seed: number, out: string) {
  const tree = await build(demo, seed);
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

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const seed = Number(opt('--seed') ?? 1);
  if (!Number.isInteger(seed)) throw new Error(`--seed must be an integer, got ${opt('--seed')}`);
  const only = opt('--demo');
  const demos = only === undefined ? DEMOS : DEMOS.filter((d) => d.dir === only);
  if (demos.length === 0) throw new Error(`--demo ${only}: no such demo (${DEMOS.map((d) => d.dir).join(', ')})`);
  const out = opt('--out');
  if (out !== undefined && demos.length > 1) throw new Error('--out needs --demo: each demo writes its own directory');
  for (const demo of demos) await write(demo, seed, resolve(out ?? join(APP_ROOT, demo.dir)));
}

await main();
