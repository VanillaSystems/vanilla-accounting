/**
 * The actions of the workflow vat-filing (workflows/vat-filing): the return of an open period
 * from the books, its XML for the tax authority's import, and, once a person filed it, the close
 * and the seal of the period. They do what `npm run vat-xml` and `npm run seal -- <q> --close`
 * do, in that order, with a person's review and filing between them. A period is prepared only
 * once it has ended (r6f-33); the year's last period is archived but sealed by the year close,
 * after the year-end entries of 31.12. Every refusal is a code the screens have words for
 * (src/types/refusal.ts).
 *
 * The figures a person approves are the figures that are filed (r7h-24): the XML step writes the
 * XML from the books of that moment only when they still give the reviewed figures, else the
 * review comes again with today's; from the XML on, the period is held (`config.approvedReturn`,
 * src/books/store.ts periodLock) until «Eingereicht» closes it or «Zurück» frees it; and the seal
 * step refuses to seal books whose figures differ from the filed XML.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { addDays, derivePeriod, isFilingKey, localToday } from '../accounting/periods.js';
import { loadBooks, saveBooks, type Books } from '../books/store.js';
import { closesTheYear, periodKeyOf, writeSeal } from '../books/seal.js';
import { filing, filingMethod, ratesWithoutActivityId, vat } from '../engines/index.js';
import { closeGoneSaleQuestions } from '../intake/sale-questions.js';
import { ech0217Xml } from '../providers/ech0217/xml.js';
import type { QuarterKey } from '../types/index.js';
import { refuse } from '../types/refusal.js';
import { yearPaths, type Workspace } from '../workspace/workspace.js';
import type { Action } from './actions.js';
import type { Run } from './model.js';

/**
 * What the compute step hands on: the period, its figures by box and what is to pay (negative: a
 * credit). `reviewedBefore`: the books changed after a review, so these are today's figures and
 * that is what the earlier review showed.
 */
export interface PeriodReturn { period: string; from: string; to: string; figures: Record<string, number>; payable: number; reviewedBefore?: { payable: number } }

const periodOf = (input: Record<string, unknown>): QuarterKey => {
  const key = String(input.period ?? (input.return as PeriodReturn | undefined)?.period ?? '');
  if (!isFilingKey(key, filing().length)) throw refuse('notFilingKey', { period: key }, `"${key}" is no filing period`);
  return key as QuarterKey;
};

/** Where the filed XML is kept, beside the period's seal. */
export const filedXml = (ws: Workspace, key: string): string => join(yearPaths(ws.paths, key.slice(0, 4)).filings, `mwst-ech0217-${key}.xml`);
/** Where the prepared XML waits until the person filed it. */
const preparedXml = (ws: Workspace, key: string): string => join(ws.paths.data, 'filing', `mwst-ech0217-${key}.xml`);

/** What the XML step hands on: where the file is, for the person to upload it. */
export interface PreparedXml { path: string; period: string; warnings: string[] }

/** What the seal step hands on: the seal's file, or that the year close seals this period. */
export type SealOutput = { file: string } | { yearClose: true };

/** A period's XML as it is now: the filed one once the period is sealed, else the prepared one; undefined before either. */
export function filingXml(ws: Workspace, key: string): string | undefined {
  return [filedXml(ws, key), preparedXml(ws, key)].find((p) => existsSync(p));
}

const returnOf = (books: Books, key: QuarterKey): PeriodReturn => {
  const { from, to } = derivePeriod(key)!;
  const { ziffern, payable } = vat().figures(books.journalEntries, key, books.config.vatAdjustments ?? []);
  return { period: key, from, to, figures: ziffern as Record<string, number>, payable };
};

const sameFigures = (a: PeriodReturn, b: PeriodReturn): boolean => {
  const boxes = new Set([...Object.keys(a.figures), ...Object.keys(b.figures)]);
  return a.payable === b.payable && [...boxes].every((z) => (a.figures[z] ?? 0) === (b.figures[z] ?? 0));
};

/**
 * The hold of `key` set or lifted. The hold and closedThrough are the lines the write door never
 * moves (src/books/store.ts update), so the filing writes them as `npm run seal -- <q> --close`
 * does: outside it, after the person decided.
 */
function hold(ws: Workspace, books: Books, key: QuarterKey, on: boolean): void {
  const held = books.config.approvedReturn;
  if (on ? held?.period === key : !held || held.period !== key) return;
  if (on) books.config.approvedReturn = { period: key, through: derivePeriod(key)!.to };
  else delete books.config.approvedReturn;
  saveBooks(ws, books);
}

/**
 * A filing run that came to rest without filing (discarded, by a person or when its workflow went)
 * frees the period it held; the engine's `onRest` calls it (src/server/routes/automation.ts).
 */
export function releaseApproval(ws: Workspace, run: Pick<Run, 'workflow' | 'item' | 'state'>): void {
  if (run.workflow !== 'vat-filing' || run.state.status !== 'discarded') return;
  const key = run.item.id;
  if (!isFilingKey(key, filing().length)) return;
  const books = loadBooks(ws);
  if (books.config.approvedReturn?.period === key) { rmSync(preparedXml(ws, key), { force: true }); hold(ws, books, key as QuarterKey, false); }
}

