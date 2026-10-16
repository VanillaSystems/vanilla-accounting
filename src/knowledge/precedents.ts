/**
 * An answer «privat» or «geschäftlich» is kept as a precedent of the booking guide's `private`
 * step, in the company's layer (knowledge/rules/booking.guide.yaml, src/knowledge/layers.ts),
 * where the booking and the AI read the person's decisions. Besides the words every precedent has
 * (item, decision, by), it carries what code needs to find it again: `match`, the payment's
 * counterparty as one key (precedentKey), and `choice`. The next question of that kind on a
 * payment with the same key is answered and booked by it without anyone asked
 * (src/server/questions.ts). A wrong auto-answer is worse than a question, so the key must name
 * one counterparty for certain; a bank text such as «Karte 5412 Einkauf» gives none.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import { merchantOf } from './counterparties.js';
import { RULES_DIR } from './layers.js';
import type { BankTransaction, Index } from '../types/index.js';
import { receiptKeys } from '../accounting/manual-booking.js';
import type { Workspace } from '../workspace/workspace.js';
import { CHOICES, type Choice } from '../questions/model.js';

export const PRECEDENT_STEP = 'private';
export const guideFile = (ws: Pick<Workspace, 'paths'>): string => join(ws.paths.root, RULES_DIR, 'booking.guide.yaml');

/** What names a payment's other party, strongest first: its receipts' VAT number, their vendor, the bank's counterparty text. */
export type PrecedentMatch = { uid: string } | { vendor: string } | { tx: string };

export interface ChoicePrecedent { id: string; date: string; item: string; decision: string; by: string; match: PrecedentMatch; choice: Choice; question?: string }

/**
 * Words of a bank text that name a way to pay or the bank's wrapper, never a counterparty: a text
 * of these alone («Karte 5412 Einkauf», «Kartenzahlung», «TWINT», «Card transaction of …») is
 * generic. Lower case, in the app's four languages.
 */
const GENERIC = new Set([
  'karte', 'kartenzahlung', 'einkauf', 'zahlung', 'zahlungen', 'belastung', 'gutschrift', 'lastschrift', 'dauerauftrag', 'überweisung', 'bezug', 'barbezug', 'bargeld',
  'twint', 'maestro', 'visa', 'mastercard', 'debit', 'debitkarte', 'kreditkarte', 'pos', 'ec', 'bancomat', 'postomat', 'atm', 'e-banking', 'ebanking', 'online',
  'card', 'transaction', 'payment', 'purchase', 'issued', 'by', 'of', 'sent', 'money', 'to', 'from', 'received', 'paid', 'transfer', 'withdrawal', 'cash',
  'carte', 'achat', 'paiement', 'retrait', 'virement', 'carta', 'acquisto', 'pagamento', 'prelievo', 'bonifico',
  'chf', 'eur', 'usd', 'gbp', 'nr', 'no', 'ref', 'referenz', 'am', 'vom', 'bei', 'in', 'und', 'mit',
]);

const words = (s: string) => s.toLowerCase().replace(/\d+([.,]\d+)*/g, ' ').replace(/[^\p{L}&\s-]/gu, ' ').split(/\s+/).filter(Boolean);
const normalized = (s: string | undefined) => s?.toLowerCase().replace(/[^a-z0-9äöü]/g, '') || undefined;

/** A bank text that names no counterparty: nothing but generic words and numbers. */
export const isGenericText = (text: string): boolean => !words(text).some((w) => w.length >= 3 && !GENERIC.has(w));

/**
 * The payment's counterparty as a precedent's key, or none when it is not certain: the one VAT
 * number of its receipts, else their one vendor, else the bank's counterparty text when it is
 * not generic. Receipts that name two counterparties give none.
 */
