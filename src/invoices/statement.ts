/**
 * The Kontoauszug of a contact (docs/specs/invoicing.md 4.4.5, P3.7): its Rechnungen, Gutschriften,
 * payments, write-offs and Stornos of a period, with the balance before, after each row and at the
 * end, per currency; and the items open at its end. It books nothing.
 *
 * The balance is that of Offene Posten (src/invoices/lists.ts openItems, rules.ts openOn) on every day,
 * by construction: each Rechnung starts at its total on its date, and each later event takes off what
 * it took off then, never more than was open (a payment beyond it is named as such, `beyond`), so the
 * sum of a Rechnung's rows up to a day is its `openOn` of that day.
 */
import { fromRappen, toRappen } from '../accounting/rappen.js';
import type { InvoiceCurrency, InvoiceLanguage, Issued, Invoice, WriteOffReason } from './model.js';
import { creditNotesOf, totals } from './rules.js';
import { TEXTS, formatAmount, formatDate } from './texts.js';

export type StatementRowKind = 'invoice' | 'credit-note' | 'payment' | 'write-off' | 'cancellation';

export interface StatementRow {
  date: string;
  kind: StatementRowKind;
  /** The Rechnung the row is of. */
  invoiceId: string;
  /** The document it names: the Rechnung's number, or a Gutschrift's. */
  number: string;
  /** The Rechnung's number when the row is a Gutschrift of it. */
  of?: string;
  reason?: WriteOffReason;
  /** What it adds (a Rechnung) or takes off (the rest), in the Rechnung's currency. */
  debit: number;
  credit: number;
  /** A payment or Gutschrift beyond what was open: the part it did not take off (a Kundenguthaben). */
  beyond?: number;
  balance: number;
}

export interface StatementSection {
  currency: InvoiceCurrency;
  opening: number;
  rows: StatementRow[];
  closing: number;
  /** The Rechnungen open at the end, oldest first: what Offene Posten lists for the contact. */
  open: Array<{ invoiceId: string; number: string; date: string; dueDate: string; gross: number; open: number }>;
}

export interface Statement { contactId: string; from: string; to: string; sections: StatementSection[] }

interface Event { date: string; order: number; kind: StatementRowKind; number: string; of?: string; reason?: WriteOffReason; amount: number }

/** A Rechnung's events in order: its issue, then what took something off it, each by its own date. */
function eventsOf(inv: Issued, invoices: readonly Invoice[]): Event[] {
  const ev: Event[] = [{ date: inv.date, order: 0, kind: 'invoice', number: inv.number, amount: toRappen(totals(inv).gross) }];
  // Money in before the Rechnung's date counts from that date, as Offene Posten counts it (openOn).
  const on = (date: string) => (date < inv.date ? inv.date : date);
  for (const p of inv.payments) ev.push({ date: on(p.date), order: 1, kind: 'payment', number: inv.number, amount: toRappen(p.amount) });
  for (const c of creditNotesOf(inv, invoices)) ev.push({ date: on(c.date), order: 1, kind: 'credit-note', number: c.number, of: inv.number, amount: -toRappen(totals(c).gross) });
  for (const w of inv.writeOffs ?? []) ev.push({ date: on(w.date), order: 1, kind: 'write-off', number: inv.number, reason: w.reason, amount: toRappen(w.amount) });
  // A Storno takes off what is open then; it comes last on its day.
  if (inv.cancelled) ev.push({ date: on(inv.cancelled.date), order: 2, kind: 'cancellation', number: inv.number, amount: Number.POSITIVE_INFINITY });
  return ev.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
}

/** The Kontoauszug of `contactId` from `from` to `to` (both included). */
export function statementOf(invoices: readonly Invoice[], contactId: string, from: string, to: string): Statement {
  const mine = invoices.filter((i): i is Issued => !i.deleted && i.status === 'issued' && i.kind === 'invoice' && i.customerId === contactId && i.date <= to);
  const currencies = [...new Set(mine.map((i) => i.currency))].sort();
  const sections = currencies.map((currency): StatementSection => {
    let opening = 0;
    const rows: Array<Omit<StatementRow, 'balance'> & { delta: number }> = [];
    const open: StatementSection['open'] = [];
    for (const inv of mine.filter((i) => i.currency === currency)) {
      let left = 0;
      for (const e of eventsOf(inv, invoices)) {
        if (e.date > to) break;
        const delta = e.kind === 'invoice' ? e.amount : -Math.min(left, e.amount);
        left += delta;
        if (e.date < from) { opening += delta; continue; }
        const beyond = e.kind !== 'invoice' && e.kind !== 'cancellation' && e.amount > -delta ? e.amount + delta : 0;
        // A Storno of a Rechnung with nothing open left takes nothing off: no row.
        if (e.kind === 'cancellation' && delta === 0) continue;
        rows.push({
          date: e.date, kind: e.kind, invoiceId: inv.id, number: e.number, ...(e.of ? { of: e.of } : {}), ...(e.reason ? { reason: e.reason } : {}),
          debit: delta > 0 ? fromRappen(delta) : 0, credit: delta < 0 ? fromRappen(-delta) : 0, ...(beyond ? { beyond: fromRappen(beyond) } : {}), delta,
        });
      }
      if (left > 0) open.push({ invoiceId: inv.id, number: inv.number, date: inv.date, dueDate: inv.dueDate, gross: totals(inv).gross, open: fromRappen(left) });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'invoice' ? 0 : 1) - (b.kind === 'invoice' ? 0 : 1) || a.number.localeCompare(b.number));
    let balance = opening;
    const out = rows.map(({ delta, ...r }) => { balance += delta; return { ...r, balance: fromRappen(balance) }; });
    open.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
    return { currency: currency as InvoiceCurrency, opening: fromRappen(opening), rows: out, closing: fromRappen(balance), open };
  });
  return { contactId, from, to, sections };
}

