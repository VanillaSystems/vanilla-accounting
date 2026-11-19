/**
 * The third persona walk, A-2 (docs/specs/payroll.md §22 decisions 109, 110): the webshop's pension fund bill is paid on
 * 10.07., ahead of the quarter whose payslips withhold its BVG share. Without `collects:` the app offers «Zieht Lohnabzüge
 * ein: BVG» on the payment (named by the payee), the click writes `collects: [pension]` into the company's file of the
 * fund, text-preserving, with an undo; from then on the hand form proposes the employees' share of July to September
 * (597.60) on 2270 and the rest on 5720, and a payment she booked whole on 5720 is named under «Arbeitnehmeranteil
 * abziehen» for that share, whose click clears 2270. Invented people only (the webshop persona's figures).
 */
import './support/demo-workspace.js';
import './support/jurisdiction.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadBooks, PERSON, saveBooks, update } from '../src/books/store.js';
import { cleanUp, drop, firm, linesOf, pay, run, sum } from './support/payslip-firm.js';
import { textPdf } from './support/text-pdf.js';
import { handStart } from '../src/saving/hand-rule.js';
import { collectsOffer, keptCollectsText, restoreCollects, withCollects, writeCollects } from '../src/payroll/collects-way.js';
import { collectorsOf, unclearedContributions } from '../src/booking/withheld.js';
import { loadClassifyContext, mappedReceipts } from '../src/booking/classify.js';
import { businessOfPayment } from '../src/intake/batch-payers.js';
import { providerIssuesIn } from '../src/intake/pair-chain.js';
import { clearWithheld } from '../src/server/edits.js';
import type { Workspace } from '../src/workspace/workspace.js';

after(cleanUp);

const MONTHS = [['07', 'Juli'], ['08', 'August'], ['09', 'September']] as const;
const PEOPLE = [
  { key: 'W', name: 'Corinne Wyss', gross: '4\'700.00', ahv: '249.10', alv: '51.70', bvg: '199.20', net: 4200 },
  { key: 'B', name: 'Lea Brunner', gross: '1\'550.00', ahv: '82.15', alv: '17.05', net: 1450.8 },
];
const WAGES = MONTHS.flatMap(([m, month]) => PEOPLE.map((p) => pay(`L${p.key}-${m}`, `2026-${m}-25`, p.net, p.name, `Lohn ${month} 2026`)));
const PENSION = pay('PK', '2026-07-10', 1195.2, 'Pensionskasse Zentral', 'Beiträge Q3 2026 PK-26-3-1180');
const slips = () => MONTHS.flatMap(([m, month]) => PEOPLE.map((p) => [`Lohnabrechnung_2026-${m}_${p.name.split(' ')[1]}.pdf`, textPdf([
  'Teegarten Wyss GmbH', 'Seestrasse 12, 6004 Luzern', `Lohnabrechnung ${month} 2026`, p.name,
  `Bruttolohn ${p.gross}`, `AHV/IV/EO 5.3% -${p.ahv}`, `ALV 1.1% -${p.alv}`, ...(p.bvg ? [`Pensionskasse (BVG), Arbeitnehmerbeitrag -${p.bvg}`] : []),
  `Nettolohn, Auszahlung am 25. ${month} ${p.net.toFixed(2).replace(/^(\d)(\d{3})/, "$1'$2")}`,
])] as [string, Promise<Buffer>]));

async function webshop(): Promise<Workspace> {
  const ws = firm('Teegarten Wyss GmbH', [...WAGES, PENSION]);
  await drop(ws, slips());
  await run(ws);
  return ws;
}

/** The offer on payment `ref`, as the route makes it. */
function offerOf(ws: Workspace, ref: string) {
  const books = loadBooks(ws);
  const tx = books.transactions.find((t) => t.ref === ref)!;
  const counterparties = loadClassifyContext(ws).counterparties ?? [];
  const linked = mappedReceipts(books, tx);
  return { tx, offer: collectsOffer({ books, tx, linked, business: businessOfPayment(tx, linked, counterparties), collectors: collectorsOf(counterparties), counterparties }) };
}

test('decision 110: the text writer sets `collects:` and nothing else, in place or at the end; none takes it out; an empty file starts with its id', () => {
  const file = '# the company\'s file of its fund\r\nid: pk\r\nname: "Pensionskasse"\r\nmatch:\r\n  payee: [Pensionskasse]\r\n';
  assert.equal(withCollects(file, ['pension'], 'pk'), `${file}collects: [pension]\r\n`, 'appended, the line ends kept');
  assert.equal(withCollects('id: pk\ncollects:\n- tax\nname: X\n', ['pension', 'tax'], 'pk'), 'id: pk\ncollects: [pension, tax]\nname: X\n', 'a list at the margin replaced in place');
  assert.equal(withCollects('id: pk\ncollects: [pension]\nname: X\n', [], 'pk'), 'id: pk\nname: X\n');
  assert.equal(withCollects('', ['pension'], 'ausgleichskasse'), 'id: "ausgleichskasse"\ncollects: [pension]\n', 'a binding of an app file starts with its id');
  assert.throws(() => withCollects('id: [', ['pension'], 'pk'), /kein gültiges YAML/);
});

