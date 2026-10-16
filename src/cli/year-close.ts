/**
 * npm run year:close -- <YYYY> [--dry-run] [--done a,b] [--na c,d] [--rates-dir <dir>]
 *
 * The year-end close (docs/year-end.md). Prints the checklist, every item computed from the
 * books: the preconditions, the Kursdifferenz per foreign-currency account, the VAT closing
 * check, the guided year-end entries and the closing balance sheet. Then:
 *
 *   - books the Kursdifferenz on 31.12. (rerunning replaces it, never adds a second one),
 *   - closes the year when nothing blocks: config.closedThrough → 31.12., the fourth quarter
 *     sealed, the close recorded in filings/<year>/year-close.json, the workspace committed.
 *
 *   --dry-run      writes nothing: shows what is open and what would be booked
 *   --done a,b     marks guided entries as booked (ids as the checklist lists them)
 *   --na c,d       marks guided entries as not needed this year
 *   --rates-dir    reads the ESTV rates from another folder (a rehearsal's stand-in 31.12. rate)
 */
import { parseArgs } from 'node:util';
import type { Revaluation, YearClose } from '../accounting/year-close.js';
import { causeText, chf, problemText } from './year-close-text.js';
import { bookRevaluation, closeYear, markTemplate, ratesOf, YearCloseRefused, yearCloseOf } from '../books/year-close.js';
import { openWorkspace } from '../workspace/workspace.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'dry-run': { type: 'boolean' }, done: { type: 'string' }, na: { type: 'string' }, 'rates-dir': { type: 'string' } },
});
const year = positionals[0] ?? '';
if (!/^\d{4}$/.test(year)) {
  console.error('Usage: npm run year:close -- <YYYY> [--dry-run] [--done a,b] [--na c,d]   e.g. npm run year:close -- 2026 --dry-run');
  process.exit(2);
}
const dryRun = values['dry-run'] === true;
const ws = openWorkspace();
const rates = ratesOf(values['rates-dir']);

const list = (s: string | undefined) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
const say = problemText;

const CHECK_TITLE: Record<YearClose['checks'][number]['id'], string> = {
  q4Filed: 'The fourth quarter is filed',
  quartersSealed: 'Q1 to Q3 are closed and sealed',
  bankReconciled: 'Every bank account matches its statement on 31.12.',
  statementsComplete: 'Statements cover the whole year',
  allBooked: 'Every transaction of the year is booked',
  doctor: 'npm run doctor finds nothing to fix',
  bookingsPlausible: 'No cash account below zero, no sale with its sides swapped',
};

const mark = (s: 'ok' | 'fail' | 'warn') => (s === 'ok' ? '✓' : s === 'warn' ? '!' : '✗');

function revaluationLine(r: Revaluation): string {
  const head = `  ${r.account} ${r.label.padEnd(18)} ${r.currency} ${chf(r.native).padStart(12)}`;
  if (r.status === 'no-rate') return `✗${head}  no ESTV rate of 31.12. yet`;
  const diff = `${r.difference >= 0 ? 'gain' : 'loss'} CHF ${chf(Math.abs(r.difference))}`;
  return `${r.status === 'booked' ? '✓' : '•'}${head} × ${r.rate.rate} = CHF ${chf(r.targetChf).padStart(12)}  book CHF ${chf(r.bookChf).padStart(12)}  ${diff}${r.status === 'booked' ? ' (booked)' : ''}`;
}

