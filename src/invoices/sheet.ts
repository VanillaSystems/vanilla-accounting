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
import { DEFAULT_UNITS, isItem, unitWord, type Address, type DocumentKind, type CustomerFields, type Exemption, type InvoiceCurrency, type InvoiceLanguage, type InvoiceLayout, type InvoiceLine, type InvoiceRole, type Prices, type Sender, type UnitDef } from './model.js';
import { isQrBillIban, prettyReference } from '../providers/qr-bill/reference.js';
import { optionsOf, pricedGross, priced, revenueVatCode, totals } from './rules.js';
import { TEXTS, formatAmount, formatDate, formatQuantity, kindTitle, type InvoiceTexts } from './texts.js';
import { chargesVat, invoiceActivities, invoiceRates, invoicing } from '../engines/index.js';

/** Everything a sheet shows, whatever document it is: a draft, an issued invoice, a credit note, a reminder, a cancellation notice. */
export interface SheetData {
  /** Every kind prints on the same sheet; an Angebot, Auftrag and Lieferschein carry no payment part, a Lieferschein no prices. */
  kind: DocumentKind;
  /** An Auftrag printed as Auftragsbestätigung (absent) or Proformarechnung. */
  printAs?: 'confirmation' | 'proforma';
  /** An Angebot's last day. */
  validUntil?: string;
  /** The customer's own order reference. */
  ordered?: string;
  language: InvoiceLanguage;
  /** Absent on a draft: the title says "Entwurf" and no QR-bill is printed. */
  number?: string;
  /** A reminder's title (its level's): the sheet's title becomes "1. Mahnung · Rechnung …". */
  reminderTitle?: string;
  /** A Zahlungsaufforderung of a retention: the title becomes «Zahlungsaufforderung · Rechnung …». */
  instalment?: boolean;
  /** A Teil- or Schlussrechnung: its title. */
  role?: InvoiceRole;
  /** A Rechnung's retention: printed below the total with what is paid now, which its QR-bill asks for. */
  retention?: { percent: number; until: string; amount: number };
  date: string;
  /** The day or period of the supply when it is not the invoice date. */
  supplied?: { from: string; to?: string };
  dueDate?: string;
  currency: InvoiceCurrency;
  customer: CustomerFields;
  sender: Omit<Sender, 'payTo'> & { payTo?: Sender['payTo'] };
  lines: InvoiceLine[];
  /** Net or gross prices; absent: net. */
  prices?: Prices;
  /** The firm's units with their words; absent: the app's defaults. A unit no list names prints as its id. */
  units?: readonly UnitDef[];
  exemption?: Exemption;
  /** A draft's greeting line above the intro (Firma › Rechnungslayout); an issued invoice has it in its intro. */
  salutation?: string;
  intro: string;
  closing: string;
  /** The title above the positions in place of the kind's word (a Vorlage's, a draft's own). */
  title?: string;
  layout: InvoiceLayout;
  /** The letterhead PDF (a path under the workspace) the PDF is printed on: each sheet leaves its background to it. */
  letterhead?: string;
  /** The logo as a URL the page can load (a data: URI for the PDF). */
  logoSrc?: string;
  reference?: string;
  /** What the QR-bill asks for when it is not the total: an open rest, a reminder with its fee. */
  due?: { paidSoFar: number; fee: number; open: number; interest?: { amount: number; rate: number; from: string; days: number }; held?: { amount: number; until: string; percent: number }; notAsked?: number };
  /** A credit note: the invoice it credits and what happens with the money. */
  credit?: { number: string; date: string; gross: number; paid: number; paidDate?: string; settlement?: 'refund' | 'offset' };
  cancelled?: { date: string; reason: string };
  /** The payment terms printed below the totals, with their Skonto: only when they offer one (net terms: the closing says the days). */
  terms?: { text: string; skonto?: { percent: number; until: string; amount: number; pays: number } };
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
    words: {
      newCustomer: string; chooseCustomer: string; addLine: string; removeLine: string; intro: string; closing: string; desc: string; noExemption: string; supplied: string;
      /** `activity`: «Tätigkeit», for a net rate the firm gave no label (the picker of a firm with two net rates). */
      activity?: string;
      /** The other kinds of position (spec 4.4.3), a page break's marker on screen, and the handle that moves a position (drag, or Alt+↑/↓). */
      addText: string; addSubtotal: string; addDiscount: string; addPageBreak: string; pageBreak: string; move: string;
      title: string; plain: string; percent: string; amount: string; lineDiscount: string;
      /** An Angebot's or Auftrag's position: an ordinary one, or an option (spec 4.4.1). */
      position?: string; option?: string;
      /** «＋ Artikel» (the picker), «＋ Gruppe», a group's title placeholder, the revenue account of a position on screen and an Artikel's code. */
      addArticle?: string; addGroup?: string; group?: string; account?: string; code?: string;
    };
    /** The revenue account a position without its own books on (the contact's, else the settings'): the account field's placeholder. */
    revenueAccount?: string;
  };
}

