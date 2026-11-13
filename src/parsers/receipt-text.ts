/**
 * What the intake reads off a receipt's extracted text without a model: whether it can prove
 * anything at all (textProves), a Swiss UID, a VAT indicator worth a model call, and the vendor
 * traps that look like an invoice but prove no VAT.
 */

import type { Receipt, VatRateGroup } from '../types/index.js';
import type { DocumentsData } from '../core/modules/schema.js';
import { documentWordsInUse } from '../books/statement-facts.js';
import { wordsRe } from '../core/modules/words.js';

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
/** «Leistungsort Deutschland: nicht der schweizerischen MWST unterstellt», «not registered for VAT in Switzerland», «reverse charge»: no Swiss VAT, said in words. */
const NO_SWISS_VAT = new RegExp([
  String.raw`nicht der (?:schweizerischen )?(?:MWST|MwSt|Mehrwertsteuer) unterstellt`, String.raw`(?:von|nicht) der (?:MWST|MwSt|Mehrwertsteuer) (?:ausgenommen|befreit)`,
  String.raw`unterlieg\w* nicht der (?:MWST|MwSt|Mehrwertsteuer)`, String.raw`keine (?:schweizerische )?(?:MWST|MwSt|Mehrwertsteuer)\b(?!-)`,
  String.raw`not registered for VAT in Switzerland`, String.raw`no Swiss VAT`, String.raw`no (?:sales tax or )?VAT charged`, String.raw`reverse charge`,
  String.raw`(?:exonérée?s?|exclue?s?) de la TVA`, String.raw`pas de TVA suisse`, String.raw`non soggett\w* (?:all')?IVA`, String.raw`esente (?:da )?IVA`, String.raw`senza IVA svizzera`,
].join('|'), 'i');

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

/** A part of a receipt said to carry no VAT: «0%», «0% (Export)», «Kurtaxe (ohne MWST)». */
const NONE_PART = /(?<![\d.,])0(?:[.,]0)?\s*%|ohne (?:MWST|MwSt)|sans TVA|senza IVA|without VAT|no VAT/i;

const cents = (x: number) => Math.round(x * 100) / 100;
const currencyIn = (s: string) => (/\bCHF\b|\bFr\./.test(s) ? 'CHF' : /\bEUR\b|€/.test(s) ? 'EUR' : /\bUSD\b|US\$/.test(s) ? 'USD' : undefined);

/** A line that is one amount and at most its currency («3200.00», «USD 48.00»): a cell of a column of amounts. */
const isValueLine = (line: string) => amounts(line).length === 1 && !line.replace(DATE, ' ').replace(MONEY, '').replace(CURRENCY, '').trim();

/** A statement's signs in a text: a balance, or four days or more (the dated movements of an account or a card). */
export function statementSigns(text: string): boolean {
  return /(?<!\p{L})(?:Saldo|Saldovortrag|Schlusssaldo|Anfangssaldo|Solde|Saldo iniziale|Saldo finale|Opening balance|Closing balance)(?!\p{L})/iu.test(text)
    || new Set([...text.matchAll(DATE)].map((m) => m[0])).size >= 4;
}

/**
 * What tells that a text is no single receipt whose total can be read without a model: a statement
 * (it names itself so, shows a balance, or lists four days or more), or more than one page with a
 * total of its own (several invoices in one PDF).
 */
function notOneReceipt(text: string, words: DocumentsData, totalRe: RegExp): boolean {
  if (words.statement.length && wordsRe(words.statement).test(text)) return true;
  if (statementSigns(text)) return true;
  return text.split('\f').filter((page) => page.split('\n').some((l) => totalRe.test(l) && !NOT_TOTAL.test(l))).length > 1;
}

/**
 * The total a text labels as its total (the jurisdiction's words, documents.yaml receipt.total:
 * Total, Betrag, Gesamtbetrag, Amount due, Montant total, Totale …), with the line its currency
 * stands on. On the label's own line: the last amount of the last such line. In a column of amounts
 * apart from its labels (a two-column invoice as pdf.js reads it): the largest amount, when it
 * closes the column. Without any label: the only amount an invoice shows. Undefined when the text is
 * unclear about it (notOneReceipt) or its largest amount does not close the column.
 */
