/**
 * The checks of a workspace that npm run doctor prints and npm run year:close requires clean:
 * manifest, books.json and its seals, folders, chart, bank accounts and their statements. Apart
 * from doctor's tool and mailbox checks, so the app (year close) does not load the mail client.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBooks, sealsOf, type Books } from '../books/store.js';
import { bankKind, parseIban } from './banks.js';
import { readBankStatements, type StatementFile } from './bank-statements.js';
import type { Workspace } from './workspace.js';

export type Result =
  | { status: 'ok'; label: string }
  | { status: 'warn'; label: string; note: string }
  | { status: 'fail'; label: string; fix: string };

export const ok = (label: string): Result => ({ status: 'ok', label });
export const warn = (label: string, note: string): Result => ({ status: 'warn', label, note });
export const fail = (label: string, fix: string): Result => ({ status: 'fail', label, fix });

/** The checks of the workspace itself; `npm run year:close` requires them clean. */
export function workspaceChecks(ws: Workspace): Result[] {
  const results: Result[] = [ok(`Workspace ${ws.paths.root} (${ws.company.name})`)];
  const { profile } = ws;
  results.push(profile
    ? ok(`Profile: ${profile.preset}, sells ${profile.sells}, ${ws.company.legalForm ?? 'legal form not set'}`)
    : warn('No profile in belege.workspace.yaml', 'set up before npm run init; nothing is missing for booking'));

  try {
    const books = loadBooks(ws);
    results.push(ok(`books.json reads (schema ${books.schema})`), ...sealChecks(books));
  } catch (e) {
    results.push(fail(`books.json: ${(e as Error).message.split('\n')[0]}`, 'Restore books.json from git (git checkout books.json), or create it with npm run init in a new folder.'));
  }

  for (const [label, dir] of [['receipts/', ws.paths.receipts], ['bank-statements/', ws.paths.statements], ['filings/', ws.paths.filings]] as const) {
    results.push(existsSync(dir) ? ok(`${label} exists`) : fail(`${label} missing`, `mkdir ${dir}`));
  }
  // Not in git (.gitignore), so a fresh clone of the books lacks it; an upload creates it.
  results.push(existsSync(ws.paths.inbox) ? ok('beleg-import/ exists') : warn('beleg-import/ missing', `mkdir ${ws.paths.inbox} to drop receipts there`));

  let accounts: { number: string; name: string }[] = [];
  try {
    accounts = JSON.parse(readFileSync(ws.paths.accounts, 'utf8'));
    results.push(ok(`accounts.json: ${accounts.length} accounts`));
  } catch (e) {
    results.push(fail(`accounts.json does not read (${(e as Error).message.split('\n')[0]})`, 'Restore it from git, or copy the chart from a new workspace made by npm run init.'));
  }
  const numbers = new Set(accounts.map((a) => a.number));
  const statements = readBankStatements(ws);
  for (const b of ws.bankAccounts) {
    const label = `${b.bank} ${b.currency} books on ${b.account}`;
    if (!numbers.has(b.account)) { results.push(fail(`${label}, which is not in accounts.json`, `Add { "number": "${b.account}", "name": "${b.label}" } to accounts.json, or fix the account in belege.workspace.yaml.`)); continue; }
    if (b.statements && !b.iban && !existsSync(resolve(ws.paths.statements, b.bank))) { results.push(fail(`${label}: bank-statements/${b.bank}/ missing`, `mkdir "${resolve(ws.paths.statements, b.bank)}" and put its camt.053 files there.`)); continue; }
    const mine = statements.filter((f): f is Extract<StatementFile, { status: 'read' }> => f.status === 'read' && f.account === b);
    const iban = mine.map((f) => f.statement.iban && parseIban(f.statement.iban)).find((i) => i);
    if (b.statements && !b.iban && iban) {
      results.push(warn(`${label}: ${mine.length} statement(s) read from bank-statements/${b.bank}/, for IBAN ${iban}`, `add iban: ${iban} to ${b.bank} ${b.currency} in belege.workspace.yaml, so its statements land here wherever the file is`));
      continue;
    }
    const note = bankKind(b.bank).note;
    const read = b.statements ? `, ${mine.length} statement(s) read` : '';
    results.push(note ? warn(label + read, note) : ok(label + read));
  }
  for (const f of statements) {
    if (f.status === 'unmatched') results.push(fail(`bank-statements/${f.file} belongs to no bank account`, f.problem));
    if (f.status === 'skipped') results.push(warn(`bank-statements/${f.file} is not read`, f.reason));
    if (f.status === 'duplicate') results.push(warn(`bank-statements/${f.file} is not read`, `statement ${f.statement.id} is the same as in ${f.of}; delete one of the two`));
  }

  if (profile) {
    const manual = ws.bankAccounts.some((b) => b.bank === 'manual');
    if (profile.ownerPaysPrivately === 'yes' && !manual) {
      results.push(fail('The owner pays business costs privately, but no bank account is `manual`', 'Add { bank: manual, currency: CHF, account: "2451", label: Kontokorrent <owner> } to bankAccounts (2850 Privat for an Einzelfirma).'));
    }
    if (profile.payouts === 'yes' && !numbers.has('1093')) {
      results.push(fail('Payouts from a webshop or payment provider need the clearing account 1093', 'Add { "number": "1093", "name": "Guthaben Zahlungsanbieter" } to accounts.json.'));
    }
  }

  const charts = existsSync(ws.paths.history) ? readdirSync(ws.paths.history).filter((f) => f.endsWith('.Konten.txt')).sort() : [];
  results.push(ok(charts.length
    ? `Booking reads the prior-year export ${charts.at(-1)} in history/`
    : 'Booking reads accounts.json and the casebook (no prior-year export in history/)'));
  return results;
}

/** The seals of the filed quarters (src/books/seal.ts): broken is a problem, missing a note. */
function sealChecks(books: Books): Result[] {
  const { checks, unsealed } = sealsOf(books);
  const intact = checks.filter((c) => c.status === 'intact').map((c) => c.quarter);
  return [
    ...checks.flatMap((c) => c.status === 'broken'
      ? [fail(`Seal ${c.quarter} broken: ${c.problem}`, 'The books open read-only. Restore books.json from git (git log -p books.json; npm run check-closed shows what changed); a seal is never rewritten.')]
      : []),
    ...(intact.length ? [ok(`Seals hold: ${intact.join(', ')}`)] : []),
    ...(unsealed.length ? [warn(`Filed quarters without a seal: ${unsealed.join(', ')}`, `npm run seal -- ${unsealed[0]} (one run per quarter), then commit filings/`)] : []),
  ];
}
