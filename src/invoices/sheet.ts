/**
 * The A4 invoice sheet (ADR 0012): one HTML renderer for the screen, editing in place and the
 * PDF. An invoice is a list of blocks (title, intro, each table row, totals, notes, closing);
 * each block is measured at its printed width by whoever holds a page (the browser in the UI,
 * Chromium for the PDF, MEASURE_SCRIPT), then `paginate` places them on sheets of 210 x 297 mm:
 * page 2 and later carry a page header and repeat the table header, a table header never ends a
 * page alone, and the QR-bill takes the bottom 105 mm of the last sheet, or a sheet of its own.
 * The sheet with the QR-bill has no footer, as Swiss invoices print it: the QR-bill names the
 * account and the header the VAT number, so a short invoice fits on one page.
 *
 * Pure strings, no Node module: the UI imports it as it is.
 */
import { SwissQRBill } from 'swissqrbill/svg';
import { UNITS, type Address, type CustomerFields, type Exemption, type InvoiceCurrency, type InvoiceLanguage, type InvoiceLayout, type InvoiceLine, type Sender } from './model.js';
import { isQrBillIban, prettyReference } from '../providers/qr-bill/reference.js';
import { lineAmount, totals } from './rules.js';
import { TEXTS, formatAmount, formatDate, formatQuantity, type InvoiceTexts } from './texts.js';
import { chargesVat, invoiceRates, invoicing } from '../engines/index.js';

/** Everything a sheet shows, whatever document it is: a draft, an issued invoice, a credit note, a reminder, a cancellation notice. */
export interface SheetData {
  kind: 'invoice' | 'credit-note';
  language: InvoiceLanguage;
  /** Absent on a draft: the title says "Entwurf" and no QR-bill is printed. */
  number?: string;
  /** A reminder's level: the title becomes "1. Mahnung · Rechnung …". */
  reminderLevel?: number;
  date: string;
  /** The day or period of the supply when it is not the invoice date. */
  supplied?: { from: string; to?: string };
  dueDate?: string;
  currency: InvoiceCurrency;
  customer: CustomerFields;
  sender: Omit<Sender, 'payTo'> & { payTo?: Sender['payTo'] };
  lines: InvoiceLine[];
  exemption?: Exemption;
  /** A draft's greeting line above the intro (Firma › Rechnungslayout); an issued invoice has it in its intro. */
  salutation?: string;
  intro: string;
  closing: string;
  layout: InvoiceLayout;
  /** The logo as a URL the page can load (a data: URI for the PDF). */
  logoSrc?: string;
  reference?: string;
  /** What the QR-bill asks for when it is not the total: an open rest, a reminder with its fee. */
  due?: { paidSoFar: number; fee: number; open: number };
  /** A credit note: the invoice it credits and what happens with the money. */
  credit?: { number: string; date: string; gross: number; paid: number; paidDate?: string; settlement?: 'refund' | 'offset' };
  cancelled?: { date: string; reason: string };
  /** On screen only, never in a PDF: what the UI adds to the sheet. */
  screen?: ScreenSheet;
}

/**
 * The sheet on screen: the QR-bill's place on a draft says what comes there, the envelope window
 * can be drawn, and a draft is edited in place. An editable field carries `data-ed` (a key the UI
 * reads back: `date`, `dueDate`, `intro`, `closing`, `customer`, `exemption`, `l:<line>:<field>`)
 * and an action button `data-ia` (`addline`, `rmline` with `data-k`). The words are the UI's.
 */
export interface ScreenSheet {
  qrPlaceholder: string;
  /** The C5 window as a frame, with this label. */
  windowGuide?: string;
  edit?: {
    /** `draft`: everything a draft holds; `texts`: only the texts above and below the table (a reminder, the layout's defaults). */
    scope: 'draft' | 'texts';
    customers: Array<{ id: string; name: string }>;
    customerId?: string;
    words: { newCustomer: string; chooseCustomer: string; addLine: string; removeLine: string; intro: string; closing: string; desc: string; noExemption: string; supplied: string };
  };
}

