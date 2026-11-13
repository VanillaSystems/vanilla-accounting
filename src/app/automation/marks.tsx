/**
 * What other areas show of the automation (docs/0.4.0/views.md, "What a view does"): the buttons
 * the workflows declare for an object, and the link from a record to the run that wrote it. An
 * area never names a workflow: a workflow with a manual trigger for its kind of object brings its
 * button, and removing the workflow removes the button.
 */
import { language, t } from '../i18n/index.js';
import { aiIsOff } from '../ai/ai-off.js';
import { commandRefusalText, refusalText } from './refusal.js';
import { buttonsFor, hasAi, runResult, stepOf, textIn, type ItemFact, type ItemKind, type RunDetail, type WorkflowDecl } from '../../workflows/model.js';
import { BotIcon } from '../areas/automation/Graph.js';
import type { Nav } from '../areas/index.js';
import type { Location } from '../shell/route.js';
import { api, errorText } from '../lib/api.js';
import { automationCommand, automationNow, useAutomation } from './store.js';
import { useState } from 'react';

const OPEN = new Set(['queued', 'running', 'waiting', 'parked', 'stuck']);
const RESTING = new Set(['done', 'waiting', 'stuck', 'parked', 'discarded']);

/** The run once it rests (done, waiting for a person, stuck), or as it is after about 20 s. */
async function rested(id: string): Promise<RunDetail> {
  for (let i = 0; ; i++) {
    const r = await api.automationRun(id);
    if (RESTING.has(r.status) || i >= 40) return r;
    await new Promise((res) => setTimeout(res, 500));
  }
}

/** What a run started by a button did, in one line (r4c-34): booked, waiting for whom and why, or stuck. */
function runResultText(w: WorkflowDecl, r: RunDetail): string {
  const workflow = textIn(w.label, language());
  const res = runResult(w, r);
  switch (res.kind) {
    case 'done': return [t('marks.done', { workflow, n: res.entries }), ...(res.held ?? []).map((h) => `${t('reconcile.heldRun', { n: h.n, account: h.account })}.`)].join(' ');
    case 'waiting': {
      const step = typeof res.step === 'string' ? res.step : textIn(res.step, language());
      // A workflow that books nothing (the VAT filing) does not say «nichts gebucht» (r7h-34).
      return t(res.noModel ? (aiIsOff() ? 'marks.waitsAiOff' : 'marks.waitsNoModel') : w.id === 'vat-filing' ? 'marks.waitsReview' : 'marks.waits', { workflow, step });
    }
    case 'stuck': return t('marks.stuck', { workflow, error: refusalText(res.error, res.why) });
    case 'running': return t('marks.started', { workflow });
  }
}

/**
 * A workflow's run for one object, started by a click that is not the workflow's own button (a payment
 * marked as needing no receipt goes on to be booked, #340), awaited until it rests: what came of it,
 * in the button's words. Undefined when the workflow is not there.
 */
export async function startAndSay(workflowId: string, item: { kind: ItemKind; id: string }): Promise<string | undefined> {
  const workflow = automationNow()?.workflows.find((w) => w.id === workflowId);
  if (!workflow) return undefined;
  const r = await automationCommand({ kind: 'start', workflow: workflow.id, item });
  if (!r.ok) return t('marks.refused', { workflow: textIn(workflow.label, language()), why: commandRefusalText(r) });
  return r.run ? runResultText(workflow, await rested(r.run)) : undefined;
}

/** How many runs one click on a list's chip starts; the rest are named, for the next click. */
export const START_ALL_MAX = 50;

/**
 * A manual trigger for each open object of its kind at once: «Automatisch buchen» in Automatisierung's
 * list (r3-noai-22) starts the booking of every unbooked payment that no run holds yet, at most
 * START_ALL_MAX, waits until they rest and says in one line what came of them: booked (by a rule or
 * the AI), waiting for the receipt, and, without an AI, that no rule decided the rest and the app
 * cannot book them by itself: they are booked by hand under Aufgaben.
 */
