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
 *   POST /api/rules/kept/undo         { keep }: that keep taken back, rule file and its bookings, as the server recorded it
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
import { discardDraft, draftRules, hashOf, keepDraft, ruleCommand, ruleFactsOf, setDraftVat, type DraftCommand, type DraftView, type KeepResult, type KeptBookings, type KeptView, type RuleCommand, type RulesView } from '../../saving/rules.js';
import { forgetKeep, laterOf, listKeeps, loadKeep, newKeepId, saveKeep, type KeepRecord } from '../../saving/keeps.js';
import { recordDeletion } from '../../saving/changes.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookedState } from '../../accounting/payment-entries.js';
import { wageOffer } from '../../saving/wage-rule.js';
import { loadWorkflows } from '../../workflows/load.js';
import { draftShareRule, shareOffer } from '../../saving/share-rule.js';
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
import { askedBy, askRuns, closeAsksWithoutRule } from '../../workflows/held.js';
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
  res.json(kept.ok ? await recordKeep(kept) : kept);
});

const RESTING = new Set(['done', 'waiting', 'stuck', 'parked', 'discarded']);
/** How long the keep's answer waits for its booking runs; runs still going are named as running, and the card asks again. */
const BOOK_WAIT_MS = 30_000;
/** How long the server goes on closing the tasks of a keep's runs still going after its answer. */
const SETTLE_MS = 10 * 60_000;
/** How many booking runs one keep starts; the rest are named with their number and follow on the next run. */
export const KEEP_RUNS_MAX = 200;
export const BOOKED_BY_RULE = 'Deine Regel hat diese Zahlung beim Behalten gebucht.';
export const WAITS_BY_RULE = 'Deine Regel bucht diese Zahlung, sobald ihr Beleg da ist.';

const restsNow = (id: string) => RESTING.has(engine().run(id)?.state.status ?? 'done');
const PERSON_WORKFLOWS = new Set(['ask', 'booking']);

/** The tasks of these payments that wait for a person (a question of the ask workflow, a booking run at «von Hand buchen»), closed with `reason`; `except` the keep's own runs. */
async function closeTasksOf(refs: ReadonlySet<string>, reason: string, except: ReadonlySet<string> = new Set()): Promise<void> {
  const e = engine();
  for (const r of e.runs()) {
    if (r.mode !== 'live' || r.state.status !== 'waiting' || r.item.kind !== 'transaction' || !refs.has(r.item.id) || except.has(r.id)) continue;
    if (PERSON_WORKFLOWS.has(r.workflow)) await e.command({ kind: 'discard', run: r.id, reason });
  }
}

/** The entries a run wrote, by its effects. */
const entriesOfRun = (id: string): string[] => (engine().run(id)?.steps ?? []).flatMap((s) => s.effects.filter((x) => x.applied).flatMap((x) => x.wrote.entries ?? []));

/**
 * What the keep's runs made so far (#383): the payments their runs booked, the runs still going, the
 * payments a run left unbooked (another booking came first, the run waits for a person). The tasks
 * of the payments now booked close here, each time: a question of the ask workflow, and a booking run
 * of another start waiting at «von Hand buchen» for the same payment.
 */
async function keptState(runs: readonly string[], later = 0): Promise<KeptBookings> {
  const e = engine();
  const books = loadBooks(WS);
  const mine = new Set(runs);
  const refOf = new Map(runs.flatMap((id) => { const r = e.run(id); return r ? [[id, r.item.id] as const] : []; }));
  const made = books.journalEntries.filter((x) => mine.has(x.run ?? '') && !!x.rule);
  const booked = new Set(made.map((x) => x.transactionRef).filter((ref) => bookedState(books, ref, WS.bankAccounts) === 'booked'));
  const running = runs.filter((id) => !restsNow(id));
  await closeTasksOf(booked, BOOKED_BY_RULE, mine);
  const first = [...made].sort((a, b) => b.date.localeCompare(a.date))[0];
  return {
    runs: [...runs],
    refs: [...booked],
    entries: made.map((x) => x.id),
    running: running.length,
    notBooked: runs.filter((id) => restsNow(id) && !booked.has(refOf.get(id) ?? '')).map((id) => refOf.get(id) ?? id),
    ...(later ? { later } : {}),
    ...(first ? { first: { id: first.id, date: first.date } } : {}),
  };
}

