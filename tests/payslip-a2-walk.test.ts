/**
 * docs/specs/payroll.md §15.2, the A-2 acceptance with the AI off: payslips another program issued and the bank statement
 * dropped together. Every wage is booked gross by code (`by.check: payslip`); the compensation fund's Akonto clears exactly
 * the AHV/IV/EO/ALV share; the pension fund's payment clears the BVG share once its file says `collects: [pension]`; a
 * payslip with withholding tax books 2279 and the canton's payment clears it, its commission apart; net bank lines without
 * a payslip are not booked by code (the owner's decision on #359: the wage rule stays a one-click proposal), and nothing is
 * asked. The webshop persona's figures (tests/withheld-drop-489.test.ts); invented people only.
 */
import './support/jurisdiction.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runIntake, storePort, type Ask } from '../src/intake/pipeline.js';
import { PIPELINE } from '../src/intake/run.js';
import { loadBooks, moduleActor } from '../src/books/store.js';
import { loadChart } from '../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../src/workspace/workspace.js';
import type { BankTransaction, JournalEntry } from '../src/types/index.js';
import { tempWorkspace, writeIndex } from './support/workspace.js';
import { textPdf } from './support/text-pdf.js';
import { wageOffer } from '../src/saving/wage-rule.js';
import { externalPayslip } from '../src/booking/payslip.js';

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
const AKONTO = pay('AK', '2026-09-28', 2683.5, 'Ausgleichskasse Luzern', 'Akonto AHV/IV/EO/ALV Q3 2026 AK-26-Q3-30871');
const PENSION = pay('PK', '2026-09-30', 1195.2, 'Pensionskasse Zentral', 'Beiträge Q3 2026 PK-26-3-1180');

const payslip = (p: (typeof PEOPLE)[number], month: string) => textPdf([
  'Teegarten Wyss GmbH', 'Seestrasse 12, 6004 Luzern', `Lohnabrechnung ${month} 2026`, `${p.name}, ${p.role}`,
  `Bruttolohn ${p.gross}`, `AHV/IV/EO 5.3% -${p.ahv}`, `ALV 1.1% -${p.alv}`, ...(p.bvg ? [`Pensionskasse (BVG), Arbeitnehmerbeitrag -${p.bvg}`] : []),
  `Nettolohn, Auszahlung am 25. ${month} ${p.net.toFixed(2).replace(/^(\d)(\d{3})/, "$1'$2")}`,
]);

function camt(txs: BankTransaction[]): string {
  const row = (t: BankTransaction) => `<Ntry><Amt Ccy="CHF">${t.amount.toFixed(2)}</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${t.date}</Dt></BookgDt><ValDt><Dt>${t.date}</Dt></ValDt><AcctSvcrRef>${t.ref}</AcctSvcrRef>`
    + `<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>${/^L/.test(t.ref) ? 'SALA' : 'DMCT'}</SubFmlyCd></Fmly></Domn></BkTxCd>`
    + `<NtryDtls><TxDtls><Amt Ccy="CHF">${t.amount.toFixed(2)}</Amt><RltdPties><Cdtr><Pty><Nm>${t.counterparty}</Nm></Pty></Cdtr></RltdPties><RmtInf><Ustrd>${t.description}</Ustrd></RmtInf></TxDtls></NtryDtls><AddtlNtryInf>${t.description}</AddtlNtryInf></Ntry>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>Q3</MsgId><CreDtTm>2026-10-01T05:30:00</CreDtTm></GrpHdr>`
    + `<Stmt><Id>Q3</Id><CreDtTm>2026-10-01T05:30:00</CreDtTm><FrToDt><FrDtTm>2026-07-01T00:00:00</FrDtTm><ToDtTm>2026-09-30T23:59:59</ToDtTm></FrToDt><Acct><Id><IBAN>CH3880808000000000002</IBAN></Id><Ccy>CHF</Ccy></Acct>${txs.map(row).join('')}</Stmt></BkToCstmrStmt></Document>`;
}

