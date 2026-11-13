/**
 * The company's rules over HTTP (src/saving/rules.ts, docs/0.4.0/saving.md "One click for a rule").
 *
 *   GET  /api/rules                   every rule of the workspace in its structure, with how often it applied
 *   POST /api/rules                   a RuleCommand: off, on, delete, restore (the undo)
 *   GET  /api/rules/draft?path=       the AI's draft of one rules file, rule by rule
 *   POST /api/rules/draft             { kind: keep, path, basis, confirm? } saves exactly that draft; { kind: discard, path }
 *   GET  /api/rules/share?ref=        the rule with a private share a split payment offers («Immer so?»), or null
 *   POST /api/rules/share             { ref }: that rule drafted into its file; the answer names the file for its card
 *   GET  /api/rules/grouped?ref=      the batch payer a person's links of several receipts to a payment offer («Immer so?», #190), or null
 *   POST /api/rules/grouped           { ref }: `grouped: true` drafted into the business's company file; the answer names the file for its card
 *   GET  /api/rules/kept              the result line of each keep whose undo can still run (src/saving/keeps.ts)
 *   POST /api/rules/kept              { keep }: what that keep's booking runs made so far, their tasks closed
 *   POST /api/rules/kept/close        { keep }: its result line closed
 *   POST /api/rules/kept/undo         { keep, withLater? }: that keep taken back (and the later keeps of its file first), rule file and its bookings, as the server recorded it
 *   POST /api/rules/book-open         «Automatisch buchen» for all open payments: only what a rule or code decides, no model asked
 *   GET  /api/rules/wages            the rule for the open wages, drafted by code (#383), or null
 *   GET  /api/rules/unread?ref=     a payment whose receipt could not be read: its business and the rate its receipts showed most often (issue #57), or null
 *   POST /api/rules/unread            { ref, rate }: «Immer so?» — the company's rule for that business's unread receipts drafted into its file (waits in Änderungen)
 *   POST /api/rules/sale              { question }: «Immer so?» under an answer to a sale question: the payer rule drafted for its card, or the payer is mixed
 *   GET  /api/rules/correction?ref=   the rule change a person's correction of a rule booking teaches («Regel anpassen?»), or null
 *   POST /api/rules/correction        { ref }: that change drafted into the rule's file; the answer names the file for its card
 *   GET  /api/rules/learn?ref=        what a person's correction of a booking no rule made may teach («Ins Wissen übernehmen?»), or null
 *   POST /api/rules/learn             { ref }: the AI's rule (drafted into its file for the card) or note sentence, checked by code, or why none
 *   GET  /api/rules/hand?payment=     the form of a rule made by hand, started from that payment
 *   POST /api/rules/hand              a HandRule: drafted into its file for the same card; refused when the app cannot carry it out
 *   POST /api/rules/note              a NoteRuleCommand: the rule of a sentence of a partner's notes (or its adjustment) drafted into the partner's file for the card
 *
 * A rule the person keeps here takes effect at once: the click is their switching on
 * (docs/0.4.0/workflows.md "Changing a workflow"), so a workflow that ran as switched on before is
 * switched on again with the new rules. A workflow that waited already keeps waiting.
 */
import { Router } from 'express';
import { RequestError, WS, tagsField, updateBooks } from '../books.js';
import { loadBooks, periodLock } from '../../books/store.js';
import { chartOf } from '../../booking/classify.js';
import { chartNames, companyRules } from '../../booking/rule-book.js';
import { loadKnowledge } from '../../knowledge/layers.js';
import { baseCurrency } from '../../engines/index.js';
import { discardDraft, draftRules, hashOf, keepDraft, ruleCommand, ruleFactsOf, setDraftVat, type DraftCommand, type DraftView, type KeepResult, type BookOpen, type KeptBookings, type KeptEnded, type KeptView, type RuleCommand, type RulesView } from '../../saving/rules.js';
import { forgetKeep, KEEP_ID, laterOf, listKeeps, loadKeep, newKeepId, saveKeep, updateKeep, type KeepRecord } from '../../workflows/keeps.js';
import { type Books } from '../../books/store.js';
import { bookByRules } from '../../workflows/book-by-rules.js';
import type { JournalEntry } from '../../types/index.js';
import { reconciliationOf } from '../../books/reconcile.js';
import { classifyTransactions, loadClassifyContext } from '../../booking/classify.js';
import { answerSettles, mustSettle, receiptKnowledge, receiptWaitOf } from '../../booking/receipt-wait.js';
import { loadFxResolver } from '../../accounting/fx-rates.js';
import { recordDeletion } from '../../saving/changes.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookedState } from '../../accounting/payment-entries.js';
import { wageOffer } from '../../saving/wage-rule.js';
import { loadWorkflows } from '../../workflows/load.js';
import { clearTakenShares, dismissSetupShare, draftShareRule, shareOffer } from '../../saving/share-rule.js';
import { draftGroupedFlag, groupedOffer } from '../../saving/grouped-flag.js';
import { draftUnreadRule, unreadOffer } from '../../saving/unread-rule.js';
import { draftSaleRule } from '../../saving/sale-rule.js';
import { correctionOffer, draftCorrectionRule } from '../../saving/correction-rule.js';
import { learnOffer, proposeFromCorrection } from '../../saving/learn-rule.js';
import { draftHandRule, handStart, type HandRule } from '../../saving/hand-rule.js';
import { draftNoteRule, type NoteRuleCommand } from '../../saving/note-rule.js';
import type { RuleRefusal } from '../../booking/rules.js';
import { keepSwitchedOn, openSwitch } from '../../workflows/switch-on.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { engine, queueCommit } from './automation.js';
import { ASK_WORKFLOW, askedBy, askRuns, closeAsksWithoutRule } from '../../workflows/held.js';
import { payerNames } from '../../knowledge/payer.js';

