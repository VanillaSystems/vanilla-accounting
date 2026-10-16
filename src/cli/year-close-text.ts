/** The English words of `npm run year:close` and `npm run year:open` for what src/accounting/year-close.ts reports. */
import type { DifferenceCause, Opening, Problem } from '../accounting/year-close.js';

export const chf = (n: number): string => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const PROBLEM_TEXT: { [C in Problem['code']]: (p: Extract<Problem, { code: C }>) => string } = {
  q4NotFiled: (p) => `the ${p.quarter} VAT return is not filed: copy the filed XML to filings/${p.quarter.slice(0, 4)}/ (docs/quarter-workflow.md step 10)`,
  notClosed: (p) => `${p.quarter} is not closed: npm run seal -- ${p.quarter} --close once its return is filed`,
  unsealed: (p) => `${p.quarter} is closed but has no seal: npm run seal -- ${p.quarter}`,
  sealBroken: (p) => `the seal of ${p.quarter} is broken (${p.problem}): restore books.json from git`,
  noYearEndBalance: (p) => `${p.account} ${p.label}: no bank balance on 31.12.: import the December statement (camt.053), or npm run extract-balances for the PDF`,
  balanceDiffers: (p) => `${p.account} ${p.label}: books ${p.currency} ${chf(p.book)}, bank ${p.currency} ${chf(p.bank)} on ${p.date} (difference ${chf(p.book - p.bank)}): find the missing or double entry (Kontenabgleich tab)`,
  statementGap: (p) => `${p.account} ${p.label}: no statement covers ${p.from} to ${p.to}: import it`,
  unbooked: (p) => `${p.count} transaction(s) of the year have no entry (${p.refs.join(', ')}${p.count > p.refs.length ? ', …' : ''}): npm run classify`,
  doctor: (p) => `npm run doctor: ${p.label}`,
  noRate: (p) => `the ESTV rate of 31.12. for ${p.currency} is not published yet: npm run fetch-rates once it is`,
  fxToBook: (p) => `${p.account}: a Kursdifferenz of CHF ${chf(p.difference)} is not booked yet (npm run year:close books it)`,
  yearLocked: () => 'the books are closed through 31.12. already, so the Kursdifferenz can no longer be dated 31.12.',
  undecided: (p) => `guided year-end entries not yet booked or marked not needed: ${p.templates.join(', ')} (--done or --na)`,
  unbalanced: (p) => `Aktiven and Passiven differ by CHF ${chf(p.residual)}: see the causes; never book the difference away`,
  notInChart: (p) => `account ${p.account} is not in accounts.json, so the Bilanz leaves out its CHF ${chf(p.amount)}: add the account or move the entry`,
  outsideStatements: (p) => `account ${p.account} is on neither statement (class 1 to 8), CHF ${chf(p.amount)}: move the entry`,
  paymentsUnlinked: (p) => `payments name open invoices without being linked to them (${p.payments.map((x) => `${x.transactionRef} → ${x.number}`).join(', ')}): link them first (Rechnungen), or the Debitoren count their revenue twice`,
  cashNegative: (p) => `cash account ${p.account} is below zero on ${p.date} (CHF ${chf(p.balance)}, entry ${p.entry}): cash cannot fall under nothing; a booking has its sides swapped or a receipt of cash is missing`,
  swappedSale: (p) => `entry ${p.entry} of ${p.date} books ${p.accountDebit} / ${p.accountCredit}: revenue in the debit against cash or bank is a swapped sale, unless it is a refund to the customer (minus code)`,
};

export const problemText = (p: Problem): string => (PROBLEM_TEXT[p.code] as (p: Problem) => string)(p);

type Cause = DifferenceCause | Opening['causes'][number];

const CAUSE_TEXT: { [C in Cause['code']]: (c: Extract<Cause, { code: C }>) => string } = {
  openingUnbalanced: (c) => `the year's own opening balances differ by CHF ${chf(c.amount)}`,
  oneLeg: (c) => `entries with one account only, CHF ${chf(c.amount)}: ${c.entryIds.join(', ')}`,
  outsideStatements: (c) => `account ${c.account} is on neither statement (class 1 to 8): CHF ${chf(c.amount)}`,
  notInChart: (c) => `account ${c.account} is not in accounts.json: CHF ${chf(c.amount)}`,
  notRevalued: (c) => `${c.account} opens at CHF ${chf(c.actual)}, but its ${c.currency} balance × the 31.12. rate is CHF ${chf(c.expected)}: book the Kursdifferenz first`,
};

export const causeText = (c: Cause): string => (CAUSE_TEXT[c.code] as (c: Cause) => string)(c);
