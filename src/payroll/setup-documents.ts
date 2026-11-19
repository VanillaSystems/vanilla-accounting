/**
 * The Sozialversicherungen set up from the funds' and insurers' documents (docs/specs/payroll.md §6.1 step 2, §8.1):
 * a document dropped into Belege whose first lines name a kind's document (payroll.yaml `setupDocuments.kinds`) is
 * proposed on a card in Löhne › Einstellungen. Code reads what the text states plainly: the fund's name in its
 * letterhead, a number after its label, a rate in % on the line of its words. The AI may read the rest, from the
 * document's lines without a salary or a birth date (`notToModel`, the social security number masked by src/llm/ask.ts),
 * and only what a figure needs. Nothing is used before the person keeps the card: keeping writes the same insurances and
 * dated entries the forms write, each naming the document (`source.receiptId`). Pure and browser-safe.
 */
import type { DocumentsData } from '../core/modules/schema.js';
import type { PayrollData } from '../core/modules/schema.js';
import type { Receipt } from '../types/index.js';
import type { PayrollStore } from './model.js';

/** One insurance a document proposes, each field with who read it. */
export interface InsuranceProposal {
  kind: string;
  name?: string;
  memberNumber?: string;
  contractNumber?: string;
  code?: string;
  rates: Record<string, number>;
  /** A person's pension contributions a month (a pension certificate), by her name as the document prints it. */
  person?: { name: string; employee?: number; employer?: number };
  /** Who read each field (`name`, `memberNumber`, `rates.<key>`, `person`): code off the text, or the AI. */
  by: Record<string, 'code' | 'ai'>;
}

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (words: readonly string[]) => new RegExp(`(?<![\\p{L}\\d])(?:${[...words].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\p{L}\\d])`, 'iu');
const HEAD_LINES = 12;
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** The kind of insurance a document is for, by the words of its first lines; undefined for any other document. */
export function setupKindOf(text: string, data: Pick<PayrollData, 'setupDocuments'>): string | undefined {
  const kinds = data.setupDocuments?.kinds ?? {};
  const head = lines(text).slice(0, HEAD_LINES).join('\n');
  return Object.entries(kinds).find(([, words]) => words.length && wordRe(words).test(head))?.[0];
}

/** Whether a file's name names a fund's document («Vorsorgeausweis_Wyss.jpg», «UVG-Police.png»): a picture of one is not read by a model's vision (§22 decision 108). */
export function setupFileName(name: string, data: Pick<PayrollData, 'setupDocuments'>): boolean {
  const words = [...(data.setupDocuments?.titles ?? []), ...Object.values(data.setupDocuments?.kinds ?? {}).flat()];
  return words.length > 0 && wordRe(words).test(name.replace(/[_.]+/g, ' '));
}

/** What tells a bill (documents.yaml `receipt`): its titles and its payment slip. */
export type BillWords = { receipt: Pick<DocumentsData['receipt'], 'title' | 'slip'> };