/**
 * The keep recorded, then the booking run for each payment the kept rules decide (as «Braucht keinen
 * Beleg» starts it, #340), at most KEEP_RUNS_MAX (the rest named, for the next run), awaited a while.
 * Runs still going after it finish on their own and close their tasks then (keptState), for at most
 * SETTLE_MS and only while this workspace is open. The tasks of the payments that wait for their
 * receipt close: the rule books them when the receipt comes, nothing is left for the person to book.
 */
async function recordKeep(kept: Extract<KeepResult, { ok: true }>): Promise<KeepResult> {
  if (!kept.undo) return kept;
  const book = kept.open?.book ?? [];
  const waits = kept.open?.waits ?? [];
  const marks = Object.fromEntries(loadBooks(WS).transactions.flatMap((t) => (book.includes(t.ref) && t.waitsForPerson ? [[t.ref, t.waitsForPerson] as const] : [])));
  const k: KeepRecord = {
    id: newKeepId(), at: new Date().toISOString(), file: kept.undo.file, before: kept.undo.before, after: kept.undo.after,
    rules: kept.rules ?? [], runs: [], waits, later: Math.max(0, book.length - KEEP_RUNS_MAX), marks,
  };
  saveKeep(WS, k);
  if (waits.length) await closeTasksOf(new Set(waits), WAITS_BY_RULE);
  if (book.length) {
    const e = engine();
    for (const id of book.slice(0, KEEP_RUNS_MAX)) {
      const r = await e.command({ kind: 'start', workflow: 'booking', item: { kind: 'transaction', id } });
      if (r.ok && r.run) k.runs.push(r.run);
    }
    saveKeep(WS, k);
    const until = Date.now() + BOOK_WAIT_MS;
    while (Date.now() < until && !k.runs.every(restsNow)) await new Promise((r) => setTimeout(r, 100));
    if (!k.runs.every(restsNow)) {
      const root = WS.paths.root;
      const end = Date.now() + SETTLE_MS;
      const here = () => WS.paths.root === root;
      void (async () => {
        while (here() && Date.now() < end && !k.runs.every(restsNow)) await new Promise((r) => setTimeout(r, 500));
        if (here()) await keptState(k.runs);
      })().catch(() => undefined);
    }
  }
  const keep = await keptView(k, listKeeps(WS));
  return { ...kept, ...(book.length ? { booked: keep.booked } : {}), keep };
}

/** One keep as its result line shows it: what its runs booked, the payments still waiting for their receipt, and whether a later keep of the file holds its undo. */
async function keptView(k: KeepRecord, all: readonly KeepRecord[]): Promise<KeptView> {
  const books = loadBooks(WS);
  const waits = k.waits.filter((ref) => bookedState(books, ref, WS.bankAccounts) !== 'booked').length;
  return { id: k.id, at: k.at, file: k.file, rules: k.rules, booked: await keptState(k.runs, k.later), waits, ...(laterOf(all, k).length ? { blocked: 'later' as const } : {}) };
}

const fileHash = (file: string): string => { const p = join(WS.paths.root, file); return hashOf(existsSync(p) ? readFileSync(p, 'utf8') : ''); };

/** A keep's undo can still run: the file is as it left it, or as a later keep of the same file left it whose own undo brings it back there. */
function undoable(k: KeepRecord, all: readonly KeepRecord[]): boolean {
  if (fileHash(k.file) === k.after) return true;
  return laterOf(all, k).some((x) => hashOf(x.before) === k.after && undoable(x, all));
}

const keepIdOf = (body: unknown): string => {
  const id = (body as { keep?: unknown } | undefined)?.keep;
  if (typeof id !== 'string') throw new RequestError(400, 'keep erwartet.');
  return id;
};

const KEEP_GONE = 'Dieses Behalten lässt sich nicht mehr zurücknehmen: die Regeln haben sich seither geändert, oder es ist schon zurückgenommen.';

/** The keep by its id, while its undo can still run; a record whose undo cannot is forgotten. */
function liveKeep(id: string): { k: KeepRecord; all: KeepRecord[] } {
  const all = listKeeps(WS);
  const k = all.find((x) => x.id === id);
  if (!k || !undoable(k, all)) { if (k) forgetKeep(WS, k.id); throw new RequestError(404, KEEP_GONE); }
  return { k, all };
}

