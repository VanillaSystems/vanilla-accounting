/**
 * #489 (webshop-ai-r5-10): the payslips came in the same drop as the bank statement, yet the compensation fund's
 * Akonto payment stayed booked whole on 5700, without the employees' share the payslips withheld; only «2270
 * ausgleichen» fixed it. A drop hands each file to the inbox's run as it takes it: the statement (with the Akonto
 * bill, which Finder lists first) in one run, the payslips after it. The first run books the wages (booked at once,
 * without waiting for their payslip) net and the Akonto with nothing on 2270, as told: nothing was withheld then.
 * The payslips' run books the wages again, gross from their payslips, and the deductions land on 2270; the Akonto
 * payment, its bill linked long before, was never asked again. Now the classify step books every contribution
 * payment the app booked to the share code reads off the payslips, whenever it changes; never a person's booking.
 *
 * The texts are the webshop persona's files (.claude/skills/verify/persona-files/webshop.mjs, kit.mjs payroll):
 * two people, AHV/IV/EO 5.3 % and ALV 1.1 % a month, the owner's pension fund contribution, the pension fund's bill
 * paid on 10.07., the Akonto bill AK-26-Q3-30871 paid on 28.09.
 */
import './support/jurisdiction.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { PIPELINE } from '../src/intake/run.js';
import { classifyStep } from '../src/intake/classify.js';
import { loadBooks, moduleActor, PERSON, saveBooks, update } from '../src/books/store.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { textPdf } from './support/text-pdf.js';
import { mergedLines, unclearedContributions } from '../src/booking/withheld.js';
import { clearWithheld, undoClearWithheld } from '../src/server/edits.js';

const roots: string[] = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const MONTHS = [['07', 'Juli'], ['08', 'August'], ['09', 'September']] as const;
const PEOPLE = [
  { key: 'W', name: 'Corinne Wyss', role: 'Geschäftsführerin', gross: '4\'700.00', ahv: '249.10', alv: '51.70', bvg: '199.20', net: 4200, deductions: 500 },
  { key: 'B', name: 'Lea Brunner', role: 'Mitarbeiterin Versand (40 %)', gross: '1\'550.00', ahv: '82.15', alv: '17.05', net: 1450.8, deductions: 99.2 },
];
const pay = (ref: string, date: string, amount: number, counterparty: string, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description, reference: description });
const WAGES = MONTHS.flatMap(([m, month]) => PEOPLE.map((p) => pay(`L${p.key}-${m}`, `2026-${m}-25`, p.net, p.name, `Lohn ${month} 2026`)));
const PENSION = pay('PK', '2026-07-10', 1195.2, 'Pensionskasse Zentral', 'Beiträge Q3 2026 PK-26-3-1180');
const AKONTO = pay('AK', '2026-09-28', 2683.5, 'Ausgleichskasse Luzern', 'Akonto AHV/IV/EO/ALV Q3 2026 AK-26-Q3-30871');

const payslip = (p: (typeof PEOPLE)[number], month: string) => textPdf([
  'Teegarten Wyss GmbH', 'Seestrasse 12, 6004 Luzern', `Lohnabrechnung ${month} 2026`, `${p.name}, ${p.role}`,
  `Bruttolohn ${p.gross}`, `AHV/IV/EO 5.3% -${p.ahv}`, `ALV 1.1% -${p.alv}`, ...(p.bvg ? [`Pensionskasse (BVG), Arbeitnehmerbeitrag -${p.bvg}`] : []),
  `Nettolohn, Auszahlung am 25. ${month} ${p.net.toFixed(2).replace(/^(\d)(\d{3})/, "$1'$2")}`,
  `Die Arbeitgeberbeiträge stehen in der Akontorechnung der Ausgleichskasse Luzern${p.bvg ? ' und in der Beitragsrechnung der Pensionskasse Zentral' : ''}.`,
]);
const AKONTO_BILL = () => textPdf(['Ausgleichskasse Luzern', 'Würzenbachstrasse 8, 6006 Luzern', 'Teegarten Wyss GmbH', 'Akontorechnung AK-26-Q3-30871',
  "Datum: 07.07.2026 Periode: 3. Quartal 2026 Lohnsumme gemäss Meldung: CHF 18'750.00", "AHV/IV/EO 10.6% 1'987.50", 'ALV 2.2% 412.50',
  'Familienausgleichskasse FAK 1.3% 243.75', 'Verwaltungskosten 2% der AHV/IV/EO-Beiträge 39.75', "Total CHF 2'683.50",
  'Beiträge von Arbeitgeber und Arbeitnehmenden zusammen. Sozialversicherungsbeiträge unterliegen nicht der MWST.']);