/** A firm with staff, named as its payslips' letterhead, its statement of `txs` read in; `files` are its company's business files. */
function firm(name: string, txs: BankTransaction[], files: Record<string, string> = {}): Workspace {
  const made = tempWorkspace('payslip-a2-', join(APP_ROOT, 'demo-consulting', 'vanilla-accounting'));
  roots.push(made.paths.root);
  const manifest = join(made.paths.root, 'belege.workspace.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('Muster Consulting GmbH', name));
  appendFileSync(manifest, 'profile:\n  preset: consultant\n  fiscalYear: calendar\n  start: new\n  sells: services\n  foreignCustomers: no\n  imports: no\n  employees: staff\n  ownerPaysPrivately: no\n  privateUse: []\n  payouts: no\n');
  for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(made.paths.root, path)), { recursive: true }); writeFileSync(join(made.paths.root, path), body); }
  const ws = workspaceAt(made.paths.root);
  mkdirSync(dirname(ws.paths.accounts), { recursive: true });
  writeFileSync(ws.paths.accounts, JSON.stringify(loadChart().accounts.map((a) => ({ number: a.number, name: a.name, type: a.type }))));
  writeIndex(ws, { transactions: [], journalEntries: [], config: { closedThrough: '2026-06-30' } });
  const folder = join(ws.paths.root, 'transactional-data', '2026', 'bank-statements', 'Raiffeisen');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'camt053_Q3-2026.xml'), camt(txs));
  return ws;
}

async function drop(ws: Workspace, files: Array<[string, Buffer | Promise<Buffer>]>) {
  mkdirSync(ws.paths.inbox, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(ws.paths.inbox, name), await bytes);
}
/** The AI off; `asked` records every prompt a model would have been sent (none, it is off). */
const run = (ws: Workspace, ask?: Ask) => runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask, steps: PIPELINE, ...(process.env.LOG && { log: (l: string) => console.log(l) }) });
const sum = (lines: JournalEntry[], account: string, side: 'accountDebit' | 'accountCredit' = 'accountDebit') => Math.round(lines.filter((e) => e[side] === account).reduce((s, e) => s + e.amount, 0) * 100) / 100;
const linesOf = (ws: Workspace, ref: string) => loadBooks(ws).journalEntries.filter((e) => e.transactionRef === ref);
const SLIPS = () => MONTHS.flatMap(([m, month]) => PEOPLE.map((p) => [`Lohnabrechnung_2026-${m}_${p.name.split(' ')[1]}.pdf`, payslip(p, month)] as [string, Promise<Buffer>]));
const PENSION_FILE = 'id: pensionskasse-zentral\nname: Pensionskasse Zentral\nmatch:\n  payee: ["Pensionskasse Zentral"]\ncollects: [pension]\n';

test('§15.2 1–2 AI off: six payslips and the statement; every wage gross by code, the Akonto clears the fund\'s share, the pension fund the BVG share, 2270 is 0 at 30.09.', async () => {
  const ws = firm('Teegarten Wyss GmbH', [...WAGES, AKONTO, PENSION], { 'knowledge/authorities/pensionskasse-zentral.yaml': PENSION_FILE });
  await drop(ws, SLIPS());
  await run(ws);
  const books = loadBooks(ws);
  assert.equal(books.receipts.filter(externalPayslip).length, 6, 'each a payslip by code');
  for (const w of WAGES) {
    const lines = linesOf(ws, w.ref);
    const p = PEOPLE.find((x) => x.name === w.counterparty)!;
    assert.ok(lines.length && lines.every((e) => e.by?.kind === 'code' && e.by.check === 'payslip' && !e.vatCode), `${w.ref} booked by code`);
    assert.deepEqual([sum(lines, '5000'), sum(lines, '2270', 'accountCredit')], [Math.round((p.net + p.deductions) * 100) / 100, p.deductions], `${w.ref} gross`);
  }
  const ak = linesOf(ws, 'AK');
  assert.deepEqual([sum(ak, '2270'), sum(ak, '5700')], [1200, 1483.5], 'the AHV/IV/EO and ALV the six payslips withheld, the rest the employer\'s');
  const pk = linesOf(ws, 'PK');
  assert.deepEqual([sum(pk, '2270'), sum(pk, '5720')], [597.6, 597.6], 'the BVG share, the rest the employer\'s');
  const on2270 = books.journalEntries.reduce((s, e) => s + (e.accountCredit === '2270' ? e.amount : 0) - (e.accountDebit === '2270' ? e.amount : 0), 0);
  assert.equal(Math.round(on2270 * 100) / 100, 0, '2270 is cleared');
  await run(ws);
  assert.deepEqual(linesOf(ws, 'AK').map((e) => [e.accountDebit, e.amount]), ak.map((e) => [e.accountDebit, e.amount]), 'a further run changes nothing');
});

test('§15.2 2 without `collects` the pension fund\'s payment is not the app\'s to split: it stays for the person, the Akonto is still booked', async () => {
  const ws = firm('Teegarten Wyss GmbH', [...WAGES, AKONTO, PENSION]);
  await drop(ws, SLIPS());
  await run(ws);
  assert.equal(linesOf(ws, 'PK').length, 0);
  assert.equal(sum(linesOf(ws, 'AK'), '2270'), 1200);
});