export async function startForEach(workflowId: string, kind: ItemKind, ids: readonly string[]): Promise<string | undefined> {
  const workflow = automationNow()?.workflows.find((w) => w.id === workflowId);
  if (!workflow) return undefined;
  const name = textIn(workflow.label, language());
  if (!ids.length) return t('marks.allNone', { workflow: name });
  const runs: string[] = [];
  for (const id of ids.slice(0, START_ALL_MAX)) {
    const r = await automationCommand({ kind: 'start', workflow: workflow.id, item: { kind, id } });
    if (!r.ok) return r.refusal === 'not-approved' ? t('marks.waitsSwitchOn', { workflow: name }) : t('marks.refused', { workflow: name, why: commandRefusalText(r) });
    if (r.run) runs.push(r.run);
  }
  const n = { booked: 0, receipt: 0, noModel: 0, person: 0, other: 0 };
  for (const run of await Promise.all(runs.map(rested))) {
    const res = runResult(workflow, run);
    if (res.kind === 'done' && res.entries) n.booked++;
    else if (res.kind === 'done' && run.steps.some((s) => s.output?.why === 'waitsForReceipt')) n.receipt++;
    else if (res.kind === 'waiting' && res.noModel) n.noModel++;
    else if (res.kind === 'waiting') n.person++;
    else n.other++;
  }
  const later = Math.max(0, ids.length - START_ALL_MAX);
  return [
    t('marks.allBooked', { workflow: name, n: n.booked, all: runs.length }),
    n.receipt ? t('marks.allReceipt', { n: n.receipt }) : '',
    n.noModel ? t(aiIsOff() ? 'marks.allNoModelOff' : 'marks.allNoModel', { n: n.noModel }) : '',
    n.person ? t('marks.allPerson', { n: n.person }) : '',
    n.other ? t('marks.allOther', { n: n.other }) : '',
    later ? t('marks.allLater', { n: later, max: START_ALL_MAX }) : '',
  ].filter(Boolean).join(' ');
}

export function WorkflowButtons({ kind, id, facts = [], nav, canEdit }: { kind: ItemKind; id: string; facts?: ItemFact[]; nav: Nav; canEdit: boolean }) {
  const { view } = useAutomation();
  // What the last click came to, beside the button as well as in the toast: a toast is gone in
  // seconds and easily missed (r4c-34, r5h-20: «Automatisch buchen» without Claude seemed to do nothing).
  const [said, setSaid] = useState<{ item: string; text: string; go?: Location }>();
  if (!view) return null;
  const buttons = buttonsFor(view.workflows, kind, facts).filter((b) => b.runnable);
  if (!buttons.length) return null;
  const say = (text: string, go?: Location) => { setSaid({ item: id, text, ...(go ? { go } : {}) }); nav.toast(text); };
  // The button says what came of it, not only that something started: a run without the AI may only wait for a person.
  async function start(workflow: WorkflowDecl) {
    const name = textIn(workflow.label, language());
    say(t('marks.started', { workflow: name }));
    try {
      const r = await automationCommand({ kind: 'start', workflow: workflow.id, item: { kind, id } });
      if (!r.ok) {
        // A refusal in words, never a code or a version hash (r6h-24): what waits, and where to act.
        if (r.refusal === 'not-approved') say(t('marks.waitsSwitchOn', { workflow: name }), { route: { area: 'automation', view: 'workflow', workflow: workflow.id, tab: 'graph' }, query: {} });
        else say(t('marks.refused', { workflow: name, why: commandRefusalText(r) }));
        return;
      }
      if (!r.run) return;
      say(runResultText(workflow, await rested(r.run)));
      nav.refresh();
    } catch (e) { say(errorText(e)); }
  }
  return (
    <span className="wfbuttons">
      {said?.item === id && (
        <span className="wfsaid" role="status" data-testid="workflow-said">
          {said.text}
          {said.go ? <> <button type="button" className="linkbtn" onClick={() => nav.go(said.go!)}>{t('marks.goSwitchOn')}</button></> : null}
        </span>
      )}
      {buttons.map(({ workflow, label, ai }) => {
        const open = view.runs.find((r) => r.workflow === workflow.id && r.item.id === id && OPEN.has(r.status));
        if (open) {
          return (
            <button key={workflow.id} type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: open.id }, query: {} })}>
              {t('marks.runOpen', { workflow: textIn(workflow.label, language()), status: t(`automation.status.${open.status}` as 'automation.status.done') })}
            </button>
          );
        }
        return (
          <button key={workflow.id} type="button" className="btn" disabled={!canEdit} data-tip={ai ? t('automation.ai') : undefined}
            onClick={() => void start(workflow)}>
            {ai ? <BotIcon /> : null}{textIn(label, language())}
          </button>
        );
      })}
    </span>
  );
}

/**
 * "von KI gebucht · Lauf …": the run a record came from, and why it is like this. `by`: who decided the
 * record; a rule's or the code's booking in a run with an AI step is not the AI's (r9n-32).
 */
export function RunLink({ run, by, nav }: { run: string; by?: { kind: string }; nav: Nav }) {
  const { view } = useAutomation();
  const summary = view?.runs.find((r) => r.id === run);
  const w = summary && view!.workflows.find((x) => x.id === summary.workflow);
  const byAi = (by ? by.kind === 'model' : true) && !!w && summary!.path.some((s) => stepOf(w, s)?.kind === 'agent') && hasAi(w, view!.workflows);
  return (
    <button type="button" className="linkbtn runlink" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run }, query: {} })}>
      {byAi ? <BotIcon /> : null}{byAi ? t('marks.byAi', { run }) : t('marks.byRun', { run })}
    </button>
  );
}
