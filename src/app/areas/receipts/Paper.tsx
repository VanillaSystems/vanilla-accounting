/**
 * A PDF drawn as paper: each page on a canvas, cut to its ink, so a narrow till slip on an A4
 * page shows as a narrow strip (the mockup's paper). Falls back to the browser's viewer.
 */
import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { t } from '../../i18n/index.js';

GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 6;

/** The page's canvas cut to its ink with a small margin; a full page or an empty one stays whole. */
function trim(c: HTMLCanvasElement): HTMLCanvasElement {
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const { width: w, height: h } = c;
  const d = g.getImageData(0, 0, w, h).data;
  const ink = (x: number, y: number) => { const i = (y * w + x) * 4; return d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235; };
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  const rowInk = (y: number) => { for (let x = 0; x < w; x += 2) if (ink(x, y)) return true; return false; };
  const colInk = (x: number) => { for (let y = top; y <= bottom; y += 2) if (ink(x, y)) return true; return false; };
  while (top < bottom && !rowInk(top)) top++;
  while (bottom > top && !rowInk(bottom)) bottom--;
  while (left < right && !colInk(left)) left++;
  while (right > left && !colInk(right)) right--;
  const cw = right - left, ch = bottom - top;
  const out = document.createElement('canvas');
  out.className = 'pg';
  if (cw < 20 || ch < 20 || (cw > w * 0.8 && ch > h * 0.8)) {
    out.width = w; out.height = h;
    out.getContext('2d')!.drawImage(c, 0, 0);
    out.style.width = `${w / 2}px`;
    return out;
  }
  const pad = Math.round(w * 0.04);
  out.width = cw + pad * 2; out.height = ch + pad * 2;
  const o = out.getContext('2d')!;
  o.fillStyle = '#fff';
  o.fillRect(0, 0, out.width, out.height);
  o.drawImage(c, left, top, cw, ch, pad, pad, cw, ch);
  out.style.width = `${Math.min(out.width / 2, c.width / 2)}px`;
  return out;
}

export function Paper({ src, maxWidth = 600 }: { src: string; maxWidth?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    const el = box.current;
    if (!el) return;
    let live = true;
    const task = getDocument(src);
    (async () => {
      const doc = await task.promise;
      const width = Math.min(el.parentElement?.clientWidth || maxWidth, maxWidth);
      const pages: HTMLCanvasElement[] = [];
      for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * 2 });
        const c = document.createElement('canvas');
        c.width = viewport.width; c.height = viewport.height;
        await page.render({ canvas: c, viewport }).promise;
        if (!live) return;
        pages.push(trim(c));
      }
      if (live) el.replaceChildren(...pages);
    })().catch(() => { if (live) setFailed(true); });
    return () => { live = false; task.destroy(); };
  }, [src, maxWidth]);

  if (failed) return <iframe className="pg" style={{ width: '100%', height: 760, border: 0 }} src={`${src}#toolbar=0`} title={t('receipts.preview')} />;
  return <div ref={box} className="pages"><div className="loading" /></div>;
}
