/**
 * Saved reports: one file per report under knowledge/reports/<slug>.report.yaml, the spec as the
 * AI or the form wrote it (src/reports/spec.ts), never its figures. Like a rule of knowledge/, the
 * file is the company's customizing: Änderungen lists it until it is saved in git, and every write
 * here answers the file's text before and after, so the person's «Rückgängig» puts it back.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Workspace } from '../workspace/workspace.js';
import { KNOWLEDGE_DIR } from '../knowledge/layers.js';
import { parseSpec, specData, type ReportRefusal, type ReportSpec } from './spec.js';

export const REPORTS_DIR = `${KNOWLEDGE_DIR}/reports`;
const SUFFIX = '.report.yaml';
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;

type Ws = Pick<Workspace, 'paths'>;

/** A saved report as Eigene Berichte lists it; a file the app cannot read says why. */
export type SavedReport =
  | { slug: string; path: string; spec: ReportSpec }
  | { slug: string; path: string; refusal: ReportRefusal };

/** A write: the file's text before (null: there was none) and after (null: it is gone). */
export interface SavedWrite { slug: string; path: string; before: string | null; after: string | null }

export const isSlug = (s: unknown): s is string => typeof s === 'string' && SLUG.test(s);
export const reportPath = (slug: string): string => `${REPORTS_DIR}/${slug}${SUFFIX}`;
const full = (ws: Ws, slug: string) => join(ws.paths.root, reportPath(slug));
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

export const slugOf = (title: string): string =>
  title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'bericht';

export function listSaved(ws: Ws): SavedReport[] {
  const dir = join(ws.paths.root, REPORTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(SUFFIX)).map((f) => f.slice(0, -SUFFIX.length)).filter(isSlug).sort().map((slug): SavedReport => {
    const f = `${slug}${SUFFIX}`;
    const path = reportPath(slug);
    let raw: unknown;
    try { raw = parse(readFileSync(join(dir, f), 'utf8')); } catch { return { slug, path, refusal: { code: 'shape', params: { what: 'yaml' } } }; }
    const p = parseSpec(raw);
    return p.ok ? { slug, path, spec: p.value } : { slug, path, refusal: p.refusal };
  });
}

/** The file's text: a line on what it is, then the spec. */
export const reportText = (spec: ReportSpec): string =>
  `# A report of Bilanz & ER › Eigene Berichte: what it shows, never its figures (the app computes them from the books).\n${stringify(specData(spec), { lineWidth: 0 })}`;

/** Writes the spec: under `slug` when it edits that report, else under a new slug from its title. */
export function saveReport(ws: Ws, spec: ReportSpec, slug?: string): SavedWrite {
  let s = slug;
  if (!s) {
    const base = slugOf(spec.title);
    s = base;
    for (let n = 2; existsSync(full(ws, s)); n++) s = `${base}-${n}`;
  }
  const p = full(ws, s);
  const before = read(p);
  const after = reportText(spec);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, after);
  return { slug: s, path: reportPath(s), before, after };
}

export function deleteReport(ws: Ws, slug: string): SavedWrite | undefined {
  const p = full(ws, slug);
  const before = read(p);
  if (before === null) return undefined;
  rmSync(p);
  return { slug, path: reportPath(slug), before, after: null };
}

/** «Rückgängig»: the file as it was (`text`), or gone when there was none; undefined when it changed since (`now` is what the write left). */
export function restoreReport(ws: Ws, slug: string, text: string | null, now: string | null): SavedWrite | undefined {
  const p = full(ws, slug);
  const before = read(p);
  if (before !== now) return undefined;
  if (text === null) { if (before !== null) rmSync(p); } else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
  return { slug, path: reportPath(slug), before, after: text };
}
