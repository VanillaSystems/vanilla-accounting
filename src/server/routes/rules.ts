/**
 * The company's rules over HTTP (src/saving/rules.ts, docs/0.4.0/saving.md "One click for a rule").
 *
 *   GET  /api/rules                   every rule of the workspace in its structure, with how often it applied
 *   POST /api/rules                   a RuleCommand: off, on, delete, restore (the undo)
 *   GET  /api/rules/draft?path=       the AI's draft of one rules file, rule by rule
 *   POST /api/rules/draft             { kind: keep, path, basis, confirm? } saves exactly that draft; { kind: discard, path }
 *   GET  /api/rules/share?ref=        the rule with a private share a split payment offers («Immer so?»), or null
 *   POST /api/rules/share             { ref }: that rule drafted into its file; the answer names the file for its card
 *
 * A rule the person keeps here takes effect at once: the click is their switching on
 * (docs/0.4.0/workflows.md "Changing a workflow"), so a workflow that ran as switched on before is
 * switched on again with the new rules. A workflow that waited already keeps waiting.
 */
import { Router } from 'express';
import { RequestError, WS } from '../books.js';
import { loadBooks } from '../../books/store.js';
import { chartOf } from '../../booking/classify.js';
import { chartNames, companyRules } from '../../booking/rule-book.js';
import { loadKnowledge } from '../../knowledge/layers.js';
import { baseCurrency } from '../../engines/index.js';
import { discardDraft, draftRules, keepDraft, ruleCommand, ruleFactsOf, type DraftCommand, type DraftView, type RuleCommand, type RulesView } from '../../saving/rules.js';
import { loadWorkflows } from '../../workflows/load.js';
import { draftShareRule, shareOffer } from '../../saving/share-rule.js';
import { keepSwitchedOn, openSwitch } from '../../workflows/switch-on.js';
import { APP_ROOT } from '../../workspace/workspace.js';
import { engine, queueCommit } from './automation.js';
import { askedBy, askRuns, closeAsksWithoutRule } from '../../workflows/held.js';
import { payerNames } from '../../knowledge/payer.js';

export const router = Router();

/** What a rule's plain words name: the chart's accounts, the businesses, the books' currency. */
function namesView(): Pick<RulesView, 'names' | 'currency'> {
  return {
    names: {
      accounts: Object.fromEntries(chartNames(chartOf(WS))),
      businesses: Object.fromEntries(loadKnowledge(APP_ROOT, WS.paths.root).counterparties.map((c) => [c.id, c.name])),
      payers: payerNames(loadBooks(WS).transactions),
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
function keepingSwitchedOn<T>(change: () => Promise<T>): Promise<T> {
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
  if (!c || typeof c.path !== 'string' || (c.kind !== 'keep' && c.kind !== 'discard')) throw new RequestError(400, 'Unbekannter Befehl.');
  if (c.kind === 'discard') { res.json({ ok: discardDraft(WS, c.path) }); return; }
  if (typeof c.basis !== 'string') throw new RequestError(400, 'basis erwartet.');
  res.json(await keepingSwitchedOn(() => keepDraft(WS, c.path, c.basis, c.confirm === true)));
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