test('decisions 109–110, walk 3 A-2: «Zieht Lohnabzüge ein: BVG» on the pension fund\'s payment, then the split proposed for the months the bill pays ahead; undone, the file is gone', async () => {
  const ws = await webshop();
  assert.equal(linesOf(ws, 'PK').length, 0, 'not the app\'s to book: nothing open on 10.07.');
  const before = handStart(ws, 'PK')!;
  assert.ok(before.nature?.kind !== 'contributions' || !before.nature.collector, 'no proposal of the share before');
  const { tx, offer } = offerOf(ws, 'PK');
  assert.deepEqual(offer?.kinds, ['pension'], 'the payee names the pension fund, which the payslips withheld and nobody collects');
  assert.equal(offer!.target.created, true);
  assert.equal(offerOf(ws, 'LW-07').offer, undefined, 'a wage is offered nothing');

  const { text, before: was } = keptCollectsText(ws, offer!.target, ['pension'], tx);
  assert.equal(was, undefined);
  const path = writeCollects(ws, offer!.target.path, text);
  assert.match(readFileSync(join(ws.paths.root, path), 'utf8'), /^id: "pensionskasse-zentral"\nname: "Pensionskasse Zentral"\nmatch:\n {2}payee: \["Pensionskasse Zentral"\]\ncollects: \[pension\]\n$/);
  assert.equal(offerOf(ws, 'PK').offer, undefined, 'kept: offered no more');

  const after = handStart(ws, 'PK')!;
  assert.equal(after.nature?.kind, 'contributions');
  if (after.nature?.kind !== 'contributions') return;
  assert.deepEqual([after.nature.deductions, after.nature.takes, after.nature.account, after.nature.collector?.months], ['2270', 597.6, '5720', ['2026-07', '2026-08', '2026-09']], 'July to September\'s BVG share on 2270, the rest the firm\'s');

  restoreCollects(ws, path, was);
  assert.ok(!existsSync(join(ws.paths.root, path)), 'the file the click made goes');
});

test('decision 109: a payment she booked whole on 5720 is named under «Arbeitnehmeranteil abziehen» for its share once the fund collects; the click clears 2270', async () => {
  const ws = await webshop();
  const file = join(ws.paths.root, 'knowledge/authorities/pensionskasse-zentral.yaml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'id: pensionskasse-zentral\nname: Pensionskasse Zentral\nmatch:\n  payee: ["Pensionskasse Zentral"]\n');
  const books = loadBooks(ws);
  const bank = books.journalEntries.find((e) => e.transactionRef === 'LW-07' && e.accountCredit !== '2270')!.accountCredit;
  update(books, PERSON, (b) => { b.journalEntries.push({ id: 'pk-hand', date: '2026-07-10', transactionRef: 'PK', accountDebit: '5720', accountCredit: bank, amount: 1195.2, currency: 'CHF', description: 'Pensionskasse Q3', origin: 'manual' } as never); });
  saveBooks(ws, books);
  const open = () => { const b = loadBooks(ws); const i = providerIssuesIn(ws, b); return unclearedContributions(b, '2026-07-01', '2026-09-30', new Set(i.withheldPayees ?? []), i.withheldShares).find((u) => u.tx.ref === 'PK'); };
  assert.equal(open(), undefined, 'without `collects` the books do not say whose part it is');
  writeFileSync(file, `${readFileSync(file, 'utf8')}collects: [pension]\n`);
  const u = open();
  assert.equal(u?.open, 597.6, 'the BVG share the payslips withheld after the payment');
  const b = loadBooks(ws);
  update(b, PERSON, (x) => clearWithheld(x, u, 'PK'));
  saveBooks(ws, b);
  const pk = linesOf(ws, 'PK');
  assert.deepEqual([sum(pk, '2270'), sum(pk, '5720')], [597.6, 597.6]);
  const on2270 = loadBooks(ws).journalEntries.reduce((s, e) => s + (e.accountCredit === '2270' ? e.amount : 0) - (e.accountDebit === '2270' ? e.amount : 0), 0);
  assert.equal(Math.round(on2270 * 100), 120000, 'what stays on 2270 is the compensation fund\'s AHV/IV/EO and ALV share (3 × 400.00), not paid yet');
});
