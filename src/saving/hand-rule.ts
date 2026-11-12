/**
 * A rule made by hand in Firma › Regeln (MISSION: everything possible without AI; r8k-4): the
 * person names whose payments (a business the firm knows, a payer, or a text) and how they are
 * booked, the app drafts the rule into its file as the sidebar's AI would, and the same card
 * (src/saving/rules.ts draftRules, keepDraft) shows what it would do and keeps it with one click.
 * Nothing is kept until the person clicks «Behalten».
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { loadBooks } from '../books/store.js';
import { loadClassifyContext, mappedReceipts, paymentFacts, ruleBookingLines, ruleOfPayment, type RuleLine } from '../booking/classify.js';
import { stableWords } from '../knowledge/gaps.js';
import type { BankTransaction } from '../types/index.js';
import { OWN_USE, parseRule, RULE_SECTION, RULE_STEP, type RuleRefusal } from '../booking/rules.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { homeOf, loadKnowledge, RULES_DIR } from '../knowledge/layers.js';
import { ibanKey, payerKey, payerNames, textKey } from '../knowledge/payer.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { draftDir } from './changes.js';
import { ruleFactsOf } from './rules.js';
import type { Tags } from '../books/tags.js';

/** Whose payments a hand-made rule books. */
export type HandMatch =
  /** A business the firm knows: the rule stands in its file. */
  | { kind: 'business'; id: string }
  /** The payer's IBAN or its name as the bank writes it. */
  | { kind: 'payer'; payer: string }
  /** A pattern over the payment's text and the bank's counterparty name. */
  | { kind: 'text'; text: string };

/** POST /api/rules/hand: the form of Firma › Regeln. */
export interface HandRule {
  match: HandMatch;
  direction?: 'in' | 'out';
  amount?: { over?: number; under?: number };
  account: string;
  /** null: booked without a VAT code (a firm not registered, a transfer); absent: not chosen, so code takes it from the receipts of the rule's payments, or the card asks (src/booking/rule-vat.ts). */
  vat?: string | null;
  /** A foreign VAT split off a sale abroad: its rate, the account it goes onto (an answer to the sale question, never the form). */
  foreignTax?: { rate: number; account: string };
  /** The reporting dimensions every booking of the rule carries (#127). */
  tags?: Tags;
  /** The owner's share in percent (`then.private`); `ownUse`: booked as own use, the input tax corrected (`as: own-use`). */
  private?: { share: number; ownUse?: boolean };
}

/**
 * GET /api/rules/hand?payment=: the form started from a payment (a task «Von Hand buchen»), with the
 * payment's name. `similar`: how many payments of the open period without a booking the started
 * rule would hold for, this one among them, so a task can say «3 Zahlungen wie diese» (#344); `wider`:
 * the payment's lasting words where they hold for more of them than the start does (`?by=text` starts with them).
 * `rule`: the company rule that decides the payment already (it waits for its receipt, say), with
 * the lines it would book now: the hand-booking form proposes them.
 */
export interface HandStart { match: HandMatch; direction: 'in' | 'out'; name: string; similar?: number; wider?: { text: string; similar: number }; rule?: { id: string; lines: RuleLine[] } }

const GUIDE = `${RULES_DIR}/booking.guide.yaml`;

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'regel';

/** The payer as a rule keeps it: an IBAN without spaces, else the name's key (src/knowledge/payer.ts). */
const payerOf = (s: string) => ibanKey(s) ?? textKey({ description: '', counterparty: s }) ?? s.trim();

/** Where a drafted rule came from (`source:`, AGENTS.md): the form of Firma › Regeln, or a person's correction (issue #40). */
export type HandSource = 'hand' | 'correction';

/** The rule as written in its file, without its id. */
function written(h: HandRule, today: string, source: HandSource = 'hand'): { when?: Record<string, unknown>; then: Record<string, unknown>; source: string } {
  const when: Record<string, unknown> = {
    ...(h.match.kind === 'payer' ? { payer: payerOf(h.match.payer) } : h.match.kind === 'text' ? { text: h.match.text.trim() } : {}),
    ...(h.direction ? { direction: h.direction } : {}),
    ...(h.amount && (h.amount.over !== undefined || h.amount.under !== undefined) ? { amount: h.amount } : {}),
  };
  return { ...(Object.keys(when).length ? { when } : {}), then: {
    account: h.account, ...(h.vat === undefined ? {} : { vat: h.vat ?? 'none' }),
    ...(h.private ? { private: h.private.ownUse ? { share: h.private.share, as: OWN_USE } : h.private.share } : {}),
    ...(h.foreignTax ? { foreignTax: h.foreignTax } : {}),
    ...(h.tags && Object.keys(h.tags).length ? { tags: h.tags } : {}),
  }, source: `${source} ${today}` };
}