/** The webshop after its statement was read in: the payments of the quarter, the pension fund's bill booked with its split; the inbox empty. */
function webshop(): Workspace {
  const made = tempWorkspace('withheld-489-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  appendFileSync(join(made.paths.root, 'belege.workspace.yaml'), 'profile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: no\n  imports: no\n  employees: staff\n  ownerPaysPrivately: no\n  privateUse: []\n  payouts: no\n');
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  const pension = (debit: string) => ({ id: `e-PK-${debit}`, transactionRef: 'PK', date: PENSION.date, accountDebit: debit, accountCredit: '1020', amount: 597.6, description: 'Pensionskasse Zentral', origin: 'classify', by: { kind: 'model', model: 'test' } }) as JournalEntry;
  writeIndex(ws, { transactions: [...WAGES, PENSION, AKONTO], journalEntries: [pension('2270'), pension('5720')], config: { closedThrough: '2026-06-30' } });
  // The statement as the drop read it in: its camt.053 in the account's folder, which every run reads the payments from.
  const folder = join(ws.paths.root, 'transactional-data', '2026', 'bank-statements', 'Raiffeisen');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'camt053_Q3-2026.xml'), camt([...WAGES, PENSION, AKONTO]));
  return ws;
}

function camt(txs: BankTransaction[]): string {
  const row = (t: BankTransaction) => `<Ntry><Amt Ccy="CHF">${t.amount.toFixed(2)}</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${t.date}</Dt></BookgDt><ValDt><Dt>${t.date}</Dt></ValDt><AcctSvcrRef>${t.ref}</AcctSvcrRef>`
    + `<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>${/^L/.test(t.ref) ? 'SALA' : 'DMCT'}</SubFmlyCd></Fmly></Domn></BkTxCd>`
    + `<NtryDtls><TxDtls><Amt Ccy="CHF">${t.amount.toFixed(2)}</Amt><RltdPties><Cdtr><Pty><Nm>${t.counterparty}</Nm></Pty></Cdtr></RltdPties><RmtInf><Ustrd>${t.description}</Ustrd></RmtInf></TxDtls></NtryDtls><AddtlNtryInf>${t.description}</AddtlNtryInf></Ntry>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>Q3</MsgId><CreDtTm>2026-10-01T05:30:00</CreDtTm></GrpHdr>`
    + `<Stmt><Id>Q3</Id><CreDtTm>2026-10-01T05:30:00</CreDtTm><FrToDt><FrDtTm>2026-07-01T00:00:00</FrDtTm><ToDtTm>2026-09-30T23:59:59</ToDtTm></FrToDt><Acct><Id><IBAN>CH3880808000000000002</IBAN></Id><Ccy>CHF</Ccy></Acct>${txs.map(row).join('')}</Stmt></BkToCstmrStmt></Document>`;
}

/** Puts files into the inbox as the drop does for each receipt it takes. */
async function drop(ws: Workspace, files: Array<[string, Buffer | Promise<Buffer>]>) {
  mkdirSync(ws.paths.inbox, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(ws.paths.inbox, name), await bytes);
}

