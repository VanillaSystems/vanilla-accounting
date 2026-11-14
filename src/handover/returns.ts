/**
 * A return on the sharer's side (docs/specs/e2e-and-fiduciary.md B5): kept in handover/returns/<id>/
 * as it came (package.vanilla) with her decisions (state.json), reviewed by record against the
 * version it was made on, and taken over through the write door.
 *
 * The merge is three-way by record (B5.3): base (his `before`), hers (the record in her books now)
 * and his (`after`). What only he changed applies; what only she changed stays; the same record
 * changed both ways is a conflict she picks; a change dated in a period filed meanwhile is offered
 * as a correction booked in the open period with `corrects` (golden rule 1). Taking over is one save
 * as a person-type actor carrying his name, kept with every record's state before it so that
 * «Rückgängig» takes the whole take-over back; it writes a version (B7).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadBooks, periodLock, saveBooks, update, PERSON, type Actor, type Books } from '../books/store.js';
import { addDays, filingKeyOf } from '../accounting/periods.js';
import { reversalOf } from '../accounting/reversal.js';
import { filing, vat } from '../engines/index.js';
import type { JournalEntry } from '../types/index.js';
import type { Workspace } from '../workspace/workspace.js';
import { PackageError, readPackage, type PackageContents, type Question, type ReturnChange } from './package.js';
import { applyToBooks, dateOf, parseRefKey, recordFiles, recordsOf, refKey, sameRecord, type RecordChange, type RecordMap } from './records.js';
import { learnOffer } from '../saving/learn-rule.js';
import { currentVersion, writeVersion, type Party, type Version } from './versions.js';

const DIR = 'handover';
const returnsDir = (ws: Pick<Workspace, 'paths'>) => join(ws.paths.root, DIR, 'returns');
const dirOf = (ws: Pick<Workspace, 'paths'>, id: string) => {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new PackageError(`Keine Rücksendung ${id}.`, 'shareNotPackage');
  return join(returnsDir(ws), id);
};

/** What the sharer decided on a row: leave it out, keep her version or take his (a conflict), or book it as a correction (a period filed meanwhile). */
export type Decision = 'skip' | 'mine' | 'theirs' | 'correction';

/** One take-over: what it changed, each record as it was in her books before, so it can be taken back whole. */
export interface Applied {
  at: string;
  version: number;
  /** Records it changed: `before` hers before, `after` as it left them. */
  changes: RecordChange[];
  /** Correction entries it booked for rows of filed periods. */
  corrections: string[];
  /** Receipt files it put into the workspace. */
  files: string[];
  rows: string[];
  undone?: { at: string; version: number };
}

interface State {
  receivedAt: string;
  decisions: Record<string, Decision>;
  questions: Record<string, Question & { taken?: number }>;
  applied: Applied[];
}