/** `pagebreak`: the next block starts a new sheet (a Seitenumbruch position); a row after it repeats the table header. */
export interface Block { html: string; head?: boolean; row?: boolean; pagebreak?: boolean }

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
  if (!payTo || d.kind !== 'invoice' || d.cancelled) return undefined;
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
  const base = d.title?.trim() || kindTitle(L, d.kind, d.printAs, d.role);
  return d.reminderTitle ? `${d.reminderTitle} · ${base}` : d.instalment ? `${L.instalment} · ${base}` : base;
}

/** The code a position's revenue books with, shown on a draft's screen; none where the jurisdiction has none for it (a firm not registered). */
function codeOf(rate: number, exemption: Exemption | undefined, activity: 1 | 2 | undefined): string | undefined {
  try { return revenueVatCode(rate, exemption, activity ?? 1); } catch { return undefined; }
}

/** The blocks of the sheet's flowing part, in reading order; each table row is a block so a long table breaks between rows. */
export function sheetBlocks(d: SheetData): Block[] {
  const L = TEXTS[d.language];
  const show = d.layout.show;
  const ed = d.screen?.edit;
  const draft = ed?.scope === 'draft';
  const n = (x: number) => formatAmount(x, d.language);
  const t = totals(d);
  const amounts = priced(d).amounts;
  // A Lieferschein prints what was delivered, never a price (spec 4.4.1).
  const priceless = d.kind === 'delivery-note';
  // An option is marked on an Angebot or Auftrag; its draft offers the switch.
  const options = d.kind === 'quote' || d.kind === 'sales-order';
  const items = d.lines.filter(isItem);
  // A document without VAT (a firm not registered) prints no rate column, no VAT line and no net total: what an invoice shows, the firm owes. An issued document says so by its lines, a draft by the firm's setup.
  const withVat = draft ? chargesVat() : items.some((l) => l.vatRate > 0) || !!d.exemption;
  const vatColumn = (show.vatColumn || draft) && withVat && !priceless;
  const cols: Array<[string, string]> = priceless ? [['d', L.desc], ['q', L.qty]]
    : [['d', L.desc], ...(show.quantity ? [['q', L.qty], ['p', L.price]] as Array<[string, string]> : []), ...(vatColumn ? [['v', L.vat]] as Array<[string, string]> : []), ['a', `${L.amount} ${d.currency}`]];
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
    d.kind === 'quote' && d.validUntil ? `<span>${L.validUntil} ${date('validUntil', d.validUntil)}</span>` : '',
    d.ordered ? `<span>${L.yourOrder} ${esc(d.ordered)}</span>` : '',
    show.customerVatId && d.customer.vatId && d.customer.address.country !== 'CH' ? `<span>${L.yourVat} ${esc(d.customer.vatId)}</span>` : '',
  ].join('');
  B.push({ html: `<h3>${esc(sheetTitle(d, L))} ${d.number ? esc(d.number) : `<span class="draftno">${L.draft}</span>`}</h3><div class="meta">${meta}</div>` });
  if (show.intro && d.salutation) B.push({ html: `<p class="intro salutation">${esc(d.salutation)}</p>` });
  if (show.intro) B.push(...texts('intro', d.intro));
  B.push({ html: `<table class="tb">${colgroup}<thead><tr>${cols.map(([k, x]) => `<th class="${k === 'd' ? '' : 'r'}">${esc(x)}</th>`).join('')}</tr></thead></table>`, head: true });
  // Which of its two net rates a line's revenue is booked at: the screen's choice, never on paper (#504).
  const activities = draft ? invoiceActivities().map((r, i): [string, string] => [String(i + 1), `${r.label ?? `${ed.words.activity ?? ''} ${i + 1}`.trim()} ${r.rate} %`]) : [];
  const units = d.units ?? DEFAULT_UNITS;
  const unit = (id: string | undefined) => (id ? unitWord(units, id, d.language) : '');
  const row = (k: number, cls: string, cells: string) => `<table class="tb">${colgroup}<tbody><tr class="${cls}"${draft ? ` data-row="${k}"` : ''}>${cells}</tr></tbody></table>`;
  // On screen, each position of a draft has a handle to move it (drag, or Alt+↑/↓) and a button to remove it.
  const tools = (k: number) => (draft
    ? `<button type="button" class="edmv scr" data-ia="move" data-k="${k}" draggable="true" title="${esc(ed.words.move)}" aria-label="${esc(ed.words.move)}">⠿</button>${d.lines.length > 1 || !isItem(d.lines[k]) ? `<button type="button" class="edx scr" data-ia="rmline" data-k="${k}" title="${esc(ed.words.removeLine)}" aria-label="${esc(ed.words.removeLine)}">×</button>` : ''}`
    : '');
  const span = cols.length;
  const pct = (x: number) => `${formatQuantity(x)} %`;
  d.lines.forEach((l, k) => {
    if (l.kind === 'pagebreak') {
      B.push({ pagebreak: true, html: draft ? row(k, 'pbreak scr', `<td colspan="${span}"><span>${esc(ed.words.pageBreak)}</span>${tools(k)}</td>`) : '' });
      return;
    }
    if (l.kind === 'text') {
      const style = draft ? ` ${pick(`l:${k}:style`, [['plain', ed.words.plain], ['title', ed.words.title]], l.style ?? 'plain')}` : '';
      const text = draft ? editable(`l:${k}:text`, esc(l.text), ed.words.desc, 'blocked') : esc(l.text);
      B.push({ row: true, html: row(k, `ltext${l.style === 'title' ? ' title' : ''}`, `<td colspan="${span}">${text}${style ? `<span class="edstyle scr">${style}</span>` : ''}${tools(k)}</td>`) });
      return;
    }
    if (l.kind === 'group') {
      // A Gruppe: its title and the sum of its sub-positions (a Lieferschein: the title alone).
      const title = draft ? editable(`l:${k}:text`, esc(l.text), ed.words.group ?? ed.words.desc) : esc(l.text);
      B.push({ row: true, html: row(k, 'lgroup', priceless ? `<td colspan="${span}">${title}${tools(k)}</td>` : `<td colspan="${span - 1}">${title}</td><td class="r">${n(amounts[k] ?? 0)}${tools(k)}</td>`) });
      return;
    }
    if (l.kind === 'subtotal' && priceless) return;
    if (l.kind === 'subtotal') {
      const label = draft ? editable(`l:${k}:text`, esc(l.text), ed.words.desc) : esc(l.text);
      B.push({ row: true, html: row(k, 'lsub', `<td colspan="${span - 1}">${label}</td><td class="r">${n(amounts[k] ?? 0)}${tools(k)}</td>`) });
      return;
    }
    if (l.kind === 'discount' && priceless) return;
    if (l.kind === 'discount') {
      const label = draft ? editable(`l:${k}:text`, esc(l.text), ed.words.desc) : esc(l.text);
      const value = draft
        ? `${editable(`l:${k}:discount`, l.percent !== undefined ? esc(formatQuantity(l.percent)) : l.amount !== undefined ? n(l.amount) : '', '0')} ${pick(`l:${k}:dmode`, [['percent', '%'], ['amount', d.currency]], l.amount !== undefined ? 'amount' : 'percent')}`
        : l.percent !== undefined ? pct(l.percent) : '';
      B.push({ row: true, html: row(k, 'ldisc', `<td colspan="${span - 1}">${label}${value ? ` <span class="dval">${value}</span>` : ''}</td><td class="r">${n(amounts[k] ?? 0)}${tools(k)}</td>`) });
      return;
    }
    const incl = l.vatRate > 0 && pricedGross(l, d.prices);
    // An Artikel position prints its code before its text where the layout shows codes; a draft's is editable.
    const code = draft ? (l.kind === 'article' ? `<span class="lcode">${editable(`l:${k}:code`, esc(l.code ?? ''), ed.words.code ?? '')}</span> ` : '')
      : show.articleCode && l.code ? `<span class="lcode">${esc(l.code)}</span> ` : '';
    const sub = l.inGroup ? ' lingrp' : '';
    const off = l.discount ? `<span class="loff">${esc(L.lineDiscount(pct(l.discount)))}</span>` : '';
    const opt = l.optional && options ? `<span class="lopt">${esc(L.option)}</span> ` : '';
    const optPick = draft && options ? `<span class="edstyle scr">${pick(`l:${k}:optional`, [['no', ed.words.position ?? ''], ['yes', ed.words.option ?? L.option]], l.optional ? 'yes' : 'no')}</span>` : '';
    if (priceless) {
      const qty = draft ? `${editable(`l:${k}:quantity`, esc(formatQuantity(l.quantity)))} ${esc(unit(l.unit))}` : esc(`${formatQuantity(l.quantity)}${l.unit ? ` ${unit(l.unit)}` : ''}`);
      B.push({ row: true, html: row(k, `litem${sub}`, `<td>${code}${draft ? editable(`l:${k}:text`, esc(l.text), ed.words.desc, 'blocked') : esc(l.text)}</td><td class="r">${qty}${tools(k)}</td>`) });
      return;
    }
    // A deduction of a Teilrechnung stays at what that one invoiced: shown, moved or removed, never changed (stages.ts).
    const cells = draft && !l.deducts
      ? {
        text: editable(`l:${k}:text`, esc(l.text), ed.words.desc, 'blocked'),
        qty: `${editable(`l:${k}:quantity`, esc(formatQuantity(l.quantity)))} ${pick(`l:${k}:unit`, [['', '–'], ...[...units.map((u): [string, string] => [u.id, u[d.language]]), ...(l.unit && !units.some((u) => u.id === l.unit) ? [[l.unit, l.unit] as [string, string]] : [])]], l.unit ?? '')}`,
        price: `${editable(`l:${k}:price`, n(l.price))}<span class="loff ed-off${l.discount ? ' on' : ''}">${esc(ed.words.lineDiscount)} ${editable(`l:${k}:discount`, l.discount ? esc(formatQuantity(l.discount)) : '', '0')} %</span>`,
        rate: pick(`l:${k}:vatRate`, invoiceRates().map((r): [string, string] => [String(r), `${r} %${r > 0 && incl ? ` ${L.included}` : ''}`]), String(l.vatRate))
          + (activities.length && l.vatRate > 0 ? `<span class="edact scr">${pick(`l:${k}:activity`, activities, String(l.activity ?? 1))}</span>` : ''),
      }
      : { text: `${opt}${esc(l.text)}${incl && !vatColumn ? ` (${l.vatRate} % ${L.included})` : ''}${off && !show.quantity ? off : ''}`, qty: esc(`${formatQuantity(l.quantity)}${l.unit ? ` ${unit(l.unit)}` : ''}`), price: `${n(l.price)}${off}`, rate: `${l.vatRate} %${incl ? ` ${L.included}` : ''}` };
    // On screen, the revenue account it books on (editable, empty: the contact's or the settings') and the code that follows from its rate (spec 4.4.3).
    const vatCode = draft ? codeOf(l.vatRate, d.exemption, l.activity) : undefined;
    const account = draft ? `<span class="edacc scr">${esc(ed.words.account ?? '')} ${editable(`l:${k}:account`, esc(l.account ?? ''), ed.revenueAccount ?? '')}${vatCode ? ` · <span class="mono">${esc(vatCode)}</span>` : ''}</span>` : '';
    if (draft) cells.text = `${opt}${code}${cells.text}${optPick}${account}`;
    else cells.text = `${code}${cells.text}`;
    B.push({ row: true, html: row(k, `litem${sub}${l.optional && options ? ' lopt-row' : ''}`, `<td>${cells.text}</td>${show.quantity ? `<td class="r">${cells.qty}</td><td class="r">${cells.price}</td>` : ''}${vatColumn ? `<td class="r">${cells.rate}</td>` : ''}<td class="r">${n(amounts[k] ?? 0)}${tools(k)}</td>`) });
  });
  if (draft) {
    const article: Array<[string, string]> = ed.words.addArticle ? [['addarticle', ed.words.addArticle]] : [];
    const group: Array<[string, string]> = ed.words.addGroup ? [['addgroup', ed.words.addGroup]] : [];
    const add: Array<[string, string]> = priceless ? [['addline', ed.words.addLine], ...article, ['addtext', ed.words.addText], ...group, ['addpagebreak', ed.words.addPageBreak]]
      : [['addline', ed.words.addLine], ...article, ['addtext', ed.words.addText], ...group, ['addsubtotal', ed.words.addSubtotal], ['adddiscount', ed.words.addDiscount], ['addpagebreak', ed.words.addPageBreak]];
    B.push({ html: `<div class="edadd scr">${add.map(([a, w]) => `<button type="button" data-ia="${a}">＋ ${esc(w)}</button>`).join('')}</div>` });
  }
  const rates = t.byRate.filter((r) => r.rate > 0).map((r) => `<div><span>${esc(L.vatOn(String(r.rate), n(r.net)))}</span><span>${n(r.vat)}</span></div>`).join('');
  const due = d.due && (d.due.paidSoFar || d.due.fee || d.due.interest || d.due.held || d.due.notAsked) ? [
    d.due.paidSoFar ? `<div><span>${L.paidSoFar}</span><span>${n(-d.due.paidSoFar)}</span></div>` : '',
    d.due.fee ? `<div><span>${L.fee}</span><span>${n(d.due.fee)}</span></div>` : '',
    // Default interest, a position without VAT: what is owed for paying late, not for a supply.
    // An amount typed by hand without a rate names no percent.
    d.due.interest ? `<div><span>${esc(d.due.interest.rate ? L.interest(String(d.due.interest.rate), formatDate(d.due.interest.from, d.language), d.due.interest.days) : L.interestWord)}</span><span>${n(d.due.interest.amount)}</span></div>` : '',
    // A retention not yet due stays out of what a reminder asks; what a Zahlungsaufforderung does not ask is named.
    d.due.held ? `<div><span>${esc(L.retention(formatQuantity(d.due.held.percent), formatDate(d.due.held.until, d.language)))}</span><span>${n(-d.due.held.amount)}</span></div>` : '',
    d.due.notAsked ? `<div><span>${esc(L.notAsked)}</span><span>${n(-d.due.notAsked)}</span></div>` : '',
    `<div class="tot"><span>${L.openNow} ${d.currency}</span><span>${n(d.due.open)}</span></div>`,
  ].join('') : '';
  const net = withVat ? `<div><span>${L.net}</span><span>${n(t.net)}</span></div>` : '';
  const opts = options ? optionsOf(d) : { n: 0, amount: 0 };
  const left = opts.n ? `<div class="optleft"><span>${esc(L.optionsLeftOut(opts.n, `${d.currency} ${n(opts.amount)}`))}</span></div>` : '';
  // A retention (spec 4.4.9): what is held back until its day, and what is paid now, which the QR-bill asks for.
  const held = d.retention && !d.due ? `<div><span>${esc(L.retention(formatQuantity(d.retention.percent), formatDate(d.retention.until, d.language)))}</span><span>${n(-d.retention.amount)}</span></div><div class="tot"><span>${L.payNow} ${d.currency}</span><span>${n(Math.round((t.gross - d.retention.amount) * 100) / 100)}</span></div>` : '';
  if (!priceless) B.push({ html: `<div class="sum">${net}${rates}<div class="tot"><span>${L.total} ${d.currency}</span><span>${n(t.gross)}</span></div>${held}${left}${due}</div>` });
  if (d.kind === 'credit-note' && d.credit) {
    const c = d.credit, credit = -t.gross, open = Math.round((c.gross - c.paid) * 100) / 100;
    const back = Math.max(0, Math.round((credit - open) * 100) / 100), A = (x: number) => `${d.currency} ${n(x)}`;
    const settled = back > 0 ? (c.settlement === 'offset' ? L.offset(A(back)) : L.refund(A(back))) : L.stillOpen(c.number, A(Math.round((open - credit) * 100) / 100));
    B.push({ html: `<div class="settle"><div><span>${esc(L.ofInvoice(c.number, formatDate(c.date, d.language)))}</span><span>${n(c.gross)}</span></div>${c.paid ? `<div><span>${L.paidOn(formatDate(c.paidDate ?? c.date, d.language))}</span><span>${n(-c.paid)}</span></div>` : ''}<div><span>${L.creditLine}</span><span>${n(-credit)}</span></div></div><p class="settled">${esc(settled)}</p>` });
  }
  if (d.terms?.skonto && !d.due) {
    const sk = d.terms.skonto;
    B.push({ html: `<p class="terms">${esc(d.terms.text)}<br>${esc(L.skontoLine(String(sk.percent), formatDate(sk.until, d.language), `${d.currency} ${n(sk.amount)}`, `${d.currency} ${n(sk.pays)}`))}</p>` });
  }
  // The reason for 0 % is a registered firm's: one that charges no VAT has none to give.
  if (priceless) { /* a Lieferschein names no VAT and no reason for 0 % */ }
  else if (draft && withVat && items.some((l) => l.vatRate === 0)) {
    const options: Array<[string, string]> = [...(d.exemption ? [] : [['', ed.words.noExemption] as [string, string]]), ['abroad', L.exemption.abroad], ['export', L.exemption.export]];
    B.push({ html: `<p class="abroad">${pick('exemption', options, d.exemption ?? '')}</p>` });
  } else if (d.exemption) B.push({ html: `<p class="abroad">${esc(L.exemption[d.exemption])}</p>` });
  const pay = payment(d);
  if (pay && !pay.qr && d.number) B.push({ html: `<p class="payinfo">${L.payment}: ${L.iban} ${esc(prettyIban(pay.iban))}${d.reference ? `, ${L.reference} ${esc(prettyReference(d.reference))}` : ''}</p>` });
  if (show.closing) B.push(...texts('closing', d.closing));
  return B;
}

