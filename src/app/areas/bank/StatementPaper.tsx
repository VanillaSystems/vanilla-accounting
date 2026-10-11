/**
 * A statement PDF drawn page by page, the chosen payment's line marked on it (found by lines.ts in
 * the page's own text). Pages are drawn once per file and reused while payments are chosen.
 * Falls back to the browser's viewer.
 */
import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { BankTransaction } from '../../../types/index.js';
import { t } from '../../i18n/index.js';
import { findLines, type TextItem } from './lines.js';

GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 14;
const WIDTH = 1240;

interface Page { canvas: HTMLCanvasElement; height: number; items: TextItem[] }
interface Doc { pages: Page[]; n: number }

const drawn = new Map<string, Promise<Doc>>();

function pagesOf(src: string): Promise<Doc> {
  let doc = drawn.get(src);
  if (!doc) {
    doc = (async () => {
      const pdf = await getDocument(src).promise;
      const pages: Page[] = [];
      for (let i = 1; i <= Math.min(pdf.numPages, MAX_PAGES); i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: WIDTH / page.getViewport({ scale: 1 }).width });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        await page.render({ canvas, viewport: vp }).promise;
        const text = await page.getTextContent();
        const items = text.items.flatMap((it): TextItem[] => {
          if (!('str' in it)) return [];
          const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
          return [{ s: it.str, x, y, h: Math.hypot(it.transform[2], it.transform[3]) * vp.scale }];
        });
        pages.push({ canvas, height: vp.height, items });
      }
      return { pages, n: pdf.numPages };
    })();
    doc.catch(() => drawn.delete(src));
    drawn.set(src, doc);
  }
  return doc;
}

/** Forgets a drawn file, so a statement read again shows its new pages. */
export const forgetPages = () => drawn.clear();

export interface Mark { tx: Pick<BankTransaction, 'ref' | 'date' | 'amount'>; fee?: Pick<BankTransaction, 'ref'>; wise: boolean }

/** The page strip around the marked lines, as one wrapped canvas; none when no page holds them. */
function excerptOf(doc: Doc, mark: Mark): { w: HTMLElement; page: number } | undefined {
  for (const [i, p] of doc.pages.entries()) {
    const lines = findLines(p.items, mark.tx, mark.wise, mark.fee);
    if (!lines.length) continue;
    const y0 = Math.max(0, Math.min(...lines.map((l) => l[0])) - 70);
    const y1 = Math.min(p.height, Math.max(...lines.map((l) => l[1])) + 70);
    const w = document.createElement('div');
    w.className = 'pgw';
    const c = document.createElement('canvas');
    c.className = 'pg';
    c.width = p.canvas.width; c.height = y1 - y0;
    c.getContext('2d')!.drawImage(p.canvas, 0, y0, c.width, c.height, 0, 0, c.width, c.height);
    w.append(c);
    for (const [a, z] of lines) {
      const hl = document.createElement('div');
      hl.className = 'hl';
      hl.style.top = `${((a - y0) / (y1 - y0)) * 100}%`;
      hl.style.height = `${((z - a) / (y1 - y0)) * 100}%`;
      w.append(hl);
    }
    return { w, page: i + 1 };
  }
  return undefined;
}

/**
 * `onPage` hears where the mark is ("Seite 2 von 5"), or that it is not found. `scroller` is the
 * box that scrolls the paper: the line is scrolled into it only when out of sight. `excerpt` draws
 * only the strip around the marked line (the statement as evidence for an entry), else every page.
 */
export function StatementPaper({ src, mark, excerpt, onPage, scroller }: { src: string; mark?: Mark; excerpt?: boolean; onPage?(text: string): void; scroller?(el: HTMLElement): HTMLElement | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const key = mark ? `${mark.tx.ref}|${mark.fee?.ref ?? ''}` : '';

  useEffect(() => {
    setFailed(false);
    let live = true;
    pagesOf(src).then((doc) => {
      const el = box.current;
      if (!live || !el) return;
      const strip = excerpt && mark ? excerptOf(doc, mark) : undefined;
      if (strip) {
        el.replaceChildren(strip.w);
        onPage?.(t('bank.page', { page: strip.page, n: doc.n }));
        return;
      }
      let first: { hl: HTMLElement; page: number } | undefined;
      el.replaceChildren(...doc.pages.map((p, i) => {
        const w = document.createElement('div');
        w.className = 'pgw';
        const c = document.createElement('canvas');
        c.className = 'pg';
        c.width = p.canvas.width; c.height = p.canvas.height;
        c.getContext('2d')!.drawImage(p.canvas, 0, 0);
        w.append(c);
        if (mark) for (const [y0, y1] of findLines(p.items, mark.tx, mark.wise, mark.fee)) {
          const hl = document.createElement('div');
          hl.className = 'hl';
          hl.style.top = `${(y0 / p.height) * 100}%`;
          hl.style.height = `${((y1 - y0) / p.height) * 100}%`;
          w.append(hl);
          first ??= { hl, page: i + 1 };
        }
        return w;
      }));
      if (first) {
        onPage?.(t('bank.page', { page: first.page, n: doc.n }));
        const sc = scroller?.(el);
        if (sc) {
          const h = first.hl.getBoundingClientRect(), v = sc.getBoundingClientRect();
          if (h.bottom > v.bottom - 40 || h.top < v.top) sc.scrollTop += h.top - v.top - v.height * 0.4;
        }
      } else onPage?.(mark ? t('bank.lineNotFound') : '');
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [src, key, excerpt]);

  if (failed) return <iframe className="pg" style={{ width: '100%', height: 760, border: 0 }} src={`${src}#toolbar=0`} title={t('bank.statement')} />;
  return <div ref={box} className="pages"><div className="loading" /></div>;
}