export const router = Router();

/** What a rule's plain words name: the chart's accounts, the businesses, the payers, the reporting dimensions, the books' currency. */
function namesView(): Pick<RulesView, 'names' | 'currency'> {
  return {
    names: {
      accounts: Object.fromEntries(chartNames(chartOf(WS))),
      businesses: Object.fromEntries(loadKnowledge(APP_ROOT, WS.paths.root).counterparties.map((c) => [c.id, c.name])),
      payers: payerNames(loadBooks(WS).transactions),
      ...(WS.dimensions?.length ? { dimensions: [...WS.dimensions] } : {}),
    },
    currency: baseCurrency(),
  };
}

export function rulesView(): RulesView {
  const books = loadBooks(WS);
  const byRule = new Map<string, { refs: Set<string>; last: string }>();
  for (const e of books.journalEntries) {
    if (!e.rule) continue;
    const r = byRule.get(e.rule) ?? { refs: new Set<string>(), last: '' };
    r.refs.add(e.transactionRef);
    if (e.date > r.last) r.last = e.date;
    byRule.set(e.rule, r);
  }
  const asked = held(false);
  const rules = companyRules(WS, ruleFactsOf(WS)).map((r) => {
    const used = r.kind === 'rule' ? byRule.get(r.id) : undefined;
    return { ...r, applied: used?.refs.size ?? 0, ...(used?.last ? { last: used.last } : {}), asked: r.kind === 'rule' ? asked[r.id] ?? 0 : 0 };
  });
  const sw = openSwitch(WS);
  const waiting = loadWorkflows(APP_ROOT, WS.paths.root).workflows.flatMap((w) => { const p = sw.pending(w); return p ? [{ workflow: w.id, label: w.label, files: p.files }] : []; });
  return { rules, waiting, ...namesView() };
}

/** The payments each ask rule held, by rule id: all its questions, or (`waiting`) those still open. */
function held(waiting: boolean): Record<string, number> {
  const out: Record<string, Set<string>> = {};
  for (const r of askRuns(engine())) {
    const rule = askedBy(r);
    if (rule && (!waiting || r.state.status === 'waiting')) (out[rule] ??= new Set()).add(r.item.id);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.size]));
}

/** Runs `change` in the commit queue; the workflows that ran as switched on before it run switched on after it. */
export function keepingSwitchedOn<T>(change: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void queueCommit(async () => {
      try {
        const switchedOn = keepSwitchedOn(WS, () => loadWorkflows(APP_ROOT, WS.paths.root).workflows);
        const out = await change();
        switchedOn();
        // A rule removed or switched off asks nothing more: its open questions close (wishes3-7).
        await closeAsksWithoutRule(engine(), WS);
        resolve(out);
      } catch (e) {
        reject(e);
      }
      return false;
    });
  });
}

router.get('/api/rules', (_req, res) => { res.json(rulesView()); });

const COMMANDS = new Set(['off', 'on', 'delete', 'restore']);

router.post('/api/rules', async (req, res) => {
  const c = req.body as RuleCommand;
  if (!c || !COMMANDS.has(c.kind) || typeof c.file !== 'string') throw new RequestError(400, 'Unbekannter Befehl.');
  if (c.kind === 'restore' ? typeof c.before !== 'string' || typeof c.after !== 'string' : typeof c.id !== 'string' || typeof c.step !== 'string') throw new RequestError(400, 'Regel erwartet.');
  res.json(await keepingSwitchedOn(() => ruleCommand(WS, c)));
});

