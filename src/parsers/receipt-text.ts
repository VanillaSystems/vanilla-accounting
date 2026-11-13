/**
 * What the intake reads off a receipt's extracted text without a model: whether it can prove
 * anything at all (textProves), a Swiss UID, a VAT indicator worth a model call, and the vendor
 * traps that look like an invoice but prove no VAT.
 */

import type { Receipt, VatRateGroup } from '../types/index.js';
import type { DocumentsData } from '../core/modules/schema.js';
import { documentWordsInUse } from '../books/statement-facts.js';
import { HEAD, firstOf, namesStatement, wordsRe } from '../core/modules/words.js';
import { invoicing, vat as vatEngine } from '../engines/index.js';

// A Swiss UID survives text extraction in more shapes than one: extraction wraps it across
// lines ("#CHE-\n153.004.184 MWST" on Shopify's bills, the same break after "CHE-" on some
// other invoices), and some layouts space the groups out. Matching the strict
// "CHE-###.###.###" form alone produces false "no VAT proof" verdicts on perfectly good
// invoices, so allow whitespace between every part.
const SWISS_UID_RE = /CHE[-\s]*\d{3}[.\s]*\d{3}[.\s]*\d{3}/;

export function hasSwissUid(text: string): boolean {
  return SWISS_UID_RE.test(text);
}

/** Every Swiss UID a text shows, with or without «MWST» after it, as «CHE123456789»: whom a document names (src/intake/own-invoice.ts). */
export function uidsIn(text: string): Set<string> {
  return new Set([...text.matchAll(new RegExp(SWISS_UID_RE, 'g'))].map((m) => normUid(m[0])));
}

/** A VAT number to compare whole: upper case, without spaces, dots and dashes («CHE-123.456.789» → «CHE123456789», «DE123456789» stays). */
export const normUid = (s: string): string => s.toUpperCase().replace(/[\s.\-]/g, '');

/**
 * Anything on a text that could be VAT: one of the jurisdiction's VAT labels as a word (invoicing.yaml
 * `vatLabels`: «USt» stands alone, never inside «August»), a Swiss UID however it is spaced, a rate
 * with a decimal. A sign for the document's kind (document-kind.ts); its absence proves nothing (#391).
 */
export function hasVatIndicator(text: string, labels: readonly string[] = invoicing().vatLabels ?? []): boolean {
  return (labels.length > 0 && wordsRe(labels).test(text)) || hasSwissUid(text) || /\d[.,]\d\s?%/.test(text);
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

/**
 * What a receipt's own text states plainly: the date, the total, and its Swiss VAT when the
 * arithmetic proves it. `noSwissVat`: the text says in words that it charges no Swiss VAT (a sale
 * abroad, an exempt premium, a foreign supplier's reverse charge) and proves no Swiss rate; silence
 * is never read as it.
 */
export interface TextFacts {
  date?: string;
  amount?: number;
  currency?: string;
  vatId?: string;
  vatSummary?: VatRateGroup[];
  noSwissVat?: true;
}

const RATES = [8.1, 2.6, 3.8];
const DATE = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(20\d{2})(?!\d)/g;
const MONEY = /(?<![\d.,'’])(?:\d{1,3}(?:[.'’ ]\d{3})+|\d+)[.,]\d{2}(?![\d%])/g;
const UID_VAT = /CHE[-\s]*(\d{3})[.\s]*(\d{3})[.\s]*(\d{3})\s*(?:MWST|TVA|IVA|VAT)/;
const NOT_TOTAL = /exkl|excl|netto|zwischen|sub/i;
const CURRENCY = /\bCHF\b|\bFr\.|\bEUR\b|€|\bUSD\b|US\$/g;
/** A Swiss rate as a percent anywhere in the text, with or without a VAT word beside it («8.1%», «2,6 %», «3.8 Prozent»). */
export const SWISS_PERCENT = new RegExp(String.raw`(?<![\d.,])(?:${RATES.map((r) => String(r).replace('.', '[.,]')).join('|')})\s*(?:%|Prozent|pour ?cent|per ?cento)`, 'i');
/** A rate of the jurisdiction as a percent anywhere in the text, today's or a superseded one (rates.yaml: «7.7 %» of 2023). */
const namesDomesticRate = (text: string): boolean =>
  [...text.matchAll(/(?<![\d.,])(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:%|Prozent|pour ?cent|per ?cento)/giu)].some((m) => {
    const rate = Number(m[1].replace(',', '.'));
    return rate > 0 && vatEngine().isDomesticRate(rate);
  });
