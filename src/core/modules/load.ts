/**
 * Reads a jurisdiction module: the app's shipped modules/<id>/, then the workspace's overlay of the
 * same id merged on top, key by key. One loader for the CLI, the server and the Mac app; the
 * browser receives its result as data, never workspace code (docs/0.4.0/modules.md).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ChartData, InvoicingData, Jurisdiction, SetupData, PeriodsData, StatementsData, YearEndData, ModuleManifest, RatesData, ReturnData, TaxCodesData } from './schema.js';
import { checkJurisdiction, type ModuleProblem } from './check.js';

const FILES = { rates: 'rates.yaml', taxCodes: 'tax-codes.yaml', vatReturn: 'return.yaml', chart: 'chart.yaml', periods: 'periods.yaml', statements: 'statements.yaml', yearEnd: 'year-end.yaml', invoicing: 'invoicing.yaml', setup: 'setup.yaml' } as const;

/** Merges an overlay onto a shipped value: maps key by key, `null` (YAML `~`) removes a key, anything else replaces. */
export function mergeOverlay<T>(shipped: T, overlay: unknown): T {
  if (overlay === undefined) return shipped;
  if (!isMap(shipped) || !isMap(overlay)) return overlay as T;
  const out: Record<string, unknown> = { ...shipped };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) delete out[key];
    else out[key] = mergeOverlay(out[key], value);
  }
  return out as T;
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readYaml(path: string): unknown {
  return existsSync(path) ? parse(readFileSync(path, 'utf8')) : undefined;
}

export interface LoadedJurisdiction {
  jurisdiction: Jurisdiction;
  /** Where each part came from: the app, or the workspace's overlay of it. */
  overlaid: (keyof typeof FILES | 'manifest')[];
  problems: ModuleProblem[];
  /** sha256 of the resolved data: what the browser caches and the seal records. */
  hash: string;
}

/**
 * The jurisdiction `id` as the workspace sees it. Throws when the app has no such module; a
 * workspace module without a shipped twin is a later slot (docs/0.4.0/migration.md, step 16).
 */
export function loadJurisdiction(appRoot: string, id: string, workspaceRoot?: string): LoadedJurisdiction {
  const shippedDir = join(appRoot, 'modules', id);
  if (!existsSync(join(shippedDir, 'module.yaml'))) throw new Error(`no module "${id}": the app ships modules/ch only`);
  const overlayDir = workspaceRoot ? join(workspaceRoot, 'modules', id) : undefined;
  const overlayManifest = overlayDir ? readYaml(join(overlayDir, 'module.yaml')) as Partial<ModuleManifest> | undefined : undefined;
  const overlaid: LoadedJurisdiction['overlaid'] = [];

  const part = <T>(file: string, key: keyof typeof FILES): T => {
    const shipped = readYaml(join(shippedDir, file)) as T;
    const overlay = overlayManifest ? readYaml(join(overlayDir!, file)) : undefined;
    if (overlay !== undefined) overlaid.push(key);
    return mergeOverlay(shipped, overlay);
  };

  const jurisdiction: Jurisdiction = {
    manifest: { ...readYaml(join(shippedDir, 'module.yaml')) as ModuleManifest, ...(overlayManifest?.baseCurrency ? { baseCurrency: overlayManifest.baseCurrency } : {}) },
    rates: part<RatesData>(FILES.rates, 'rates'),
    taxCodes: part<TaxCodesData>(FILES.taxCodes, 'taxCodes'),
    vatReturn: part<ReturnData>(FILES.vatReturn, 'vatReturn'),
    chart: part<ChartData>(FILES.chart, 'chart'),
    periods: part<PeriodsData>(FILES.periods, 'periods'),
    statements: part<StatementsData>(FILES.statements, 'statements'),
    yearEnd: part<YearEndData>(FILES.yearEnd, 'yearEnd'),
    invoicing: part<InvoicingData>(FILES.invoicing, 'invoicing'),
    setup: part<SetupData>(FILES.setup, 'setup'),
  };
  if (overlayManifest) overlaid.push('manifest');
  return {
    jurisdiction,
    overlaid,
    problems: checkJurisdiction(jurisdiction),
    hash: createHash('sha256').update(JSON.stringify(jurisdiction)).digest('hex'),
  };
}

/** A workspace's jurisdiction as the app serves it (/modules.json) and the engines use it. */
export interface WorkspaceModules extends LoadedJurisdiction {
  /** What the engines compute with: the workspace's overlay when it has no problems, else the shipped module. */
  effective: Jurisdiction;
}

export function workspaceModules(appRoot: string, workspaceRoot: string, id = 'ch'): WorkspaceModules {
  const loaded = loadJurisdiction(appRoot, id, workspaceRoot);
  return { ...loaded, effective: loaded.problems.length ? loadJurisdiction(appRoot, id).jurisdiction : loaded.jurisdiction };
}