const readState = (ws: Pick<Workspace, 'paths'>, id: string): State => {
  const f = join(dirOf(ws, id), 'state.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as State) : { receivedAt: new Date().toISOString(), decisions: {}, questions: {}, applied: [] };
};
const writeState = (ws: Pick<Workspace, 'paths'>, id: string, s: State) => writeFileSync(join(dirOf(ws, id), 'state.json'), JSON.stringify(s, null, 2) + '\n');
const packageOf = (ws: Pick<Workspace, 'paths'>, id: string): PackageContents => readPackage(readFileSync(join(dirOf(ws, id), 'package.vanilla')));

/**
 * Keeps a return that arrived («Öffnen…» of a `.vanilla` of kind return): refused for another firm.
 * The same file twice is the same return.
 */
export function receiveReturn(ws: Workspace, bytes: Uint8Array, now = new Date()): { id: string; from: Party; changes: number; basedOn: number } {
  const p = readPackage(bytes);
  if (p.index.kind !== 'return') throw new PackageError('Das ist keine Rücksendung.', 'shareWrongKind');
  const uid = ws.company.uid;
  // The same firm: by its UID when both name one, else by its name.
  if (uid && p.index.firm.uid ? uid !== p.index.firm.uid : p.index.firm.name !== ws.company.name) {
    throw new PackageError(`Diese Rücksendung gehört zu ${p.index.firm.name}, nicht zu ${ws.company.name}.`, 'shareOtherCompany', { firm: p.index.firm.name });
  }
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const dir = dirOf(ws, id);
  if (!existsSync(join(dir, 'package.vanilla'))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.vanilla'), bytes);
    writeState(ws, id, { receivedAt: now.toISOString(), decisions: {}, questions: {}, applied: [] });
  }
  return { id, from: p.index.from, changes: p.changes?.length ?? 0, basedOn: p.index.version.n };
}

export interface ReturnSummary { id: string; from: Party; at: string; receivedAt: string; changes: number; basedOn: number; applied: boolean; undone: boolean; message?: string }

/** The returns kept, newest first. */
export function listReturns(ws: Workspace): ReturnSummary[] {
  if (!existsSync(returnsDir(ws))) return [];
  return readdirSync(returnsDir(ws)).filter((d) => /^[0-9a-f]{12}$/.test(d) && existsSync(join(returnsDir(ws), d, 'package.vanilla'))).map((id) => {
    const { index, changes } = packageOf(ws, id);
    const s = readState(ws, id);
    const live = s.applied.filter((a) => !a.undone);
    return { id, from: index.from, at: index.at, receivedAt: s.receivedAt, changes: changes?.length ?? 0, basedOn: index.version.n, applied: live.length > 0, undone: s.applied.length > 0 && !live.length, ...(index.message ? { message: index.message } : {}) };
  }).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
}

// ─── The review ─────────────────────────────────────────────────────────────

/** The groups of B5.2, in their order. */
export const GROUPS = ['corrects', 'vat', 'account', 'amount', 'split', 'link', 'new', 'deleted', 'knowledge', 'other'] as const;
export type GroupId = (typeof GROUPS)[number];

/**
 * - apply: only he changed it; it applies.
 * - same: she has it as he does already.
 * - conflict: both changed it, differently (or she removed it).
 * - sealed: it lies in a period filed since he got the books; an entry may be booked as a correction.
 * - fixed: a sealed row of another kind than an entry: nothing can change it.
 */
export type RowStatus = 'apply' | 'same' | 'conflict' | 'sealed' | 'fixed';

export interface ReviewRow {
  id: string;
  kind: RecordChange['kind'];
  key: string;
  group: GroupId;
  status: RowStatus;
  date?: string;
  label: string;
  before?: unknown;
  after?: unknown;
  /** The record in her books now. */
  mine?: unknown;
  why?: string;
  /** For a sealed row: the filing period it would correct. */
  period?: string;
  decision?: Decision;
  question?: string;
  /** Taken over by a take-over still standing. */
  applied?: boolean;
}

export interface VatEffect { period: string; filed: boolean; before: number; after: number }

export interface Review {
  id: string;
  from: Party;
  at: string;
  basedOn: number;
  message?: string;
  rows: ReviewRow[];
  effect: VatEffect[];
  applied: Applied[];
  /** Payments whose correction may teach a rule («Immer so?», B6): account or code changes and split payments taken over. */
  learn: string[];
}

type Entry = Partial<JournalEntry>;
const asEntry = (r: unknown) => (r ?? {}) as Entry;

/** Which group a change of an entry falls in (B5.2); a split is decided per payment afterwards. */
function groupOf(c: Pick<RecordChange, 'kind' | 'before' | 'after'>): GroupId {
  if (c.kind === 'file' || c.kind === 'config') return 'knowledge';
  if (c.kind === 'mappings' || c.kind === 'receipts') return 'link';
  if (c.kind !== 'journalEntries') return 'other';
  const b = asEntry(c.before), a = asEntry(c.after);
  if (c.after && a.corrects && (!c.before || b.corrects !== a.corrects)) return 'corrects';
  if (!c.before) return 'new';
  if (!c.after) return 'deleted';
  if ((b.vatCode ?? '') !== (a.vatCode ?? '')) return 'vat';
  if (b.accountDebit !== a.accountDebit || b.accountCredit !== a.accountCredit) return 'account';
  if (b.amount !== a.amount || b.date !== a.date) return 'amount';
  return 'other';
}

function labelOf(c: Pick<RecordChange, 'kind' | 'key' | 'before' | 'after'>): string {
  const r = (c.after ?? c.before ?? {}) as Record<string, unknown>;
  if (c.kind === 'journalEntries' || c.kind === 'transactions') return String(r.description ?? c.key);
  if (c.kind === 'receipts') return String(r.originalFilename ?? r.filename ?? c.key);
  if (c.kind === 'mappings') return `${r.transactionRef} ↔ ${r.receiptId}`;
  return c.key;
}

/** Her records now, the record files included. */
const hersOf = (ws: Workspace, books: Books): RecordMap => recordsOf(books, recordFiles(ws.paths.root));

function rowsOf(ws: Workspace, books: Books, changes: readonly ReturnChange[], state: State): ReviewRow[] {
  const mine = hersOf(ws, books);
  const lock = periodLock(books);
  const live = new Set(state.applied.filter((a) => !a.undone).flatMap((a) => a.rows));
  const rows = changes.map((c): ReviewRow => {
    const id = refKey(c);
    const hers = mine.get(id);
    const dates = [dateOf(c, c.before, books), dateOf(c, c.after, books), dateOf(c, hers, books)].filter((d): d is string => !!d);
    const sealed = dates.some((d) => lock.isClosed(d));
    const status: RowStatus = sameRecord(hers, c.after) ? 'same'
      : sealed ? (c.kind === 'journalEntries' ? 'sealed' : 'fixed')
        : sameRecord(hers, c.before) ? 'apply' : 'conflict';
    const date = dateOf(c, c.after, books) ?? dateOf(c, c.before, books);
    const original = dateOf(c, c.before, books) ?? date;
    return {
      id, kind: c.kind, key: c.key, group: groupOf(c), status, label: labelOf(c),
      ...(date ? { date } : {}),
      ...(c.before !== undefined ? { before: c.before } : {}),
      ...(c.after !== undefined ? { after: c.after } : {}),
      ...(hers !== undefined ? { mine: hers } : {}),
      ...(c.why ? { why: c.why } : {}),
      ...(status === 'sealed' && original ? { period: filingKeyOf(original, filing().length) } : {}),
      ...(state.decisions[id] ? { decision: state.decisions[id] } : {}),
      ...(state.questions[id] ? { question: state.questions[id].text } : {}),
      ...(live.has(id) ? { applied: true } : {}),
    };
  });
  // A payment whose booking became several lines (or got a private line) is one «Aufgeteilt» row group (B5.2).
  const byRef = new Map<string, ReviewRow[]>();
  for (const r of rows.filter((x) => x.kind === 'journalEntries')) {
    const ref = asEntry(r.after ?? r.before).transactionRef;
    if (ref) byRef.set(ref, [...(byRef.get(ref) ?? []), r]);
  }
  for (const group of byRef.values()) {
    if (group.length > 1 && group.some((r) => r.before === undefined) && group.some((r) => r.before !== undefined && r.after !== undefined) && !group.some((r) => asEntry(r.after).corrects)) {
      for (const r of group) r.group = 'split';
    }
  }
  return rows.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || (a.date ?? '').localeCompare(b.date ?? '') || a.id.localeCompare(b.id));
}

