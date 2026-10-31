/**
 * A PDF's first pages as PNG images, for a model that reads images but no PDF (Codex). Rendered
 * only when such a model is asked about the file, never at intake, and kept in a disposable cache
 * keyed by the file's content, the page and the resolution, so a page is rendered once. The PDF
 * itself is only read: the electronic original stays as it was received (GeBüV).
 *
 * macOS draws the pages (PDFKit, through osascript's JavaScript bridge): part of every Mac, nothing
 * to install, nothing to pack, and it asks for no developer tools. The desktop app does not ship
 * pdf.js's canvas binary (desktop/not-packed.cjs), so pdf.js cannot draw here.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 150 dpi reads a receipt's small print; a long till roll is scaled down so its longer side stays at MAX_SIDE. */
export const DPI = 150;
export const MAX_SIDE = 2400;
/** The pages sent: a receipt's facts are on its first pages, and each image costs the model's input. */
export const MAX_PAGES = 4;

export interface PdfPages {
  /** The PDF's page count. */
  total: number;
  /** The rendered pages, first ones first: their 1-based number and the PNG. */
  pages: { page: number; file: string }[];
}

const RENDER = `
ObjC.import('AppKit'); ObjC.import('PDFKit');
function run(argv) {
  const [pdf, outDir, dpi, maxSide, wanted] = [argv[0], argv[1], Number(argv[2]), Number(argv[3]), argv[4].split(',').map(Number)];
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(pdf));
  if (!doc || doc.isNil()) return JSON.stringify({ error: 'unreadable' });
  const total = Number(doc.pageCount);
  const pages = [];
  for (const n of wanted.filter((n) => n >= 1 && n <= total)) {
    const page = doc.pageAtIndex(n - 1);
    const box = page.boundsForBox($.kPDFDisplayBoxCropBox).size;
    const turned = page.rotation % 180 !== 0;
    const wPt = turned ? box.height : box.width, hPt = turned ? box.width : box.height;
    const scale = Math.min(dpi / 72, maxSide / Math.max(wPt, hPt));
    const w = Math.max(1, Math.round(wPt * scale)), h = Math.max(1, Math.round(hPt * scale));
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, w, h, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext(ctx);
    $.NSColor.whiteColor.setFill;
    $.NSRectFill($.NSMakeRect(0, 0, w, h));
    $.CGContextScaleCTM(ctx.CGContext, scale, scale);
    page.drawWithBoxToContext($.kPDFDisplayBoxCropBox, ctx.CGContext);
    ctx.flushGraphics;
    $.NSGraphicsContext.restoreGraphicsState;
    const file = outDir + '/p' + n + '.png';
    rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(file, true);
    pages.push(n);
  }
  return JSON.stringify({ total, pages });
}`;

function render(pdf: string, dir: string, wanted: number[]): Promise<{ total: number }> {
  return new Promise((done, fail) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', RENDER, pdf, dir, String(DPI), String(MAX_SIDE), wanted.join(',')], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return fail(new Error(`PDF-Seiten nicht gezeichnet: ${(stderr || err.message).trim().slice(0, 200)}`));
      const out = JSON.parse(stdout) as { total?: number; error?: string };
      if (out.error || !out.total) return fail(new Error(`PDF nicht lesbar: ${pdf}`));
      done({ total: out.total });
    });
  });
}

/**
 * The first `maxPages` pages of `pdf` as PNGs under `cacheDir`, drawn now only where the cache
 * has none. The cache's folder per file is its content's SHA-256 and the resolution.
 */
export async function pdfPages(pdf: string, cacheDir: string, maxPages = MAX_PAGES): Promise<PdfPages> {
  const hash = createHash('sha256').update(readFileSync(pdf)).digest('hex');
  const dir = join(cacheDir, hash, `${DPI}dpi-${MAX_SIDE}`);
  const count = join(dir, 'pages.json');
  const known = existsSync(count) ? (JSON.parse(readFileSync(count, 'utf8')) as { total: number }).total : undefined;
  const wanted = Array.from({ length: Math.min(maxPages, known ?? maxPages) }, (_, i) => i + 1);
  const file = (n: number) => join(dir, `p${n}.png`);
  let total = known;
  if (total === undefined || wanted.some((n) => !existsSync(file(n)))) {
    mkdirSync(dir, { recursive: true });
    ({ total } = await render(pdf, dir, wanted));
    writeFileSync(count, JSON.stringify({ total }));
  }
  return { total, pages: wanted.filter((n) => n <= total).map((page) => ({ page, file: file(page) })) };
}
