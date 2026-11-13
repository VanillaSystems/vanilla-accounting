/**
 * The rule for the wages, offered where code knows everything (#383): on a firm that pays wages,
 * the open payments out the evidence rules recognise as wages by their text (evidence.guide.yaml
 * ev-exempt-wages, receipt-wait.ts `wages`) are one kind. Their rule needs no form: the words they
 * share, money out, the jurisdiction's wage account (setup.yaml `wages`) when the firm's chart has
 * it, and no VAT code (a wage is no supply). The task list offers it in one click; the card of the
 * drafted rule shows its payments, and nothing is kept before the person keeps it.
 */
import { loadBooks, periodLock } from '../books/store.js';
import { chartOf } from '../booking/classify.js';
import { chartNames } from '../booking/rule-book.js';
import { receiptKnowledge } from '../booking/receipt-wait.js';
import { wholeWords } from '../booking/rules.js';
import { existsSync, readFileSync } from 'node:fs';
import { chart, setup } from '../engines/index.js';
import { stableWords } from '../knowledge/gaps.js';
import { loadKnowledge } from '../knowledge/layers.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import type { HandRule } from './hand-rule.js';

/** GET /api/rules/wages: the rule for the open wages, and which payments they are. */
export interface WageOffer { rule: HandRule; refs: string[]; text: string; account: string }

/** At least this many open wages before a rule for them is offered: one is booked as quickly by hand. */
export const WAGES_FROM = 2;

/**
 * The type of an account in the firm's own chart (accounts.json), else in the jurisdiction's for a
 * number the books know: a firm whose 5000 is no expense account has no wage account there (as the
 * bank-charges account, #381).
 */
export function firmTypeOf(ws: Pick<Workspace, 'paths'>): (account: string) => string | undefined {
  if (existsSync(ws.paths.accounts)) {
    const types = new Map((JSON.parse(readFileSync(ws.paths.accounts, 'utf8')) as Array<{ number: string; type?: string }>).map((a) => [String(a.number), a.type]));
    // An account the firm's file lists without a type (an older chart) takes its number's type in the jurisdiction's chart.
    return (account) => (types.has(account) ? types.get(account) ?? chart().typeOf(account) : undefined);
  }
  const known = chartNames(chartOf(ws));
  return (account) => (known.has(account) ? chart().typeOf(account) : undefined);
}

export function wageOffer(ws: Workspace): WageOffer | undefined {
  const account = setup().wages?.account;
  if (!account || firmTypeOf(ws)(account) !== 'expense') return undefined;
  const { wages } = receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws);
  if (!wages.length) return undefined;
  const books = loadBooks(ws);
  const closed = periodLock(books).isClosed;
  const booked = new Set(books.journalEntries.map((e) => e.transactionRef));
  const open = books.transactions.filter((t) => t.direction === 'DBIT' && !closed(t.date) && !booked.has(t.ref) && wages.some((w) => w.test(t.description)));
  if (open.length < WAGES_FROM) return undefined;
  // The words that stay from one wage to the next («Lohn Juli 2026» → «Lohn»), each once.
  const words = [...new Set(open.map((t) => stableWords(t.description)).filter(Boolean))];
  if (!words.length) return undefined;
  const text = words.map(wholeWords).join('|');
  return { rule: { match: { kind: 'text', text }, direction: 'out', account, vat: null }, refs: open.map((t) => t.ref), text: words.join(' | '), account };
}