router.get('/api/rules/draft', (req, res) => {
  const path = String(req.query.path ?? '');
  const d = draftRules(WS, path);
  if (!d) throw new RequestError(404, `Kein Entwurf mit Regeln: ${path}`);
  res.json({ ...d, ...namesView(), held: held(true) } satisfies DraftView);
});

router.post('/api/rules/draft', async (req, res) => {
  const c = req.body as DraftCommand;
  if (!c || typeof c.path !== 'string' || (c.kind !== 'keep' && c.kind !== 'discard' && c.kind !== 'vat')) throw new RequestError(400, 'Unbekannter Befehl.');
  if (c.kind === 'discard') { res.json({ ok: discardDraft(WS, c.path) }); return; }
  if (c.kind === 'vat') {
    if (typeof c.basis !== 'string' || typeof c.step !== 'string' || typeof c.id !== 'string' || typeof c.rate !== 'number') throw new RequestError(400, 'basis, step, id und rate erwartet.');
    res.json(setDraftVat(WS, c.path, c.basis, c.step, c.id, c.rate));
    return;
  }
  if (typeof c.basis !== 'string') throw new RequestError(400, 'basis erwartet.');
  const kept = await keepingSwitchedOn(() => keepDraft(WS, c.path, c.basis, c.confirm === true));
  // A rule kept books the open payments it decides at once (#383): the card showed them, and its tasks close.
  // The server records the keep (#392, #396): its result line and its undo go by the keep's id alone.
  const reply = kept.ok ? await recordKeep(kept) : kept;
  // The setup's phone share has done its job once a kept rule books a private share on the phone's account (#402);
  // after the keep, and never at its cost: a failure here only leaves the share standing.
  if (kept.ok) {
    try { clearTakenShares(WS); } catch (e) { console.error(`clearTakenShares: ${e instanceof Error ? e.message : String(e)}`); }
  }
  res.json(reply);
});

/** «Nicht jetzt» (or «Nie», `never`) on the setup's share offer (#402): kept in onboarding.json, so it does not come back. */
router.post('/api/rules/share/dismiss', (req, res) => {
  const b = (req.body ?? {}) as { ref?: unknown; never?: unknown };
  if (typeof b.ref !== 'string' || (b.never !== undefined && typeof b.never !== 'boolean')) throw new RequestError(400, 'ref und optional never erwartet.');
  res.json({ ok: dismissSetupShare(WS, b.ref, b.never === true) });
});

/** How many payments one keep (or one «Automatisch buchen» for all) books; the rest are named with their number and follow on the next run. */
export const KEEP_RUNS_MAX = 200;
/**
 * How long a keep's undo is offered. After it, inbox runs may have booked by the rule what the keep
 * did not: an undo would take back the rule and only the keep's own bookings, which is no longer what
 * «Rückgängig» says. Firma › Regeln switches the rule off or deletes it any time.
 */
export const KEEP_UNDO_DAYS = 7;
/** The records kept at most, and for how long at most: the oldest go first. */
const KEEP_RECORDS_MAX = 50;
const KEEP_RECORD_DAYS = 30;
const DAY_MS = 86_400_000;
/** How long a keep counts as still booking: a keep whose process ended meanwhile does not hold its undo for ever. */
const BOOKING_MS = 5 * 60_000;
export const BOOKED_BY_RULE = 'Deine Regel hat diese Zahlung beim Behalten gebucht.';
export const WAITS_BY_RULE = 'Deine Regel bucht diese Zahlung, sobald ihr Beleg da ist.';

const PERSON_WORKFLOWS = new Set(['ask', 'booking']);

/** The tasks of these payments that wait for a person (a question of the ask workflow, a booking run at «von Hand buchen»), closed with `reason`. Returns the tasks closed. */
async function closeTasksOf(refs: ReadonlySet<string>, reason: string): Promise<Array<{ ref: string; workflow: string }>> {
  const e = engine();
  const closed: Array<{ ref: string; workflow: string }> = [];
  for (const r of e.runs()) {
    if (r.mode !== 'live' || r.state.status !== 'waiting' || r.item.kind !== 'transaction' || !refs.has(r.item.id) || !PERSON_WORKFLOWS.has(r.workflow)) continue;
    await e.command({ kind: 'discard', run: r.id, reason });
    closed.push({ ref: r.item.id, workflow: r.workflow });
  }
  return closed;
}

