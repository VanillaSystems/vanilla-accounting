/**
 * A bank or card statement among the receipts (issue #151), told from its own text and its file
 * name by code, with no bank named in the app: it names itself («Kontoauszug», «statement»,
 * words of the jurisdiction's documents.yaml) and shows an IBAN, a period or a balance line.
 * Its date is the period's last day. Which money account it belongs to is read from the
 * manifest's accounts (their IBAN, else the bank's own name with the currency), so Kontoauszüge
 * can show it at its account and month; one with no account to tell stays under Belege.
 */
import type { DocumentsData } from '../core/modules/schema.js';
import type { Receipt } from '../types/index.js';
import type { LedgerBankAccount } from '../workspace/workspace.js';
import { HEAD, IBAN, isBankStatement, wordsRe } from '../core/modules/words.js';

export interface StatementFacts {
  /** The first day of the period, when the text or the name gives it. */
  from?: string;
  /** The last day of the period: the statement's date. */
  to?: string;
  /** The account's IBAN as the text prints it, without spaces. */
  iban?: string;
  /** The account's currency, when the file name gives it. */
  currency?: string;
}

const DMY = String.raw`(\d{1,2})\.(\d{1,2})\.(20\d{2})`;
const ISO = String.raw`(20\d{2})-(\d{2})-(\d{2})`;
/** «01.02.2026 – 28.02.2026», «01.02.2026 bis 28.02.2026», «2026-02-01 to 2026-02-28»: a dash or a word between two days. */
const BETWEEN = String.raw`\s*(?:[-–—−]|bis|to|au|al|a)\s*`;
const PERIOD_DMY = new RegExp(`(?<!\\d)${DMY}${BETWEEN}${DMY}(?!\\d)`);
const PERIOD_ISO = new RegExp(`(?<!\\d)${ISO}${BETWEEN}${ISO}(?!\\d)`);
/** A day as a statement prints it: «31.03.2026», «2026-03-31», «31 March 2026», «31. März 2026». */
const DAY = String.raw`(?:\d{1,2}\.\d{1,2}\.20\d{2}|20\d{2}-\d{2}-\d{2}|\d{1,2}\.?[ \t]+\p{L}{3,}\.?[ \t]+20\d{2})`;
/** A currency account's balance heading, a line that starts with the currency's code and its day: «USD on 31 March 2026», «EUR per 31.03.2026». */
const BALANCE_AT = new RegExp(String.raw`^[ \t]*[A-Z]{3}[ \t]+(?:on|am|per|au|al)[ \t]+${DAY}`, 'mu');

const iso = (y: string, m: string | number, d: string | number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** A day the calendar has: «31.02.2026» is none. */
const validDay = (d: string) => { const [y, m, day] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, day)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === day; };

/** The first period two days delimit in `text`, the earlier day first. */
export function statementPeriod(text: string): { from: string; to: string } | undefined {
  const dmy = PERIOD_DMY.exec(text);
  const span = dmy
    ? { from: iso(dmy[3], dmy[2], dmy[1]), to: iso(dmy[6], dmy[5], dmy[4]) }
    : (() => { const m = PERIOD_ISO.exec(text); return m && { from: iso(m[1], m[2], m[3]), to: iso(m[4], m[5], m[6]) }; })();
  if (!span || !validDay(span.from) || !validDay(span.to)) return undefined;
  return span.from <= span.to ? span : { from: span.to, to: span.from };
}

