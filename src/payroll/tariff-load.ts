/**
 * «Tarif laden» (docs/specs/payroll.md §3f, §19.3): fetches a region's tariff file of a year, keeps it, and
 * makes it the one payroll computes with. Every new version (the first, or a file a region corrected during
 * the year) is compared first with every closed payslip: as
 * long as one would compute otherwise, nothing changes until the person says how (`backdated`): the
 * Rückwirkende Korrektur carries each payslip's difference to the person's next open month, «So lassen»
 * keeps them as closed and records the choice. A closed payslip is never changed.
 */
import type { Workspace } from '../workspace/workspace.js';
import { idSource } from '../invoices/store.js';
import { payrollContext } from './service.js';
import { affectedByTariff, backdatedCorrections, keepEvents, reopenOffer, type Affected } from './settings.js';
import { appendPayslipEvents } from './store.js';
import { fetchTariff, httpFetcher, keepTariffVersion, makeCurrent, tariffIndex, tariffSource, type Fetcher, type TariffVersion } from './tariffs.js';
import { PayrollRefusal } from './close.js';
import type { PayslipCorrection, PayslipEvent } from './model.js';

export type TariffLoad =
  | { saved: true; region: string; year: string; version: TariffVersion; unchanged: boolean; corrections: PayslipCorrection[]; warnings: [] }
  | { saved: false; region: string; year: string; version: TariffVersion; affected: Affected[]; reopen?: string; warnings: [] };

export interface TariffLoadOptions {
  backdated?: 'correct' | 'keep';
  /** The file as bytes (a person's upload); absent: fetched from the jurisdiction's source. */
  bytes?: Uint8Array;
  fetcher?: Fetcher;
  isClosed?: (day: string) => boolean;
  now?: string;
}

export async function loadTariff(ws: Workspace, region: string, year: string, opts: TariffLoadOptions = {}): Promise<TariffLoad> {
  const now = opts.now ?? new Date().toISOString();
  const isClosed = opts.isClosed ?? (() => false);
  const ctx = payrollContext(ws);
  const got = opts.bytes ? { bytes: opts.bytes, url: undefined } : await fetchTariff(ctx.data, region, year, opts.fetcher ?? httpFetcher);
  const { loaded, version } = keepTariffVersion(ws, region, year, got.bytes, got.url, now);
  const current = tariffIndex(ws, region, year)?.current;
  const base = { region, year, version, warnings: [] as [] };
  if (current === version.sha256) return { saved: true, ...base, unchanged: true, corrections: [] };
  // Also the first file: a payslip closed without it left its tax out, and the card offers to carry it. Compared with
  // what each payslip withheld and was corrected by since, never with the file before (§22 decision 105).
  const affected = affectedByTariff(ctx, { ...ctx, tariffs: tariffSource(ws, loaded) }, isClosed);
  if (affected.length && !opts.backdated) {
    const reopen = reopenOffer(ctx, affected, isClosed);
    return { saved: false, ...base, affected, ...(reopen ? { reopen } : {}) };
  }
  // A closed period offers only the correction (§19.3, golden rule 1).
  if (opts.backdated === 'keep' && affected.some((a) => a.closedPeriod)) throw new PayrollRefusal('closedPeriod', 'Eine Lohnabrechnung einer geschlossenen Periode wird nur korrigiert: «So lassen» gibt es für sie nicht.');
  const corrections = opts.backdated === 'correct' ? backdatedCorrections(ctx, affected, () => `co_${idSource.bytes(6).toString('hex')}`, now) : [];
  const events: PayslipEvent[] = opts.backdated === 'keep' ? keepEvents(affected, { path: `tariffs/${region}/${year}`, validFrom: version.created }, now) : corrections;
  const yearOf = (e: PayslipEvent) => (e.event === 'correction' ? e.of : e.id).slice(0, 4);
  // The corrections first: a failure between the two leaves the old file current with its corrections entered, and a
  // retry, comparing with them (affectedByTariff), carries nothing twice; never a new file without its corrections.
  for (const y of new Set(events.map(yearOf))) appendPayslipEvents(ws, y, events.filter((e) => yearOf(e) === y));
  makeCurrent(ws, region, year, version.sha256);
  return { saved: true, ...base, unchanged: false, corrections };
}
