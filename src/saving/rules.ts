/**
 * Keeping, switching off and deleting the company's rules with one click (MISSION: «the person
 * keeps it with one click»; docs/0.4.0/saving.md, "One click for a rule"). A draft of a rules file
 * the AI wrote is shown in plain words and kept at once, without the AI step «Speichern
 * vorbereiten»: the app renders a rule from its structure itself. Every rule a save adds or changes
 * must be one the app carries out (src/booking/rules.ts); a rule in sentences is refused when it is
 * kept, never stored as prose nothing acts on. Firma › Regeln switches a rule off or deletes it in
 * place, each with an undo that puts the file back as it was.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { parse, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { chartNames, companyRules, factsOf, holdsRules, rulesIn, type RuleRow } from '../booking/rule-book.js';
import { chartOf, decidedBeforeRules, loadClassifyContext, mappedReceipts, paymentFacts, ruleLine } from '../booking/classify.js';
import { loadKnowledge, KNOWLEDGE_DIR } from '../knowledge/layers.js';
import { holds, loneWords, parseRule, type BookingRule, type RuleFacts } from '../booking/rules.js';
import { ruleVatOf, takesNoCode, type RateSeen } from '../booking/rule-vat.js';
import { receiptKnowledge, receiptWaitOf, settlementAccount } from '../booking/receipt-wait.js';
import type { BankTransaction } from '../types/index.js';
import { firmTypeOf } from './wage-rule.js';
import { rateOf } from '../accounting/vat-codes.js';
import { previewRules, ruleKey, type OpenDecided, type PlacedRow, type RulePreview } from '../booking/rule-preview.js';
import { noteOffer, type NoteOffer } from '../knowledge/note-rules.js';
import { loadFxResolver } from '../accounting/fx-rates.js';
import { hasBooks, loadBooks } from '../books/store.js';
import type { Counterparty } from '../knowledge/counterparties.js';
import { payerNames } from '../knowledge/payer.js';
import { commitExactly, repositoryAt } from '../workspace/git.js';
import { APP_ROOT, type Workspace } from '../workspace/workspace.js';
import { draftDir } from './changes.js';
import { recordSettled, ruleChanges } from './settled-drafts.js';
import type { Dimension } from '../books/tags.js';

type Ws = Pick<Workspace, 'paths'>;

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);
const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/** What the rules of a workspace may name: its chart, the VAT codes, its businesses (and `alsoBusiness`, a business a draft adds), its reporting dimensions. */
export function ruleFactsOf(ws: Pick<Workspace, 'paths' | 'dimensions'>, alsoBusiness?: string): RuleFacts {
  const ids = new Set(loadKnowledge(APP_ROOT, ws.paths.root).counterparties.map((c) => c.id));
  if (alsoBusiness) ids.add(alsoBusiness);
  return factsOf(chartNames(chartOf(ws)), ids, ws.dimensions);
}

/** How a rules file changes: its rules added, changed and removed, whether anything else changed, and what cannot be kept. */
export interface RuleDiff {
  path: string;
  added: RuleRow[];
  changed: RuleRow[];
  /** Each changed rule as it stands now, in the order of `changed`: the card says what it was. */
  before: RuleRow[];
  removed: RuleRow[];
  /** Parts of the file other than its rules and `grouped` changed (a business's name or how it is recognised). */
  others: boolean;
  /** A business's file says anew whether it pays several receipts in one payment (`grouped`, #190): the value it would have. */
  grouped?: boolean;
  /** Added or changed rules the app cannot carry out: keeping refuses them. */
  refused: RuleRow[];
  /** Added or changed rules that rest on single words alone (loneWords): keeping them asks for confirmation. */
  wide: RuleRow[];
  /** Added or changed rules whose payments are booked today on several other accounts or privately (RulePreview.spread): keeping them asks for confirmation. Filled by withPreview. */
  spread: RuleRow[];
  /** Added or changed rules that book payments against a national VAT rule (RulePreview.overrides, issue #75): keeping them asks for confirmation. Filled by withPreview. */
  overrides: RuleRow[];
  /** The knowledge would not load with this file (it names the reason). */
  broken?: string;
}