export interface Block { html: string; head?: boolean; row?: boolean }

/** In millimetres, as the mockup lays the sheet out. */
export const PAGE = { firstTop: 88, nextTop: 30, bottom: 297 - 14, footer: 11, qrBill: 105, cutLine: 5 } as const;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const editable = (key: string, html: string, ph = '', cls = '') =>
  `<span class="ed${cls ? ` ${cls}` : ''}" contenteditable="plaintext-only" spellcheck="false" data-ed="${esc(key)}"${ph ? ` data-ph="${esc(ph)}"` : ''}>${html}</span>`;
const pick = (key: string, options: Array<[string, string]>, value: string) =>
  `<select class="ed edsel" data-ed="${esc(key)}">${options.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const dmy = (iso: string) => iso.split('-').reverse().join('.');
/** A day, or a period from – to. */
export const suppliedText = (s: { from: string; to?: string }, date: (iso: string) => string): string => (s.to && s.to !== s.from ? `${date(s.from)} – ${date(s.to)}` : date(s.from));

const countryName = (code: string, lang: InvoiceLanguage): string => {
  try { return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code; } catch { return code; }
};

/** Where the house number comes before the street ("12 rue du Marché", "500 Mission Street"). */
export const NUMBER_FIRST: readonly string[] = ['FR', 'LU', 'GB', 'IE', 'US', 'CA', 'AU'];

/** The address lines as the post of the destination country wants them, the country last (not for Switzerland). */
export function addressLines(a: Address, lang: InvoiceLanguage): string[] {
  const parts = [a.street, a.number].filter(Boolean);
  const street = (NUMBER_FIRST.includes(a.country) ? parts.reverse() : parts).join(' ');
  const out = street ? [street] : [];
  if (a.line2) out.push(a.line2);
  if (a.country === 'GB' || a.country === 'IE') out.push(a.town, a.postcode);
  else if (['US', 'CA', 'AU'].includes(a.country)) out.push([a.town, [a.state, a.postcode].filter(Boolean).join(' ')].filter(Boolean).join(a.country === 'US' ? ', ' : ' '));
  else out.push(`${a.postcode} ${a.town}`.trim());
  if (a.country !== 'CH') out.push(countryName(a.country, lang).toUpperCase());
  return out.filter(Boolean);
}

/** The address on one line, its empty parts left out (a company not yet given its address). */
export const oneLine = (a: Address): string => [[a.street, a.number].filter(Boolean).join(' '), `${a.postcode ?? ''} ${a.town ?? ''}`.trim()].filter(Boolean).join(', ');
const withAddress = (name: string, a: Address, sep: string) => [name, oneLine(a)].filter(Boolean).join(sep);

/** Where the money goes, and whether the QR-bill can carry it (a Swiss or Liechtenstein IBAN). */
function payment(d: SheetData): { iban: string; qr: boolean } | undefined {
  const payTo = d.sender.payTo;
  if (!payTo || d.kind === 'credit-note' || d.cancelled) return undefined;
  const iban = payTo.qrIban ?? payTo.iban;
  return { iban, qr: !!d.number && !!d.reference && d.layout.show.qrBill && isQrBillIban(iban) };
}

/** The sheet ends with a QR-bill (printed, or its place kept on a draft): it takes the bottom 105 mm of the last sheet. */
export function hasQrBill(d: SheetData): boolean {
  const pay = payment(d);
  return !!pay?.qr || (d.kind === 'invoice' && !d.number && d.layout.show.qrBill && !!pay && isQrBillIban(pay.iban));
}

const prettyIban = (iban: string) => iban.replace(/\s+/g, '').replace(/(.{4})(?!$)/g, '$1 ');

export function sheetTitle(d: SheetData, L: InvoiceTexts = TEXTS[d.language]): string {
  const base = d.kind === 'credit-note' ? L.credit : L.invoice;
  return d.reminderLevel ? `${L.reminder(d.reminderLevel)} · ${base}` : base;
}

/** The blocks of the sheet's flowing part, in reading order; each table row is a block so a long table breaks between rows. */
export function sheetBlocks(d: SheetData): Block[] {
  const L = TEXTS[d.language];
  const show = d.layout.show;
  const ed = d.screen?.edit;
  const draft = ed?.scope === 'draft';
  const n = (x: number) => formatAmount(x, d.language);
  const t = totals(d.lines);
  // A document without VAT (a firm not registered) prints no rate column, no VAT line and no net total: what an invoice shows, the firm owes. An issued document says so by its lines, a draft by the firm's setup.
  const withVat = draft ? chargesVat() : d.lines.some((l) => l.vatRate > 0) || !!d.exemption;
  const vatColumn = (show.vatColumn || draft) && withVat;
  const cols: Array<[string, string]> = [['d', L.desc], ...(show.quantity ? [['q', L.qty], ['p', L.price]] as Array<[string, string]> : []), ...(vatColumn ? [['v', L.vat]] as Array<[string, string]> : []), ['a', `${L.amount} ${d.currency}`]];
  const colgroup = `<colgroup>${cols.map(([k]) => `<col class="c${k}">`).join('')}</colgroup>`;
  const B: Block[] = [];
  const paras = (text: string, cls: string) => text.split(/\n\s*\n/).filter((x) => x.trim()).map((x) => ({ html: `<p class="${cls}">${esc(x.trim())}</p>` }));
  const texts = (key: 'intro' | 'closing', text: string) => (ed ? [{ html: `<p class="${key}">${editable(key, esc(text), ed.words[key], 'blocked')}</p>` }] : paras(text, key));
  const date = (key: string, iso: string) => (draft ? editable(key, dmy(iso)) : formatDate(iso, d.language));

  if (d.cancelled) B.push({ html: `<p class="cxnote">${esc(L.cancelledOn(formatDate(d.cancelled.date, d.language), d.cancelled.reason))}</p>` });
  const meta = [
    `<span>${L.date} ${date('date', d.date)}</span>`,
    draft ? `<span>${L.supplied} ${editable('supplied', d.supplied ? esc(suppliedText(d.supplied, dmy)) : '', ed.words.supplied)}</span>`
      : d.supplied ? `<span>${L.supplied} ${esc(suppliedText(d.supplied, (iso) => formatDate(iso, d.language)))}</span>` : '',
    d.kind === 'credit-note' && d.credit ? `<span>${L.forInvoice} ${esc(d.credit.number)}</span>` : d.dueDate ? `<span>${L.due} ${date('dueDate', d.dueDate)}</span>` : '',
    show.customerVatId && d.customer.vatId && d.customer.address.country !== 'CH' ? `<span>${L.yourVat} ${esc(d.customer.vatId)}</span>` : '',
  ].join('');
  B.push({ html: `<h3>${esc(sheetTitle(d, L))} ${d.number ? esc(d.number) : `<span class="draftno">${L.draft}</span>`}</h3><div class="meta">${meta}</div>` });
  if (show.intro && d.salutation) B.push({ html: `<p class="intro salutation">${esc(d.salutation)}</p>` });
  if (show.intro) B.push(...texts('intro', d.intro));
  B.push({ html: `<table class="tb">${colgroup}<thead><tr>${cols.map(([k, x]) => `<th class="${k === 'd' ? '' : 'r'}">${esc(x)}</th>`).join('')}</tr></thead></table>`, head: true });
  d.lines.forEach((l, k) => {
    const unit = l.unit ? ` ${L.units[l.unit]}` : '';
    const cells = draft
      ? {
        text: editable(`l:${k}:text`, esc(l.text), ed.words.desc, 'blocked'),
        qty: `${editable(`l:${k}:quantity`, esc(formatQuantity(l.quantity)))} ${pick(`l:${k}:unit`, [['', '–'], ...UNITS.map((u): [string, string] => [u, L.units[u]])], l.unit ?? '')}`,
        price: editable(`l:${k}:price`, n(l.price)),
        rate: pick(`l:${k}:vatRate`, invoiceRates().map((r): [string, string] => [String(r), `${r} %`]), String(l.vatRate)),
        remove: d.lines.length > 1 ? `<button type="button" class="edx scr" data-ia="rmline" data-k="${k}" title="${esc(ed.words.removeLine)}" aria-label="${esc(ed.words.removeLine)}">×</button>` : '',
      }
      : { text: esc(l.text), qty: esc(`${formatQuantity(l.quantity)}${unit}`), price: n(l.price), rate: `${l.vatRate} %`, remove: '' };
    B.push({ row: true, html: `<table class="tb">${colgroup}<tbody><tr><td>${cells.text}</td>${show.quantity ? `<td class="r">${cells.qty}</td><td class="r">${cells.price}</td>` : ''}${vatColumn ? `<td class="r">${cells.rate}</td>` : ''}<td class="r">${n(lineAmount(l))}${cells.remove}</td></tr></tbody></table>` });
  });
  if (draft) B.push({ html: `<div class="edadd scr"><button type="button" data-ia="addline">＋ ${esc(ed.words.addLine)}</button></div>` });
  const rates = t.byRate.filter((r) => r.rate > 0).map((r) => `<div><span>${esc(L.vatOn(String(r.rate), n(r.net)))}</span><span>${n(r.vat)}</span></div>`).join('');
  const due = d.due && (d.due.paidSoFar || d.due.fee) ? [
    d.due.paidSoFar ? `<div><span>${L.paidSoFar}</span><span>${n(-d.due.paidSoFar)}</span></div>` : '',
    d.due.fee ? `<div><span>${L.fee}</span><span>${n(d.due.fee)}</span></div>` : '',
    `<div class="tot"><span>${L.openNow} ${d.currency}</span><span>${n(d.due.open)}</span></div>`,
  ].join('') : '';
  const net = withVat ? `<div><span>${L.net}</span><span>${n(t.net)}</span></div>` : '';
  B.push({ html: `<div class="sum">${net}${rates}<div class="tot"><span>${L.total} ${d.currency}</span><span>${n(t.gross)}</span></div>${due}</div>` });
  if (d.kind === 'credit-note' && d.credit) {
    const c = d.credit, credit = -t.gross, open = Math.round((c.gross - c.paid) * 100) / 100;
    const back = Math.max(0, Math.round((credit - open) * 100) / 100), A = (x: number) => `${d.currency} ${n(x)}`;
    const settled = back > 0 ? (c.settlement === 'offset' ? L.offset(A(back)) : L.refund(A(back))) : L.stillOpen(c.number, A(Math.round((open - credit) * 100) / 100));
    B.push({ html: `<div class="settle"><div><span>${esc(L.ofInvoice(c.number, formatDate(c.date, d.language)))}</span><span>${n(c.gross)}</span></div>${c.paid ? `<div><span>${L.paidOn(formatDate(c.paidDate ?? c.date, d.language))}</span><span>${n(-c.paid)}</span></div>` : ''}<div><span>${L.creditLine}</span><span>${n(-credit)}</span></div></div><p class="settled">${esc(settled)}</p>` });
  }
  if (draft && d.lines.some((l) => l.vatRate === 0)) {
    const options: Array<[string, string]> = [...(d.exemption ? [] : [['', ed.words.noExemption] as [string, string]]), ['abroad', L.exemption.abroad], ['export', L.exemption.export]];
    B.push({ html: `<p class="abroad">${pick('exemption', options, d.exemption ?? '')}</p>` });
  } else if (d.exemption) B.push({ html: `<p class="abroad">${esc(L.exemption[d.exemption])}</p>` });
  const pay = payment(d);
  if (pay && !pay.qr && d.number) B.push({ html: `<p class="payinfo">${L.payment}: ${L.iban} ${esc(prettyIban(pay.iban))}${d.reference ? `, ${L.reference} ${esc(prettyReference(d.reference))}` : ''}</p>` });
  if (show.closing) B.push(...texts('closing', d.closing));
  return B;
}

/** Block heights in mm → the blocks of each sheet (indices; -1 is the repeated table header), and whether the QR-bill needs a sheet of its own. */
export function paginate(blocks: ReadonlyArray<Pick<Block, 'head' | 'row'>>, mm: readonly number[], opts: { footer: boolean; qrBill: boolean }): { pages: number[][]; qrOwnPage: boolean } {
  const foot = opts.footer ? PAGE.footer : 0;
  const limit = PAGE.bottom - foot;
  const headIndex = blocks.findIndex((b) => b.head);
  const headMm = headIndex >= 0 ? mm[headIndex] : 0;
  const pages: number[][] = [[]];
  let y: number = PAGE.firstTop;
  blocks.forEach((b, i) => {
    const keep = b.head ? mm[i + 1] ?? 0 : 0;
    if (y + mm[i] + keep > limit && pages[pages.length - 1].length) {
      pages.push([]);
      y = PAGE.nextTop;
      if (b.row) { pages[pages.length - 1].push(-1); y += headMm; }
    }
    pages[pages.length - 1].push(i);
    y += mm[i];
  });
  return { pages, qrOwnPage: opts.qrBill && y > 297 - PAGE.qrBill - PAGE.cutLine };
}

/** The sheets as HTML, from the blocks and their pagination. */
export function assembleSheets(d: SheetData, blocks: Block[], pagination: { pages: number[][]; qrOwnPage: boolean }): string {
  const L = TEXTS[d.language];
  const { layout } = d;
  const show = layout.show;
  const pay = payment(d);
  const qr = pay?.qr ? qrBillHtml(d, pay.iban) : hasQrBill(d) ? `<div class="qrb ph">${d.screen ? `<span>${esc(d.screen.qrPlaceholder)}</span>` : ''}</div>` : '';
  const { pages, qrOwnPage } = pagination;
  const n = pages.length + (qrOwnPage ? 1 : 0);
  const title = `${esc(sheetTitle(d, L))} ${d.number ? esc(d.number) : `<span class="draftno">${L.draft}</span>`}`;
  const s = d.sender;
  const withVat = d.screen?.edit?.scope === 'draft' || !d.number ? chargesVat() : d.lines.some((l) => l.vatRate > 0) || !!d.exemption;
  const uid = withVat ? `${esc(s.uid)} ${L.vatSuffix}` : esc(s.uid);
  const uidLabel = withVat ? L.vatNo : L.uidNo;
  const pageHead = (k: number) => `<div class="phead"><span>${esc(s.name)} · ${title}</span><span>${L.page(k, n)}</span></div>`;
  const footer = (k: number, qrHere = false) => show.footer && !qrHere
    ? `<div class="foot"><span>${[s.name, oneLine(s.address)].filter(Boolean).map(esc).join('<br>')}</span>${s.payTo ? `<span>${L.bank}${s.payTo.bank ? `: ${esc(s.payTo.bank)}` : ''}<br>${L.iban} ${esc(prettyIban(s.payTo.iban))}</span>` : ''}<span>${uidLabel}<br>${uid}</span>${n > 1 ? `<span class="pno">${L.page(k, n)}</span>` : ''}</div>`
    : n > 1 ? `<div class="foot bare"><span class="pno">${L.page(k, n)}</span></div>` : '';
  const style = `--ivf:${FONT_STACK[layout.font]};--iva:${layout.accent};--lh:${LOGO_MM[layout.logoSize]}mm`;
  const sheet = (cls: string, inner: string) => `<div class="a4 ${cls}" style="${style}" lang="${d.language}">${inner}</div>`;
  const cust = d.customer;
  const addr = addressLines(cust.address, d.language);
  const ed = d.screen?.edit;
  const name = ed?.scope === 'draft'
    ? pick('customer', [...(ed.customerId ? [] : [['', ed.words.chooseCustomer] as [string, string]]), ...ed.customers.map((c): [string, string] => [c.id, c.name]), ['+', `＋ ${ed.words.newCustomer}`]], ed.customerId ?? '')
    : esc(cust.name);
  const guide = d.screen?.windowGuide ? `<div class="winframe scr"><span>${esc(d.screen.windowGuide)}</span></div>` : '';
  const to = `${guide}<div class="to${addr.length + (cust.attn ? 1 : 0) > 4 ? ' many' : ''}">${show.senderLine ? `<span class="sl">${esc(withAddress(s.name, s.address, ' · '))}</span>` : ''}<span>${name}</span>${cust.attn ? `<span>${esc(cust.attn)}</span>` : ''}${addr.map((x) => `<span>${esc(x)}</span>`).join('')}</div>`;
  const logo = show.logo ? `<div class="logo pos-${layout.logoPosition} sz-${layout.logoSize}">${d.logoSrc ? `<img src="${esc(d.logoSrc)}" alt="${esc(s.name)}">` : `<span class="wordmark">${esc(s.name)}</span>`}</div>` : '';
  const from = `<div class="from"><b>${esc(s.name)}</b>${oneLine(s.address) ? `<span>${esc(oneLine(s.address))}</span>` : ''}${s.uid ? `<span>${uid}</span>` : ''}</div>`;
  let h = '';
  pages.forEach((ids, i) => {
    const k = i + 1;
    const withQr = !!qr && k === pages.length && !qrOwnPage;
    const top = i === 0 ? logo + from + to : pageHead(k);
    const body = ids.map((id) => (id === -1 ? blocks.find((b) => b.head)!.html : blocks[id].html)).join('');
    h += sheet(`win-${layout.window} logo-${show.logo ? layout.logoPosition : 'none'}${withQr ? ' has-qr' : ''}`,
      `${top}${d.cancelled ? `<div class="cxstamp">${L.stamp}</div>` : ''}<div class="ivmain" style="top:${i === 0 ? PAGE.firstTop : PAGE.nextTop}mm">${body}</div>${footer(k, withQr)}${withQr ? qr : ''}`);
  });
  if (qr && qrOwnPage) h += sheet('has-qr', `${pageHead(n)}${footer(n, true)}${qr}`);
  return h;
}

/** The QR-bill: swissqrbill's SVG payment part and receipt; the horizontal cut line with its scissors is the sheet's. */
function qrBillHtml(d: SheetData, iban: string): string {
  const L = TEXTS[d.language];
  const s = d.sender, c = d.customer;
  const amount = d.due ? d.due.open : totals(d.lines).gross;
  const party = (name: string, a: Address) => ({ name, address: a.street ?? '', ...(a.number ? { buildingNumber: a.number } : {}), zip: a.postcode, city: a.town, country: a.country });
  const svg = new SwissQRBill({
    currency: d.currency,
    amount,
    reference: d.reference,
    message: `${L.invoice} ${d.number}`,
    creditor: { ...party(s.name, s.address), account: iban.replace(/\s+/g, '') },
    ...(c.address.postcode && c.address.town ? { debtor: party(c.name, c.address) } : {}),
  }, { language: d.language.toUpperCase() as 'DE' | 'FR' | 'IT' | 'EN', fontName: 'Liberation Sans', scissors: true }).toString();
  return `<div class="qrb"><div class="cut">${L.cut}</div><span class="hsc">✂</span>${svg}</div>`;
}

/** Each block's advance in mm, read in a page holding `measureHtml`; resolves once the fonts are in. */
export const MEASURE_SCRIPT = `(async () => {
  await document.fonts.ready;
  const m = document.querySelector('.ivmeasure');
  const els = [...m.querySelectorAll('.ivblk')];
  const end = m.querySelector('.ivmain').getBoundingClientRect().bottom;
  const pxmm = m.querySelector('.a4').getBoundingClientRect().height / 297;
  return els.map((e, k) => ((els[k + 1] ? els[k + 1].getBoundingClientRect().top : end) - e.getBoundingClientRect().top) / pxmm);
})()`;

/** The blocks off screen at their printed width, for MEASURE_SCRIPT. */
export function measureHtml(d: SheetData, blocks: Block[]): string {
  const style = `--ivf:${FONT_STACK[d.layout.font]};--iva:${d.layout.accent}`;
  return `<div class="ivmeasure" aria-hidden="true"><div class="a4" style="${style}" lang="${d.language}"><div class="ivmain">${blocks.map((b) => `<div class="ivblk">${b.html}</div>`).join('')}</div></div></div>`;
}

/** A standalone HTML document: the sheet CSS, the fonts (@font-face rules), and `body`. */
export function sheetDocument(body: string, fontCss: string, title: string, lang: InvoiceLanguage): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${fontCss}\n${SHEET_CSS}</style></head><body>${body}</body></html>`;
}