test('§15.2 1 the statement first, the payslips a run later: the wages wait (no code booking without a payslip), then are booked gross, and the Akonto with its share', async () => {
  const ws = firm('Teegarten Wyss GmbH', [...WAGES, AKONTO]);
  await run(ws);
  assert.equal(linesOf(ws, 'LW-07').length, 0, 'a wage without its payslip is not booked by code (#359)');
  await drop(ws, SLIPS());
  await run(ws);
  assert.ok(linesOf(ws, 'LW-07').every((e) => e.by?.kind === 'code' && e.by.check === 'payslip'));
  assert.equal(sum(linesOf(ws, 'AK'), '2270'), 1200);
});

test('§15.2 3 a payslip with withholding tax books 2279; the canton\'s payment clears it, its collection commission on its own account', async () => {
  const TAX = pay('QST', '2026-08-20', 823.2, 'Kantonale Steuerverwaltung Zug', 'Quellensteuer Juli 2026');
  const WAGE = pay('LM-07', '2026-07-25', 6162, 'Sandra Muster', 'Lohn Juli 2026');
  const ws = firm('Muster Malerei GmbH', [WAGE, TAX], { 'knowledge/authorities/quellensteuer-zug.yaml': 'id: quellensteuer-zug\nname: Quellensteuer Kanton Zug\nmatch:\n  payee: ["Kantonale Steuerverwaltung Zug"]\ncollects: [tax]\n' });
  await drop(ws, [['Lohnabrechnung_Juli.pdf', textPdf(['Muster Malerei GmbH', 'Lohnabrechnung Juli 2026', 'Sandra Muster', "Bruttolohn 8'000.00", 'AHV/IV/EO 5.30% -424.00', 'ALV 1.10% -88.00', 'NBU/KTG -136.00', 'BVG -350.00', 'Quellensteuer A0N 10.5% -840.00', "Nettolohn 6'162.00"])]]);
  await run(ws);
  const wage = linesOf(ws, 'LM-07');
  assert.deepEqual([sum(wage, '5000'), sum(wage, '2270', 'accountCredit'), sum(wage, '2279', 'accountCredit')], [8000, 998, 840]);
  const tax = linesOf(ws, 'QST');
  assert.deepEqual([sum(tax, '2279'), sum(tax, '6500', 'accountCredit')], [840, 16.8], 'the tax owed cleared, 2 % commission kept');
});

test('§15.2 4 Huber: net bank lines only, AI off. Not booked by code, no question asked; the wage rule is offered in one click', async () => {
  const lines = [pay('H1', '2026-07-25', 4380.5, 'Sandra Muster', 'Lohn Juli 2026'), pay('H2', '2026-07-25', 3920.1, 'Marco Beispiel', 'Lohn Juli 2026')];
  const ws = firm('Malerei Huber GmbH', lines);
  const job = await run(ws);
  const books = loadBooks(ws);
  assert.equal(books.journalEntries.length, 0, 'no booking by code');
  assert.ok(!job.steps.some((s) => s.notes.some((n) => n.code === 'asked')), 'no question');
  const offer = wageOffer(ws)!;
  assert.deepEqual([offer.account, [...offer.refs].sort()], ['5000', ['H1', 'H2']], 'one rule for both, on the wage account');
});

test('§15.2 5 / A8 AI on: a payslip code reads is never in a prompt; one it cannot read goes to the model with its social security number masked', async () => {
  const SSN = ['756', '1234', '5678', '97'].join('.');
  const prompts: string[] = [];
  const ask: Ask = async (prompt) => { prompts.push(prompt); return '{}'; };
  const ws = firm('Muster Malerei GmbH', [pay('LM-07', '2026-07-25', 6162, 'Sandra Muster', 'Lohn Juli 2026')]);
  await drop(ws, [['lohn-juli.pdf', textPdf(['Muster Malerei GmbH', 'Lohnabrechnung Juli 2026', 'Sandra Muster', `AHV-Nr. ${SSN}`, "Bruttolohn 8'000.00", 'AHV/IV/EO 5.30% -424.00', 'ALV 1.10% -88.00', 'NBU/KTG -136.00', 'BVG -350.00', 'Quellensteuer A0N 10.5% -840.00', "Nettolohn 6'162.00"])]]);
  await run(ws, ask);
  assert.ok(prompts.every((p) => !p.includes('Sandra') && !p.includes('8\'000') && !p.includes(SSN)), 'nothing of the payslip reached a prompt');
  assert.ok(linesOf(ws, 'LM-07').every((e) => e.by?.kind === 'code' && e.by.check === 'payslip'));
  // A payslip that does not add up is a receipt like any other: the model reads it, masked (src/llm/ask.ts).
  const { maskForModel } = await import('../src/llm/mask.js');
  assert.ok(!maskForModel(`AHV-Nr. ${SSN}`).includes(SSN));
});
