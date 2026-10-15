/**
 * The export dialog's state: what a page's export preselects, the built-in presets, the viewer's
 * own presets (kept in this browser), and the request sent to POST /api/export.
 */
import { localToday, parsePeriod, type Period } from '../../../accounting/periods.js';
import { PRESETS, presetPeriod, type ExportRequest, type PresetId, type Selection } from '../../../export/model.js';
import type { Route } from '../../shell/route.js';
import { ApiError } from '../../lib/api.js';
import { language } from '../../i18n/index.js';

export interface DialogConfig {
  period: string;
  items: Selection;
  sums: boolean;
  oneBook: boolean;
  /** The built-in preset's id or the own preset's name it was opened with; null once changed by hand. */
  preset: string | null;
}

/** A preset of the viewer's: a name, a period and what it exports. */
export interface OwnPreset { name: string; period: string; items: Selection; sums: boolean; oneBook: boolean }

export const configOf = (id: PresetId, open: Period, page: Period, period?: string): DialogConfig => {
  const p = PRESETS.find((x) => x.id === id)!;
  return { period: period ?? presetPeriod(p, open, page), items: structuredClone(p.items), sums: p.sums, oneBook: p.oneBook, preset: id };
};

export const ownConfig = (p: OwnPreset): DialogConfig => ({ period: p.period, items: structuredClone(p.items), sums: p.sums, oneBook: p.oneBook, preset: p.name });

/** What a page's export preselects: the page's own objects, in the page's period (MWST: a quarter, else the open one). */
export function presetFor(route: Route, page: Period, open: Period): DialogConfig {
  const period = route.area === 'vat' && page.kind !== 'quarter' ? open.token : page.token;
  return { period, items: pageItems(route), sums: false, oneBook: false, preset: null };
}

function pageItems(route: Route): Selection {
  switch (route.area) {
    case 'receipts': return { receiptList: ['csv'], receipts: ['orig'] };
    case 'bank': return { payments: ['csv'], statements: ['orig'] };
    case 'journal': case 'codes': return { journal: ['csv'] };
    case 'vat': return { vat: ['pdf', 'csv'] };
    case 'reports': return { [route.report]: ['pdf', 'csv'] };
    default: return {};
  }
}

const KEY = 'export.presets';

/** Per viewer, in this browser: presets are a habit of one person, not part of the books. */
export function ownPresets(): OwnPreset[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as OwnPreset[]; } catch { return []; }
}

export function saveOwnPresets(list: OwnPreset[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* per viewer only */ }
}

export const periodOf = (token: string): Period => parsePeriod(token, localToday())!;

/** Sends the request and hands what comes back to the browser under the name the server gives it; returns that name. The browser (or its Save dialog) finishes the file later, unseen by the page. */
export async function download(req: Omit<ExportRequest, 'language'>): Promise<string> {
  const res = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...req, language: language() }) });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as ConstructorParameters<typeof ApiError>[0] | null;
    throw new ApiError(body?.error ? body : { error: `HTTP ${res.status}` });
  }
  const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.zip');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  return name;
}
