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
 * src/books/store.ts periodLock) until «Eingereicht» closes it or «Zurück» frees it; the XML step
 * waits while the owner's VAT questions about the period are open (r8h-24); and the seal step
 * refuses to seal books whose figures differ from the filed XML, lifting the hold so they can be
 * restored (r8h-26).
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { addDays, derivePeriod, isFilingKey, localToday } from '../accounting/periods.js';
import { closeThrough, loadBooks, periodLock, saveBooks, type Books } from '../books/store.js';
import { reconcilePendingThrough } from '../books/reconcile.js';
import { closesTheYear, periodKeyOf, writeSeal } from '../books/seal.js';
import { filing, filingBasis, filingMethod, ratesWithoutActivityId, vat } from '../engines/index.js';
import { closeGoneSaleQuestions } from '../intake/sale-questions.js';
import { eventsMissing } from '../invoices/events.js';
import { loadInvoices } from '../invoices/store.js';
import { openSaleQuestionsIn } from '../questions/model.js';
import { readQuestions } from '../questions/store.js';
import { ech0217Xml } from '../providers/ech0217/xml.js';
import type { QuarterKey } from '../types/index.js';
import { refuse } from '../types/refusal.js';
import { yearPaths, type Workspace } from '../workspace/workspace.js';
import { clearingCheck, type ClearingCheck } from '../booking/providers.js';
import { clearingBeforeIn, providersOf } from '../intake/sales-report-import.js';
import { providerIssuesIn } from '../intake/pair-chain.js';
import type { Action } from './actions.js';
import type { Run } from './model.js';

/**
 * What the compute step hands on: the period, its figures by box and what is to pay (negative: a
 * credit). `reviewedBefore`: the books changed after a review, so these are today's figures and
 * that is what the earlier review showed.
 */
export interface PeriodReturn { period: string; from: string; to: string; figures: Record<string, number>; payable: number; reviewedBefore?: { payable: number }; clearing?: ClearingCheck[] }

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

/** The boxes (and the payable) on which two returns differ; empty when they are the same return. */
const differingBoxes = (a: PeriodReturn, b: PeriodReturn): string[] => {
  const boxes = new Set([...Object.keys(a.figures), ...Object.keys(b.figures)]);
  return [...[...boxes].filter((z) => (a.figures[z] ?? 0) !== (b.figures[z] ?? 0)).sort(), ...(a.payable === b.payable ? [] : ['payable'])];
};
const sameFigures = (a: PeriodReturn, b: PeriodReturn): boolean => differingBoxes(a, b).length === 0;

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
 * The hold of a period filed with the tax authority whose books differ from the return (r10h-4): it stays,
 * with the figures as filed, so the write door takes only changes that bring the books back
 * (src/books/store.ts update) until «Weiter» seals.
 */
function holdFiled(ws: Workspace, books: Books, key: QuarterKey, filed: PeriodReturn): void {
  books.config.approvedReturn = { period: key, through: derivePeriod(key)!.to, filed: { figures: filed.figures, payable: filed.payable } };
  saveBooks(ws, books);
}

/**
 * The run of a period filed with the tax authority whose books drifted (the hold has `filed`) is not
 * discarded: the hold is lifted only by sealing (golden rule 1). The engine's `keeps` asks it.
 */
export function holdsFiledPeriod(ws: Workspace, run: Pick<Run, 'workflow' | 'item'>): boolean {
  if (run.workflow !== 'vat-filing') return false;
  const held = loadBooks(ws).config.approvedReturn;
  return !!held?.filed && held.period === run.item.id;
}

/**
 * A filing run that came to rest without filing (discarded, by a person or when its workflow went)
 * frees the period it held, unless that period is filed and drifted; the engine's `onRest` calls it (src/server/routes/automation.ts).
 */
