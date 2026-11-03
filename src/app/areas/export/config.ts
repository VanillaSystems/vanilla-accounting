/**
 * The export dialog's configuration: what a page's export preselects, the built-in presets, the
 * viewer's own presets, and how a click on a period or a preset changes it.
 */
import { type FilingLength, type Period } from '../../../accounting/periods.js';
import { PRESETS, presetPeriod, type PresetId, type Selection } from '../../../export/model.js';
import type { Route } from '../../shell/route.js';

export interface DialogConfig {
  period: string;
  items: Selection;
  sums: boolean;
  oneBook: boolean;
  /** The built-in preset's id or the own preset's name it was opened with; null once changed by hand. */
  preset: string | null;
  /** The person picked the period (a button of the period row, the picker, an own preset): a built-in preset keeps it. */
  periodChosen: boolean;
}

/** A preset of the viewer's: a name, a period and what it exports. */
export interface OwnPreset { name: string; period: string; items: Selection; sums: boolean; oneBook: boolean }

export const configOf = (id: PresetId, open: Period, page: Period, period?: string): DialogConfig => {
  const p = PRESETS.find((x) => x.id === id)!;
  return { period: period ?? presetPeriod(p, open, page), items: structuredClone(p.items), sums: p.sums, oneBook: p.oneBook, preset: id, periodChosen: false };
};

export const ownConfig = (p: OwnPreset): DialogConfig => ({ period: p.period, items: structuredClone(p.items), sums: p.sums, oneBook: p.oneBook, preset: p.name, periodChosen: true });

/** A period the person picks in the dialog. */
export const choosePeriod = (c: DialogConfig, token: string): DialogConfig => ({ ...c, period: token, periodChosen: true });

/** A built-in preset clicked in the dialog: its parts and options, in the period the person picked, else in its own. */
export const choosePreset = (c: DialogConfig, id: PresetId, open: Period, page: Period): DialogConfig =>
  c.periodChosen ? { ...configOf(id, open, page, c.period), periodChosen: true } : configOf(id, open, page);

/** The period row: the year's quarters, its half years where the firm files half-yearly, the year, the year so far, the page's period and the chosen one. */
export function periodRow(year: string, length: FilingLength, page: string, current: string): string[] {
  const halves = length === 'half' ? [`${year}-H1`, `${year}-H2`] : [];
  return [...new Set([1, 2, 3, 4].map((q) => `${year}-Q${q}`).concat(halves, [year, 'ytd', page, current]))];
}

/** What a page's export preselects: the page's own objects, in the page's period (VAT: a quarter, else the open one). */
export function presetFor(route: Route, page: Period, open: Period): DialogConfig {
  const period = route.area === 'vat' && page.kind !== 'quarter' ? open.token : page.token;
  return { period, items: pageItems(route), sums: false, oneBook: false, preset: null, periodChosen: false };
}

function pageItems(route: Route): Selection {
  switch (route.area) {
    case 'receipts': return { receiptList: ['csv'], receipts: ['orig'] };
    case 'bank': return { payments: ['csv'], statements: ['orig'] };
    case 'journal': case 'codes': return { journal: ['csv'] };
    case 'vat': return { vat: ['pdf', 'csv'] };
    case 'reports': return route.report === 'custom' ? {} : { [route.report]: ['pdf', 'csv'] };
    default: return {};
  }
}
