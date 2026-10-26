/**
 * A document whose words decide nothing (src/intake/document-kind.ts: `unclear`) and that shows
 * almost nothing of an invoice is asked of the model once (issue #186): a receipt, a document kept
 * beside an invoice, or no receipt, with a one-line reason. Words alone cannot tell a sales
 * brochure from a poor scan of a real invoice: both score 0. Without a model it stays as it was,
 * taken as a receipt. The answer only types the receipt; nothing is deleted, and a person's kind
 * is never asked about again (read.ts asks only for a receipt read for the first time).
 */
import type { DocumentsData } from '../core/modules/schema.js';
import type { Receipt } from '../types/index.js';
import type { Ask } from './pipeline.js';
import { documentKind } from './document-kind.js';

/** Invoice evidence up to which an unclear document is asked about (receiptScore: a total alone is 1). */
const LITTLE = 1;
/**
 * What the model sees of the text: enough for a brochure's first page, little enough for the fast
 * tier. A longer text is cut here, and the receipt's page says so with this number (#186).
 */
export const MODEL_TEXT = 3000;

/** The kindRule of a kind the model gave: `model:no-receipt` or `model:supporting`. */
export const MODEL_RULE = 'model:';

export type ModelKind = { is: 'receipt' | 'supporting' | 'none'; why: string };

/** Whether the model is asked about a text: its words decide nothing and it shows at most one sign of an invoice. */
export function asksModel(text: string, words: DocumentsData): boolean {
  if (!text.trim()) return false;
  const v = documentKind(text, words);
  return v.is === 'unclear' && v.score <= LITTLE;
}

export function unclearPrompt(text: string, filename: string): string {
  return `You sort documents that reached a Swiss small company's bookkeeping inbox (a mailbox, a scan, a drop).
Decide what this one is:
- "receipt": an invoice, a bill, a till receipt, a credit note, a contract or statement that asks for or confirms a payment. A poor scan or short OCR of one is still a receipt.
- "supporting": kept beside an invoice but never paid on its own: an order confirmation, a delivery note, a shipping or customs paper, a return label.
- "none": no receipt at all: a brochure, a newsletter, a product sheet, a price list, terms, marketing, a report.
When in doubt, answer "receipt": a real receipt set aside is worse than a brochure kept.

File name: ${filename}
Text (start):
${text.slice(0, MODEL_TEXT)}

Return ONLY a JSON object: {"is": "receipt" | "supporting" | "none", "why": "<one short line in the document's language: what it is>"}`;
}

export function parseModelKind(raw: string): ModelKind | undefined {
  try {
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1).replace(/[\r\n]+/g, ' ')) as { is?: unknown; why?: unknown };
    if (json.is !== 'receipt' && json.is !== 'supporting' && json.is !== 'none') return undefined;
    const why = typeof json.why === 'string' ? json.why.replace(/\s+/g, ' ').trim() : '';
    return { is: json.is, why };
  } catch {
    return undefined;
  }
}

/** The model's verdict on one unclear document; undefined when it could not say (the call failed, the answer had no verdict). */
export async function askKind(ask: Ask, text: string, filename: string): Promise<ModelKind | undefined> {
  return parseModelKind(await ask(unclearPrompt(text, filename), { step: 'receipt-kind', timeoutMs: 60_000 }));
}

/** The receipt's kind from the model's verdict: no receipt is noise, a companion is supporting, a receipt stays untyped. */
export function kindOfModel(v: ModelKind): Pick<Receipt, 'kind' | 'kindBy' | 'kindRule' | 'kindWhy'> {
  if (v.is === 'receipt') return {};
  return {
    kind: v.is === 'none' ? 'noise' : 'supporting',
    kindBy: 'rule',
    kindRule: `${MODEL_RULE}${v.is === 'none' ? 'no-receipt' : 'supporting'}`,
    ...(v.why ? { kindWhy: v.why } : {}),
  };
}

/** Who set a receipt's kind, for the list of what was set aside: a person, the model, or the words of a rule. */
export type KindBy = 'person' | 'model' | 'rule';

export function kindByOf(r: Pick<Receipt, 'kindBy' | 'kindRule'>): KindBy {
  if (r.kindBy === 'human') return 'person';
  return r.kindRule?.startsWith(MODEL_RULE) ? 'model' : 'rule';
}

/** The length of a text the model judged from its first MODEL_TEXT characters only; undefined when it saw it whole. */
export const modelCut = (r: Pick<Receipt, 'kindBy' | 'kindRule' | 'extractedText'>): number | undefined =>
  kindByOf(r) === 'model' && r.extractedText.length > MODEL_TEXT ? r.extractedText.length : undefined;