/**
 * The AI as tests stub it, answering as the walk's model did: a receipt is matched to the payment its text names, read
 * without Swiss VAT; a wage with its payslip is booked gross (the deductions on 2270), without it net; the Akonto whole
 * on the employer's accounts by the bill's lines, nothing on 2270 («ganze Zahlung ist Arbeitgeberaufwand»).
 */
const model: Ask = async (prompt, opts) => {
  if (opts.step === 'receipt-match') {
    const ref = /Akontorechnung AK-/.test(prompt) ? 'AK' : (() => {
      const p = PEOPLE.find((x) => prompt.includes(`${x.name}, ${x.role}`))!;
      const m = MONTHS.find(([, month]) => prompt.includes(`Lohnabrechnung ${month} 2026`))!;
      return `L${p.key}-${m[0]}`;
    })();
    const tx = [...WAGES, AKONTO].find((t) => t.ref === ref)!;
    return JSON.stringify({ suggestedFilename: `${tx.date.replace(/-/g, '')}-${ref.toLowerCase()}.pdf`, date: ref === 'AK' ? '2026-07-07' : tx.date, description: tx.description, amount: tx.amount, currency: 'CHF', matchedTransactionRefs: [ref], confidence: 0.95 });
  }
  if (opts.step === 'receipt-vat') return JSON.stringify({ vatId: '', currency: 'CHF', hasSwissVat: false, vatSummary: [] });
  if (opts.step === 'receipt-pair') {
    const list = JSON.parse(prompt.slice(prompt.indexOf('\n\n[') + 2, prompt.lastIndexOf(']\n\n') + 1)) as Array<{ i: number }>;
    return JSON.stringify(list.map((x) => ({ i: x.i, fits: true, why: 'stub' })));
  }
  if (opts.step !== 'classify') return '{}';
  const out: Record<string, unknown> = {};
  for (const part of prompt.split('## Chart of Accounts')[0].split(/^### Transaction \d+: /m).slice(1)) {
    const key = part.split(/\s/)[0];
    const amount = Number(/Amount: -?([\d.]+)/.exec(part)![1]);
    const person = PEOPLE.find((p) => part.includes(p.name));
    out[key] = person
      ? { entries: [{ accountDebit: '5000', accountCredit: '', amount, vat: 'none' }, ...(/Lohnabrechnung/.test(part) ? [{ accountDebit: '5000', accountCredit: '2270', amount: person.deductions, vat: 'none' }] : [])], reason: 'Lohn' }
      : { entries: [{ accountDebit: '5700', accountCredit: '', amount: 2439.75, vat: 'none' }, { accountDebit: '5710', accountCredit: '', amount: 243.75, vat: 'none' }], reason: 'ganze Zahlung ist Arbeitgeberaufwand, nichts auf 2270' };
  }
  return JSON.stringify(out);
};

const run = (ws: Workspace) => runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: model, steps: PIPELINE });
const sum = (lines: JournalEntry[], account: string, side: 'accountDebit' | 'accountCredit' = 'accountDebit') => Math.round(lines.filter((e) => e[side] === account).reduce((s, e) => s + e.amount, 0) * 100) / 100;
const linesOf = (ws: Workspace, ref: string) => loadBooks(ws).journalEntries.filter((e) => e.transactionRef === ref);

