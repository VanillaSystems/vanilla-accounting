/**
 * The actions of the workflow vat-filing (workflows/vat-filing): the return of an open period
 * from the books, its XML for the tax authority's import, and, once a person filed it, the close
 * and the seal of the quarter. They do what `npm run vat-xml` and `npm run seal -- <q> --close`
 * do, in that order, with a person's review and filing between them.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { addDays, derivePeriod, isFilingKey } from '../accounting/periods.js';
import { loadBooks, periodLock, saveBooks } from '../books/store.js';
import { closesTheYear, periodKeyOf, writeSeal } from '../books/seal.js';
import { filing, filingMethod, vat } from '../engines/index.js';
import { ech0217Xml } from '../providers/ech0217/xml.js';
import type { QuarterKey } from '../types/index.js';
import { yearPaths, type Workspace } from '../workspace/workspace.js';
import type { Action } from './actions.js';

/** What the compute step hands on: the period, its figures by box and what is to pay (negative: a credit). */
export interface PeriodReturn { period: string; from: string; to: string; figures: Record<string, number>; payable: number }

const periodOf = (input: Record<string, unknown>): QuarterKey => {
  const key = String(input.period ?? (input.return as PeriodReturn | undefined)?.period ?? '');
  if (!isFilingKey(key, filing().length)) throw new Error(`"${key}" is no filing period`);
  return key as QuarterKey;
};

/** Where the filed XML is kept, beside the period's seal. */
export const filedXml = (ws: Workspace, key: string): string => join(yearPaths(ws.paths, key.slice(0, 4)).filings, `mwst-ech0217-${key}.xml`);
/** Where the prepared XML waits until the person filed it. */
const preparedXml = (ws: Workspace, key: string): string => join(ws.paths.data, 'filing', `mwst-ech0217-${key}.xml`);

/** What the XML step hands on: where the file is, for the person to upload it. */
export interface PreparedXml { path: string; period: string; warnings: string[] }

/** A period's XML as it is now: the filed one once the period is sealed, else the prepared one; undefined before either. */
export function filingXml(ws: Workspace, key: string): string | undefined {
  return [filedXml(ws, key), preparedXml(ws, key)].find((p) => existsSync(p));
}

export const FILING_ACTIONS: Record<string, Action> = {
  'accounting.tax.vat-return': {
    outcomes: ['ok'],
    effects: [],
    run(input, _fx, { ws }) {
      const key = periodOf(input);
      const books = loadBooks(ws);
      const { from, to } = derivePeriod(key)!;
      if (periodLock(books).isClosed(to)) throw new Error(`${key} is filed already (closed through ${books.config.closedThrough}); a correction is declared on its own form`);
      const { ziffern, payable } = vat().figures(books.journalEntries, key, books.config.vatAdjustments ?? []);
      const ret: PeriodReturn = { period: key, from, to, figures: ziffern as Record<string, number>, payable };
      return { outcome: 'ok', output: { return: ret } };
    },
  },
  'providers.ech-0217': {
    outcomes: ['ok'],
    effects: [],
    run(input, _fx, { ws }) {
      const ret = input.return as PeriodReturn;
      const { xml, warnings } = ech0217Xml({
        uid: ws.company.uid, organisationName: ws.company.name, period: { key: ret.period, from: ret.from, to: ret.to },
        ziffern: ret.figures as Parameters<typeof ech0217Xml>[0]['ziffern'], payable: ret.payable, form: vat().form, rateRows: vat().rateRows, method: filingMethod(),
        generationTime: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
      });
      const path = preparedXml(ws, ret.period);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, xml);
      const prepared: PreparedXml = { path, period: ret.period, warnings };
      return { outcome: 'ok', output: { xml: prepared } };
    },
  },
  'books.seal': {
    outcomes: ['ok'],
    effects: ['files.filings', 'books.seal'],
    run(input, _fx, { ws }) {
      const key = periodOf(input);
      if (closesTheYear(key)) throw new Error(`${key} closes with the year: the year close books the year-end entries on 31.12. first, then closes and seals it`);
      const books = loadBooks(ws);
      const end = derivePeriod(key)!.to;
      const closed = books.config.closedThrough;
      if (!closed || closed < end) {
        const next = closed ? periodKeyOf(addDays(closed, 1), ws.filingLength) : key;
        if (next !== key) throw new Error(`the books are closed through ${closed}; the next ${ws.filingLength === 'half' ? 'half year' : 'quarter'} to close is ${next}, not ${key}`);
        // Closing moves closedThrough, which the write door never allows: as `npm run seal -- <q> --close` does, after the person filed.
        books.config.closedThrough = end;
        saveBooks(ws, books);
      }
      const prepared = preparedXml(ws, key);
      const filed = filedXml(ws, key);
      if (existsSync(prepared) && !existsSync(filed)) { mkdirSync(dirname(filed), { recursive: true }); copyFileSync(prepared, filed); }
      const seal = writeSeal(ws, books, key, new Date().toISOString().slice(0, 10));
      return { outcome: 'ok', output: { seal: seal.file } };
    },
  },
};