function labelledTotal(text: string, lines: string[], words: DocumentsData): { amount: number; line?: string } | undefined {
  if (!words.receipt.total.length) return undefined;
  const totalRe = wordsRe(words.receipt.total);
  if (notOneReceipt(text, words, totalRe)) return undefined;
  const labels = lines.filter((l) => totalRe.test(l) && !NOT_TOTAL.test(l));
  const inline = labels.filter((l) => amounts(l).length && !isValueLine(l)).at(-1);
  if (inline) return { amount: amounts(inline).at(-1)!, line: inline };
  // The VAT a total holds may stand below it («Total CHF» then «darin MWST 8.1%»): one such amount per such label.
  const ownVat = (l: string) => amounts(l.replace(/(?:auf|on|sur|su)\s*(?:CHF\s*)?\d[\d'’.,]*\d/gi, ' ')).length > 0;
  const within = lines.filter((l) => /inkl|incl|darin|davon|inclus|enthalten/i.test(l) && /MWST|MwSt|TVA|IVA|VAT/.test(l) && !ownVat(l)).length;
  const values = lines.filter(isValueLine);
  const value = (l: string) => amounts(l)[0];
  const closing = values.slice(0, values.length - within).at(-1);
  const after = values.slice(values.length - within);
  if (labels.length && closing !== undefined && values.every((v) => value(v) <= value(closing)) && after.every((v) => value(v) < value(closing))) {
    return { amount: value(closing), line: currencyIn(closing) ? closing : labels.filter((l) => currencyIn(l)).at(-1) };
  }
  const distinct = new Set(amounts(text));
  return !labels.length && distinct.size === 1 && namesReceipt(text, words) ? { amount: [...distinct][0] } : undefined;
}

/** A receipt's title anywhere, also as the end of a word («Prämienrechnung», «Akontorechnung»). */
const namesReceipt = (text: string, words: DocumentsData) =>
  words.receipt.title.some((w) => text.toLowerCase().includes(w.toLowerCase()));

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

/** A rate of Swiss VAT named beside a VAT word («MWST 8.1%», «inkl. 2.6 % MWST»). */
const SWISS_RATE = new RegExp(String.raw`(?:MWST|MwSt|TVA|IVA|VAT)[^\n]{0,20}?(?<![\d.,])(?:${RATES.map((r) => String(r).replace('.', '[.,]')).join('|')})\s*%|(?<![\d.,])(?:${RATES.map((r) => String(r).replace('.', '[.,]')).join('|')})\s*%[^\n]{0,20}?(?:MWST|MwSt|TVA|IVA|VAT)`, 'i');

/**
 * The facts a person reads off a receipt's text. The total is what the text labels as its total
 * (labelledTotal), or the gross of a VAT group the arithmetic proves: the Swiss-rate arithmetic
 * proves the VAT, it is no condition for the amount, so an invoice without Swiss VAT has its total
 * too. `words`: the jurisdiction's document words; without them only the arithmetic reads a total.
 */
export function textFacts(text: string, words: DocumentsData | undefined = documentWordsInUse()): TextFacts {
  const lines = text.split('\n');
  const all = amounts(text);
  const labelled = words ? labelledTotal(text, lines, words) : undefined;
  // What a line states (a rate on its base) first, then the arithmetic: a tourist tax of 6.00 beside a base of 158.00 is no 3.8 % group.
  const stated = statedGroups(text, lines, all, labelled?.amount);
  const one = stated ? undefined : inclusive(lines, all) ?? exclusive(all);
  // A group whose gross falls short of the labelled total covers only part of the receipt: no proof of its VAT.
  const groups = stated ?? (one && (!labelled || near(labelled.amount, one.gross!, 0.011)) ? [one] : undefined);
  const amount = labelled?.amount ?? one?.gross;
  const vatId = vatIdIn(text);
  const date = dateOf(text);
  const currency = amount === undefined ? undefined : currencyIn(labelled?.line ?? '') ?? currencyIn(text);
  const noSwissVat = !groups && NO_SWISS_VAT.test(text) && !SWISS_RATE.test(text);
  return {
    ...(date ? { date } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(currency ? { currency } : {}),
    ...(vatId ? { vatId } : {}),
    ...(vatId && groups ? { vatSummary: groups } : {}),
    ...(noSwissVat ? { noSwissVat: true as const } : {}),
  };
}