test('#489 the drop: statement and Akonto bill in the first run, the payslips after it; the Akonto ends net of the employees\' 1\'200.00 the payslips withheld', async () => {
  const ws = webshop();
  await drop(ws, [['Ausgleichskasse_Luzern_Akonto_Q3_2026.pdf', AKONTO_BILL()]]);
  await run(ws);
  const before = linesOf(ws, 'AK');
  assert.deepEqual([sum(before, '2270'), sum(before, '5700')], [0, 2439.75], 'the first run: wages net, nothing withheld, the Akonto whole the employer\'s');
  assert.equal(loadBooks(ws).mappings.find((m) => m.transactionRef === 'AK')?.receiptId !== undefined, true, 'the bill is linked');

  await drop(ws, MONTHS.flatMap(([m, month]) => PEOPLE.map((p) => [`Lohnabrechnung_2026-${m}_${p.name.split(' ')[1]}.pdf`, payslip(p, month)] as [string, Promise<Buffer>])));
  await run(ws);
  const books = loadBooks(ws);
  assert.equal(sum(books.journalEntries, '2270', 'accountCredit'), 1797.6, 'the wages again, gross from their payslips');
  const ak = linesOf(ws, 'AK');
  assert.equal(sum(ak, '2270'), 1200, 'the employees\' AHV/IV/EO and ALV of the six payslips');
  assert.equal(sum(ak, '5700'), 1239.75);
  assert.equal(sum(ak, '5710'), 243.75, 'the family allowances stay the employer\'s');
  assert.ok(ak.every((e) => !e.vatCode && e.origin === 'classify'), 'the app\'s own booking, no code');
  assert.match(ak.find((e) => e.accountDebit === '2270')!.reason ?? '', /Lohnabrechnungen haben für diese Kasse CHF 1200\.00 als Anteil der Arbeitnehmenden abgezogen/);

  await run(ws);
  assert.deepEqual(linesOf(ws, 'AK').map((e) => [e.accountDebit, e.amount]), ak.map((e) => [e.accountDebit, e.amount]), 'a further run changes nothing');
});

test('#489 a contribution payment the person booked herself is never rebooked by the app', async () => {
  const ws = webshop();
  await drop(ws, [['Ausgleichskasse_Luzern_Akonto_Q3_2026.pdf', AKONTO_BILL()]]);
  await run(ws);
  const books = loadBooks(ws);
  update(books, PERSON, (b) => { for (const e of b.journalEntries) if (e.transactionRef === 'AK') { e.origin = 'manual'; e.by = { kind: 'person', at: '2026-10-01T00:00:00Z' }; } });
  saveBooks(ws, books);
  await drop(ws, MONTHS.flatMap(([m, month]) => PEOPLE.map((p) => [`Lohnabrechnung_2026-${m}_${p.name.split(' ')[1]}.pdf`, payslip(p, month)] as [string, Promise<Buffer>])));
  await run(ws);
  const ak = linesOf(ws, 'AK');
  assert.deepEqual([sum(ak, '2270'), sum(ak, '5700')], [0, 2439.75], 'hers stands; the open list proposes the share');
});

const slips = () => MONTHS.flatMap(([m, month]) => PEOPLE.map((p) => [`Lohnabrechnung_2026-${m}_${p.name.split(' ')[1]}.pdf`, payslip(p, month)] as [string, Promise<Buffer>]));

test('#489 review: one payslip per run, as the drop hands them; the Akonto ends as one line per account, decided by code, with the code\'s reason alone', async () => {
  const ws = webshop();
  await drop(ws, [['Ausgleichskasse_Luzern_Akonto_Q3_2026.pdf', AKONTO_BILL()]]);
  await run(ws);
  const shares: number[] = [];
  for (const file of slips()) {
    await drop(ws, [file]);
    await run(ws);
    shares.push(sum(linesOf(ws, 'AK'), '2270'));
  }
  assert.deepEqual(shares, [0, 1.6, 501.6, 600.8, 1100.8, 1200], 'each payslip\'s share as it comes, never more than 2270 holds after the pension fund\'s 597.60 paid in advance');
  const ak = linesOf(ws, 'AK');
  assert.deepEqual(ak.map((e) => [e.accountDebit, e.amount]).sort(), [['2270', 1200], ['5700', 1239.75], ['5710', 243.75]], 'one line per account, however often the share changed');
  assert.ok(ak.every((e) => e.by?.kind === 'code' && e.by.check === 'withheldShare'), 'decided by code, not by the model');
  assert.ok(ak.every((e) => e.reason === 'Die Lohnabrechnungen haben für diese Kasse CHF 1200.00 als Anteil der Arbeitnehmenden abgezogen: so viel geht auf die Lohnabzüge, der Rest ist Beitrag des Arbeitgebers.'), 'the code\'s reason in place of the model\'s «nichts auf 2270»');
});