/** A line that states an amount of VAT («MWST-Betrag 8.1% 81.00», «Total MWST», «Montant TVA»): no total of the document, unless it says the total includes the VAT. */
const VAT_WORD = /MWST|MwSt|Mehrwertsteuer|TVA|IVA|\bVAT\b|\bUSt\b|Steuer/i;
const VAT_INCLUDED = /inkl|incl|inclus|compris|enthalten|darin|davon|TTC/i;
/** «auf 28'500.00», «on 1000.00»: a line that names a base the document computes on. */
const ON_BASE = /(?:^|\s)(?:auf|on|sur|su)\s+(?:[\p{L} ]{0,30}\s)?(?:CHF\s*)?\d/iu;

/** The Swiss VAT number a text names with its «MWST» (CHE-123.456.789): textFacts' vatId without the rest. */
export function vatIdIn(text: string): string | undefined {
  const uid = UID_VAT.exec(text);
  return uid ? `CHE-${uid[1]}.${uid[2]}.${uid[3]}` : undefined;
}

const money = (s: string) => Number(s.replace(/[’' ]/g, '').replace(/[.,](\d{2})$/, '#$1').replace(/[.,]/g, '').replace('#', '.'));
/** The money values a text states, in order: each standing alone, never a piece of a date, a UID or a longer number. */
export const amounts = (line: string) => [...line.replace(DATE, ' ').matchAll(MONEY)].map((m) => money(m[0]));
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
    if (vat <= 0 || vat >= net || !near(net * rate / 100, vat, 0.06)) continue;
    const gross = all.find((g) => near(g, net + vat, 0.011));
    if (gross !== undefined && (!best || gross > best.gross!)) best = { ratePercent: rate, net, vat, gross };
  }
  return best;
}

/**
 * «inkl. MWST 8.1 %: 98.37», «darin MWST 8.1%» with the amounts in a column of their own: the VAT a
 * total holds, found as the total it fits. The VAT stands on its line, or else among the text's amounts.
 */
function inclusive(lines: string[], all: number[]): VatRateGroup | undefined {
  for (const line of lines) {
    const m = /(?:inkl|incl|enthalten|inclus|darin|davon)[^\n]*?(?:MWST|TVA|IVA|MwSt|VAT)[^\n]*?(\d+[.,]\d)\s*%/i.exec(line);
    if (!m) continue;
    const rate = Number(m[1].replace(',', '.'));
    const own = amounts(line.slice(m.index + m[0].length)).at(-1);
    const fits = (vat: number) => all.filter((g) => g > vat && near(g * rate / (100 + rate), vat, 0.02)).sort((a, b) => b - a)[0];
    for (const vat of own !== undefined ? [own] : all.filter((v) => v > 0)) {
      const gross = fits(vat);
      if (gross !== undefined) return { ratePercent: rate, vat, gross };
    }
  }
  return undefined;
}

/**
 * «MWST 8.1% auf 783.00» beside its VAT of 63.42, «darin MWST 3.8% auf 158.00» beside 5.78: a group
 * per Swiss rate a line names with its base (the net, or with «darin»/«inkl.» the gross), when the
 * VAT it comes to stands among the text's amounts. What the total holds beyond them is a group at
 * 0 % only when the text says a part carries none («0%», «ohne MWST»: an export, a tourist tax, the
 * import tax a courier passes on). Undefined when no line names a base, or a named one does not add up.
 */
function statedGroups(text: string, lines: string[], all: number[], total: number | undefined): VatRateGroup[] | undefined {
  const groups: VatRateGroup[] = [];
  for (const line of lines) {
    const m = /(?:MWST|MwSt|TVA|IVA|VAT)\s*(\d+[.,]\d)\s*%[^\n\d]{0,30}?(?:auf|on|sur|su)\s*(?:CHF\s*)?(\d[\d'’.,]*\d)/i.exec(line);
    if (!m) continue;
    const rate = Number(m[1].replace(',', '.'));
    const base = amounts(m[2])[0];
    const within = /inkl|incl|darin|davon|inclus|enthalten/i.test(line);
    const vatOf = (b: number) => (within ? b * rate / (100 + rate) : b * rate / 100);
    const vat = base === undefined ? undefined : all.find((v) => v > 0 && near(vatOf(base), v, 0.006));
    if (!RATES.includes(rate) || base === undefined || vat === undefined) return undefined;
    groups.push(within ? { ratePercent: rate, net: cents(base - vat), vat, gross: base } : { ratePercent: rate, net: base, vat, gross: cents(base + vat) });
  }
  if (!groups.length || total === undefined) return undefined;
  const rest = cents(total - groups.reduce((s, g) => s + g.gross!, 0));
  if (rest < 0) return undefined;
  if (rest === 0) return groups;
  return NONE_PART.test(text) ? [...groups, { ratePercent: 0, net: rest, vat: 0, gross: rest }] : undefined;
}

/** A part of a receipt said to carry no VAT: «0%», «0% (Export)», «Kurtaxe (ohne MWST)», «Kurs (von der MWST ausgenommen)». */
const NONE_PART = /(?<![\d.,])0(?:[.,]0)?\s*%|ohne (?:MWST|MwSt)|keine (?:MWST|MwSt)|ausgenommen|exonér|sans TVA|esente|senza IVA|without VAT|no VAT|exempt/i;

const cents = (x: number) => Math.round(x * 100) / 100;
const currencyIn = (s: string) => (/\bCHF\b|\bFr\./.test(s) ? 'CHF' : /\bEUR\b|€/.test(s) ? 'EUR' : /\bUSD\b|US\$/.test(s) ? 'USD' : undefined);

/** A line that is one amount and at most its currency («3200.00», «USD 48.00»): a cell of a column of amounts. */
const isValueLine = (line: string) => amounts(line).length === 1 && !line.replace(DATE, ' ').replace(MONEY, '').replace(CURRENCY, '').trim();

/** A line that is a date and nothing else: a cell of a column of days, as a statement or a card's bill lists its movements. */
const isDayLine = (line: string) => /^\s*\d{1,2}\.\d{1,2}\.20\d{2}\s*$/.test(line);

/** A statement's signs in a text: a balance word, or a column of three days or more (the dated movements of an account or a card). */
export function statementSigns(text: string): boolean {
  return /(?<!\p{L})(?:Saldovortrag|Schlusssaldo|Anfangssaldo|Endsaldo|Solde final|Saldo iniziale|Saldo finale|Opening balance|Closing balance)(?!\p{L})/iu.test(text)
    || text.split('\n').filter(isDayLine).length >= 3;
}

/**
 * What tells that a text is no single receipt whose total can be read without a model: it names
 * itself a statement in its head (namesStatement, before any receipt word), lists a column of days,
 * or has more than one page with a total of its own (several invoices in one PDF).
 */
function notOneReceipt(text: string, words: DocumentsData, isLabel: (l: string) => boolean): boolean {
  if (namesStatement(text, words)) return true;
  if (text.split('\n').filter(isDayLine).length >= 3) return true;
  return text.split('\f').filter((page) => page.split('\n').some(isLabel)).length > 1;
}

/**
 * A line that labels the document's total (the jurisdiction's words, documents.yaml receipt.total:
 * Total, Gesamtbetrag, Rechnungsbetrag, zu bezahlen, Amount due, Montant total, Totale …, also inside
 * a word: «Rechnungstotal»). Not: a sum before VAT or a part («exkl.», «netto», «Zwischentotal»), an
 * amount of VAT («Total MWST»: unless it says the VAT is included, or `vatLines`), a base the document
 * computes on («auf 28'500.00»), or what documents.yaml `notTotal` names (a payroll, a sum insured, a
 * limit, hours).
 */
function totalLabel(words: DocumentsData, vatLines = false): (line: string) => boolean {
  const total = words.receipt.total.map((w) => w.toLowerCase());
  const not = words.notTotal?.length ? wordsRe(words.notTotal) : undefined;
  return (l) => {
    const low = l.toLowerCase();
    return total.some((w) => low.includes(w)) && !NOT_TOTAL.test(l) && !not?.test(l)
      && (vatLines || !(VAT_WORD.test(l) && !VAT_INCLUDED.test(l))) && !ON_BASE.test(l);
  };
}

/**
 * The total a text labels as its total, with the line its currency stands on. On the label's own
 * line: the last amount of the last such line that is not 0.00 (a paid invoice's «Amount due 0.00»
 * is no total). In a column of amounts apart from its labels (a two-column invoice as pdf.js reads
 * it): the largest amount, when it closes the column (the VAT a «darin MWST» line names may stand
 * below it). Without any label: the only amount an invoice shows (loneAmount). Undefined when the
 * text is unclear about it.
 */
function labelledTotal(text: string, lines: string[], words: DocumentsData): { amount: number; line?: string } | undefined {
  if (!words.receipt.total.length) return undefined;
  const isLabel = totalLabel(words);
  if (notOneReceipt(text, words, isLabel)) return undefined;
  const labels = lines.filter(isLabel);
  const onLine = (l: string) => !isValueLine(l) && (amounts(l).at(-1) ?? 0) !== 0;
  // A line of VAT only when no other: a customs assessment's «Gesamtbetrag MWST» is its total.
  const inline = labels.filter(onLine).at(-1) ?? lines.filter(totalLabel(words, true)).filter(onLine).at(-1);
  if (inline) return { amount: amounts(inline).at(-1)!, line: inline };
  // The VAT a total holds may stand below it («Total CHF» then «darin MWST 8.1%»): one such amount per such label.
  const ownVat = (l: string) => amounts(l.replace(/(?:auf|on|sur|su)\s*(?:CHF\s*)?\d[\d'’.,]*\d/gi, ' ')).length > 0;
  const within = lines.filter((l) => /inkl|incl|darin|davon|inclus|enthalten/i.test(l) && /MWST|MwSt|TVA|IVA|VAT/.test(l) && !ownVat(l)).length;
  const values = lines.filter(isValueLine);
  const value = (l: string) => amounts(l)[0];
  const closing = values.slice(0, values.length - within).at(-1);
  const after = values.slice(values.length - within);
  if (labels.length && closing !== undefined && value(closing) > 0 && values.every((v) => value(v) <= value(closing)) && after.every((v) => value(v) < value(closing))) {
    return { amount: value(closing), line: currencyIn(closing) ? closing : labels.filter((l) => currencyIn(l)).at(-1) };
  }
  return labels.length ? undefined : loneAmount(text, lines, words);
}

/** A unit price, not what the document totals: «à 89.00», «pro Stunde», «je», «per», «@», «/h». */
const UNIT_PRICE = /(?:^|\s)(?:à|a|pro|je|per|@)\s|\/\s*(?:h|Std|Stunde|Monat|Stk)\b|\bx\s*\d/i;

/**
 * The only amount a document shows, when the document names itself an invoice: a line of its head
 * starts with a receipt's title, also as the end of its first word («Rechnung 12», «Prämienrechnung
 * Betriebshaftpflicht»), and no word of a document beside an invoice or of one that is none stands
 * before it (a delivery note that says «Rechnung folgt», terms that name a fee). Never a unit price.
 */
function loneAmount(text: string, lines: string[], words: DocumentsData): { amount: number } | undefined {
  const distinct = new Set(amounts(text));
  if (distinct.size !== 1) return undefined;
  const head = text.slice(0, HEAD);
  const titles = words.receipt.title.map((w) => w.toLowerCase());
  const at = head.split('\n').findIndex((l) => { const first = l.trim().split(/\s+/)[0]?.toLowerCase() ?? ''; return titles.some((w) => !w.includes(' ') && first.endsWith(w)); });
  if (at < 0) return undefined;
  const titleAt = head.split('\n').slice(0, at).join('\n').length;
  const before = firstOf({ ...words.supporting, ...words.other }, head)[0];
  if (before && before.at <= titleAt) return undefined;
  if (lines.some((l) => amounts(l).length && UNIT_PRICE.test(l))) return undefined;
  return { amount: [...distinct][0] };
}

const WORD = /\p{L}{3,}/gu;
/** Shorter than this, even a PDF's own text says too little to read anything off. */
const MIN_OWN_TEXT = 20;

/**
 * Whether a receipt's text can prove what it lacks (a «MWST», above all). A digital PDF's own text
 * (`pdftotext`) says what the document says. A reading of a picture (an old local OCR's, the
 * model's) only when it is legible: at least three words, and an amount or twenty words. An OCR's
 * noise off a phone photo («=\n.;\nx!\n\nEX dr ir\nale», #284) is not, however long it is.
 */
export function textProves(r: Pick<Receipt, 'extractedText' | 'extractionMethod'>): boolean {
  const text = r.extractedText ?? '';
  if (r.extractionMethod === 'pdftotext') return text.length >= MIN_OWN_TEXT;
  const words = text.match(WORD)?.length ?? 0;
  return words >= 3 && (words >= 20 || amounts(text).length > 0);
}

/** The readings a model made: its text is what there is to read, however little. */
export const MODEL_READ: ReadonlySet<Receipt['extractionMethod']> = new Set(['claude', 'claude-vision']);

/** A text that proves nothing and that no model wrote: a local OCR's noise off a photo, a PDF's own few characters (#284). */
export const noiseText = (r: Pick<Receipt, 'extractedText' | 'extractionMethod'>): boolean => !textProves(r) && !MODEL_READ.has(r.extractionMethod);

/**
 * The one answer to «does this receipt wait for the model's reading?», for every kind of firm: its
 * text is empty (a photo, a scan, also after a model call that failed) or noise no model has read
 * yet, and its date or amount is not there, so nobody entered them by hand either. A document set
 * aside (noise, a duplicate, a statement) waits for nothing. The read step takes these up
 * (`readsAgain` in src/intake/read.ts is the noise case outside filed quarters); Belege's line, the
 * detail's notice and the list's state «unlesbar» all ask here (src/app/areas/receipts).
 */
export function waitsForReading(r: Pick<Receipt, 'extractedText' | 'extractionMethod' | 'date' | 'amount' | 'kind'>): boolean {
  const unread = !(r.extractedText ?? '').trim() || noiseText(r);
  return unread && (!r.date || r.amount == null) && r.kind !== 'noise' && r.kind !== 'duplicate' && r.kind !== 'statement';
}

/**
 * The one answer to «is this receipt read?» (#384): its date and its amount are there, and it is a
 * receipt (not set aside, not a statement, not a document beside an invoice). The drop's closing
 * lines («N Belege gelesen») and the dock's «gelesen» both count with it.
 */
export const isReadReceipt = (r: Pick<Receipt, 'extractedText' | 'extractionMethod' | 'date' | 'amount' | 'kind'>): boolean =>
  !!r.date && r.amount != null && !waitsForReading(r) && r.kind !== 'noise' && r.kind !== 'duplicate' && r.kind !== 'statement' && r.kind !== 'supporting';

/** «No Swiss VAT» read off a text that proves nothing: no evidence either way, so the VAT is not read (#284). A person's facts are hers. */
export const unprovenNoVat = (r: Pick<Receipt, 'vatBy' | 'vatExtractedAt' | 'hasSwissVat' | 'vatSummary' | 'extractedText' | 'extractionMethod'>): boolean =>
  r.vatBy !== 'human' && r.vatExtractedAt != null && r.hasSwissVat === false && !r.vatSummary?.length && !textProves(r);

export function textFacts(text: string, words: DocumentsData | undefined = documentWordsInUse()): TextFacts {
  const lines = text.split('\n');
  const all = amounts(text);
  const labelled = words ? labelledTotal(text, lines, words) : undefined;
  // What lines state (a rate on its base) and that covers the labelled total first: a tourist tax of 6.00 beside a base of 158.00 is no 3.8 % group.
  const stated = statedGroups(text, lines, all, labelled?.amount);
  // Then the arithmetic, as before: a gross it proves wins over a label line that says otherwise (a «Restbetrag», a line read wrongly).
  const one = stated ? undefined : exclusive(all) ?? inclusive(lines, all);
  const groups = stated ?? (one ? [one] : undefined);
  const amount = stated ? labelled!.amount : one?.gross ?? labelled?.amount;
  const vatId = vatIdIn(text);
  const date = dateOf(text);
  const line = labelled?.line;
  const currency = amount === undefined ? undefined : currencyIn(line ?? '') ?? currencyIn(text);
  // «No Swiss VAT» only when said in words (documents.yaml noVat) and nothing on the receipt speaks of Swiss VAT: no rate group, no
  // Swiss rate as a percent anywhere (a superseded one too), no Swiss VAT number with its «MWST», no wording that a price includes the
  // VAT («Flyer inkl. MWST» beside «Porto nicht MWST-pflichtig»). Silence is never read as it.
  const says = !!words?.noVat?.length && wordsRe(words.noVat).test(text);
  const included = invoicing().vatIncluded ?? [];
  const noSwissVat = says && !groups && !namesDomesticRate(text) && !vatId && !(included.length && wordsRe(included).test(text));
  return {
    ...(date ? { date } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(currency ? { currency } : {}),
    ...(vatId ? { vatId } : {}),
    ...(vatId && groups ? { vatSummary: groups } : {}),
    ...(noSwissVat ? { noSwissVat: true as const } : {}),
  };
}