/** The period (and the currency, when the name has it) a statement file's name gives: «Kontoauszug 01.01.2026 - 31.01.2026 - CH… - 2026-01-31.pdf», «statement_12345678_CHF_2026-01-01_2026-01-31.pdf». */
export function statementPdf(filename: string): { fromDate: string; toDate: string; currency?: string } | null {
  const r = filename.match(/(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/);
  const w = r ? null : filename.match(/statement_\d+_([A-Z]{3})_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.pdf/);
  const named = r ? { fromDate: `${r[3]}-${r[2]}-${r[1]}`, toDate: `${r[6]}-${r[5]}-${r[4]}` } : w ? { currency: w[1], fromDate: w[2], toDate: w[3] } : null;
  return named && validDay(named.fromDate) && validDay(named.toDate) ? named : null;
}

type Named = Pick<Receipt, 'extractedText' | 'filename' | 'originalFilename'>;

/**
 * The facts of a statement among the receipts, or undefined for a document that is none. A
 * statement names itself in its first lines before any receipt word and shows an IBAN or the
 * columns of its movements (isBankStatement: an invoice that mentions a statement stays an
 * invoice, a supplier's «Statement» with a period and balances is a receipt), and two signs of
 * an IBAN, a period and a balance line («Statement of work» with its phase's days is none). The period comes
 * from the text, else from the file's name (its original name too, before a run renamed it).
 */
export function statementFacts(r: Named, words: DocumentsData): StatementFacts | undefined {
  const text = r.extractedText ?? '';
  if (!isBankStatement(text, words)) return undefined;
  const iban = IBAN.exec(text)?.[0].replace(/\s/g, '');
  const balance = (words.balance.length > 0 && wordsRe(words.balance).test(text)) || BALANCE_AT.test(text);
  const inText = statementPeriod(text);
  const inName = statementPdf(r.filename) ?? (r.originalFilename ? statementPdf(r.originalFilename) : null);
  const period = inText ?? (inName ? { from: inName.fromDate, to: inName.toDate } : undefined);
  if (Number(!!iban) + Number(!!period) + Number(balance) < 2) return undefined;
  return { ...period, ...(iban ? { iban } : {}), ...(inName?.currency ? { currency: inName.currency } : {}) };
}

let documentWords: DocumentsData | undefined;
/** The open jurisdiction's document words, handed over with it (src/engines/index.ts setJurisdiction): the books read no engine. */
export function useDocumentWords(words: DocumentsData): void {
  documentWords = words;
}
export const documentWordsInUse = (): DocumentsData | undefined => documentWords;

/**
 * The receipts with each one nobody typed (no kind, and no person who cleared one) that reads as
 * a statement typed as one, dated on its period's last day unless it has a date of its own (a day
 * read off the phone's capture is none). Without the jurisdiction's words they stay as they are.
 * Pure: loadBooks runs it on every load, so a rule learnt later reaches receipts already read.
 */
export function typeStatements(receipts: readonly Receipt[], words = documentWords): Receipt[] {
  if (!words) return [...receipts];
  return receipts.map((r) => {
    const facts = r.kind || r.kindBy ? undefined : statementFacts(r, words);
    if (!facts) return r;
    const { dateSource, ...undated } = r;
    const dated = facts.to && (!r.date || dateSource === 'captured') ? { ...undated, date: facts.to } : r;
    return { ...dated, kind: 'statement', kindBy: 'rule', kindRule: 'document:statement' };
  });
}

type Account = Pick<LedgerBankAccount, 'bank' | 'currency' | 'account' | 'iban'>;

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The manifest's account a statement belongs to: the one whose IBAN the text prints; else the
 * one account whose bank is named in the statement's first lines and whose currency the file
 * name gives (or the bank's only account). The owner's `manual` account is no bank. Undefined
 * when none or several fit: the statement then stays under Belege.
 */
export function accountOfStatement(facts: StatementFacts, r: Pick<Receipt, 'extractedText'>, accounts: readonly Account[]): Account | undefined {
  const byIban = facts.iban && accounts.find((a) => a.iban && a.iban.replace(/\s/g, '').toUpperCase() === facts.iban!.toUpperCase());
  if (byIban) return byIban;
  const head = (r.extractedText ?? '').slice(0, HEAD);
  const named = accounts.filter((a) => a.bank !== 'manual' && new RegExp(`(?<![\\p{L}\\d])${escape(a.bank)}(?![\\p{L}])`, 'iu').test(head));
  const fit = facts.currency ? named.filter((a) => a.currency === facts.currency) : named;
  return fit.length === 1 ? fit[0] : undefined;
}