test('#489 review: «Rückgängig» after «Arbeitnehmeranteil abziehen» leaves the booking hers: the payslips\' run does not book the share on it again', async () => {
  const ws = webshop();
  await drop(ws, [['Ausgleichskasse_Luzern_Akonto_Q3_2026.pdf', AKONTO_BILL()]]);
  await run(ws);
  // The wages booked gross without their payslips linked: code cannot tell the fund's part of 2270. She clicks the open item's proposal, then takes it back.
  const books = loadBooks(ws);
  update(books, moduleActor('test'), (b) => {
    for (const w of WAGES) {
      const net = b.journalEntries.find((e) => e.transactionRef === w.ref)!;
      b.journalEntries.push({ ...net, id: `${net.id}-2270`, accountCredit: '2270', amount: PEOPLE.find((p) => p.name === w.counterparty)!.deductions });
    }
  });
  const u = unclearedContributions(books, '2026-07-01', '2026-09-30', new Set(['AK']))[0];
  assert.ok(u, 'the open item names the payment');
  const done = update(books, PERSON, (b) => clearWithheld(b, u, 'AK'));
  update(books, PERSON, (b) => undoClearWithheld(b, done.before, done.after));
  saveBooks(ws, books);
  const back = linesOf(ws, 'AK');
  const asItIs = () => linesOf(ws, 'AK').map((e) => [e.id, e.accountDebit, e.amount, e.origin, e.by?.kind]).sort();
  // Hers as a change by hand makes a line: only the line the undo put back (what Änderungen lists, by `by`); the FAK line the click never touched stays the model's.
  assert.deepEqual(back.map((e) => [e.accountDebit, e.amount, e.origin, e.by?.kind]).sort(), [['5700', 2439.75, 'manual', 'person'], ['5710', 243.75, 'classify', 'model']]);
  assert.deepEqual(back.filter((e) => e.by?.kind === 'person').map((e) => e.id), done.before.map((e) => e.id), 'only the lines the undo changed are hers');
  const kept = asItIs();
  await drop(ws, slips());
  await run(ws);
  assert.deepEqual(asItIs(), kept, 'the payslips\' run does not book the share on it again');
  // A receipt linked to it later, and a --force run, leave it as she left it.
  const linked = loadBooks(ws);
  update(linked, moduleActor('test'), (b) => { b.mappings.push({ transactionRef: 'AK', receiptId: b.receipts.find((r) => r.filename.includes('lw-07'))!.id, by: 'llm' }); });
  saveBooks(ws, linked);
  await run(ws);
  assert.deepEqual(asItIs(), kept, 'a receipt linked later: not booked again');
  await runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask: model, steps: [['classify', classifyStep({ force: true })]] });
  assert.deepEqual(asItIs(), kept, '--force leaves her booking');
});

test('#489 review: the merge sums only lines alike in accounts, code, day, corrected period and tags; the descriptions are kept', () => {
  const line = (id: string, amount: number, over: Partial<JournalEntry> = {}) => ({ id, transactionRef: 'AK', date: '2026-09-28', accountDebit: '2270', accountCredit: '1020', amount, description: 'Akonto', ...over }) as JournalEntry;
  const merged = mergedLines([line('a', 500), line('b', 1.6, { description: 'Anteil' }), line('c', 99.2, { tags: { projekt: 'x' } }), line('d', 10, { corrects: '2026-Q2' }), line('e', 5, { date: '2026-09-29' }), line('f', 0, { accountDebit: '5700' })]);
  assert.deepEqual(merged.map((e) => [e.id, e.amount, e.description]), [['a', 501.6, 'Akonto · Anteil'], ['c', 99.2, 'Akonto'], ['d', 10, 'Akonto'], ['e', 5, 'Akonto']]);
});