/** What the keep booked: the payments booked by its entries, the newest of them, and the payments it meant to book and did not. Reads only. */
function keptBookings(k: Pick<KeepRecord, 'book' | 'entries' | 'later'>, books: Books): KeptBookings {
  const mine = new Set(k.entries);
  const made = books.journalEntries.filter((x) => mine.has(x.id));
  const booked = new Set(made.map((x) => x.transactionRef).filter((ref) => bookedState(books, ref, WS.bankAccounts) === 'booked'));
  const first = [...made].sort((a, b) => b.date.localeCompare(a.date))[0];
  return {
    runs: [],
    refs: [...booked],
    entries: made.map((x) => x.id),
    running: 0,
    notBooked: k.book.filter((ref) => !booked.has(ref)),
    ...(k.later ? { later: k.later } : {}),
    ...(first ? { first: { id: first.id, date: first.date } } : {}),
  };
}

/**
 * Records the keep, then books at once the open payments its rules decide (#383), and closes their
 * tasks; the tasks of the payments that wait for their receipt close too (the rule books them when it
 * comes). The record holds every task it closed, so its undo starts exactly those again.
 */
async function recordKeep(kept: Extract<KeepResult, { ok: true }>): Promise<KeepResult> {
  if (!kept.undo) return kept;
  pruneKeeps();
  const decided = kept.open?.book ?? [];
  const book = decided.slice(0, KEEP_RUNS_MAX);
  const waits = kept.open?.waits ?? [];
  const books = loadBooks(WS);
  const rules = new Set(kept.rules ?? []);
  const marks = Object.fromEntries(books.transactions.flatMap((t) => (book.includes(t.ref) && t.waitsForPerson ? [[t.ref, t.waitsForPerson] as const] : [])));
  const id = newKeepId();
  saveKeep(WS, {
    id, at: new Date().toISOString(), file: kept.undo.file, before: kept.undo.before, after: kept.undo.after,
    rules: [...rules], book, entries: [], prior: books.journalEntries.filter((e) => !!e.rule && rules.has(e.rule)).map((e) => e.id),
    waits, later: decided.length - book.length, tasks: [], marks, booking: true,
  });
  const made = await bookByRules(WS, book);
  const booked = new Set(made.map((e) => e.transactionRef));
  const closed = [...await closeTasksOf(booked, BOOKED_BY_RULE), ...await closeTasksOf(new Set(waits), WAITS_BY_RULE)];
  updateKeep(WS, id, (x) => { x.entries.push(...made.map((e) => e.id)); x.tasks.push(...closed); delete x.booking; });
  const keep = keptView(loadKeep(WS, id)!, listKeeps(WS), loadBooks(WS), Date.now());
  return { ...kept, ...(book.length ? { booked: keep.booked } : {}), keep };
}

const fileHash = (file: string): string => { const p = join(WS.paths.root, file); return hashOf(existsSync(p) ? readFileSync(p, 'utf8') : ''); };

/** The file is as the keep left it, or as a later keep of the same file left it whose own undo brings it back there. */
function fileHolds(k: KeepRecord, all: readonly KeepRecord[]): boolean {
  if (fileHash(k.file) === k.after) return true;
  return laterOf(all, k).some((x) => hashOf(x.before) === k.after && fileHolds(x, all));
}

const untilOf = (k: KeepRecord): number => Date.parse(k.at) + KEEP_UNDO_DAYS * DAY_MS;

/** Why a keep's undo no longer means what it says, or undefined while it does. */
function endedOf(k: KeepRecord, all: readonly KeepRecord[], books: Books, now: number): KeptEnded | undefined {
  if (!fileHolds(k, all)) return 'file';
  if (now > untilOf(k)) return 'expired';
  const lock = periodLock(books);
  const mine = new Set(k.entries);
  if (books.journalEntries.some((e) => mine.has(e.id) && lock.isClosed(e.date))) return 'closed';
  const rules = new Set(k.rules);
  const prior = new Set(k.prior);
  if (books.journalEntries.some((e) => !!e.rule && rules.has(e.rule) && !mine.has(e.id) && !prior.has(e.id))) return 'bookedSince';
  return undefined;
}

/** One keep as its line shows it. */
function keptView(k: KeepRecord, all: readonly KeepRecord[], books: Books, now: number): KeptView {
  const later = laterOf(all, k);
  const ended = endedOf(k, all, books, now);
  const waits = k.waits.filter((ref) => bookedState(books, ref, WS.bankAccounts) !== 'booked').length;
  return {
    id: k.id, at: k.at, file: k.file, rules: k.rules, booked: keptBookings(k, books), waits,
    until: new Date(untilOf(k)).toISOString().slice(0, 10),
    ...(later.length ? { blocked: 'later' as const, blockedBy: later.map((x) => x.id) } : {}),
    ...(ended ? { ended } : {}),
  };
}

