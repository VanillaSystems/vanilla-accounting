/**
 * The text of a PDF through pdf.js, in the three shapes the parsers were written against
 * (`pdftotext` default, `-raw` and `-layout`), so that no program outside Node is needed:
 *
 *  - `reading`: the text blocks of the page (a paragraph, a column of a table, a sidebar) in
 *    reading order, their lines with single spaces, a blank line between blocks, as pdftotext's
 *    default lays a page out. Receipts (src/cli/extract.ts); stored as `extractedText`.
 *  - `raw`: the runs in content-stream order, broken into lines by poppler's rule (a new line
 *    when the baseline moves or the x position goes back).
 *  - `layout`: the lines top to bottom, the runs padded with spaces to their column, blank lines
 *    for vertical gaps. A statement's columns, handed to the model that reads it (#217).
 *
 * Pages end with a form feed, as pdftotext prints them.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';

export type TextMode = 'reading' | 'raw' | 'layout';

/**
 * One run of glyphs as pdf.js reports it, with the page's rotation taken out: `x` grows along
 * the baseline, `y` is the baseline (up), `size` the font size. `angle` is the run's direction
 * in degrees (0 upright); runs of another angle are printed after the upright ones.
 */
export interface Run {
  text: string;
  x: number;
  xMax: number;
  y: number;
  size: number;
  angle: number;
}

/** Runs per page, in content-stream order. */
export type PageRuns = Run[];

// pdf.js finds its standard fonts and CMaps on disk from these; without them a PDF naming a
// non-embedded font gets no glyph widths and its words run together.
const PDFJS_DIR = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const FONT_OPTIONS = {
  standardFontDataUrl: `${pathToFileURL(PDFJS_DIR).href}/standard_fonts/`,
  cMapUrl: `${pathToFileURL(PDFJS_DIR).href}/cmaps/`,
  cMapPacked: true,
  isEvalSupported: false,
};

/**
 * pdf.js, loaded on first use. It creates a DOMMatrix as it loads, for drawing pages; Node has
 * none, and pdf.js would load @napi-rs/canvas to get one. The engine only reads text and never
 * draws a page, so an empty class stands in: the canvas binary is not needed, and the desktop app
 * does not ship it (desktop/not-packed.cjs). A dynamic import, so the stand-in is in place first
 * also where a bundle hoists its packages' imports (the desktop app's).
 */
