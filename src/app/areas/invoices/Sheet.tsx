/**
 * The A4 sheet on screen, laid out by the renderer the PDF uses (src/invoices/sheet.ts): the
 * blocks are measured here at their printed width once the invoice fonts are in, placed on pages
 * with `paginate` and written with `assembleSheets`; each page is then zoomed to the column.
 * A draft is edited on the sheet itself: a field reports what was typed (`final` when it is
 * left), a button its action.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import arimo400 from '@fontsource/arimo/files/arimo-latin-400-normal.woff2?url';
import arimo700 from '@fontsource/arimo/files/arimo-latin-700-normal.woff2?url';
import { SHEET_CSS, assembleSheets, hasQrBill, measureHtml, paginate, sheetBlocks, type SheetData } from '../../../invoices/sheet.js';

/** Arimo stands in for Liberation Sans, the QR-bill's font, as in the PDF (src/invoices/fonts.ts). */
const fontsReady: Promise<unknown> = (() => {
  const style = document.createElement('style');
  style.dataset.invoiceSheet = '';
  style.textContent = SHEET_CSS;
  document.head.append(style);
  const faces = [new FontFace('Liberation Sans', `url(${arimo400})`, { weight: '400' }), new FontFace('Liberation Sans', `url(${arimo700})`, { weight: '700' })];
  for (const f of faces) document.fonts.add(f);
  return Promise.all([...faces.map((f) => f.load()), ...[400, 600, 700].map((w) => document.fonts.load(`${w} 10pt Inter`))]).catch(() => undefined);
})();

function layOut(d: SheetData, box: HTMLDivElement): string {
  const blocks = sheetBlocks(d);
  box.innerHTML = measureHtml(d, blocks);
  const els = [...box.querySelectorAll<HTMLElement>('.ivblk')];
  const end = box.querySelector('.ivmain')!.getBoundingClientRect().bottom;
  const pxmm = box.querySelector('.a4')!.getBoundingClientRect().height / 297;
  const mm = els.map((e, k) => ((els[k + 1] ? els[k + 1].getBoundingClientRect().top : end) - e.getBoundingClientRect().top) / pxmm);
  box.innerHTML = '';
  return assembleSheets(d, blocks, paginate(blocks, mm, { footer: d.layout.show.footer, qrBill: hasQrBill(d) }));
}

let measureBox: HTMLDivElement | undefined;

/** A number field: typing replaces what is there, as in a form. */
const numeric = (el: HTMLElement) => /^l:\d+:(quantity|price)$/.test(el.dataset.ed ?? '');

export interface SheetProps {
  data: SheetData;
  editing?: boolean;
  className?: string;
  /** False: the edit is refused and the field shows what it had again. */
  onEdit?(key: string, value: string, final: boolean): boolean | void;
  /** May name the field to put the caret in once the sheet is laid out again. */
  onAction?(action: string, k: number): string | void;
  /** A field to put the caret in once laid out; `onFocused` says it is done. */
  focus?: string;
  onFocused?(): void;
}