export function precedentKey(books: Pick<Index, 'mappings' | 'receipts'>, tx: Pick<BankTransaction, 'ref' | 'description' | 'counterparty'>): PrecedentMatch | undefined {
  const { uids, vendors } = receiptKeys(books, tx);
  if (uids.size === 1) return { uid: [...uids][0] };
  if (uids.size > 1 || vendors.size > 1) return undefined;
  if (vendors.size === 1) return { vendor: [...vendors][0] };
  const text = tx.counterparty || merchantOf(tx.description);
  if (isGenericText(text)) return undefined;
  const key = normalized(words(text).join(' '));
  return key && key.length >= 3 ? { tx: key } : undefined;
}

const sameMatch = (a: PrecedentMatch, b: PrecedentMatch) => JSON.stringify(a) === JSON.stringify(b);

const HEADER = '# The company\'s rules and precedents for the steps of processes/booking.guide.yaml (src/knowledge/layers.ts).\n';

function load(ws: Pick<Workspace, 'paths'>) {
  const file = guideFile(ws);
  return parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : `${HEADER}process: booking\n`);
}

const asPrecedent = (v: unknown): ChoicePrecedent | undefined => {
  const p = v as Partial<ChoicePrecedent> | null;
  const m = p?.match as Record<string, unknown> | undefined;
  const one = m && Object.keys(m).length === 1 && ['uid', 'vendor', 'tx'].some((k) => typeof m[k] === 'string');
  return p && typeof p.id === 'string' && one && CHOICES.includes(p.choice as Choice) ? p as ChoicePrecedent : undefined;
};

/** The precedents with a choice, newest last. */
export function choicePrecedents(ws: Pick<Workspace, 'paths'>): ChoicePrecedent[] {
  const list = (load(ws).toJS() as { steps?: Record<string, { precedents?: unknown[] }> } | null)?.steps?.[PRECEDENT_STEP]?.precedents ?? [];
  return list.flatMap((p) => asPrecedent(p) ?? []);
}

export const precedentFor = (ws: Pick<Workspace, 'paths'>, key: PrecedentMatch): ChoicePrecedent | undefined =>
  choicePrecedents(ws).filter((p) => sameMatch(p.match, key)).at(-1);

function precedentsSeq(doc: ReturnType<typeof load>): YAMLSeq {
  if (!isMap(doc.get('steps'))) doc.set('steps', doc.createNode({}));
  const steps = doc.get('steps') as YAMLMap;
  if (!isMap(steps.get(PRECEDENT_STEP))) steps.set(PRECEDENT_STEP, doc.createNode({}));
  const step = steps.get(PRECEDENT_STEP) as YAMLMap;
  if (!isSeq(step.get('precedents'))) step.set('precedents', doc.createNode([]));
  return step.get('precedents') as YAMLSeq;
}

function save(ws: Pick<Workspace, 'paths'>, doc: ReturnType<typeof load>): void {
  const file = guideFile(ws);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

/** Keeps `p`, comments and all; an older precedent of the same key goes, so a correction wins. */
export function keepPrecedent(ws: Pick<Workspace, 'paths'>, p: ChoicePrecedent): void {
  const doc = load(ws);
  const seq = precedentsSeq(doc);
  seq.items = seq.items.filter((node) => { const q = asPrecedent((node as { toJSON?: () => unknown }).toJSON?.()); return !q || !sameMatch(q.match, p.match); });
  const node = doc.createNode(p);
  (node as { flow?: boolean }).flow = true;
  seq.items.push(node);
  save(ws, doc);
}

/** Takes the precedent `id` back (the answer it came from was undone). */
export function dropPrecedent(ws: Pick<Workspace, 'paths'>, id: string): void {
  if (!existsSync(guideFile(ws))) return;
  const doc = load(ws);
  const seq = precedentsSeq(doc);
  const before = seq.items.length;
  seq.items = seq.items.filter((node) => asPrecedent((node as { toJSON?: () => unknown }).toJSON?.())?.id !== id);
  if (seq.items.length !== before) save(ws, doc);
}