/** Whether a row would be taken over by «Übernehmen» with the decisions as they stand. */
const takes = (r: ReviewRow): 'theirs' | 'correction' | undefined => {
  if (r.applied || r.decision === 'skip' || r.question) return undefined;
  if (r.status === 'apply') return 'theirs';
  if (r.status === 'conflict' && r.decision === 'theirs') return 'theirs';
  if (r.status === 'sealed' && r.decision === 'correction') return 'correction';
  return undefined;
};

/** The day corrections are booked on: the first day of the books not locked. */
const firstOpenDay = (books: Books): string => {
  const lock = periodLock(books);
  return lock.lockedThrough ? addDays(lock.lockedThrough, 1) : new Date().toISOString().slice(0, 10);
};

/** A row of a period filed meanwhile, as entries in the open period with `corrects` (golden rule 1): hers reversed, his booked anew. */
function correctionOf(r: ReviewRow, books: Books, version: number): JournalEntry[] {
  const day = firstOpenDay(books);
  const period = r.period!;
  const ref = `K-${r.key}-${version}`;
  const out: JournalEntry[] = [];
  const hers = r.mine as JournalEntry | undefined;
  if (hers) {
    const back = reversalOf(hers, day, `Korrektur ${hers.id} (${period}): Storno «${hers.description ?? ''}»`);
    out.push({ id: `${hers.id}-k${version}s`, transactionRef: ref, ...back, corrects: period, origin: 'manual' });
  }
  const his = r.after as JournalEntry | undefined;
  if (his) {
    out.push({ ...his, id: `${his.id}-k${version}`, transactionRef: ref, date: day, corrects: period, description: `Korrektur ${hers?.id ?? his.id} (${period}): ${his.description ?? ''}`, origin: 'manual' });
  }
  return out;
}