/** Forgets the records no line needs: closed and gone, older than KEEP_RECORD_DAYS, and the oldest past KEEP_RECORDS_MAX. */
function pruneKeeps(): void {
  const now = Date.now();
  const books = loadBooks(WS);
  let all = listKeeps(WS);
  for (const k of all) {
    const old = now - Date.parse(k.at) > KEEP_RECORD_DAYS * DAY_MS;
    if (old || (k.closed && endedOf(k, all, books, now))) forgetKeep(WS, k.id);
  }
  all = listKeeps(WS);
  for (const k of all.slice(0, Math.max(0, all.length - KEEP_RECORDS_MAX))) forgetKeep(WS, k.id);
}

const keepIdOf = (body: unknown): string => {
  const id = (body as { keep?: unknown } | undefined)?.keep;
  if (typeof id !== 'string' || !KEEP_ID.test(id)) throw new RequestError(400, 'keep erwartet: die Kennung eines Behaltens.');
  return id;
};

const KEEP_GONE = 'Dieses Behalten gibt es nicht mehr: es ist zurückgenommen oder abgelaufen.';

export const ENDED_TEXT: Record<KeptEnded, string> = {
  file: 'Die Datei dieser Regel hat sich seither anders geändert (von Hand oder durch die App): Rückgängig geht nicht mehr. Unter Firma › Regeln ausschalten oder löschen.',
  expired: `Rückgängig ging ${KEEP_UNDO_DAYS} Tage lang: seither kann die Regel weitere Zahlungen gebucht haben. Unter Firma › Regeln ausschalten oder löschen.`,
  closed: 'Eine Buchung der Regel liegt in einer abgeschlossenen oder freigegebenen Periode: Rückgängig geht nicht mehr.',
  bookedSince: 'Die Regel hat seither weitere Zahlungen gebucht: Rückgängig nähme nur einen Teil zurück. Unter Firma › Regeln ausschalten oder löschen.',
};

/**
 * GET /api/rules/kept: the line of every keep the person did not close, oldest first, and of each one
 * she closed that still holds an earlier keep's undo (that line names it). A keep whose undo is gone
 * says why (`ended`). Reads only: forgetting and closing tasks happen in the POSTs.
 */
router.get('/api/rules/kept', (_req, res) => {
  const all = listKeeps(WS);
  const books = loadBooks(WS);
  const now = Date.now();
  const holds = (k: KeepRecord) => all.some((x) => laterOf(all, x).some((y) => y.id === k.id) && !endedOf(x, all, books, now));
  res.json({ kept: all.filter((k) => !k.closed || holds(k)).map((k) => keptView(k, all, books, now)) });
});

/** POST /api/rules/kept { keep }: that keep's line as it is now. */
router.post('/api/rules/kept', (req, res) => {
  const k = loadKeep(WS, keepIdOf(req.body));
  if (!k) throw new RequestError(404, KEEP_GONE);
  res.json(keptView(k, listKeeps(WS), loadBooks(WS), Date.now()));
});

/** POST /api/rules/kept/close { keep }: its line closed; a record whose undo is gone is forgotten. */
router.post('/api/rules/kept/close', (req, res) => {
  updateKeep(WS, keepIdOf(req.body), (k) => { k.closed = true; });
  pruneKeeps();
  res.json({ ok: true });
});

/** Why a booking of a keep stays at its undo. */
export type KeptLeft = { changed: number; closed: number; gone: number; other: number };

type UndoOne = { ok: true; removed: number; left: KeptLeft } | { ok: false; refusal: string; message: string };

/**
 * One keep taken back, read from its record. The rules file goes back as it was (none, when the keep
 * wrote the first); then the entries the keep wrote go, as the person's change, each recorded for
 * Änderungen: only those still of the kept rules and not changed by a person. If the books cannot be
 * saved, the file is put back as the keep left it and the record stays. Each payment so left without
 * a booking is as before the keep (the deletion mark it had then), and the tasks the keep closed
 * start again, exactly those.
 */
