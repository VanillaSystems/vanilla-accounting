/**
 * What other areas show of the automation (docs/0.4.0/views.md, "What a view does"): the buttons
 * the workflows declare for an object, and the link from a record to the run that wrote it. An
 * area never names a workflow: a workflow with a manual trigger for its kind of object brings its
 * button, and removing the workflow removes the button.
 */
import { language, t } from '../i18n/index.js';
import { buttonsFor, hasAi, stepOf, textIn, type ItemFact, type ItemKind } from '../../workflows/model.js';
import { BotIcon } from '../areas/automation/Graph.js';
import type { Nav } from '../areas/index.js';
import { automationCommand, useAutomation } from './store.js';

const OPEN = new Set(['queued', 'running', 'waiting', 'parked', 'stuck']);

export function WorkflowButtons({ kind, id, facts = [], nav, canEdit }: { kind: ItemKind; id: string; facts?: ItemFact[]; nav: Nav; canEdit: boolean }) {
  const { view } = useAutomation();
  if (!view) return null;
  const buttons = buttonsFor(view.workflows, kind, facts).filter((b) => b.runnable);
  if (!buttons.length) return null;
  return (
    <span className="wfbuttons">
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
            onClick={() => void automationCommand({ kind: 'start', workflow: workflow.id, item: { kind, id } }).then((r) => nav.toast(r.ok ? t('marks.started', { workflow: textIn(workflow.label, language()) }) : r.detail ?? r.refusal))}>
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