/** The file's body with every rule list emptied and without its `grouped`: what the card does not show line by line. */
function withoutRules(text: string): string {
  const body = (parse(text) ?? {}) as { steps?: Record<string, { rules?: unknown[] }>; grouped?: unknown };
  for (const s of Object.values(body.steps ?? {})) if (s && typeof s === 'object') delete s.rules;
  delete body.grouped;
  return JSON.stringify(body);
}

/** Whether a business's file says it pays several receipts in one payment. */
const groupedIn = (text: string): boolean => ((parse(text) ?? {}) as { grouped?: unknown }).grouped === true;

/** The workspace's businesses with `text` at `path` (a copy of knowledge/ with the file in it), or why they would not load. */
function knowledgeWith(ws: Ws, path: string, text: string): { counterparties: Counterparty[] } | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rules-check-'));
  try {
    const own = join(ws.paths.root, KNOWLEDGE_DIR);
    if (existsSync(own)) cpSync(own, join(dir, KNOWLEDGE_DIR), { recursive: true });
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    return { counterparties: loadKnowledge(APP_ROOT, dir).counterparties };
  } catch (e) {
    return { error: (e as Error).message.replace(dir + '/', '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function ruleDiff(ws: Ws, path: string, before: string, after: string): RuleDiff {
  const business = path.startsWith(`${KNOWLEDGE_DIR}/rules/`) ? undefined : basename(path, '.yaml');
  const facts = ruleFactsOf(ws, business);
  let broken: string | undefined;
  let a: RuleRow[] = [];
  try { a = after ? rulesIn(path, after, facts) : []; } catch (e) { broken = (e as Error).message; }
  const b = before ? rulesIn(path, before, facts) : [];
  const key = (r: RuleRow) => `${r.step}#${r.id}`;
  const same = (x: RuleRow, y: RuleRow) => JSON.stringify([x.kind, x.rule, x.note, x.off, x.source]) === JSON.stringify([y.kind, y.rule, y.note, y.off, y.source]);
  const added = a.filter((r) => !b.some((x) => key(x) === key(r)));
  const changed = a.filter((r) => b.some((x) => key(x) === key(r) && !same(x, r)));
  const removed = b.filter((r) => !a.some((x) => key(x) === key(r)));
  const was = changed.map((r) => b.find((x) => key(x) === key(r))!);
  const wide = [...added, ...changed].filter((r) => r.kind === 'rule' && loneWords(placedOf(r)).length > 0);
  let others = false;
  let grouped: boolean | undefined;
  if (!broken) {
    try {
      others = withoutRules(before) !== withoutRules(after);
      if (business && groupedIn(before) !== groupedIn(after)) grouped = groupedIn(after);
    } catch (e) { broken = (e as Error).message; }
  }
  if (!broken && after) { const k = knowledgeWith(ws, path, after); if ('error' in k) broken = k.error; }
  return { path, added, changed, before: was, removed, others, ...(grouped !== undefined ? { grouped } : {}), refused: [...added, ...changed].filter((r) => r.kind !== 'rule'), wide, spread: [], overrides: [], ...(broken ? { broken } : {}) };
}

const placedOf = (r: RuleRow) => ({ rule: r.rule as BookingRule, ...(r.business ? { business: r.business } : {}) });

/**
 * Why a set of changed files cannot be kept: a rule the app cannot carry out, knowledge that would
 * not load, or (unless the person `confirmed` it on the card, having seen its payments) a rule that
 * rests on single words alone.
 */
export function rulesRefusal(diffs: RuleDiff[], confirmed = false): string | undefined {
  const lines = diffs.flatMap((d) => [
    ...(d.broken ? [`${d.path}: ${d.broken}`] : []),
    ...d.refused.map((r) => `${d.path}: Regel «${r.id || '?'}» kann die App nicht ausführen (${r.kind === 'note' ? 'in Sätzen geschrieben' : r.refusal?.code ?? '?'})`),
    ...(confirmed ? [] : d.wide.map((r) => `${d.path}: Regel «${r.id}» erkennt Zahlungen nur an einzelnen Wörtern (${loneWords(placedOf(r)).join(', ')}): auf ihrer Karte die passenden Zahlungen ansehen und bestätigen`)),
    ...(confirmed ? [] : d.spread.filter((r) => !d.wide.includes(r)).map((r) => `${d.path}: Regel «${r.id}» trifft Zahlungen, die heute auf verschiedenen Konten oder privat gebucht sind: auf ihrer Karte ansehen und bestätigen`)),
    ...(confirmed ? [] : d.overrides.map((r) => `${d.path}: Regel «${r.id}» bucht Zahlungen anders, als es die Steuerregeln des Landes verlangen: auf ihrer Karte ansehen und bestätigen`)),
  ]);
  return lines.length ? lines.join('; ') : undefined;
}

/** The draft of one rules file against the file as it is: what the sidebar's card and Änderungen show. */
export interface DraftRules extends RuleDiff {
  /** The draft's content hash: «Behalten» keeps exactly what was shown. */
  basis: string;
  /** One click keeps it: the file loads, every rule in it is one the app carries out, and a rule (or `grouped`) changes. */
  keepable: boolean;
  /** Keeping it needs the person's confirmation (`wide`, `spread` or `overrides` is not empty): the button says «Trotzdem behalten». */
  confirm: boolean;
  /** What each added or changed rule would do on this year's payments, in the order of `added` then `changed`. */
  preview: RulePreview[];
  /** For each added or changed rule drafted from a sentence of the notes, by ruleKey: whether code offers it (src/knowledge/note-rules.ts). Keeping refuses one not offered as it is. */
  offers: Record<string, NoteOffer>;
  /** The rules that name no VAT and whose receipts do not settle it: the card asks once which rate they book at (F05). */
  vatAsks: VatAsk[];
}

/** A drafted rule without `vat` whose receipts show different rates or none: the rates they show, and the rates to choose from (0: no Swiss VAT). */
export interface VatAsk { step: string; id: string; seen: RateSeen[]; choices: number[] }

/** Every rule of the workspace with `rows` standing for the file at `path`, each as the classifier places it. */
function rulesWith(ws: Ws, path: string, rows: readonly RuleRow[]): PlacedRow[] {
  return [...companyRules(ws, ruleFactsOf(ws)).filter((r) => r.file !== path), ...rows]
    .filter((r) => r.kind === 'rule' && r.rule).map((row) => ({ row, placed: placedOf(row) }));
}

export function draftRules(ws: Workspace, path: string): DraftRules | undefined {
  if (!holdsRules(path) || path.includes('..')) return undefined;
  const draft = join(draftDir(ws), path);
  if (!existsSync(draft)) return undefined;
  const drafted = read(draft);
  // The AI's draft is not the person's yet: the VAT it left out is written in by code, the same on every read.
  const { text: after, asks: vatAsks } = settleVat(ws, path, drafted);
  if (after !== drafted) writeFileSync(draft, after);
  const { diff: d, preview } = withPreview(ws, ruleDiff(ws, path, read(join(ws.paths.root, path)), after), after);
  const offers = offersOf(ws, d, preview, after);
  const keepable = !d.broken && !d.refused.length && (d.added.length + d.changed.length + d.removed.length > 0 || d.grouped !== undefined) && !notOffered(offers).length;
  return { ...d, basis: hashOf(after), keepable, confirm: keepable && (d.wide.length > 0 || d.spread.length > 0 || d.overrides.length > 0 || rebooking(offers).length > 0), preview, offers, vatAsks };
}

const businessOf = (path: string) => (path.startsWith(`${KNOWLEDGE_DIR}/rules/`) ? undefined : basename(path, '.yaml'));

/** Rule `id` in `step` of a rules file's document, and its `then` map. */
function ruleNode(doc: ReturnType<typeof parseDocument>, file: string, step: string, id: string): { rule: YAMLMap; then: YAMLMap } | undefined {
  const seq = doc.getIn(['steps', sectionOf(file, step), 'rules']);
  const rule = seq instanceof YAMLSeq ? seq.items.find((item): item is YAMLMap => item instanceof YAMLMap && item.get('id') === id) : undefined;
  const then = rule?.get('then');
  return rule && then instanceof YAMLMap ? { rule, then } : undefined;
}

/**
 * The draft with the VAT of each rule that names none written in where the receipts of its payments
 * settle it (src/booking/rule-vat.ts), and the rules whose card must ask. Only the VAT is missing:
 * a rule refused for anything else keeps that refusal.
 */
function settleVat(ws: Workspace, path: string, text: string): { text: string; asks: VatAsk[] } {
  const business = businessOf(path);
  const facts = ruleFactsOf(ws, business);
  let rows: RuleRow[];
  try { rows = rulesIn(path, text, facts).filter((r) => r.refusal?.code === 'vatMissing'); } catch { return { text, asks: [] }; }
  if (!rows.length) return { text, asks: [] };
  const doc = parseDocument(text);
  const books = hasBooks(ws) ? loadBooks(ws) : undefined;
  const k = knowledgeWith(ws, path, text);
  const context = { ...loadClassifyContext(ws), counterparties: 'error' in k ? [] : k.counterparties };
  const fx = loadFxResolver();
  const { wages } = receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws);
  const typeOf = firmTypeOf(ws);
  const asks: VatAsk[] = [];
  for (const row of rows) {
    const node = ruleNode(doc, path, row.step, row.id);
    if (!node) continue;
    // Without a code the rule parses as it would book: which payments it holds for, on which account.
    const raw = node.rule.toJSON() as Record<string, unknown>;
    const probe = parseRule({ ...raw, then: { ...(raw.then as object), vat: 'none' } }, facts, !!business);
    const booking = probe.ok ? probe.rule.then.booking : undefined;
    if (!probe.ok || !booking) continue;
    const placed = { rule: probe.rule, ...(business ? { business } : {}) };
    const payments = books ? books.transactions.filter((tx) => holds(placed, paymentFacts(books, tx, context, fx))) : [];
    const receipts = payments.flatMap((tx) => mappedReceipts(books!, tx));
    // Wages (the evidence rules' wording, on a firm that pays wages) and an account that takes no VAT code book without one, unasked (#383).
    const wage = (tx: BankTransaction) => wages.some((w) => w.test(tx.description));
    const noCode = takesNoCode(booking.account, settlementAccount(context), typeOf) || (payments.length > 0 && payments.every(wage));
    const vat = ruleVatOf(booking.account, receipts, noCode);
    if (vat.kind === 'fill') node.then.set('vat', vat.vat);
    else asks.push({ step: row.step, id: row.id, seen: vat.seen, choices: vat.choices });
  }
  return { text: asks.length === rows.length ? text : String(doc), asks };
}

/** The person's answer to a card's VAT question: the rate goes into the draft as shown (`basis`); refused when the draft changed since. */
export function setDraftVat(ws: Workspace, path: string, basis: string, step: string, id: string, rate: number): KeepResult {
  if (!holdsRules(path) || path.includes('..')) return { ok: false, refusal: 'not-rules', message: `${path} hält keine Regeln.` };
  const draft = join(draftDir(ws), path);
  if (!existsSync(draft)) return { ok: false, refusal: 'gone', message: 'Diesen Entwurf gibt es nicht mehr.' };
  const text = read(draft);
  if (hashOf(text) !== basis) return { ok: false, refusal: 'stale', message: 'Der Entwurf hat sich seit der Anzeige geändert.' };
  const doc = parseDocument(text);
  const node = ruleNode(doc, path, step, id);
  if (!node || rateOf(rate) === undefined) return { ok: false, refusal: 'changed', message: `Regel ${id}: einen Satz von ${rate} % gibt es nicht.` };
  node.then.set('vat', rate);
  writeFileSync(draft, String(doc));
  return { ok: true, committed: false };
}

/** The checks of each added or changed rule drafted from the notes, against every rule of the workspace with the draft applied. */
function offersOf(ws: Ws, d: RuleDiff, preview: readonly RulePreview[], after: string): Record<string, NoteOffer> {
  const targets = [...d.added, ...d.changed].filter((r) => r.rule?.note);
  if (!targets.length || d.broken) return {};
  const rows = rulesWith(ws, d.path, rulesIn(d.path, after, ruleFactsOf(ws, d.path.startsWith(`${KNOWLEDGE_DIR}/rules/`) ? undefined : basename(d.path, '.yaml')))).map((r) => r.row);
  const adjusting = (r: RuleRow) => d.changed.includes(r) && !!d.before[d.changed.indexOf(r)].rule?.note;
  return Object.fromEntries(targets.flatMap((r) => { const o = noteOffer(r, preview.find((p) => p.key === ruleKey(r)), rows, adjusting(r)); return o ? [[ruleKey(r), o]] : []; }));
}

/** The rules from the notes code does not offer as drafted: they stay a note, or only an ask rule may carry them out. */
const notOffered = (offers: Record<string, NoteOffer>): string[] => Object.entries(offers).filter(([, o]) => o.offer !== 'rule').map(([k]) => k);
/** Rules adjusted to a changed sentence that book this year's payments otherwise than they are booked: keeping them asks for confirmation. */
const rebooking = (offers: Record<string, NoteOffer>): string[] => Object.entries(offers).filter(([, o]) => o.offer === 'rule' && o.otherwise).map(([k]) => k);

/** A diff with what its added and changed rules would do on this year's payments, which of them spread over decisions made (RulePreview.spread) and which book against a national VAT rule (RulePreview.overrides). */
export function withPreview(ws: Workspace, d: RuleDiff, after: string): { diff: RuleDiff; preview: RulePreview[] } {
  const targets = [...d.added, ...d.changed];
  const shown = d.broken || !after ? [] : preview(ws, d.path, after, targets);
  const flagged = (has: (p: RulePreview) => unknown) => targets.filter((r) => shown.some((p) => p.key === ruleKey(r) && has(p)));
  return { diff: { ...d, spread: flagged((p) => p.spread), overrides: flagged((p) => p.overrides) }, preview: shown };
}

/** The preview of `targets` (rules of the draft at `path`) on the books, with the draft's businesses routing the payments. */
function preview(ws: Workspace, path: string, after: string, targets: RuleRow[]): RulePreview[] {
  const rules = targets.filter((r) => r.kind === 'rule');
  if (!rules.length || !hasBooks(ws)) return [];
  const k = knowledgeWith(ws, path, after);
  if ('error' in k) return [];
  const all = rulesWith(ws, path, rulesIn(path, after, ruleFactsOf(ws, path.startsWith(`${KNOWLEDGE_DIR}/rules/`) ? undefined : basename(path, '.yaml'))));
  const context = { ...loadClassifyContext(ws), counterparties: k.counterparties, rules: all.map((r) => r.placed) };
  const keys = new Set(rules.map(ruleKey));
  const books = loadBooks(ws);
  const fx = loadFxResolver();
  // A payment that needs a receipt is not booked while none is linked, by a rule too: the card says it waits (#383).
  const known = receiptKnowledge(loadKnowledge(APP_ROOT, ws.paths.root), ws);
  const waits = (tx: BankTransaction) => receiptWaitOf(books, tx, context, known, fx).wait;
  return previewRules(all.filter((r) => keys.has(ruleKey(r.row))), all, books, context, fx, waits, decidedBeforeRules(books, context));
}

export type KeepResult =
  | {
    ok: true; committed: boolean;
    /** The open payments the kept rules decide: booked at once by the keep, or waiting for their receipt. */
    open?: OpenDecided;
    /** The rules file as it was: «Rückgängig» puts it back (RuleCommand restore). */
    undo?: { file: string; before: string; after: string };
    /** What the booking runs the keep started made of `open.book` (src/server/routes/rules.ts). */
    booked?: KeptBookings;
  }
  | { ok: false; refusal: 'gone' | 'stale' | 'rules' | 'wide' | 'not-rules' | 'changed' | 'note'; message: string };

/**
 * What keeping a rule booked: its booking runs (the undo goes by them), the payments they booked and
 * their entries, how many runs are still going, the payments a run left unbooked, and how many
 * payments were not started at the keep (more than KEEP_RUNS_MAX: the next run books them).
 */
export interface KeptBookings { runs: string[]; refs: string[]; entries: string[]; running: number; notBooked: string[]; later?: number; first?: { id: string; date: string } }

const CUSTOMIZING = ['Vanilla-Kind: customizing', "Vanilla-Person: the app's user"];

/** The subject of a save that keeps rules, in plain German. */
function subjectOf(ws: Workspace, d: RuleDiff): string {
  const ctx = { chartOfAccounts: chartOf(ws), counterparties: loadKnowledge(APP_ROOT, ws.paths.root).counterparties, payers: hasBooks(ws) ? payerNames(loadBooks(ws).transactions) : {} };
  const say = (r: RuleRow) => (r.rule ? ruleLine({ rule: r.rule, ...(r.business ? { business: r.business } : {}) }, ctx) : r.id);
  const parts = [
    ...d.added.map((r) => `Neue Regel: ${say(r)}`),
    ...d.changed.map((r) => `Regel geändert: ${say(r)}`),
    ...d.removed.map((r) => `Regel entfernt: ${r.rule ? say(r) : r.id}`),
    ...(d.grouped === undefined ? [] : [`${d.grouped ? 'Sammelzahler' : 'Kein Sammelzahler mehr'}: ${basename(d.path, '.yaml')}`]),
  ];
  return (parts.join('; ') || `Regeln: ${d.path}`).slice(0, 200);
}

/** Saves one file of the company's customizing at once, as the person's save (a rule kept, notes written). */
export async function commit(ws: Ws, message: string, path: string): Promise<boolean> {
  const repo = await repositoryAt(ws.paths.repository);
  if (!repo) return false;
  return commitExactly(repo, `${message}\n\n${CUSTOMIZING.join('\n')}`, [relative(repo, join(ws.paths.root, path))]);
}

/**
 * «Behalten»: the one draft file goes into the books folder as the person saw it (`basis`) and is
 * saved at once. Refused when it changed since, when it is not a rules file, or when a rule in it
 * cannot be carried out.
 */
export async function keepDraft(ws: Workspace, path: string, basis: string, confirmed = false): Promise<KeepResult> {
  if (!holdsRules(path) || path.includes('..')) return { ok: false, refusal: 'not-rules', message: `${path} hält keine Regeln.` };
  const draft = join(draftDir(ws), path);
  if (!existsSync(draft)) return { ok: false, refusal: 'gone', message: 'Diesen Entwurf gibt es nicht mehr.' };
  const after = read(draft);
  if (hashOf(after) !== basis) return { ok: false, refusal: 'stale', message: 'Der Entwurf hat sich seit der Anzeige geändert.' };
  const { diff: d, preview } = withPreview(ws, ruleDiff(ws, path, read(join(ws.paths.root, path)), after), after);
  const offers = offersOf(ws, d, preview, after);
  const stays = notOffered(offers);
  if (stays.length && !d.broken && !d.refused.length) return { ok: false, refusal: 'note', message: `Aus den Notizen nicht als Regel angeboten: ${stays.map((k) => k.split('#').at(-1)).join(', ')} (bleibt eine Notiz oder wird eine Frage-Regel)` };
  const rebooks = rebooking(offers);
  if (rebooks.length && !confirmed) return { ok: false, refusal: 'wide', message: `Regel ${rebooks.map((k) => k.split('#').at(-1)).join(', ')} bucht Zahlungen dieses Jahres anders, als sie heute gebucht sind: auf ihrer Karte ansehen und bestätigen` };
  const why = rulesRefusal([d], confirmed);
  if (why) return { ok: false, refusal: (d.wide.length || d.spread.length || d.overrides.length) && !rulesRefusal([d], true) ? 'wide' : 'rules', message: why };
  const to = join(ws.paths.root, path);
  const was = read(to);
  const changes = ruleChanges(was, after);
  mkdirSync(dirname(to), { recursive: true });
  if (after.trim()) writeFileSync(to, after); else rmSync(to, { force: true });
  rmSync(draft);
  const committed = await commit(ws, subjectOf(ws, d), path);
  // What became of each rule, for the AI sidebar (#362): after the keep is done, and never failing it.
  recordSettled(ws, path, changes, 'kept');
  // The open payments the kept rules decide, as the card showed them: the keep books them at once (#383).
  const open = preview.reduce<OpenDecided>((all, p) => ({ book: [...all.book, ...(p.open?.book ?? [])], waits: [...all.waits, ...(p.open?.waits ?? [])] }), { book: [], waits: [] });
  return { ok: true, committed, ...(open.book.length || open.waits.length ? { open, undo: { file: path, before: was, after: hashOf(after) } } : {}) };
}

/** «Verwerfen»: the draft of one file is gone; the file stays as it is. */
export function discardDraft(ws: Ws, path: string): boolean {
  if (path.includes('..')) return false;
  const draft = join(draftDir(ws), path);
  if (!existsSync(draft)) return false;
  const changes = ruleChanges(read(join(ws.paths.root, path)), read(draft));
  rmSync(draft);
  recordSettled(ws, path, changes, 'discarded');
  return true;
}

// ─── Firma › Regeln ─────────────────────────────────────────────────────────

/** A rule with how often it applied: the payments booked by it, the day of the last, and the payments it held to ask about. */
export interface RuleListed extends RuleRow { applied: number; last?: string; asked: number }

/** GET /api/rules. */
export interface RulesView {
  rules: RuleListed[];
  /** The workflows waiting to be switched on because a rules or knowledge file they read changed (the AI's edit, a hand edit): the rules in those files are not live (r6h-24). */
  waiting: Array<{ workflow: string; label: { en: string } & Partial<Record<'de' | 'fr' | 'it', string>>; files: string[] }>;
  /** What a rule's plain words name: accounts, businesses and payers (by the key `when.payer` holds) by their names. */
  names: { accounts: Record<string, string>; businesses: Record<string, string>; payers: Record<string, string>; dimensions?: Dimension[] };
  currency: string;
}

/** GET /api/rules/draft: the draft with the names its rules' words use, and the payments each ask rule holds open, by rule id. */
export type DraftView = DraftRules & Pick<RulesView, 'names' | 'currency'> & { held: Record<string, number> };

/** POST /api/rules/draft. */
export type DraftCommand = { kind: 'keep'; path: string; basis: string; confirm?: boolean } | { kind: 'discard'; path: string } | { kind: 'vat'; path: string; basis: string; step: string; id: string; rate: number };

export type RuleCommand =
  | { kind: 'off' | 'on' | 'delete'; file: string; step: string; id: string }
  /** Undo: the file as it was before, when it is still as the command left it (`after`, its hash). */
  | { kind: 'restore'; file: string; before: string; after: string };

export type RuleCommandResult =
  | { ok: true; undo?: { file: string; before: string; after: string }; committed: boolean }
  | { ok: false; refusal: 'not-found' | 'draft-waiting' | 'changed' | 'not-rules'; message: string };

/** The key of a step inside a file: a company guide keys its sections by step id, a business's file by the full step reference. */
const sectionOf = (file: string, step: string) => (file.startsWith(`${KNOWLEDGE_DIR}/rules/`) ? step.split('#')[1] ?? step : step);

/** The file's text with one rule switched off or on, or deleted; comments and the rest stay as written. */
export function editRule(text: string, file: string, step: string, id: string, kind: 'off' | 'on' | 'delete'): string | undefined {
  const doc = parseDocument(text);
  const seq = doc.getIn(['steps', sectionOf(file, step), 'rules']);
  if (!(seq instanceof YAMLSeq)) return undefined;
  const i = seq.items.findIndex((item) => item instanceof YAMLMap && item.get('id') === id);
  if (i < 0) return undefined;
  const item = seq.items[i] as YAMLMap;
  if (kind === 'delete') seq.delete(i);
  else if (kind === 'off') item.set('off', true);
  else item.delete('off');
  return String(doc);
}

const WORDS: Record<'off' | 'on' | 'delete', string> = { off: 'Regel ausgeschaltet', on: 'Regel eingeschaltet', delete: 'Regel gelöscht' };

export async function ruleCommand(ws: Ws, c: RuleCommand): Promise<RuleCommandResult> {
  if (!holdsRules(c.file) || c.file.includes('..')) return { ok: false, refusal: 'not-rules', message: `${c.file} hält keine Regeln.` };
  if (existsSync(join(draftDir(ws), c.file))) return { ok: false, refusal: 'draft-waiting', message: 'Für diese Datei wartet ein Entwurf: erst behalten oder verwerfen.' };
  const path = join(ws.paths.root, c.file);
  const now = read(path);
  if (c.kind === 'restore') {
    if (hashOf(now) !== c.after) return { ok: false, refusal: 'changed', message: 'Die Regeln haben sich seither geändert.' };
    // A file that was not there before (the first rule ever kept) goes again, as keepDraft removes one that would be empty.
    if (c.before.trim()) writeFileSync(path, c.before); else rmSync(path, { force: true });
    return { ok: true, committed: await commit(ws, 'Regel wiederhergestellt', c.file) };
  }
  const next = editRule(now, c.file, c.step, c.id, c.kind);
  if (next === undefined) return { ok: false, refusal: 'not-found', message: `Regel ${c.id} gibt es in ${c.file} nicht.` };
  writeFileSync(path, next);
  return { ok: true, undo: { file: c.file, before: now, after: hashOf(next) }, committed: await commit(ws, `${WORDS[c.kind]}: ${c.id}`, c.file) };
}