const FONT_STACK: Record<InvoiceLayout['font'], string> = {
  Inter: "'Inter', 'Liberation Sans', Arial, sans-serif",
  Helvetica: "'Liberation Sans', Helvetica, Arial, sans-serif",
};
const LOGO_MM = { s: 10, m: 15, l: 21 } as const;

/** The sheet's CSS, the mockup's: Swiss C5 window 47 to 81 mm from the top, 117 to 196 mm (right) or 20 to 95 mm (left) from the left edge. */
export const SHEET_CSS = `
@page { size: A4; margin: 0 }
html, body { margin: 0 }
@media print { .a4 { box-shadow: none !important; margin: 0 !important } }
.a4 { --ivf: 'Inter', Arial, sans-serif; --iva: #141a26; width: 210mm; height: 297mm; position: relative; background: #fff; color: #141a26; font-family: var(--ivf); font-size: 9.5pt; line-height: 1.4; overflow: hidden; font-variant-numeric: tabular-nums; text-align: left; break-after: page; box-sizing: border-box }
.a4:last-child { break-after: auto }
.a4 .logo { position: absolute; top: 15mm; display: block; height: var(--lh, 15mm) }
.a4 .logo.pos-left { left: 20mm } .a4 .logo.pos-center { left: 50%; transform: translateX(-50%) } .a4 .logo.pos-right { right: 20mm }
.a4 .logo img { height: 100%; width: auto; max-width: 90mm; display: block }
.a4 .wordmark { font-size: 15pt; font-weight: 700; color: var(--iva); white-space: nowrap; line-height: 1 }
.a4 .from { position: absolute; top: 16mm; right: 20mm; text-align: right; font-size: 7.5pt; line-height: 1.45; color: #5b6270; display: flex; flex-direction: column }
.a4 .from b { color: #141a26; font-weight: 600 }
.a4.logo-right .from { right: auto; left: 20mm; text-align: left }
.a4.logo-center .from { top: calc(15mm + var(--lh, 15mm) + 3mm); right: 0; left: 0; text-align: center; flex-direction: row; justify-content: center; gap: 3mm }
.a4 .to { position: absolute; top: 52mm; left: 118mm; width: 76mm; max-height: 28mm; display: flex; flex-direction: column; font-size: 10pt; line-height: 1.3 }
.a4 .to.many { font-size: 9pt; line-height: 1.22 }
.a4.win-left .to { left: 22mm }
.a4 .to .sl { position: absolute; top: -4.6mm; font-size: 6.5pt; color: #5b6270; white-space: nowrap; border-bottom: .15mm solid #9aa1ad; max-width: 76mm; overflow: hidden; text-overflow: ellipsis }
.a4 .ivmain { position: absolute; left: 20mm; right: 20mm; top: 88mm }
.a4 .ivmain > p:first-child { margin-top: 0 }
.a4 h3 { font-family: inherit; font-size: 15pt; font-weight: 700; color: var(--iva); margin: 0 0 1.5mm; letter-spacing: -.01em }
.a4 .draftno { color: #8a909c; font-style: italic; font-weight: 400 }
.a4 .meta { display: flex; flex-wrap: wrap; gap: 1mm 6mm; color: #5b6270; font-size: 8.5pt; margin-bottom: 6mm }
.a4 .intro, .a4 .closing { white-space: pre-line }
.a4 .intro { margin: 0 0 4mm }
.a4 .closing { margin: 5mm 0 0 }
.a4 table { width: 100%; border-collapse: collapse; font-size: 9pt }
.a4 table.tb { table-layout: fixed }
.a4 col.cq { width: 22mm } .a4 col.cp { width: 24mm } .a4 col.cv { width: 15mm } .a4 col.ca { width: 30mm }
.a4 th { text-align: left; font-weight: 600; font-size: 7.5pt; color: #5b6270; border-bottom: .35mm solid var(--iva); padding: 1.2mm 1mm }
.a4 td { padding: 1.8mm 1mm; border-bottom: .2mm solid #e3e6ec; vertical-align: top; overflow-wrap: anywhere }
.a4 .r { text-align: right; white-space: nowrap }
.a4 .sum, .a4 .settle { margin: 3mm 0 0 auto; width: 78mm }
.a4 .sum > div, .a4 .settle > div { display: flex; justify-content: space-between; gap: 4mm; padding: .8mm 1mm }
.a4 .sum .tot { border-top: .4mm solid var(--iva); margin-top: 1mm; padding-top: 1.6mm; font-weight: 700; font-size: 10.5pt }
.a4 .settle { font-size: 8pt; color: #5b6270; margin-top: 5mm }
.a4 .settled { font-weight: 600; margin: 4mm 0 0 }
.a4 .abroad, .a4 .payinfo { color: #5b6270; font-size: 8pt; margin: 5mm 0 0 }
.a4 .cxnote { color: #9f1239; font-weight: 600; margin: 0 0 4mm }
.a4 .cxstamp { position: absolute; top: 120mm; left: 50%; transform: translateX(-50%) rotate(-18deg); font-size: 44pt; font-weight: 700; letter-spacing: .08em; color: rgba(159, 18, 57, .18); border: 1.2mm solid rgba(159, 18, 57, .18); padding: 2mm 8mm; pointer-events: none }
.a4 .phead { position: absolute; top: 15mm; left: 20mm; right: 20mm; display: flex; justify-content: space-between; font-size: 7.5pt; color: #5b6270; border-bottom: .2mm solid #e3e6ec; padding-bottom: 1.5mm }
.a4 .foot { position: absolute; left: 20mm; right: 20mm; bottom: 12mm; display: flex; gap: 10mm; font-size: 7pt; line-height: 1.45; color: #5b6270; border-top: .2mm solid #e3e6ec; padding-top: 2mm }
.a4 .foot .pno { margin-left: auto }
.a4 .foot.bare { border-top: 0 }
.a4.has-qr .foot { bottom: 110mm }
.a4 .qrb { position: absolute; left: 0; bottom: 0; width: 210mm; height: 105mm; border-top: .2mm dashed #000; font-family: 'Liberation Sans', Arial, sans-serif }
.a4 .qrb > svg { width: 210mm; height: 105mm; display: block }
.a4 .qrb text { font-family: 'Liberation Sans', Arial, sans-serif }
.a4 .qrb .cut { position: absolute; top: -4mm; left: 0; right: 0; text-align: center; font-size: 7pt; line-height: 1; color: #000 }
.a4 .qrb .hsc { position: absolute; left: 6mm; top: -2.4mm; font-size: 9pt; line-height: 1; background: #fff; padding: 0 .5mm; color: #000 }
.a4 .qrb.ph { border-top-color: #c7ccd4; background: repeating-linear-gradient(-45deg, #fafbfc 0 3mm, #f3f4f6 3mm 6mm); display: flex; align-items: center; justify-content: center; color: #8a909c; font-size: 9pt }
.ivmeasure { position: absolute; left: -10000px; top: 0; visibility: hidden; pointer-events: none }
.ivmeasure .ivmain { top: 0 }
`;