async function undoOne(k: KeepRecord): Promise<UndoOne> {
  const all = listKeeps(WS);
  const ended = endedOf(k, all, loadBooks(WS), Date.now());
  if (ended) return { ok: false, refusal: ended, message: ENDED_TEXT[ended] };
  // While the keep still books (another window's undo during its answer), its entries are not all recorded yet.
  if (k.booking && Date.now() - Date.parse(k.at) < BOOKING_MS) return { ok: false, refusal: 'running', message: 'Die Regel bucht noch: gleich nochmals.' };
  if (laterOf(all, k).length) return { ok: false, refusal: 'later', message: 'Seither ist in derselben Datei eine weitere Regel behalten worden: zuerst jene zurücknehmen.' };
  const path = join(WS.paths.root, k.file);
  const now = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const back = await keepingSwitchedOn(() => ruleCommand(WS, { kind: 'restore', file: k.file, before: k.before, after: k.after }));
  if (!back.ok) return back;
  const mine = new Set(k.entries);
  const rules = new Set(k.rules);
  let out;
  try {
    out = updateBooks((books) => {
      const lock = periodLock(books);
      const left: KeptLeft = { changed: 0, closed: 0, other: 0, gone: k.entries.filter((id) => !books.journalEntries.some((e) => e.id === id)).length };
      const go = new Set<string>();
      for (const e of books.journalEntries) {
        if (!mine.has(e.id)) continue;
        if (lock.isClosed(e.date)) left.closed++;
        else if (e.origin === 'manual' || e.by?.kind === 'person' || e.by?.kind === 'assistant') left.changed++;
        // Code or another rule wrote it (a bank fee, a payout): not the kept rule's to take back.
        else if (!e.rule || !rules.has(e.rule)) left.other++;
        else go.add(e.id);
      }
      const gone = books.journalEntries.filter((e) => go.has(e.id));
      books.journalEntries = books.journalEntries.filter((e) => !go.has(e.id));
      const unbooked = [...new Set(gone.map((e) => e.transactionRef))].filter((ref) => !books.journalEntries.some((e) => e.transactionRef === ref));
      for (const t of books.transactions) {
        if (!unbooked.includes(t.ref)) continue;
        // The payment as before the keep: the wait for the person it had then (a booking she deleted), none otherwise.
        if (k.marks[t.ref]) t.waitsForPerson = k.marks[t.ref];
        else if (t.waitsForPerson?.why === 'bookingDeleted') delete t.waitsForPerson;
      }
      const others = (ref: string) => books.journalEntries.filter((e) => e.transactionRef === ref).map((e) => e.id);
      return { removed: go.size, left, gone: gone.map((e) => ({ entry: e, kept: others(e.transactionRef) })) };
    });
  } catch (e) {
    // The books stay as they were: so does the rule, and the record keeps its undo.
    await keepingSwitchedOn(() => ruleCommand(WS, { kind: 'restore', file: k.file, before: now, after: hashOf(k.before) }));
    throw e;
  }
  for (const g of out.gone) recordDeletion(WS, g.entry, g.kept);
  forgetKeep(WS, k.id);
  const books = loadBooks(WS);
  const lock = periodLock(books);
  const busy = new Set(engine().runs().filter((r) => r.mode === 'live' && r.state.status !== 'done' && r.state.status !== 'discarded').map((r) => r.item.id));
  for (const [ref, workflow] of new Map(k.tasks.map((x) => [x.ref, x.workflow]))) {
    const t = books.transactions.find((x) => x.ref === ref);
    if (!t || lock.isClosed(t.date) || busy.has(ref) || bookedState(books, ref, WS.bankAccounts) === 'booked') continue;
    await engine().command({ kind: 'start', workflow, item: { kind: 'transaction', id: ref } });
  }
  return { ok: true, removed: out.removed, left: out.left };
}

/**
 * POST /api/rules/kept/undo { keep, withLater? }: «Rückgängig» of one keep, all of it read from the
 * server's record. Refused while a later keep of the same file stands, unless `withLater`: then those
 * go first, newest first, and this one last; a refusal on the way stops there and says so.
 */
router.post('/api/rules/kept/undo', async (req, res) => {
  const id = keepIdOf(req.body);
  const withLater = (req.body as { withLater?: unknown }).withLater === true;
  const all = listKeeps(WS);
  const k = all.find((x) => x.id === id);
  if (!k) throw new RequestError(404, KEEP_GONE);
  const chain = withLater ? [...laterOf(all, k).reverse(), k] : [k];
  // All or nothing: every keep of the chain must still be undoable before the first is taken back.
  const books = loadBooks(WS);
  const now = Date.now();
  for (const x of chain) {
    const ended = endedOf(x, all, books, now);
    if (ended) { res.json({ ok: false, refusal: ended, message: ENDED_TEXT[ended], ...(x.id === k.id ? {} : { keep: x.id }) }); return; }
    if (x.booking && now - Date.parse(x.at) < BOOKING_MS) { res.json({ ok: false, refusal: 'running', message: 'Die Regel bucht noch: gleich nochmals.' }); return; }
  }
  const total = { removed: 0, left: { changed: 0, closed: 0, gone: 0, other: 0 } as KeptLeft };
  for (const x of chain) {
    const r = await undoOne(x);
    if (!r.ok) { res.json({ ...r, ...(total.removed ? { removed: total.removed } : {}) }); return; }
    total.removed += r.removed;
    for (const key of ['changed', 'closed', 'gone', 'other'] as const) total.left[key] += r.left[key];
  }
  pruneKeeps();
  res.json({ ok: true, ...total });
});