/** The changes «Übernehmen» of `rows` makes to her books: his records, and the correction entries. */
function planOf(rows: readonly ReviewRow[], books: Books, version: number): { changes: Array<RecordChange & { row: string }>; corrections: JournalEntry[] } {
  const changes: Array<RecordChange & { row: string }> = [];
  const corrections: JournalEntry[] = [];
  for (const r of rows) {
    const how = takes(r);
    if (how === 'theirs') changes.push({ kind: r.kind, key: r.key, ...(r.mine !== undefined ? { before: r.mine } : {}), ...(r.after !== undefined ? { after: r.after } : {}), row: r.id });
    if (how === 'correction') corrections.push(...correctionOf(r, books, version));
  }
  return { changes, corrections };
}

/** Each filing period's payable before and after taking over every row as decided now (B5.2: the effect on top). */
function effectOf(rows: readonly ReviewRow[], books: Books): VatEffect[] {
  const { changes, corrections } = planOf(rows, books, 0);
  const after = structuredClone({ config: books.config, journalEntries: books.journalEntries }) as Pick<Books, 'config' | 'journalEntries'>;
  applyToBooks(after, changes.filter((c) => c.kind === 'journalEntries'));
  after.journalEntries.push(...corrections);
  const length = filing().length;
  const lock = periodLock(books);
  const keys = new Set<string>();
  for (const e of [...changes.flatMap((c) => [c.before, c.after]), ...corrections] as Array<Entry | undefined>) {
    if (!e?.date) continue;
    keys.add(e.corrects ?? filingKeyOf(e.date, length));
  }
  const adjustments = books.config.vatAdjustments ?? [];
  const code = vat();
  return [...keys].sort().flatMap((period) => {
    try {
      const before = code.figures(books.journalEntries, period as never, adjustments).payable;
      const now = code.figures(after.journalEntries, period as never, adjustments).payable;
      const end = [...books.journalEntries, ...after.journalEntries].filter((e) => filingKeyOf(e.date, length) === period).map((e) => e.date).sort().at(-1);
      return [{ period, filed: !!end && lock.isClosed(end), before, after: now }];
    } catch {
      return [];
    }
  });
}

export function reviewOf(ws: Workspace, id: string, books: Books = loadBooks(ws)): Review {
  const p = packageOf(ws, id);
  const state = readState(ws, id);
  const rows = rowsOf(ws, books, p.changes ?? [], state);
  const applied = state.applied;
  const learnRows = rows.filter((r) => r.applied && r.kind === 'journalEntries' && (r.group === 'account' || r.group === 'vat' || r.group === 'split'));
  const refs = [...new Set(learnRows.map((r) => asEntry(r.after).transactionRef).filter((x): x is string => !!x))];
  // One offer per partner (B6): his corrections of the same partner count together; a payment no offer fits teaches nothing.
  const partners = new Set<string>();
  const learn = refs.filter((ref) => {
    let key = ref;
    try {
      const offer = learnOffer(ws, books, ref);
      if (offer) key = offer.partner.kind === 'business' ? `b:${offer.partner.id}` : `p:${offer.partner.payer}`;
    } catch { /* no offer: the payment stands for itself */ }
    if (partners.has(key)) return false;
    partners.add(key);
    return true;
  }).slice(0, 5);
  return {
    id, from: p.index.from, at: p.index.at, basedOn: p.index.version.n, ...(p.index.message ? { message: p.index.message } : {}),
    rows, effect: effectOf(rows, books), applied, learn,
  };
}