/**
 * Block heights in mm → the blocks of each sheet (indices; -1 is the repeated table header), and
 * whether the QR-bill needs a sheet of its own. A page-break block ends its sheet; the next table
 * row starts the next under the repeated header.
 */
export function paginate(blocks: ReadonlyArray<Pick<Block, 'head' | 'row' | 'pagebreak'>>, mm: readonly number[], opts: { footer: boolean; qrBill: boolean }): { pages: number[][]; qrOwnPage: boolean } {
  const foot = opts.footer ? PAGE.footer : 0;
  const limit = PAGE.bottom - foot;
  const headIndex = blocks.findIndex((b) => b.head);
  const headMm = headIndex >= 0 ? mm[headIndex] : 0;
  const pages: number[][] = [[]];
  let y: number = PAGE.firstTop;
  let broken = false;
  // A page break ends its sheet only after a table row on it: one as the first position, or a second in a row, leaves no blank sheet and no lonely header.
  let rows = false;
  blocks.forEach((b, i) => {
    const keep = b.head ? mm[i + 1] ?? 0 : 0;
    if (b.pagebreak) {
      pages[pages.length - 1].push(i);
      if (!rows) return;
      pages.push([]);
      y = PAGE.nextTop;
      broken = true;
      rows = false;
      return;
    }
    if (y + mm[i] + keep > limit && pages[pages.length - 1].length) {
      pages.push([]);
      y = PAGE.nextTop;
      broken = true;
      rows = false;
    }
    if (broken && b.row && headIndex >= 0 && i > headIndex) { pages[pages.length - 1].push(-1); y += headMm; }
    broken = false;
    if (b.row) rows = true;
    pages[pages.length - 1].push(i);
    y += mm[i];
  });
  // A page break as the last position leaves no empty sheet behind.
  if (pages.length > 1 && pages[pages.length - 1].length === 0) pages.pop();
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
  const withVat = d.screen?.edit?.scope === 'draft' || !d.number ? chargesVat() : d.lines.some((l) => isItem(l) && l.vatRate > 0) || !!d.exemption;
  const uid = !s.uid ? '' : withVat ? `${esc(s.uid)} ${L.vatSuffix}` : esc(s.uid);
  const uidLabel = withVat ? L.vatNo : L.uidNo;
  const pageHead = (k: number) => `<div class="phead"><span>${esc(s.name)} · ${title}</span><span>${L.page(k, n)}</span></div>`;
  const footer = (k: number, qrHere = false) => show.footer && !qrHere
    ? `<div class="foot"><span>${[s.name, oneLine(s.address)].filter(Boolean).map(esc).join('<br>')}</span>${s.payTo ? `<span>${L.bank}${s.payTo.bank ? `: ${esc(s.payTo.bank)}` : ''}<br>${L.iban} ${esc(prettyIban(s.payTo.iban))}</span>` : ''}${s.uid ? `<span>${uidLabel}<br>${uid}</span>` : ''}${n > 1 ? `<span class="pno">${L.page(k, n)}</span>` : ''}</div>`
    : n > 1 ? `<div class="foot bare"><span class="pno">${L.page(k, n)}</span></div>` : '';
  const style = `--ivf:${FONT_STACK[layout.font]};--iva:${layout.accent};--lh:${LOGO_MM[layout.logoSize]}mm`;
  const sheet = (cls: string, inner: string) => `<div class="a4 ${cls}${d.letterhead ? ' lh' : ''}" style="${style}" lang="${d.language}">${inner}</div>`;
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

/**
 * What the QR-bill's payment part carries. Creditor and debtor go as structured addresses (street
 * and building number apart, postcode and town apart): swissqrbill writes them with address type S,
 * the only type the SIX guidelines allow since v2.3 (chapter 4.2.2); a second address line has no
 * field there and stays off the QR code.
 */
export function qrBillData(d: SheetData, iban: string) {
  const s = d.sender, c = d.customer;
  const party = (name: string, a: Address) => ({ name, address: a.street ?? '', ...(a.number ? { buildingNumber: a.number } : {}), zip: a.postcode, city: a.town, country: a.country });
  return {
    currency: d.currency,
    amount: d.due ? d.due.open : d.retention ? Math.round((totals(d).gross - d.retention.amount) * 100) / 100 : totals(d).gross,
    reference: d.reference,
    message: `${TEXTS[d.language].invoice} ${d.number}`,
    creditor: { ...party(s.name, s.address), account: iban.replace(/\s+/g, '') },
    ...(c.address.postcode && c.address.town ? { debtor: party(c.name, c.address) } : {}),
  };
}

/** The QR-bill: swissqrbill's SVG payment part and receipt; the horizontal cut line with its scissors is the sheet's. */
function qrBillHtml(d: SheetData, iban: string): string {
  const L = TEXTS[d.language];
  const svg = new SwissQRBill(qrBillData(d, iban), { language: d.language.toUpperCase() as 'DE' | 'FR' | 'IT' | 'EN', fontName: 'Liberation Sans', scissors: true }).toString();
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
/* On a letterhead the PDF's sheet is see-through: the letterhead is laid under it (src/invoices/letterhead.ts); the QR-bill stays white. */
@media print { .a4.lh { background: transparent } .a4.lh .qrb { background: #fff } }
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
.a4 tr.ltext td { border-bottom: 0; padding-bottom: .6mm; white-space: pre-line }
.a4 tr.ltext.title td { font-weight: 700; font-size: 10pt; padding-top: 3.5mm }
.a4 tr.lsub td { font-weight: 600; border-top: .3mm solid #9aa1ad }
.a4 tr.ldisc .dval { color: #5b6270 }
.a4 tr.lgroup td { font-weight: 700; border-bottom: .3mm solid #9aa1ad; padding-top: 3mm }
.a4 tr.lingrp td:first-child { padding-left: 4mm }
.a4 .lcode { font-variant-numeric: tabular-nums; color: #5b6270; margin-right: .6mm }
.a4 .loff { display: block; font-size: 7.5pt; color: #5b6270 }
.a4 .lopt { font-size: 7pt; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #5b6270; border: .2mm solid #9aa1ad; border-radius: .8mm; padding: 0 .8mm; margin-right: 1mm }
.a4 tr.lopt-row td { color: #5b6270 }
.a4 .sum .optleft { font-size: 7.5pt; color: #5b6270; padding-top: 1.4mm }
.a4 .sum, .a4 .settle { margin: 3mm 0 0 auto; width: 78mm }
.a4 .sum > div, .a4 .settle > div { display: flex; justify-content: space-between; gap: 4mm; padding: .8mm 1mm }
.a4 .sum .tot { border-top: .4mm solid var(--iva); margin-top: 1mm; padding-top: 1.6mm; font-weight: 700; font-size: 10.5pt }
.a4 .settle { font-size: 8pt; color: #5b6270; margin-top: 5mm }
.a4 .settled { font-weight: 600; margin: 4mm 0 0 }
.a4 .abroad, .a4 .payinfo, .a4 .terms { color: #5b6270; font-size: 8pt; margin: 5mm 0 0 }
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
