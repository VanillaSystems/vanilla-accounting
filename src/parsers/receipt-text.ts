/**
 * What the intake reads off a receipt's extracted text without a model: a Swiss UID, a VAT
 * indicator worth a model call, and the vendor traps that look like an invoice but prove no VAT.
 */

import type { VatRateGroup } from '../types/index.js';

// A Swiss UID survives text extraction in more shapes than one: extraction wraps it across
// lines ("#CHE-\n153.004.184 MWST" on Shopify's bills, the same break after "CHE-" on some
// other invoices), and some layouts space the groups out. Matching the strict
// "CHE-###.###.###" form alone produces false "no VAT proof" verdicts on perfectly good
// invoices, so allow whitespace between every part.
const SWISS_UID_RE = /CHE[-\s]*\d{3}[.\s]*\d{3}[.\s]*\d{3}/;

export function hasSwissUid(text: string): boolean {
  return SWISS_UID_RE.test(text);
}

/** Cheap pre-filter: anything that could be Swiss MWST. Absence skips the model and records hasSwissVat=false. */
export function hasVatIndicator(text: string): boolean {
  return /MWST|MwSt|Mehrwertsteuer|CHE-\d{3}|\bVAT\b|USt|\d[.,]\d\s?%/i.test(text);
}

/**
 * Some vendors expose two different PDFs for the same purchase: a summary or confirmation page
 * (no proof of Swiss VAT) and the actual tax invoice (shows the CHE-... UID). Filing the wrong
 * one silently loses the VAT deduction (docs/runbooks/receipt-collection.md lists the traps).
 * This only flags known patterns; absence of a flag is not proof a receipt is fine.
 */
export function detectVatProofIssue(text: string): string | undefined {
  // Amazon.de "Order Summary" (order-history print/PDF) vs. the real per-seller "Rechnung"
  // invoice. The summary only ever shows "Estimated VAT"; the real invoice shows
  // "Rechnungsnummer" + "USt-IDNr. CHE-...".
  if (/Order Summary/i.test(text) && /Estimated VAT/i.test(text) && !hasSwissUid(text)) {
    return '⚠ VAT PROOF MISSING: this looks like an Amazon order-summary page, not the real invoice — no CHE-... VAT ID shown, so it cannot justify a VAT refund. Download the actual "Invoice" PDF per order/seller from the order details popover instead (see docs/runbooks/receipt-collection.md § Amazon.de).';
  }
  return undefined;
}

/** What a receipt's own text states plainly: the date, the total, and its Swiss VAT when the arithmetic proves it. */
export interface TextFacts {
  date?: string;
  amount?: number;
  currency?: string;
  vatId?: string;
  vatSummary?: VatRateGroup[];
}

const RATES = [8.1, 2.6, 3.8];
const DATE = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(20\d{2})(?!\d)/g;
const MONEY = /(?<![\d.,'’])(?:\d{1,3}(?:[.'’ ]\d{3})+|\d+)[.,]\d{2}(?![\d%])/g;
const UID_VAT = /CHE[-\s]*(\d{3})[.\s]*(\d{3})[.\s]*(\d{3})\s*(?:MWST|TVA|IVA|VAT)/;
const TOTAL_LINE = /total|gesamtbetrag|rechnungsbetrag|zu bezahlen|endbetrag|summe/i;
const NOT_TOTAL = /exkl|excl|netto|zwischen|sub/i;

/** The Swiss VAT number a text names with its «MWST» (CHE-123.456.789): textFacts' vatId without the rest. */
export function vatIdIn(text: string): string | undefined {
  const uid = UID_VAT.exec(text);
  return uid ? `CHE-${uid[1]}.${uid[2]}.${uid[3]}` : undefined;
}

const money = (s: string) => Number(s.replace(/[’' ]/g, '').replace(/[.,](\d{2})$/, '#$1').replace(/[.,]/g, '').replace('#', '.'));
const amounts = (line: string) => [...line.replace(DATE, ' ').matchAll(MONEY)].map((m) => money(m[0]));
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps + 1e-9;

function dateOf(text: string): string | undefined {
  const labelled = /(?:rechnungsdatum|belegdatum|datum|date)\s*:?\s*(\d{1,2})\.(\d{1,2})\.(20\d{2})/i.exec(text);
  for (const m of labelled ? [labelled] : text.matchAll(DATE)) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), m[3]];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return undefined;
}

/** net + VAT = gross with VAT ≈ net × rate, among all amounts of the text, whatever the layout put where. */
function exclusive(all: number[]): VatRateGroup | undefined {
  let best: VatRateGroup | undefined;
  for (const rate of RATES) for (const net of all) for (const vat of all) {
    if (vat >= net || !near(net * rate / 100, vat, 0.06)) continue;
    const gross = all.find((g) => near(g, net + vat, 0.011));
    if (gross !== undefined && (!best || gross > best.gross!)) best = { ratePercent: rate, net, vat, gross };
  }
  return best;
}

/** «inkl. MWST 8.1 %: 98.37»: the VAT a total holds, found as the total it fits. */
function inclusive(lines: string[], all: number[]): VatRateGroup | undefined {
  for (const line of lines) {
    const m = /(?:inkl|incl|enthalten|inclus)[^\n]*?(?:MWST|TVA|IVA|MwSt)[^\n]*?(\d+[.,]\d)\s*%/i.exec(line);
    if (!m) continue;
    const rate = Number(m[1].replace(',', '.'));
    const vat = amounts(line.slice(m.index + m[0].length)).at(-1);
    const gross = vat === undefined ? undefined : all.filter((g) => near(g * rate / (100 + rate), vat, 0.02)).sort((a, b) => b - a)[0];
    if (vat !== undefined && gross !== undefined) return { ratePercent: rate, vat, gross };
  }
  return undefined;
}

function currencyOf(line: string | undefined, text: string): string | undefined {
  const of = (s: string) => (/\bCHF\b|\bFr\./.test(s) ? 'CHF' : /\bEUR\b|€/.test(s) ? 'EUR' : /\bUSD\b|US\$/.test(s) ? 'USD' : undefined);
  return (line && of(line)) || of(text);
}

export function textFacts(text: string): TextFacts {
  const lines = text.split('\n');
  const all = amounts(text);
  const group = exclusive(all) ?? inclusive(lines, all);
  const totalLine = lines.filter((l) => TOTAL_LINE.test(l) && !NOT_TOTAL.test(l) && amounts(l).length).at(-1);
  const amount = group?.gross ?? (totalLine ? amounts(totalLine).at(-1) : undefined);
  const vatId = vatIdIn(text);
  const date = dateOf(text);
  const currency = amount === undefined ? undefined : currencyOf(totalLine, text);
  return {
    ...(date ? { date } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(currency ? { currency } : {}),
    ...(vatId ? { vatId } : {}),
    ...(vatId && group ? { vatSummary: [group] } : {}),
  };
}