function print(c: YearClose): void {
  console.log(`\nYear-end close ${c.year}  (closed through ${c.closedThrough ?? 'not set'}${c.closed ? `, closed on ${c.state.closedAt}` : ''})\n`);
  console.log('Preconditions');
  for (const check of c.checks) {
    console.log(`  ${mark(check.status)} ${CHECK_TITLE[check.id]}`);
    for (const p of check.problems) console.log(`      ${say(p)}`);
  }

  console.log(`\nKursdifferenz on 31.12. (to ${c.accounts.fxDifference})`);
  if (!c.revaluations.length) console.log('  no foreign-currency account');
  for (const r of c.revaluations) console.log(revaluationLine(r));

  const v = c.vat;
  console.log(`\nVAT closing check (VAT accounts ${c.accounts.vatAccounts.join(', ')})`);
  for (const q of v.quarters) {
    const filed = q.filed === undefined ? 'not filed' : `filed ${chf(q.filed)}`;
    const corr = q.filed !== undefined && q.correction !== 0 ? `, Korrekturabrechnung ${chf(q.correction)}` : '';
    console.log(`  ${q.quarter}: books ${chf(q.books).padStart(10)}, ${filed}${corr}`);
  }
  console.log(`  owed on 1.1. ${chf(v.opening)} + tax of the year ${chf(v.booked)} − paid ${chf(v.paid)} = owed on 31.12. ${chf(v.owed)}`);
  console.log(`  expected: the fourth quarter and quarters not filed yet ${chf(v.expected)}; rounding per entry ${chf(v.rounding)}`);
  console.log(`  ${v.unexplained === 0 ? '✓ explained' : `! unexplained CHF ${chf(v.unexplained)}: a payment to the ESTV missing or booked twice, or a Korrekturabrechnung (0535) not paid in the year`}`);

  console.log('\nGuided year-end entries (book in the Jahresabschluss view, or mark with --done / --na)');
  for (const t of c.templates) {
    const state = t.state === 'done' ? '✓ booked' : t.state === 'na' ? '– not needed' : '• open';
    console.log(`  ${state.padEnd(14)} ${t.id.padEnd(18)} ${t.accountDebit || '????'} / ${t.accountCredit || '????'}${t.vatCode ? ` ${t.vatCode}` : ''}`);
  }

  const l = c.ledger;
  console.log('\nClosing balance sheet on 31.12. (VAT split off as Banana books it)');
  console.log(`  Aktiven ${chf(l.totalAssets)}  Passiven ${chf(l.totalLiabilities)}  result ${l.result >= 0 ? 'profit' : 'loss'} ${chf(Math.abs(l.result))}`);
  console.log(`  ${l.residual === 0 ? '✓ Aktiven = Passiven + result' : `✗ difference ${chf(l.residual)}`}`);
  for (const cause of l.causes) console.log(`    cause: ${causeText(cause)}`);
}

async function main(): Promise<number> {
  if (!dryRun) {
    for (const id of list(values.done)) markTemplate(ws, year, id, 'done');
    for (const id of list(values.na)) markTemplate(ws, year, id, 'na');
  } else if (values.done || values.na) console.log('--dry-run: --done and --na are not recorded.');

  let close = yearCloseOf(ws, year, rates);
  const toBook = close.revaluations.some((r) => r.status === 'to-book');
  const noRate = close.revaluations.some((r) => r.status === 'no-rate');
  if (!dryRun && toBook && !noRate && !close.closed) {
    const booked = bookRevaluation(ws, year, rates);
    console.log(`Booked the Kursdifferenz: ${booked.map((e) => `${e.id} CHF ${chf(e.amount)}`).join(', ') || 'none needed'}`);
    close = yearCloseOf(ws, year, rates);
  }
  print(close);

  if (close.closed) {
    console.log(`\n${year} is closed. Open ${+year + 1}: npm run year:open -- ${+year + 1}`);
    return 0;
  }
  if (close.blockers.length) {
    console.log(`\n${year} cannot close yet. To do:`);
    for (const p of close.blockers) console.log(`  ✗ ${say(p)}`);
    return dryRun ? 0 : 1;
  }
  if (dryRun) {
    console.log(`\nNothing blocks: npm run year:close -- ${year} closes ${year}.`);
    return 0;
  }
  const result = await closeYear(ws, year, rates);
  console.log(`\nClosed ${year}: config.closedThrough → ${result.closedThrough}, sealed ${result.seal}.`);
  console.log(result.committed ? 'Committed the workspace.' : 'Commit the workspace now (books.json and filings/), so the close is on record.');
  console.log(`Open ${+year + 1}: npm run year:open -- ${+year + 1}`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (!(e instanceof YearCloseRefused)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