export function Sheet({ data, editing, className, onEdit, onAction, focus, onFocused }: SheetProps) {
  const [fonts, setFonts] = useState(false);
  const [html, setHtml] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const refocus = useRef<string>();
  // A select the person has open (its list, or its keys) is never replaced under them: a re-layout
  // waits until it is left, unless its own change set it off (r5h-22, corner-44: the unit, then the
  // VAT rate 0.6 s later, and the open VAT list was swapped for a new one, so its choice was lost).
  const held = useRef<HTMLSelectElement | null>(null);
  const ownChange = useRef(false);
  const waiting = useRef<string>();
  /** A number field focused whose content is still to be selected: the next key replaces it all, however soon it comes. */
  const toSelect = useRef<HTMLElement | null>(null);

  useEffect(() => { let live = true; fontsReady.then(() => { if (live) setFonts(true); }); return () => { live = false; }; }, []);

  useLayoutEffect(() => {
    if (!fonts) return;
    measureBox ??= Object.assign(document.body.appendChild(document.createElement('div')), { ariaHidden: 'true' });
    const next = layOut(data, measureBox);
    if (held.current?.isConnected && !ownChange.current) { waiting.current = next; return; }
    ownChange.current = false;
    waiting.current = undefined;
    setHtml(next);
  }, [data, fonts]);

  // Each page zoomed to the column's width, again whenever the column changes.
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const fit = () => { for (const a of box.querySelectorAll<HTMLElement>(':scope > .a4')) { a.style.zoom = '1'; a.style.zoom = String(box.clientWidth / a.offsetWidth); } };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    // After a re-layout the caret goes to the field the person moved to.
    const key = refocus.current ?? focus;
    refocus.current = undefined;
    if (focus && html) onFocused?.();
    const next = key ? box.querySelector<HTMLElement>(`[data-ed="${CSS.escape(key)}"]`) : null;
    if (next) {
      next.focus();
      if (next.isContentEditable) { const sel = getSelection(); sel?.selectAllChildren(next); if (!focus && !numeric(next)) sel?.collapseToEnd(); }
    }
    return () => ro.disconnect();
  }, [html, focus]);

  // The sheet's HTML is not React's: React never sees a <select> in it change (its onChange follows
  // React's own elements), so the sheet listens to the DOM's change event, which bubbles.
  const edit = useRef(onEdit);
  edit.current = onEdit;
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const changed = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLSelectElement) || !el.dataset.ed) return;
      if (el === held.current) { ownChange.current = true; refocus.current = el.dataset.ed; }
      if (edit.current?.(el.dataset.ed, el.value, true) === false) el.value = el.dataset.was ?? '';
      else el.dataset.was = el.value;
    };
    box.addEventListener('change', changed);
    return () => box.removeEventListener('change', changed);
  }, []);

  const field = (e: { target: EventTarget }) => (e.target as HTMLElement).closest?.<HTMLElement>('[data-ed]') ?? null;
  const text = (el: HTMLElement) => (el instanceof HTMLSelectElement ? el.value : el.innerText.replace(/\n+$/, ''));

  return (
    <div
      ref={ref}
      className={`ivsheet${editing ? ' editing' : ''}${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onInput={(e) => { const el = field(e); if (el?.isContentEditable) onEdit?.(el.dataset.ed!, text(el), false); }}
      onBlur={(e) => {
        const el = field(e);
        if (el instanceof HTMLSelectElement && el === held.current) {
          held.current = null;
          if (waiting.current !== undefined) { setHtml(waiting.current); waiting.current = undefined; }
          return;
        }
        if (!el?.isContentEditable) return;
        refocus.current = (e.relatedTarget as HTMLElement | null)?.closest?.<HTMLElement>('[data-ed]')?.dataset.ed;
        if (onEdit?.(el.dataset.ed!, text(el), true) === false) el.innerText = el.dataset.was ?? '';
      }}
      onPointerDown={(e) => { const el = field(e); if (el instanceof HTMLSelectElement) held.current = el; }}
      onFocus={(e) => {
        const el = field(e);
        if (!el) return;
        if (el instanceof HTMLSelectElement) held.current = el;
        el.dataset.was = text(el);
        // Selected once the click has placed the caret, or at the first key if that comes sooner: selected later, the next key would replace what was typed, a minus first.
        if (el.isContentEditable && numeric(el)) {
          toSelect.current = el;
          requestAnimationFrame(() => { if (toSelect.current === el) { toSelect.current = null; if (document.activeElement === el) getSelection()?.selectAllChildren(el); } });
        }
      }}
      onKeyDown={(e) => {
        const el = field(e);
        if (!el?.isContentEditable) return;
        e.stopPropagation();
        if (toSelect.current === el) { toSelect.current = null; getSelection()?.selectAllChildren(el); }
        if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && el.dataset.ed !== 'intro' && el.dataset.ed !== 'closing')) { e.preventDefault(); el.blur(); }
      }}
      onMouseDown={(e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); }}
      onClick={(e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ia]');
        if (!b) return;
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable && active.dataset.ed) onEdit?.(active.dataset.ed, text(active), true);
        const focus = onAction?.(b.dataset.ia!, Number(b.dataset.k ?? -1));
        if (focus) refocus.current = focus;
      }}
    />
  );
}