const TITLE_LINES = 5;
/** A line that refers to a document by its number («Police Nr. 44.555», «N° de police: …», «N. polizza: …»): no title. */
const REFERENCE = /(?<![\p{L}])(?:nr|no|n°|n|nummer|numéro|numero)\.?(?![\p{L}])|:/iu;
const DATE_OR_AMOUNT = /\b\d{1,2}\.\d{1,2}\.(?:\d{2,4})?(?!\d)|\d[\d'’ ]*[.,]\d{2}\b/;

/**
 * Whether a text is a fund's or insurer's document (a decision, a policy, a pension certificate), never its bill (§22
 * decision 108, its second review): one of its first lines is a title naming one of payroll.yaml `setupDocuments.titles`
 * (a line referring to a document by its number is none) and the text names a kind (setupKindOf); and nothing says
 * bill: no title of `bills` or of documents.yaml `receipt.title` in its first lines (whole words: «Altersgutschrift» is
 * none), no payment slip word, no line with a word of `payable` and a date or an amount. Without `bill`, the payroll's
 * words alone.
 */
export function isSetupText(text: string, data: Pick<PayrollData, 'setupDocuments'>, bill?: BillWords): boolean {
  const sd = data.setupDocuments;
  if (!sd?.titles?.length || !setupKindOf(text, data)) return false;
  const all = lines(text);
  const titles = wordRe(sd.titles);
  if (!all.slice(0, TITLE_LINES).some((l) => titles.test(l) && !REFERENCE.test(l))) return false;
  const billTitles = [...(sd.bills ?? []), ...(bill?.receipt.title ?? [])];
  if (billTitles.length && wordRe(billTitles).test(all.slice(0, HEAD_LINES).join('\n'))) return false;
  if (bill?.receipt.slip.length && wordRe(bill.receipt.slip).test(text)) return false;
  const payable = sd.payable?.length ? wordRe(sd.payable) : undefined;
  return !payable || !all.some((l) => payable.test(l) && DATE_OR_AMOUNT.test(l));
}

export { SETUP_DOCUMENT_RULE, isSetupDocument } from '../booking/payslip.js';

/** A number the text prints after one of its labels, on the same line («Abrechnungsnummer: 100.2345»). */
function numberAfter(text: string, labels: readonly string[] | undefined): string | undefined {
  if (!labels?.length) return undefined;
  const re = new RegExp(`(?<![\\p{L}\\d])(?:${labels.map(escape).join('|')})\\s*[:#]?\\s*([A-Z0-9][A-Z0-9./-]{2,})`, 'iu');
  for (const l of lines(text)) { const m = re.exec(l); if (m && /\d/.test(m[1])) return m[1].replace(/[.,]$/, ''); }
  return undefined;
}

/** A rate the text prints in % on a line that names its words and no other rate's of the kind. */
function rateOf(text: string, words: readonly string[], others: ReadonlyArray<readonly string[]>): number | undefined {
  const re = wordRe(words);
  const not = others.filter((o) => o.length).map(wordRe);
  for (const l of lines(text)) {
    if (!re.test(l) || not.some((o) => o.test(l))) continue;
    const m = /(\d{1,2}(?:[.,]\d{1,4})?)\s*%/.exec(l);
    if (m) return Number(m[1].replace(',', '.'));
  }
  return undefined;
}

/** What code reads of a kind's document: its insurance (and, for the compensation fund's decision, any other kind whose rates it names). */
export function readSetupDocument(text: string, data: Pick<PayrollData, 'setupDocuments' | 'insurances'>): InsuranceProposal[] {
  const kind = setupKindOf(text, data);
  const sd = data.setupDocuments;
  if (!kind || !sd) return [];
  const first = lines(text)[0];
  const name = first && !wordRe(sd.kinds[kind] ?? []).test(first) && !/\d{4,}/.test(first) ? first.split(/\s*[,|·]\s*/)[0] : undefined;
  const memberNumber = numberAfter(text, sd.numbers.memberNumber);
  const contractNumber = numberAfter(text, sd.numbers.contractNumber);
  const itemOf = (k: string): InsuranceProposal => {
    const by: InsuranceProposal['by'] = {};
    const rates: Record<string, number> = {};
    const own = sd.rates[k] ?? {};
    for (const [key, words] of Object.entries(own)) {
      if (!data.insurances[k]?.rates?.[key]) continue;
      const v = rateOf(text, words, Object.entries(own).filter(([o]) => o !== key).map(([, w]) => w));
      if (v !== undefined) { rates[key] = v; by[`rates.${key}`] = 'code'; }
    }
    const out: InsuranceProposal = { kind: k, rates, by };
    if (name) { out.name = name; by.name = 'code'; }
    if (memberNumber) { out.memberNumber = memberNumber; by.memberNumber = 'code'; }
    if (contractNumber) { out.contractNumber = contractNumber; by.contractNumber = 'code'; }
    return out;
  };
  const items = [itemOf(kind)];
  // The compensation fund's decision names the family allowances' rate too: the fund runs that insurance beside it.
  for (const k of Object.keys(sd.rates)) {
    if (k === kind || sd.kinds[k]) continue;
    const other = itemOf(k);
    if (Object.keys(other.rates).length) items.push(other);
  }
  return items;
}

/** The fields a proposal still lacks, as the card and the AI's question name them: the name, a number, each rate of the kind, a pension certificate's person. */
export function missingOf(p: InsuranceProposal, data: Pick<PayrollData, 'insurances'>): string[] {
  const def = data.insurances[p.kind];
  return [
    ...(p.name ? [] : ['name']),
    ...(p.memberNumber || p.contractNumber ? [] : ['number']),
    ...Object.keys(def?.rates ?? {}).filter((k) => p.rates[k] === undefined).map((k) => `rates.${k}`),
    ...(def?.perPerson && !p.person ? ['person'] : []),
  ];
}

/** Lowercase without accents: a word of `notToModel` is looked for anywhere in a line. */
const folded = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** A day in a line («12.03.1985», «2026-01-01»): a birth date, an entry: never sent. */
const DAY_IN = /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/;
/** The fund's letterhead: the lines a model may read for its name. */
const LETTERHEAD_LINES = 2;

/**
 * The document's lines a model may read (an allow-list, review of A-2): the letterhead's first lines, a line with a rate
 * in %, a line naming a rate's, a number's, a kind's or `toModel`'s words; never an amount alone, never a line with a
 * day, never one that holds a word of `notToModel` anywhere (a salary, a coordinated wage, retirement savings, a birth date).
 */
export function linesForModel(text: string, data: Pick<PayrollData, 'setupDocuments'>): string {
  const sd = data.setupDocuments;
  if (!sd) return '';
  const deny = sd.notToModel.map(folded);
  const words = [...(sd.toModel ?? []), ...Object.values(sd.rates).flatMap((r) => Object.values(r).flat()), ...Object.values(sd.numbers).flatMap((n) => n ?? []), ...Object.values(sd.kinds).flat()];
  const allow = words.length ? wordRe(words) : undefined;
  return lines(text).filter((l, i) => {
    const f = folded(l);
    if (deny.some((d) => f.includes(d)) || DAY_IN.test(l) || !/\p{L}{2,}/u.test(l)) return false;
    return i < LETTERHEAD_LINES || l.includes('%') || !!allow?.test(l);
  }).join('\n');
}

/** The question to the AI (step `payroll-setup`): the fields of the kinds the document is for, its lines for a model, JSON back. */
export function setupPrompt(text: string, kinds: readonly string[], data: Pick<PayrollData, 'setupDocuments' | 'insurances'>): string {
  const fields = kinds.map((k) => {
    const def = data.insurances[k];
    const rates = Object.entries(def?.rates ?? {}).map(([key, r]) => `"${key}" (${r.label.en}, percent, ${r.range[0]} to ${r.range[1]})`).join(', ');
    return `- "${k}" (${def?.label.en ?? k}): name of the fund or insurer, memberNumber, contractNumber, code of the solution or category${rates ? `, rates: ${rates}` : ''}${def?.perPerson ? ', person: { name, employee, employer } with the monthly contributions in the books\' currency the certificate states for the insured person' : ''}`;
  }).join('\n');
  return `A document of a social insurance fund or insurer (a contribution decision, a pension certificate, a policy). Read only what it states plainly, for these insurances:
${fields}

Leave a field out when the document does not state it. Never compute a figure; a rate is the percent the document prints.

Document lines:
${linesForModel(text, data)}

Answer ONLY JSON: {"items":[{"kind":"<one of ${kinds.map((k) => `"${k}"`).join(', ')}>","name":"…","memberNumber":"…","contractNumber":"…","code":"…","rates":{"<key>":1.2},"person":{"name":"…","employee":300,"employer":300}}]}`;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined);
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

/** The AI's answer, checked by code: known kinds of `kinds`, known rate keys within their ranges, numbers as text, a person's contributions at zero or above. */
export function parseSetupAnswer(raw: string, kinds: readonly string[], data: Pick<PayrollData, 'insurances'>): InsuranceProposal[] {
  let v: unknown;
  try { v = JSON.parse(raw.replace(/```(?:json)?/g, '').trim().match(/\{[\s\S]*\}/)?.[0] ?? ''); } catch { return []; }
  const items = v && typeof v === 'object' ? (v as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) return [];
  return items.flatMap((x): InsuranceProposal[] => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return [];
    const o = x as Record<string, unknown>;
    const kind = typeof o.kind === 'string' && kinds.includes(o.kind) ? o.kind : undefined;
    if (!kind) return [];
    const def = data.insurances[kind];
    const by: InsuranceProposal['by'] = {};
    const rates: Record<string, number> = {};
    for (const [key, r] of Object.entries(def?.rates ?? {})) {
      const n = num((o.rates as Record<string, unknown> | undefined)?.[key], r.range[0], r.range[1]);
      if (n !== undefined) { rates[key] = n; by[`rates.${key}`] = 'ai'; }
    }
    const out: InsuranceProposal = { kind, rates, by };
    for (const f of ['name', 'memberNumber', 'contractNumber', 'code'] as const) { const s = str(o[f]); if (s) { out[f] = s; by[f] = 'ai'; } }
    const p = o.person as Record<string, unknown> | undefined;
    const pname = def?.perPerson ? str(p?.name) : undefined;
    if (pname) { out.person = { name: pname, ...(num(p?.employee, 0, 1e5) !== undefined ? { employee: num(p?.employee, 0, 1e5) } : {}), ...(num(p?.employer, 0, 1e5) !== undefined ? { employer: num(p?.employer, 0, 1e5) } : {}) }; by.person = 'ai'; }
    return [out];
  });
}

/** Code's reading with the AI's beside it: what code read stands, the AI fills only what code left out. */
export function withModel(code: readonly InsuranceProposal[], ai: readonly InsuranceProposal[]): InsuranceProposal[] {
  const out = code.map((c) => ({ ...c, rates: { ...c.rates }, by: { ...c.by } }));
  for (const a of ai) {
    const c = out.find((x) => x.kind === a.kind);
    if (!c) { out.push(a); continue; }
    for (const f of ['name', 'memberNumber', 'contractNumber', 'code', 'person'] as const) if (c[f] === undefined && a[f] !== undefined) { (c as unknown as Record<string, unknown>)[f] = a[f]; c.by[f] = 'ai'; }
    for (const [k, v] of Object.entries(a.rates)) if (c.rates[k] === undefined) { c.rates[k] = v; c.by[`rates.${k}`] = 'ai'; }
  }
  return out;
}

/** What the app keeps of a card beside the books (data/payroll-setup.json): the AI's reading, once asked, and a card set aside. */
export type SetupState = Record<string, { ai?: InsuranceProposal[]; dismissed?: string; kept?: string }>;

/** A card of Löhne › Einstellungen › Sozialversicherungen: the document, what it proposes, what is still missing. */
export interface SetupCard { receipt: string; filename: string; date?: string; items: Array<InsuranceProposal & { missing: string[]; exists?: string }>; asked: boolean }

/** The documents payroll.json names as the source of an entry or an insurance: their cards are kept, not proposed again. */
export function usedDocuments(store: Pick<PayrollStore, 'insurances' | 'employees'>): Set<string> {
  const out = new Set<string>();
  for (const i of store.insurances) {
    if (i.source?.receiptId) out.add(i.source.receiptId);
    for (const s of i.solutions) for (const r of s.rates) if (r.source?.receiptId) out.add(r.source.receiptId);
  }
  for (const e of store.employees) for (const r of e.insurances) if (r.source?.receiptId) out.add(r.source.receiptId);
  return out;
}

/**
 * The cards to show, newest document first: each receipt whose text is a kind's document, not kept (no entry names
 * it) and not set aside, with what code read and what the AI added; `exists`: the firm's insurance of that kind it
 * would add rates to. Derived on every read: a better reader reads old documents again.
 */
export function setupCards(receipts: readonly Pick<Receipt, 'id' | 'filename' | 'date' | 'extractedText' | 'kind'>[], store: Pick<PayrollStore, 'insurances' | 'employees'>, data: Pick<PayrollData, 'setupDocuments' | 'insurances'>, state: SetupState, bill?: BillWords): SetupCard[] {
  const used = usedDocuments(store);
  // `bill` (documents.yaml): a fund's bill that names a document is no card (isSetupText).
  return receipts.filter((r) => r.kind !== 'payslip' && !used.has(r.id) && !state[r.id]?.dismissed && !state[r.id]?.kept && isSetupText(r.extractedText ?? '', data, bill))
    .map((r) => {
      const items = withModel(readSetupDocument(r.extractedText ?? '', data), state[r.id]?.ai ?? []).map((p) => {
        const exists = store.insurances.find((i) => i.kind === p.kind && !i.validUntil)?.id;
        return { ...p, missing: missingOf(p, data), ...(exists ? { exists } : {}) };
      });
      return { receipt: r.id, filename: r.filename, ...(r.date ? { date: r.date } : {}), items, asked: !!state[r.id]?.ai };
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}