export const FILING_ACTIONS: Record<string, Action> = {
  'accounting.tax.vat-return': {
    outcomes: ['ok'],
    effects: [],
    run(input, _fx, { ws, now, run }) {
      const key = periodOf(input);
      const books = loadBooks(ws);
      const to = derivePeriod(key)!.to;
      const closed = books.config.closedThrough ?? '';
      if (closed && to <= closed) throw refuse('periodFiled', { period: key, through: closed }, `${key} is filed already (closed through ${closed}); a correction is declared on its own form`);
      const today = localToday(new Date(now()));
      if (to >= today) throw refuse('periodRunning', { period: key, ends: to, from: addDays(to, 1) }, `${key} runs until ${to}: it can be filed from ${addDays(to, 1)}`);
      // «Zurück» from the filing task, or a review the books outgrew: the approval is taken back and the period is free again.
      if (run?.mode === 'live') { rmSync(preparedXml(ws, key), { force: true }); hold(ws, books, key, false); }
      const ret = returnOf(books, key);
      const earlier = input.return as PeriodReturn | undefined;
      if (earlier && !sameFigures(earlier, ret)) ret.reviewedBefore = { payable: earlier.payable };
      return { outcome: 'ok', output: { return: ret } };
    },
  },
  'providers.ech-0217': {
    outcomes: ['ok', 'changed'],
    effects: [],
    run(input, _fx, { ws, run }) {
      const ret = input.return as PeriodReturn;
      const key = periodOf(input);
      const books = loadBooks(ws);
      // The books changed since the review: no XML of stale figures; the person reviews today's.
      if (!sameFigures(ret, returnOf(books, key))) return { outcome: 'changed' };
      const missing = ratesWithoutActivityId(ret.figures);
      if (missing.length) throw refuse('activityIdMissing', { rates: missing.join(', ') }, `the tax authority's activity code of the net tax rate ${missing.join(', ')} is missing (the company's VAT section), so the XML cannot name it`);
      const { xml, warnings } = ech0217Xml({
        uid: ws.company.uid, organisationName: ws.company.name, period: { key: ret.period, from: ret.from, to: ret.to },
        ziffern: ret.figures as Parameters<typeof ech0217Xml>[0]['ziffern'], payable: ret.payable, form: vat().form, rateRows: vat().rateRows, method: filingMethod(),
        generationTime: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
      });
      const path = preparedXml(ws, ret.period);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, xml);
      // From here the person uploads this file: the period is held until it is filed or the approval taken back.
      if (run?.mode === 'live') hold(ws, books, key, true);
      const prepared: PreparedXml = { path, period: ret.period, warnings };
      return { outcome: 'ok', output: { xml: prepared } };
    },
  },
  'books.seal': {
    outcomes: ['ok'],
    effects: ['files.filings', 'books.seal'],
    run(input, _fx, { ws }) {
      const key = periodOf(input);
      const books = loadBooks(ws);
      const end = derivePeriod(key)!.to;
      const closed = books.config.closedThrough;
      const lastOfYear = closesTheYear(key);
      // The books sealed are the books filed: a change that got past the hold stops here, with the figures.
      const filedReturn = input.return as PeriodReturn;
      const today = returnOf(books, key);
      if (!sameFigures(filedReturn, today)) {
        throw refuse('figuresChanged', { period: key, filed: filedReturn.payable.toFixed(2), now: today.payable.toFixed(2) }, `${key}: the books (payable ${today.payable.toFixed(2)}) differ from the return filed (payable ${filedReturn.payable.toFixed(2)}); nothing closed or sealed until they are restored`);
      }
      if (!closed || closed < end) {
        const next = closed ? periodKeyOf(addDays(closed, 1), ws.filingLength) : key;
        if (next !== key) throw refuse('nextToClose', { through: closed ?? '', next, period: key }, `the books are closed through ${closed}; the next ${ws.filingLength === 'half' ? 'half year' : 'quarter'} to close is ${next}, not ${key}`);
        // Closing moves closedThrough, which the write door never allows: as `npm run seal -- <q> --close` does, after the person filed.
        // The year's last period is left open: the year close books the year-end entries on 31.12., then closes and seals it.
        if (!lastOfYear) books.config.closedThrough = end;
      }
      // Filed: the hold gave way to the close (or, for the year's last period, to the year close).
      if (books.config.approvedReturn?.period === key) delete books.config.approvedReturn;
      saveBooks(ws, books);
      // The app's open VAT questions about the period's payments are closed with the reason, not merely hidden (r7h-29).
      closeGoneSaleQuestions(ws, books);
      const prepared = preparedXml(ws, key);
      const filed = filedXml(ws, key);
      if (existsSync(prepared) && !existsSync(filed)) { mkdirSync(dirname(filed), { recursive: true }); copyFileSync(prepared, filed); }
      if (lastOfYear) return { outcome: 'ok', output: { seal: { yearClose: true } satisfies SealOutput } };
      const seal = writeSeal(ws, books, key, new Date().toISOString().slice(0, 10));
      return { outcome: 'ok', output: { seal: { file: seal.file } satisfies SealOutput } };
    },
  },
};