export function releaseApproval(ws: Workspace, run: Pick<Run, 'workflow' | 'item' | 'state'>): void {
  if (run.workflow !== 'vat-filing' || run.state.status !== 'discarded') return;
  const key = run.item.id;
  if (!isFilingKey(key, filing().length)) return;
  const books = loadBooks(ws);
  if (books.config.approvedReturn?.period === key && !books.config.approvedReturn.filed) { rmSync(preparedXml(ws, key), { force: true }); hold(ws, books, key as QuarterKey, false); }
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
      // A period filed with the tax authority whose books still differ from the return is not prepared again: the books are restored and «Weiter» seals (r10h-4).
      if (books.config.approvedReturn?.period === key && books.config.approvedReturn.filed) throw refuse('filedNotSealed', { period: key }, `${key} is filed with the tax authority and not sealed: restore the books, then «Weiter» on the filing run`);
      // «Zurück» from the filing task, or a review the books outgrew: the approval is taken back and the period is free again.
      if (run?.mode === 'live') { rmSync(preparedXml(ws, key), { force: true }); hold(ws, books, key, false); }
      const ret = returnOf(books, key);
      // Each payment provider's clearing account at the period's end, its month ends before, and what the provider held unpaid then (#203): a fact beside the figures.
      // What a provider held on its cut-over day and paid out in its first payouts, and its orders the report holds (#405): the two causes the account can know.
      const held = providerIssuesIn(ws, books).held;
      const clearing = providersOf(ws).flatMap((p) => {
        const c = clearingCheck(p, books, ret.to);
        if (!c) return [];
        const before = clearingBeforeIn(ws, books, p);
        const missing = held.filter((h) => h.provider === p.id && h.date <= ret.to).reduce((s, h) => s + Math.round((h.gross ?? 0) * 100), 0) / 100;
        return [{ ...c, ...(before ? { before } : {}), ...(missing ? { held: missing } : {}) }];
      });
      if (clearing.length) ret.clearing = clearing;
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
      // The owner's open VAT questions about the period's payments are hers to answer first: no return is filed over them (r8h-24).
      const open = openSaleQuestionsIn(readQuestions(ws), books, ret.from, ret.to);
      if (open.length) throw refuse('questionsOpen', { period: key, n: String(open.length) }, `${key}: ${open.length} VAT question(s) about its payments are open; answer them before the return is written`);
      // An account's reconciliation of movements read from PDFs with its bank's file waits on these days (#254): its answer may change the figures.
      const reconcile = reconcilePendingThrough(books, ret.to);
      if (reconcile) throw reconcile;
      // On the agreed basis an invoice whose event is not booked (no rate of its day yet) would be missing from the return.
      const unbooked = eventsMissing(books, loadInvoices(ws), ret.to);
      if (unbooked.length) throw refuse('invoiceEventsMissing', { period: key, invoices: unbooked.join(', ') }, `${key}: the VAT of invoice(s) ${unbooked.join(', ')} is not booked yet (no official rate of its day); the return would leave it out`);
      const missing = ratesWithoutActivityId(ret.figures);
      if (missing.length) throw refuse('activityIdMissing', { rates: missing.join(', ') }, `the tax authority's activity code of the net tax rate ${missing.join(', ')} is missing (the company's VAT section), so the XML cannot name it`);
      const { xml, warnings } = ech0217Xml({
        uid: ws.company.uid, organisationName: ws.company.name, period: { key: ret.period, from: ret.from, to: ret.to },
        ziffern: ret.figures as Parameters<typeof ech0217Xml>[0]['ziffern'], payable: ret.payable, form: vat().form, rateRows: vat().rateRows, method: filingMethod(), basis: filingBasis(),
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
      const boxes = differingBoxes(filedReturn, today);
      if (boxes.length) {
        // The hold stays, in its filed mode: the person restores the bookings in the app (only changes that bring them back pass), then «Weiter» (r8h-26, r10h-4).
        holdFiled(ws, books, key, filedReturn);
        throw refuse('figuresChanged', { period: key, filed: filedReturn.payable.toFixed(2), now: today.payable.toFixed(2), boxes: boxes.filter((z) => z !== 'payable').join(', ') }, `${key}: the books (payable ${today.payable.toFixed(2)}, boxes ${boxes.join(', ')}) differ from the return filed (payable ${filedReturn.payable.toFixed(2)}); nothing closed or sealed until they are restored`);
      }
      if (!closed || closed < end) {
        const next = closed ? periodKeyOf(addDays(closed, 1), ws.filingLength) : key;
        if (next !== key) throw refuse('nextToClose', { through: closed ?? '', next, period: key }, `the books are closed through ${closed}; the next ${ws.filingLength === 'half' ? 'half year' : 'quarter'} to close is ${next}, not ${key}`);
        // Closing moves closedThrough, which the write door never allows: as `npm run seal -- <q> --close` does, after the person filed.
        // The year's last period is left open: the year close books the year-end entries on 31.12., then closes and seals it.
        if (!lastOfYear) closeThrough(books, end);
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