let pdfjs: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;
function loadPdfjs() {
  const g = globalThis as { DOMMatrix?: unknown };
  g.DOMMatrix ??= class DOMMatrix {};
  return (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'));
}

/** The runs of every page of a PDF (a path, or its bytes), or of its first `pages`. */
export async function pdfRuns(pdf: string | Uint8Array, pages = Infinity): Promise<PageRuns[]> {
  const { getDocument, VerbosityLevel } = await loadPdfjs();
  const data = typeof pdf === 'string' ? new Uint8Array(readFileSync(pdf)) : new Uint8Array(pdf);
  const doc = await getDocument({ data, ...FONT_OPTIONS, verbosity: VerbosityLevel.ERRORS }).promise;
  try {
    const out: PageRuns[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, pages); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      out.push(content.items.flatMap((item) => ('str' in item ? runOf(item) : [])));
      page.cleanup();
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

/** The text of a PDF in one of the three shapes. */
export async function pdfText(pdfPath: string, mode: TextMode = 'reading'): Promise<string> {
  return textOf(await pdfRuns(pdfPath), mode);
}

// pdf.js reads letter-spaced words ("R Ö S T E R E I") as single letters with spaces between; pdftotext did not.
const LETTER_SPACED = /^\S( \S){2,}$/;

function runOf(item: TextItem): Run[] {
  // A glyph whose font maps it to U+0000 (a hyphen, a bracket, a colon in some generators'
  // fonts) is unknown; pdftotext read the glyph's name instead. A space keeps the words apart.
  const str = item.str.replace(/\0/g, ' ');
  if (str.trim() === '') return [];
  const text = LETTER_SPACED.test(str) ? str.replace(/ /g, '') : str;
  const [a, b, c, d, x, y] = item.transform;
  const angle = ((Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90) % 360 + 360) % 360;
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const bx = x * cos + y * sin;
  const by = -x * sin + y * cos;
  const size = Math.hypot(c, d) || item.height || 1;
  return [{ text, x: bx, xMax: bx + item.width, y: by, size, angle }];
}

/** Pure: the text of extracted runs, so the shapes are testable without a PDF. */
export function textOf(pages: readonly PageRuns[], mode: TextMode): string {
  return pages.map((runs) => `${SHAPES[mode](runs)}\f`).join('');
}

const SHAPES: Record<TextMode, (runs: PageRuns) => string> = {
  raw: rawText,
  reading: (runs) => byAngle(runs).flatMap(blocksOf).map((block) => block.map(compactRow).join('\n')).join('\n\n'),
  layout: (runs) => byAngle(runs).flatMap(layoutRows).join('\n'),
};

// poppler's thresholds (TextOutputDev.cc), in multiples of the font size.
const SAME_LINE = 0.5;
const BACKTRACK = 0.2;
const WORD_GAP = 0.15;

/** Content-stream order; poppler's raw rule decides between a space and a line break. */
function rawText(runs: PageRuns): string {
  let out = '';
  runs.forEach((run, i) => {
    out += run.text;
    const next = runs[i + 1];
    if (!next) return;
    const sameLine = next.angle === run.angle
      && Math.abs(next.y - run.y) < SAME_LINE * run.size
      && next.x > run.xMax - BACKTRACK * run.size;
    if (!sameLine) out += '\n';
    else if (next.x > run.xMax + WORD_GAP * run.size && !/\s$/.test(run.text) && !/^\s/.test(next.text)) out += ' ';
  });
  return out;
}

/** The runs grouped by direction, upright first, each group in stream order. */
function byAngle(runs: PageRuns): PageRuns[] {
  const groups = new Map<number, Run[]>();
  for (const run of runs) (groups.get(run.angle) ?? groups.set(run.angle, []).get(run.angle)!).push(run);
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
}

/** Physical rows: runs whose baselines lie within half a font size of the row's first, top to bottom, left to right. */
function rowsOf(runs: PageRuns): Run[][] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Run[][] = [];
  for (const run of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(run.y - row[0].y) < SAME_LINE * Math.max(run.size, row[0].size)) row.push(run);
    else rows.push([run]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

/** The runs of a row joined; `pad` gives the whitespace for a gap between two runs (in points). */
function joinRow(row: Run[], pad: (gap: number, run: Run, charWidth: number) => string): string {
  const charWidth = rowCharWidth(row);
  let out = '';
  row.forEach((run, i) => {
    const prev = row[i - 1];
    const touching = /\s$/.test(prev?.text ?? ' ') || /^\s/.test(run.text);
    out += (prev && !touching ? pad(run.x - prev.xMax, run, charWidth) : '') + run.text;
  });
  return out;
}

/** The average glyph width of a row, the unit of layout padding (half the font size when nothing is measured). */
function rowCharWidth(row: Run[]): number {
  const chars = row.reduce((n, r) => n + r.text.length, 0);
  return row.reduce((w, r) => w + (r.xMax - r.x), 0) / Math.max(chars, 1) || row[0].size / 2;
}

// A gap wider than this (in font sizes) separates two columns of a row; a row gap taller than
// this (in font sizes) ends a block.
const COLUMN_GAP = 1.0;
const BLOCK_GAP = 2.5;

/**
 * Text blocks in reading order: each row is cut at wide gaps into segments, and a segment joins
 * the block whose last line lies less than a block gap above it and overlaps it horizontally
 * (the widest overlap wins, one segment per row); blocks are ordered by their top edge, then
 * from the left.
 */
function blocksOf(runs: PageRuns): Run[][][] {
  type Block = { lines: Run[][]; y: number; top: number; left: number };
  const blocks: Block[] = [];
  for (const row of rowsOf(runs)) {
    const taken = new Set<Block>();
    for (const segment of segmentsOf(row)) {
      const left = segment[0].x, right = segment.at(-1)!.xMax, size = segment[0].size;
      const above = blocks
        .filter((b) => !taken.has(b) && b.y - segment[0].y < BLOCK_GAP * Math.max(size, b.lines.at(-1)![0].size) && overlap(b.lines.at(-1)!, left, right) > 0)
        .sort((a, b) => overlap(b.lines.at(-1)!, left, right) - overlap(a.lines.at(-1)!, left, right))[0];
      const block = above ?? { lines: [], y: segment[0].y, top: segment[0].y, left };
      if (!above) blocks.push(block);
      block.lines.push(segment);
      block.y = segment[0].y;
      taken.add(block);
    }
  }
  return blocks.sort((a, b) => b.top - a.top || a.left - b.left).map((b) => b.lines);
}

const overlap = (line: Run[], left: number, right: number) => Math.min(line.at(-1)!.xMax, right) - Math.max(line[0].x, left);

/** A row cut into segments at gaps wider than a column gap. */
function segmentsOf(row: Run[]): Run[][] {
  const segments: Run[][] = [];
  row.forEach((run, i) => {
    const prev = row[i - 1];
    if (prev && run.x - prev.xMax <= COLUMN_GAP * Math.max(run.size, prev.size)) segments.at(-1)!.push(run);
    else segments.push([run]);
  });
  return segments;
}

const compactRow = (row: Run[]) => joinRow(row, (gap, run) => (gap > WORD_GAP * run.size ? ' ' : ''));

const paddedRow = (row: Run[]) =>
  ' '.repeat(Math.round(row[0].x / rowCharWidth(row))) + joinRow(row, (gap, _run, charWidth) => ' '.repeat(Math.max(1, Math.round(gap / charWidth))));

/** Rows padded to their columns; a vertical gap of more than a line becomes blank lines (two at most). */
function layoutRows(runs: PageRuns): string[] {
  const out: string[] = [];
  let lastY: number | undefined;
  for (const row of rowsOf(runs)) {
    if (lastY !== undefined) {
      const blank = Math.min(Math.round((lastY - row[0].y) / (1.2 * row[0].size)) - 1, 2);
      for (let i = 0; i < blank; i++) out.push('');
    }
    out.push(paddedRow(row));
    lastY = row[0].y;
  }
  return out;
}