/**
 * POST /api/rules/book-open: «Automatisch buchen» for every open payment at once (Automatisierung's
 * list, r3-noai-22). Only what a rule of the firm or code decides is booked: no model is asked,
 * however many payments are open. Each payment left is counted with why: the AI or the person decides
 * it, it waits for its receipt, she deleted its booking on purpose (waitsForPerson), a rule's question
 * holds it, its receipt cannot be read, a reconciliation holds it, or a run holds it already.
 */
router.post('/api/rules/book-open', async (_req, res) => {
  const books = loadBooks(WS);
  const lock = periodLock(books);
  const context = loadClassifyContext(WS);
  const fx = loadFxResolver();
  const known = receiptKnowledge(loadKnowledge(APP_ROOT, WS.paths.root), WS);
  const open = new Map(engine().runs().filter((r) => r.mode === 'live' && r.item.kind === 'transaction' && r.state.status !== 'done' && r.state.status !== 'discarded').map((r) => [r.item.id, r]));
  const n: BookOpen = { booked: 0, running: 0, notBooked: 0, model: 0, receipt: 0, deleted: 0, question: 0, unread: 0, reconcile: 0, busy: 0, later: 0, max: KEEP_RUNS_MAX };
  const candidates = books.transactions.filter((t) => t.amount !== 0 && !lock.isClosed(t.date) && bookedState(books, t.ref, WS.bankAccounts) !== 'booked');
  // Code and the rules, without a model, over all of them at once: what they decide is what may be booked.
  const scratch = structuredClone(books);
  const before = scratch.journalEntries.length;
  await classifyTransactions(scratch, candidates, { fx, context });
  const decidedBy = new Map<string, JournalEntry[]>();
  for (const e of scratch.journalEntries.slice(before)) decidedBy.set(e.transactionRef, [...(decidedBy.get(e.transactionRef) ?? []), e]);
  const decided: string[] = [];
  for (const t of candidates) {
    if (t.waitsForPerson) { n.deleted++; continue; }
    const run = open.get(t.ref);
    const at = run?.state.status === 'waiting' ? run.state.at : undefined;
    if (run?.workflow === ASK_WORKFLOW && (at === 'ask' || at === 'open')) { n.question++; continue; }
    if (run && !(at && PERSON_WORKFLOWS.has(run.workflow))) { n.busy++; continue; }
    if (reconciliationOf(books, t.ref)) { n.reconcile++; continue; }
    const wait = receiptWaitOf(books, t, context, known, fx);
    if (wait.wait && wait.unread) { n.unread++; continue; }
    const entries = decidedBy.get(t.ref);
    if (!entries?.length) { n.model++; continue; }
    if (mustSettle(wait) && !answerSettles(t, entries, context)) { n.receipt++; continue; }
    decided.push(t.ref);
  }
  n.later = Math.max(0, decided.length - KEEP_RUNS_MAX);
  const now = decided.slice(0, KEEP_RUNS_MAX);
  const made = await bookByRules(WS, now);
  const booked = new Set(made.map((e) => e.transactionRef));
  await closeTasksOf(booked, BOOKED_BY_RULE);
  n.booked = booked.size;
  n.notBooked = now.length - booked.size;
  res.json(n);
});

router.get('/api/rules/wages', (_req, res) => {
  res.json({ offer: wageOffer(WS) ?? null });
});

router.get('/api/rules/unread', (req, res) => {
  res.json({ offer: unreadOffer(WS, loadBooks(WS), String(req.query.ref ?? '')) ?? null });
});

router.post('/api/rules/unread', (req, res) => {
  const { ref, rate } = (req.body ?? {}) as { ref?: unknown; rate?: unknown };
  if (typeof ref !== 'string' || typeof rate !== 'number') throw new RequestError(400, 'ref und rate erwartet.');
  const path = draftUnreadRule(WS, ref, rate);
  if (!path) throw new RequestError(404, 'Diese Zahlung führt zu keinem Geschäftspartner, für den eine Regel stehen kann.');
  res.json({ path });
});

router.get('/api/rules/share', (req, res) => {
  res.json({ offer: shareOffer(WS, loadBooks(WS), String(req.query.ref ?? '')) ?? null });
});

router.post('/api/rules/share', (req, res) => {
  const ref = (req.body as { ref?: unknown })?.ref;
  if (typeof ref !== 'string') throw new RequestError(400, 'ref erwartet.');
  const path = draftShareRule(WS, ref);
  if (!path) throw new RequestError(404, 'Diese Zahlung ist nicht in einen privaten und einen geschäftlichen Teil aufgeteilt.');
  res.json({ path });
});

router.get('/api/rules/grouped', (req, res) => {
  res.json({ offer: groupedOffer(WS, loadBooks(WS), String(req.query.ref ?? '')) ?? null });
});