/**
 * GET /api/rules/kept: the result line of every keep whose undo can still run and whose line the
 * person did not close, oldest first. A keep that started no booking and leaves nothing waiting has
 * its line only where it was kept.
 */
router.get('/api/rules/kept', async (_req, res) => {
  const all = listKeeps(WS);
  const out: KeptView[] = [];
  for (const k of all) {
    if (!undoable(k, all)) { forgetKeep(WS, k.id); continue; }
    if (k.closed || (!k.runs.length && !k.waits.length && !k.later)) continue;
    out.push(await keptView(k, all));
  }
  res.json({ kept: out });
});

/** POST /api/rules/kept { keep }: what that keep's runs made so far, for its result line while some still run. */
router.post('/api/rules/kept', async (req, res) => {
  const { k, all } = liveKeep(keepIdOf(req.body));
  res.json(await keptView(k, all));
});

/** POST /api/rules/kept/close { keep }: its result line closed; nothing else changes. */
router.post('/api/rules/kept/close', (req, res) => {
  const k = loadKeep(WS, keepIdOf(req.body));
  if (k) saveKeep(WS, { ...k, closed: true });
  res.json({ ok: true });
});

/** Why a booking of a keep stays at its undo. */
export type KeptLeft = { changed: number; closed: number; gone: number };

/**
 * POST /api/rules/kept/undo { keep }: «Rückgängig» of one keep in one step, all of it read from the
 * server's record. Refused while a later keep of the same file stands (that one first) and while its
 * runs still book. The rules file goes back as it was (none, when the keep wrote the first), then the
 * bookings the keep's runs made go, as the person's change, each recorded for Änderungen: only those
 * still the run's and the rule's. A booking changed by a person since, one of a period closed since,
 * or one gone already stays and is counted with its reason. Each payment so left without a booking
 * is as before the keep: the mark of a deletion it had then, none otherwise, and its question comes
 * again (workflows/ask: «von Hand buchen» without an AI, the next run with one), as for the payments
 * the keep left waiting for their receipt.
 */
router.post('/api/rules/kept/undo', async (req, res) => {
  const { k, all } = liveKeep(keepIdOf(req.body));
  if (laterOf(all, k).length) { res.json({ ok: false, refusal: 'later', message: 'Seither ist in derselben Datei eine weitere Regel behalten worden: zuerst jene zurücknehmen.' }); return; }
  if (!k.runs.every(restsNow)) { res.json({ ok: false, refusal: 'running', message: 'Die Regel bucht noch: gleich nochmals.' }); return; }
  const back = await keepingSwitchedOn(() => ruleCommand(WS, { kind: 'restore', file: k.file, before: k.before, after: k.after }));
  if (!back.ok) { res.json(back); return; }
  const runs = new Set(k.runs);
  const known = k.runs.flatMap(entriesOfRun);
  const out = updateBooks((books) => {
    const lock = periodLock(books);
    const left: KeptLeft = { changed: 0, closed: 0, gone: known.filter((id) => !books.journalEntries.some((e) => e.id === id)).length };
    const go = new Set<string>();
    for (const e of books.journalEntries) {
      if (!runs.has(e.run ?? '')) continue;
      if (lock.isClosed(e.date)) left.closed++;
      else if (e.origin === 'manual' || !e.rule || e.by?.kind === 'person' || e.by?.kind === 'assistant') left.changed++;
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
    return { removed: go.size, left, unbooked, gone: gone.map((e) => ({ entry: e, kept: others(e.transactionRef) })) };
  });
  for (const g of out.gone) recordDeletion(WS, g.entry, g.kept);
  forgetKeep(WS, k.id);
  const books = loadBooks(WS);
  const lock = periodLock(books);
  const busy = new Set(engine().runs().filter((r) => r.mode === 'live' && r.state.status !== 'done' && r.state.status !== 'discarded').map((r) => r.item.id));
  const again = [...new Set([...out.unbooked, ...k.waits])].filter((ref) => {
    const t = books.transactions.find((x) => x.ref === ref);
    return !!t && !lock.isClosed(t.date) && !busy.has(ref) && bookedState(books, ref, WS.bankAccounts) !== 'booked';
  });
  for (const id of again) await engine().command({ kind: 'start', workflow: 'ask', item: { kind: 'transaction', id } });
  res.json({ ok: true, removed: out.removed, left: out.left });
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
