/**
 * What other areas show of the automation (docs/0.4.0/views.md, "What a view does"): the buttons
 * the workflows declare for an object, and the link from a record to the run that wrote it. An
 * area never names a workflow: a workflow with a manual trigger for its kind of object brings its
 * button, and removing the workflow removes the button.
 */
import { language, t } from '../i18n/index.js';
import { commandRefusalText, refusalText } from './refusal.js';
import { buttonsFor, hasAi, runResult, stepOf, textIn, type ItemFact, type ItemKind, type RunDetail, type WorkflowDecl } from '../../workflows/model.js';
import { BotIcon } from '../areas/automation/Graph.js';
import type { Nav } from '../areas/index.js';
import type { Location } from '../shell/route.js';
import { api, errorText } from '../lib/api.js';
import { automationCommand, useAutomation } from './store.js';
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
    case 'done': return t('marks.done', { workflow, n: res.entries });
    case 'waiting': {
      const step = typeof res.step === 'string' ? res.step : textIn(res.step, language());
      return t(res.noModel ? 'marks.waitsNoModel' : 'marks.waits', { workflow, step });
    }
    case 'stuck': return t('marks.stuck', { workflow, error: refusalText(res.error, res.why) });
    case 'running': return t('marks.started', { workflow });
  }
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
          <button key={workflow.id} type="button" className="btn" disabled={!canEdit} title={ai ? t('automation.ai') : undefined}
            onClick={() => void start(workflow)}>
            {ai ? <BotIcon /> : null}{textIn(label, language())}
          </button>
        );
      })}
    </span>
  );
}

/** "von KI gebucht · Lauf …": the run a record came from, and why it is like this. */
export function RunLink({ run, nav }: { run: string; nav: Nav }) {
  const { view } = useAutomation();
  const summary = view?.runs.find((r) => r.id === run);
  const w = summary && view!.workflows.find((x) => x.id === summary.workflow);
  const byAi = !!w && summary!.path.some((s) => stepOf(w, s)?.kind === 'agent') && hasAi(w, view!.workflows);
  return (
    <button type="button" className="linkbtn runlink" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run }, query: {} })}>
      {byAi ? <BotIcon /> : null}{byAi ? t('marks.byAi', { run }) : t('marks.byRun', { run })}
    </button>
  );
}
