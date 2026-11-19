/**
 * The A4 sheet on screen, laid out by the renderer the PDF uses (src/invoices/sheet.ts): the
 * blocks are measured here at their printed width once the invoice fonts are in, placed on pages
 * with `paginate` and written with `assembleSheets`; each page is then zoomed to the column.
 * A draft is edited on the sheet itself: a field reports what was typed (`final` when it is
 * left), a button its action. A position moves by its handle: dragged onto another row, or with
 * ↑/↓ on the handle and Alt+↑/↓ in any of its fields (`move`, with the row it goes to).
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
  /** May name the field to put the caret in once the sheet is laid out again (`mv:<k>`: the handle of row k). `to`: where `move` takes row k. */
  onAction?(action: string, k: number, to?: number): string | void;
  /** A field to put the caret in once laid out; `onFocused` says it is done. */
  focus?: string;
  onFocused?(): void;
}

export function Sheet({ data, editing, className, onEdit, onAction, focus, onFocused }: SheetProps) {
  const [fonts, setFonts] = useState(false);
  const [html, setHtml] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const refocus = useRef<string>();
  const selectAll = useRef(false);
  // A select the person has open (its list, or its keys) is never replaced under them: a re-layout
  // waits until it is left, unless its own change set it off (r5h-22, corner-44: the unit, then the
  // VAT rate 0.6 s later, and the open VAT list was swapped for a new one, so its choice was lost).
  const held = useRef<HTMLSelectElement | null>(null);
  const ownChange = useRef(false);
  const waiting = useRef<string>();
  // A number field just entered: its first key replaces what it shows, also when it comes before the
  // frame that selects it (F14: a quantity of 1 typed over at once as 12 became 121 or 2).
  const fresh = useRef<HTMLElement | null>(null);

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
    // A position just added: its text is selected, so what she types replaces «Neue Position».
    const fresh = selectAll.current && key === refocus.current;
    refocus.current = undefined;
    selectAll.current = false;
    if (focus && html) onFocused?.();
    const handle = key ? /^mv:(\d+)$/.exec(key) : null;
    const next = !key ? null : handle ? box.querySelector<HTMLElement>(`[data-ia="move"][data-k="${handle[1]}"]`) : box.querySelector<HTMLElement>(`[data-ed="${CSS.escape(key)}"]`);
    if (next) {
      next.focus();
      if (next.isContentEditable) { const sel = getSelection(); sel?.selectAllChildren(next); if (!focus && !fresh && !numeric(next)) sel?.collapseToEnd(); }
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
  const act = useRef(onAction);
  act.current = onAction;
  /** Row `from` a step to `to` (Alt+↑/↓, `move`) or dropped on row `to` (`drop`), the field being typed in saved first; the caret follows the row. */
  const move = (from: number, to: number, how: 'move' | 'drop' = 'move') => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.isContentEditable && active.dataset.ed) onEdit?.(active.dataset.ed, text(active), true);
    const focus = act.current?.(how, from, to);
    if (focus) refocus.current = focus;
  };
  const dragging = useRef<number | null>(null);
  const rowOf = (el: EventTarget | null) => (el as HTMLElement | null)?.closest?.<HTMLElement>('tr[data-row]') ?? null;
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
      onPointerDown={(e) => { const el = field(e); if (el instanceof HTMLSelectElement) held.current = el; if (el && el === document.activeElement) fresh.current = null; }}
      onFocus={(e) => {
        const el = field(e);
        if (!el) return;
        if (el instanceof HTMLSelectElement) held.current = el;
        el.dataset.was = text(el);
        if (el.isContentEditable && numeric(el)) {
          fresh.current = el;
          requestAnimationFrame(() => { if (fresh.current === el && document.activeElement === el) getSelection()?.selectAllChildren(el); });
        }
      }}
      onKeyDown={(e) => {
        const handle = (e.target as HTMLElement).closest?.<HTMLElement>('[data-ia="move"]');
        const at = handle ? Number(handle.dataset.k) : Number(/^l:(\d+):/.exec(field(e)?.dataset.ed ?? '')?.[1] ?? NaN);
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && Number.isInteger(at) && (handle || e.altKey)) {
          e.preventDefault();
          e.stopPropagation();
          move(at, at + (e.key === 'ArrowUp' ? -1 : 1));
          return;
        }
        const el = field(e);
        if (!el?.isContentEditable) return;
        e.stopPropagation();
        if (fresh.current === el) { fresh.current = null; if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) getSelection()?.selectAllChildren(el); }
        if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && el.dataset.ed !== 'intro' && el.dataset.ed !== 'closing')) { e.preventDefault(); el.blur(); }
      }}
      onMouseDown={(e) => { const b = (e.target as HTMLElement).closest('button'); if (b && b.dataset.ia !== 'move') e.preventDefault(); }}
      onDragStart={(e) => {
        const handle = (e.target as HTMLElement).closest?.<HTMLElement>('[data-ia="move"]');
        if (!handle) return;
        dragging.current = Number(handle.dataset.k);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', handle.dataset.k ?? '');
        const tr = rowOf(handle);
        if (tr) e.dataTransfer.setDragImage(tr, 12, 12);
      }}
      onDragOver={(e) => {
        const tr = rowOf(e.target);
        if (dragging.current === null || !tr) return;
        e.preventDefault();
        for (const x of ref.current?.querySelectorAll('tr.dropat') ?? []) if (x !== tr) x.classList.remove('dropat');
        tr.classList.add('dropat');
      }}
      onDragEnd={() => { dragging.current = null; for (const x of ref.current?.querySelectorAll('tr.dropat') ?? []) x.classList.remove('dropat'); }}
      onDrop={(e) => {
        const tr = rowOf(e.target);
        const from = dragging.current;
        dragging.current = null;
        for (const x of ref.current?.querySelectorAll('tr.dropat') ?? []) x.classList.remove('dropat');
        if (from === null || !tr) return;
        e.preventDefault();
        move(from, Number(tr.dataset.row), 'drop');
      }}
      onClick={(e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ia]');
        if (!b || b.dataset.ia === 'move') return;
        const active = document.activeElement as HTMLElement | null;
        if (active?.isContentEditable && active.dataset.ed) onEdit?.(active.dataset.ed, text(active), true);
        // An add button names no position: the one the person is in (the field that keeps the focus) is where it goes;
        // the caret in the first position's text, unchanged since it got there (a new draft puts it there), names none,
        // so an untouched first item gives way (insertLine).
        const untouched = active?.dataset.ed === 'l:0:text' && text(active) === (active.dataset.was ?? '');
        const inLine = untouched ? undefined : /^l:(\d+):/.exec(active?.dataset.ed ?? '')?.[1];
        const focus = onAction?.(b.dataset.ia!, Number(b.dataset.k ?? inLine ?? -1));
        if (focus) { refocus.current = focus; selectAll.current = b.dataset.ia!.startsWith('add'); }
      }}
    />
  );
}
