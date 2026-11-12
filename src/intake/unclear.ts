/**
 * A document whose words decide nothing (src/intake/document-kind.ts: `unclear`) and that shows
 * almost nothing of an invoice is asked of the model once (issue #186): a receipt or no receipt,
 * with a one-line reason. Words alone cannot tell a sales brochure from a poor scan of a real
 * invoice: both score 0. The model may only set a document aside: «no receipt» makes it noise; any
 * other answer leaves it untyped, as without a model. It never types a document `supporting`: on
 * the private books it called customs clearance decisions and order confirmations with Swiss VAT
 * «supporting», which would drop their input tax (isPurchaseDocument, src/accounting/evidence-check.ts).
 * Nothing is deleted, and a person's kind is never asked about (read.ts asks only for a receipt read
 * for the first time).
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

/** The kindRule of a kind the model gave: `model:no-receipt`. */
export const MODEL_RULE = 'model:';

export type ModelKind = { is: 'receipt' | 'none'; why: string };

/** Whether the model is asked about a text: its words decide nothing and it shows at most one sign of an invoice. */
export function asksModel(text: string, words: DocumentsData): boolean {
  if (!text.trim()) return false;
  const v = documentKind(text, words);
  return v.is === 'unclear' && v.score <= LITTLE;
}

/**
 * What is a receipt and what is none, for every prompt that may set a file aside (this one and the
 * vision reading's «Kein Beleg», src/llm/prompts.ts buildVisionPrompt): one definition, with the doubt rule.
 */
export const RECEIPT_OR_NONE = `- A receipt: anything that belongs to a payment or a tax: an invoice, a bill, a till or postal receipt, a card or debit slip, a credit note, an order confirmation, a screenshot of an order page, a customs clearance decision, a delivery note, a contract or statement. A poor scan, a blurred photo or a short OCR of one is still a receipt.
- None: no receipt at all: a brochure, a newsletter, a product sheet, a price list, terms, marketing, a report, a photo of a place or of people that shows no such document.
When in doubt, it is a receipt: a real receipt set aside is worse than a brochure kept.`;

export function unclearPrompt(text: string, filename: string): string {
  return `You sort documents that reached a Swiss small company's bookkeeping inbox (a mailbox, a scan, a drop).
Decide what this one is ("receipt" or "none"):
${RECEIPT_OR_NONE}

File name: ${filename}
Text (start):
${text.slice(0, MODEL_TEXT)}

Return ONLY a JSON object: {"is": "receipt" | "none", "why": "<one short line in the document's language: what it is>"}`;
}

export function parseModelKind(raw: string): ModelKind | undefined {
  try {
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1).replace(/[\r\n]+/g, ' ')) as { is?: unknown; why?: unknown };
    if (json.is !== 'receipt' && json.is !== 'none') return undefined;
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

/** How the vision reading says that a file is no receipt at all (src/llm/prompts.ts buildVisionPrompt asks for it). */
export const NOT_A_RECEIPT = 'Kein Beleg';

/** The longest «what it shows» a verdict may say: a short sentence, not a text. */
export const VERDICT_WHY = 160;

/**
 * The vision reading's own verdict (buildVisionPrompt): a file that shows no receipt at all (a holiday
 * photo) is answered exactly «Kein Beleg: <what it shows>» (#361), one short line and nothing after it.
 * Any other reading is no verdict, but text: «Kein Belegdatum erkennbar – …», a verdict followed by a
 * text, a line longer than VERDICT_WHY.
 */
export function visionVerdict(text: string): ModelKind | undefined {
  const m = new RegExp(`^${NOT_A_RECEIPT}: ([^\\n]{1,${VERDICT_WHY}})$`).exec(text.trim());
  const why = m?.[1].trim();
  return why ? { is: 'none', why } : undefined;
}

/** The receipt's kind from the model's verdict: no receipt is noise with the reason; a receipt stays untyped. */
export function kindOfModel(v: ModelKind): Pick<Receipt, 'kind' | 'kindBy' | 'kindRule' | 'kindWhy'> {
  if (v.is !== 'none') return {};
  return { kind: 'noise', kindBy: 'rule', kindRule: `${MODEL_RULE}no-receipt`, ...(v.why ? { kindWhy: v.why } : {}) };
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