/** A row's text in the document's language. */
export function rowText(r: StatementRow, lang: InvoiceLanguage): string {
  const L = TEXTS[lang].statement;
  const text = r.kind === 'invoice' ? L.invoice : r.kind === 'credit-note' ? L.credit(r.of ?? '') : r.kind === 'payment' ? L.payment : r.kind === 'cancellation' ? L.cancelled : L.writeOff[r.reason ?? 'loss'];
  return r.beyond ? `${text} (${L.beyond(formatAmount(r.beyond, lang))})` : text;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** What the sheet of a Kontoauszug needs beyond the statement: who sends it to whom, in which language and look. */
export interface StatementPaper {
  language: InvoiceLanguage;
  sender: { name: string; lines: string[] };
  to: { name: string; lines: string[] };
  font: string;
  accent: string;
  /** Laid on a letterhead: the sheet leaves its background to it. */
  letterhead?: boolean;
  logoSrc?: string;
}

/** The Kontoauszug as one A4 HTML page set (printed by src/invoices/pdf.ts printPdf). */
export function statementHtml(s: Statement, p: StatementPaper, fontCss: string): string {
  const L = TEXTS[p.language].statement;
  const d = (iso: string) => formatDate(iso, p.language);
  const n = (x: number) => formatAmount(x, p.language);
  const sections = s.sections.map((sec) => `
    <table class="st"><thead><tr><th>${L.cols.date}</th><th>${L.cols.doc}</th><th>${L.cols.text}</th><th class="r">${L.cols.debit}</th><th class="r">${L.cols.credit}</th><th class="r">${L.cols.balance} ${sec.currency}</th></tr></thead><tbody>
      <tr class="sum"><td colspan="5">${esc(L.opening(d(s.from)))}</td><td class="r">${n(sec.opening)}</td></tr>
      ${sec.rows.map((r) => `<tr><td>${d(r.date)}</td><td>${esc(r.number)}</td><td>${esc(rowText(r, p.language))}</td><td class="r">${r.debit ? n(r.debit) : ''}</td><td class="r">${r.credit ? n(r.credit) : ''}</td><td class="r">${n(r.balance)}</td></tr>`).join('')}
      <tr class="sum end"><td colspan="5">${esc(L.closing(d(s.to)))}</td><td class="r">${sec.currency} ${n(sec.closing)}</td></tr>
    </tbody></table>
    <h4>${esc(L.openItems(d(s.to)))}</h4>
    ${sec.open.length ? `<table class="st op"><thead><tr><th>${L.cols.doc}</th><th>${L.cols.date}</th><th>${L.due}</th><th class="r">${L.gross}</th><th class="r">${L.open} ${sec.currency}</th></tr></thead><tbody>
      ${sec.open.map((o) => `<tr><td>${esc(o.number)}</td><td>${d(o.date)}</td><td>${d(o.dueDate)}</td><td class="r">${n(o.gross)}</td><td class="r">${n(o.open)}</td></tr>`).join('')}
    </tbody></table>` : `<p>${L.none}</p>`}`).join('');
  const css = `@page { size: A4; margin: 0 } body { margin: 0 }
.a4 { width: 210mm; min-height: 297mm; box-sizing: border-box; padding: 20mm 18mm 18mm 20mm; font-family: '${p.font}', Arial, sans-serif; font-size: 9.5pt; color: #141a26; background: #fff; font-variant-numeric: tabular-nums }
@media print { .a4.lh { background: transparent } }
.a4 .head { display: flex; justify-content: space-between; align-items: flex-start; min-height: 40mm }
.a4 .head img { max-height: 16mm; max-width: 60mm }
.a4 .from { font-size: 8.5pt; color: #4a5160 } .a4 .from b { color: #141a26 }
.a4 .to { margin: 4mm 0 10mm 105mm } .a4 .to span { display: block }
.a4 h3 { color: ${p.accent}; font-size: 14pt; margin: 0 0 1mm } .a4 .period { margin: 0 0 6mm; color: #4a5160 }
.a4 h4 { font-size: 10pt; margin: 8mm 0 2mm }
.a4 table.st { width: 100%; border-collapse: collapse } .a4 table.st th { text-align: left; font-weight: 600; border-bottom: 0.4mm solid ${p.accent}; padding: 1.2mm 1mm }
.a4 table.st td { padding: 1.2mm 1mm; border-bottom: 0.2mm solid #e3e6ea; vertical-align: top } .a4 .r, .a4 table.st th.r { text-align: right; white-space: nowrap }
.a4 tr.sum td { font-weight: 600 } .a4 tr.end td { border-top: 0.4mm solid ${p.accent}; border-bottom: none }`;
  const lines = (xs: string[]) => xs.map((x) => `<span>${esc(x)}</span>`).join('');
  return `<!doctype html><html lang="${p.language}"><head><meta charset="utf-8"><title>${esc(L.title)}</title><style>${fontCss}\n${css}</style></head><body><div class="a4${p.letterhead ? ' lh' : ''}">
    <div class="head">${p.letterhead ? '<span></span>' : `<div>${p.logoSrc ? `<img src="${esc(p.logoSrc)}" alt="">` : ''}</div><div class="from"><b>${esc(p.sender.name)}</b>${p.sender.lines.map((x) => `<br>${esc(x)}`).join('')}</div>`}</div>
    <div class="to"><span>${esc(p.to.name)}</span>${lines(p.to.lines)}</div>
    <h3>${esc(L.title)}</h3><p class="period">${esc(L.period(d(s.from), d(s.to)))}</p>
    ${sections || `<p>${L.none}</p>`}
  </div></body></html>`;
}
