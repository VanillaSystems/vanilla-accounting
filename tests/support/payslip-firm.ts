/**
 * A firm with staff for the A-2 payslip tests (docs/specs/payroll.md §10.2): demo-consulting's workspace under the payslips'
 * letterhead, its camt.053 of the given payments, files dropped into its inbox, the intake run with or without a model.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runIntake, storePort, type Ask } from '../../src/intake/pipeline.js';
import { PIPELINE } from '../../src/intake/run.js';
import { loadBooks, moduleActor } from '../../src/books/store.js';
import { loadChart } from '../../src/workspace/chart.js';
import { APP_ROOT, workspaceAt, type Workspace } from '../../src/workspace/workspace.js';
import type { BankTransaction, JournalEntry } from '../../src/types/index.js';
import { tempWorkspace, writeIndex } from './workspace.js';

export const roots: string[] = [];
export const cleanUp = () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); };

export const pay = (ref: string, date: string, amount: number, counterparty: string, description: string): BankTransaction =>
  ({ ref, bank: 'Raiffeisen', date, amount, currency: 'CHF', direction: 'DBIT', counterparty, description, reference: description });

export function camt(txs: BankTransaction[]): string {
  const row = (t: BankTransaction) => `<Ntry><Amt Ccy="CHF">${t.amount.toFixed(2)}</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${t.date}</Dt></BookgDt><ValDt><Dt>${t.date}</Dt></ValDt><AcctSvcrRef>${t.ref}</AcctSvcrRef>`
    + `<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>${/^L/.test(t.ref) ? 'SALA' : 'DMCT'}</SubFmlyCd></Fmly></Domn></BkTxCd>`
    + `<NtryDtls><TxDtls><Amt Ccy="CHF">${t.amount.toFixed(2)}</Amt><RltdPties><Cdtr><Pty><Nm>${t.counterparty}</Nm></Pty></Cdtr></RltdPties><RmtInf><Ustrd>${t.description}</Ustrd></RmtInf></TxDtls></NtryDtls><AddtlNtryInf>${t.description}</AddtlNtryInf></Ntry>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>Q3</MsgId><CreDtTm>2026-10-01T05:30:00</CreDtTm></GrpHdr>`
    + `<Stmt><Id>Q3</Id><CreDtTm>2026-10-01T05:30:00</CreDtTm><FrToDt><FrDtTm>2026-07-01T00:00:00</FrDtTm><ToDtTm>2026-09-30T23:59:59</ToDtTm></FrToDt><Acct><Id><IBAN>CH3880808000000000002</IBAN></Id><Ccy>CHF</Ccy></Acct>${txs.map(row).join('')}</Stmt></BkToCstmrStmt></Document>`;
}

/** A firm with staff, named as its payslips' letterhead, its statement of `txs` read in; `files` are its company's business files. */
export function firm(name: string, txs: BankTransaction[], files: Record<string, string> = {}): Workspace {
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

export async function drop(ws: Workspace, files: Array<[string, Buffer | Promise<Buffer>]>) {
  mkdirSync(ws.paths.inbox, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(ws.paths.inbox, name), await bytes);
}
/** The AI off; `asked` records every prompt a model would have been sent (none, it is off). */
export const run = (ws: Workspace, ask?: Ask) => runIntake({ ws, books: storePort(ws, moduleActor('intake')), ask, steps: PIPELINE, ...(process.env.LOG && { log: (l: string) => console.log(l) }) });
export const sum = (lines: JournalEntry[], account: string, side: 'accountDebit' | 'accountCredit' = 'accountDebit') => Math.round(lines.filter((e) => e[side] === account).reduce((s, e) => s + e.amount, 0) * 100) / 100;
export const linesOf = (ws: Workspace, ref: string) => loadBooks(ws).journalEntries.filter((e) => e.transactionRef === ref);