/** A decision on a row, or a question back («Frage zurück», kept for the next hand-over); `null` clears it. */
export function decide(ws: Workspace, id: string, row: string, decision: Decision | null | undefined, question?: string | null, now = new Date()): void {
  const s = readState(ws, id);
  if (decision === null) delete s.decisions[row]; else if (decision) s.decisions[row] = decision;
  if (question === null) delete s.questions[row];
  else if (typeof question === 'string' && question.trim()) {
    const { changes } = packageOf(ws, id);
    const c = (changes ?? []).find((x) => refKey(x) === row);
    s.questions[row] = { key: row, text: question.trim().slice(0, 500), at: now.toISOString(), ...(c ? { label: labelOf(c) } : {}) };
  }
  writeState(ws, id, s);
}

/** The person-type actor of a take-over: the write door treats it as a person, its name is his (never written into the books). */
export const takeOverActor = (from: Party): Actor => ({ kind: 'person', name: from.name, ...(from.email ? { email: from.email } : {}), role: 'fiduciary' });

export interface ApplyResult { applied: number; corrections: number; left: number; version: Version }

/**
 * «Übernehmen» of the rows in `groups` («Alles übernehmen»: every group): one save through the write
 * door as his person-type actor, the receipt files and knowledge files his rows bring, a version
 * (return-applied), and what it changed kept for «Rückgängig». A conflict without her pick and a row
 * left out or asked about stay as they are.
 */
export function applyReturn(ws: Workspace, id: string, groups: readonly GroupId[] | 'all', now = new Date()): ApplyResult {
  const p = packageOf(ws, id);
  const state = readState(ws, id);
  const books = loadBooks(ws);
  const rows = rowsOf(ws, books, p.changes ?? [], state).filter((r) => groups === 'all' || groups.includes(r.group));
  const pending = rows.filter((r) => takes(r));
  if (!pending.length) throw new HandoverRefused('Nichts zu übernehmen: jede Zeile ist übernommen, ausgelassen, gefragt oder wartet auf deine Wahl.', []);
  const { changes, corrections } = planOf(pending, books, (currentVersion(ws.paths)?.n ?? 0) + 1);
  update(books, takeOverActor(p.index.from), (b) => {
    applyToBooks(b, changes.filter((c) => c.kind !== 'file'));
    b.journalEntries.push(...corrections);
  });
  saveBooks(ws, books);
  for (const c of changes.filter((x) => x.kind === 'file')) writeText(ws, c.key, c.after as string | undefined);
  // The receipt files his rows bring: put where the record says, picked up by the next load (placeFiles).
  const files: string[] = [];
  for (const c of changes.filter((x) => x.kind === 'receipts' && x.after)) {
    const name = (c.after as { filename?: string }).filename;
    for (const [path, data] of p.files) {
      if (!name || !path.endsWith(`/${name}`) || existsSync(join(ws.paths.root, path))) continue;
      mkdirSync(dirname(join(ws.paths.root, path)), { recursive: true });
      writeFileSync(join(ws.paths.root, path), data);
      files.push(path);
    }
  }
  const taken = new Set(pending.map((r) => r.id));
  const left = rowsOf(ws, books, p.changes ?? [], state).filter((r) => r.status !== 'same' && !r.applied && !taken.has(r.id)).length;
  const v = writeVersion(ws.paths, { reason: 'return-applied', from: p.index.from, basedOn: p.index.version.n, taken: changes.length + corrections.length, left, ret: id, at: now.toISOString() });
  state.applied.push({ at: now.toISOString(), version: v.n, changes: changes.map(({ row: _r, ...c }) => c), corrections: corrections.map((e) => e.id), files, rows: pending.map((r) => r.id) });
  writeState(ws, id, state);
  return { applied: changes.length, corrections: corrections.length, left, version: v };
}