router.post('/api/rules/grouped', (req, res) => {
  const ref = (req.body as { ref?: unknown })?.ref;
  if (typeof ref !== 'string') throw new RequestError(400, 'ref erwartet.');
  const path = draftGroupedFlag(WS, ref);
  if (!path) throw new RequestError(404, 'Diese Zahlung macht keinen Geschäftspartner zum Sammelzahler.', { code: 'noBatchPayer' });
  res.json({ path });
});

router.post('/api/rules/sale', (req, res) => {
  const question = (req.body as { question?: unknown })?.question;
  if (typeof question !== 'string') throw new RequestError(400, 'question erwartet.');
  const offer = draftSaleRule(WS, question);
  if (!offer) throw new RequestError(404, 'Diese Frage gibt es nicht.');
  res.json(offer);
});

router.get('/api/rules/correction', (req, res) => {
  res.json({ offer: correctionOffer(WS, loadBooks(WS), String(req.query.ref ?? '')) ?? null });
});

router.post('/api/rules/correction', (req, res) => {
  const ref = (req.body as { ref?: unknown })?.ref;
  if (typeof ref !== 'string') throw new RequestError(400, 'ref erwartet.');
  const path = draftCorrectionRule(WS, ref);
  if (!path) throw new RequestError(404, 'Diese Buchung lehrt keine Regel: keine Regel hat die Zahlung gebucht, oder die Buchung ist nicht von Hand korrigiert.');
  res.json({ path });
});

router.get('/api/rules/learn', (req, res) => {
  res.json({ offer: learnOffer(WS, loadBooks(WS), String(req.query.ref ?? '')) ?? null });
});

router.post('/api/rules/learn', async (req, res) => {
  const ref = (req.body as { ref?: unknown })?.ref;
  if (typeof ref !== 'string') throw new RequestError(400, 'ref erwartet.');
  const proposal = await proposeFromCorrection(WS, ref);
  if (!proposal) throw new RequestError(404, 'Diese Buchung lehrt nichts: sie ist nicht von Hand korrigiert, oder eine Regel hat sie gebucht.');
  res.json(proposal);
});

router.get('/api/rules/hand', (req, res) => {
  res.json({ start: handStart(WS, String(req.query.payment ?? ''), req.query.by === 'text' ? 'text' : undefined) ?? null });
});

const MATCHES = new Set(['business', 'payer', 'text']);

router.post('/api/rules/hand', (req, res) => {
  const h = req.body as HandRule;
  if (!h || !h.match || !MATCHES.has(h.match.kind) || typeof h.account !== 'string' || (h.vat !== undefined && h.vat !== null && typeof h.vat !== 'string')) throw new RequestError(400, 'Regel erwartet.');
  if (h.tags !== undefined) h.tags = tagsField(h.tags);
  if (h.private !== undefined && (!h.private || typeof h.private.share !== 'number' || (h.private.ownUse !== undefined && typeof h.private.ownUse !== 'boolean'))) throw new RequestError(400, 'private { share, ownUse } erwartet.');
  const out = draftHandRule(WS, h);
  if (out.ok) { res.json({ path: out.path }); return; }
  throw refused(out.refusal);
});

/** A rule the app cannot carry out, as the UI says it. */
function refused(r: RuleRefusal): RequestError {
  if (r.code === 'codeNotTaken') return new RequestError(400, `Den Steuercode ${r.params.vat} nimmt das Formular dieser Firma nicht.`, { code: 'codeNotTaken', params: { code: r.params.vat, method: r.params.method } });
  return new RequestError(400, `Diese Regel kann die App nicht ausführen (${r.code}).`, { code: 'rule', params: { refusal: r } });
}

router.post('/api/rules/note', (req, res) => {
  const c = req.body as NoteRuleCommand;
  const share = c?.then?.private;
  if (!c || typeof c.partner !== 'string' || typeof c.sentence !== 'string' || !c.then || typeof c.then.account !== 'string' || (c.then.vat !== null && typeof c.then.vat !== 'string')
    || (share !== undefined && typeof share !== 'number') || (c.then.ask !== undefined && typeof c.then.ask !== 'string') || (c.replaces !== undefined && typeof c.replaces !== 'string')) {
    throw new RequestError(400, 'partner, sentence und then { account, vat } erwartet.');
  }
  const out = draftNoteRule(WS, c);
  if (out.ok) { res.json({ path: out.path }); return; }
  const r = out.refusal;
  if (r.code === 'sentence') throw new RequestError(400, 'Kein Satz aus den Notizen.');
  if (r.code === 'replaces') throw new RequestError(404, `Regel ${r.params.id} gibt es in der Datei des Partners nicht.`);
  throw refused(r);
});