/** The text of a rules file with the hand-made rule added at the end of its rules, under an id no rule of the file has. */
export function withHandRule(text: string, h: HandRule, today: string, source: HandSource = 'hand'): string {
  const business = h.match.kind === 'business' ? h.match.id : undefined;
  const doc = parseDocument(text || (business ? `id: ${business}\n` : 'process: booking\n'));
  const section = business ? RULE_STEP : RULE_SECTION;
  const rules = doc.getIn(['steps', section, 'rules']);
  const seq = rules instanceof YAMLSeq ? rules : doc.createNode([]) as YAMLSeq;
  if (!(rules instanceof YAMLSeq)) doc.setIn(['steps', section, 'rules'], seq);
  const taken = new Set(seq.items.map((i) => (i instanceof YAMLMap ? String(i.get('id')) : '')));
  const base = `${slug(h.match.kind === 'business' ? h.match.id : h.match.kind === 'payer' ? h.match.payer : h.match.text)}-${h.account}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  seq.add(doc.createNode({ id, ...written(h, today, source) }, { flow: false }));
  const added = seq.items.at(-1) as YAMLMap;
  for (const k of ['when', 'then']) { const v = added.get(k, true); if (v instanceof YAMLMap) v.flow = true; }
  return doc.toString({ lineWidth: 0 });
}

export type HandDraft = { ok: true; path: string } | { ok: false; refusal: RuleRefusal };

/**
 * POST /api/rules/hand: the rule checked as the app would carry it out, then drafted into its
 * file (into the draft waiting for it, if one does) for the card. A rule the app cannot carry
 * out is refused here with its reason, and nothing is written.
 */
export function draftHandRule(ws: Workspace, h: HandRule, today = new Date().toISOString().slice(0, 10), source: HandSource = 'hand'): HandDraft {
  const id = h.match.kind === 'business' ? h.match.id : undefined;
  const business = id ? loadKnowledge(APP_ROOT, ws.paths.root).counterparties.find((c) => c.id === id) : undefined;
  if (id !== undefined && !business) return { ok: false, refusal: { code: 'counterparty', params: { counterparty: id } } };
  // A VAT not chosen is settled on the card (src/saving/rules.ts settleVat): the rest is checked as if it booked without one.
  const parsed = parseRule({ id: 'hand', ...written({ ...h, vat: h.vat === undefined ? null : h.vat }, today, source) }, ruleFactsOf(ws), !!business);
  if (!parsed.ok) return { ok: false, refusal: parsed.refusal };
  const path = business ? homeOf('workspace', business.role, business.id) : GUIDE;
  const draft = join(draftDir(ws), path);
  const real = join(ws.paths.root, path);
  const text = existsSync(draft) ? readFileSync(draft, 'utf8') : existsSync(real) ? readFileSync(real, 'utf8') : '';
  mkdirSync(dirname(draft), { recursive: true });
  writeFileSync(draft, withHandRule(text, h, today, source));
  return { ok: true, path };
}

/** The form started from payment `ref`: its business when the firm knows it, else its payer, else its text; `by` 'text': its text. */
export function handStart(ws: Workspace, ref: string, by?: 'text'): HandStart | undefined {
  const books = loadBooks(ws);
  const tx = books.transactions.find((t) => t.ref === ref);
  if (!tx) return undefined;
  const context = loadClassifyContext(ws);
  const business = paymentFacts(books, tx, context, loadFxResolver()).counterparty;
  const payer = payerKey(tx);
  const name = (business && context.counterparties?.find((c) => c.id === business)?.name) || (payer && payerNames([tx])[payer]) || tx.counterparty || tx.description;
  const direction = tx.direction === 'CRDT' ? 'in' : 'out';
  const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fx = loadFxResolver();
  const closed = books.config?.closedThrough;
  const booked = new Set((books.journalEntries ?? []).map((e) => e.transactionRef));
  const open = books.transactions.filter((t) => t.direction === tx.direction && !(closed && t.date <= closed) && !booked.has(t.ref));
  const count = (like: (t: BankTransaction) => boolean) => open.filter((t) => t.ref === tx.ref || like(t)).length;
  // By text: the words that stay from one such payment to the next, never the month or the invoice number of this one.
  const text = escaped(stableWords(tx.description) || tx.description);
  const byText = count((t) => new RegExp(text, 'i').test(`${t.description} ${t.counterparty ?? ''}`));
  const byPayer = payer ? count((t) => payerKey(t) === payer) : 0;
  // A business the firm knows first, else the payer, else the text. Where the text holds for more open payments (six wages to two
  // people share «Lohn», #344) code cannot tell a kind of payment from a common word («Rechnung»): it names that wider start, and the person takes it (`by`).
  const [match, similar]: [HandMatch, number] = by === 'text' ? [{ kind: 'text', text }, byText]
    : business ? [{ kind: 'business', id: business }, count((t) => paymentFacts(books, t, context, fx).counterparty === business)]
      : payer ? [{ kind: 'payer', payer: ibanKey(payer) ?? name }, byPayer]
        : [{ kind: 'text', text }, byText];
  const wider = match.kind !== 'text' && byText > similar ? { text, similar: byText } : undefined;
  const placed = ruleOfPayment(books, tx, context, fx);
  const rule = placed?.rule.then.kind === 'book' ? { id: placed.rule.id, lines: ruleBookingLines(tx, placed.rule.then.booking, mappedReceipts(books, tx), context.ownerAccount) } : undefined;
  return { match, direction, name, similar, ...(wider && { wider }), ...(rule && { rule }) };
}