function writeText(ws: Workspace, path: string, text: string | undefined): void {
  const full = join(ws.paths.root, path);
  if (text === undefined) { if (existsSync(full)) writeFileSync(full, ''); return; }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

export class HandoverRefused extends Error {
  constructor(message: string, readonly changed: string[]) { super(message); }
}

/**
 * «Rückgängig» of a return's take-over, whole (B5.3): every record back as it was, its corrections
 * removed, as a change by her (a person). Refused when a record changed since, and, by the write
 * door, in a period filed since.
 */
export function undoReturn(ws: Workspace, id: string, now = new Date()): { restored: number; version: Version } {
  const p = packageOf(ws, id);
  const state = readState(ws, id);
  const live = state.applied.filter((a) => !a.undone);
  if (!live.length) throw new HandoverRefused('Diese Rücksendung ist nicht übernommen.', []);
  const books = loadBooks(ws);
  const hers = hersOf(ws, books);
  const changes = live.flatMap((a) => a.changes);
  const corrections = new Set(live.flatMap((a) => a.corrections));
  const changed = changes.filter((c) => !sameRecord(hers.get(refKey(c)), c.after)).map((c) => refKey(c));
  const gone = [...corrections].filter((eid) => !books.journalEntries.some((e) => e.id === eid));
  if (changed.length || gone.length) throw new HandoverRefused(`Seit der Übernahme geändert: ${[...changed.map((k) => parseRefKey(k).key), ...gone].join(', ')}. Nichts zurückgenommen.`, [...changed, ...gone]);
  // Each record goes back to the state before the first take-over that touched it.
  const back = new Map<string, RecordChange>();
  for (const c of changes) if (!back.has(refKey(c))) back.set(refKey(c), c);
  update(books, PERSON, (b) => {
    applyToBooks(b, [...back.values()].filter((c) => c.kind !== 'file').map((c) => ({ kind: c.kind, key: c.key, ...(c.before !== undefined ? { after: c.before } : {}) })));
    b.journalEntries = b.journalEntries.filter((e) => !corrections.has(e.id));
  });
  saveBooks(ws, books);
  for (const c of [...back.values()].filter((x) => x.kind === 'file')) writeText(ws, c.key, c.before as string | undefined);
  const v = writeVersion(ws.paths, { reason: 'return-undone', from: p.index.from, basedOn: p.index.version.n, ret: id, at: now.toISOString() });
  for (const a of live) a.undone = { at: now.toISOString(), version: v.n };
  writeState(ws, id, state);
  return { restored: back.size + corrections.size, version: v };
}

// ─── «Frage zurück»: questions that go with the next hand-over ─────────────

const samePerson = (a: Party, b: Party) => (a.email && b.email ? a.email.toLowerCase() === b.email.toLowerCase() : a.name === b.name);

/** The questions to `to` not yet handed over. */
export function pendingQuestions(ws: Workspace, to: Party): Question[] {
  if (!existsSync(returnsDir(ws))) return [];
  return listReturns(ws).filter((r) => samePerson(r.from, to)).flatMap((r) => Object.values(readState(ws, r.id).questions).filter((q) => !q.taken).map(({ taken: _t, ...q }) => q));
}

/** Marks the questions to `to` as handed over (with the share that carries them), and returns them. */
export function takeQuestions(ws: Workspace, to: Party): Question[] {
  const out: Question[] = [];
  for (const r of listReturns(ws).filter((x) => samePerson(x.from, to))) {
    const s = readState(ws, r.id);
    let changed = false;
    for (const q of Object.values(s.questions)) if (!q.taken) { const { taken: _t, ...rest } = q; out.push(rest); q.taken = Date.now(); changed = true; }
    if (changed) writeState(ws, r.id, s);
  }
  return out;
}
