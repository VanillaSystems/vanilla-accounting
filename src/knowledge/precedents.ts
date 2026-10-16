/**
 * An answer «privat» or «geschäftlich» is kept as a precedent of the booking guide's `private`
 * step, in the company's layer (knowledge/rules/booking.guide.yaml, src/knowledge/layers.ts),
 * where the booking and the AI read the person's decisions. Besides the words every precedent has
 * (item, decision, by), it carries what code needs to find it again: `match.tx`, the payment's
 * counterparty as a key, and `choice`. The next question of that kind on a payment of the same
 * counterparty is answered by it without anyone asked (src/server/questions.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import { merchantOf } from './counterparties.js';
import { RULES_DIR } from './layers.js';
import type { BankTransaction } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { CHOICES, type Choice } from '../questions/model.js';

export const PRECEDENT_STEP = 'private';
export const guideFile = (ws: Pick<Workspace, 'paths'>): string => join(ws.paths.root, RULES_DIR, 'booking.guide.yaml');

export interface ChoicePrecedent { id: string; date: string; item: string; decision: string; by: string; match: { tx: string }; choice: Choice; question?: string }

/** The counterparty of a payment as a precedent's key: lower case, without numbers (a card's digits, a date); none when too little is left. */
export function counterpartyKey(tx: Pick<BankTransaction, 'description' | 'counterparty'>): string | undefined {
  const key = (tx.counterparty || merchantOf(tx.description)).toLowerCase().replace(/\d+/g, ' ').replace(/[^\p{L}&.\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return key.length >= 3 ? key : undefined;
}

const HEADER = '# The company\'s rules and precedents for the steps of processes/booking.guide.yaml (src/knowledge/layers.ts).\n';

function load(ws: Pick<Workspace, 'paths'>) {
  const file = guideFile(ws);
  return parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : `${HEADER}process: booking\n`);
}

const asPrecedent = (v: unknown): ChoicePrecedent | undefined => {
  const p = v as Partial<ChoicePrecedent> | null;
  return p && typeof p.id === 'string' && typeof p.match?.tx === 'string' && CHOICES.includes(p.choice as Choice) ? p as ChoicePrecedent : undefined;
};

/** The precedents with a choice, newest last. */
export function choicePrecedents(ws: Pick<Workspace, 'paths'>): ChoicePrecedent[] {
  const list = (load(ws).toJS() as { steps?: Record<string, { precedents?: unknown[] }> } | null)?.steps?.[PRECEDENT_STEP]?.precedents ?? [];
  return list.flatMap((p) => asPrecedent(p) ?? []);
}

export const precedentFor = (ws: Pick<Workspace, 'paths'>, key: string): ChoicePrecedent | undefined =>
  choicePrecedents(ws).filter((p) => p.match.tx === key).at(-1);

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
  seq.items = seq.items.filter((node) => asPrecedent((node as { toJSON?: () => unknown }).toJSON?.())?.match.tx !== p.match.tx);
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
