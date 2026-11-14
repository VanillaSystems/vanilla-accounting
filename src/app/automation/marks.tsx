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
import { BOOKING_WORKFLOW, BookingWaits, bookingWaitsOf } from './booking-waits.js';
import { bookingWaitsText } from '../lib/booking-waits.js';
import type { BookOpen } from '../../saving/rules.js';
import { useHandover } from '../handover/store.js';

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

/** The files a run's book step waited for «Einschalten» with (src/intake/pipeline.ts IntakeNote `bookingWaits`, #413), when it booked nothing so. */
export function bookingWaitsNote(r: Pick<RunDetail, 'steps'>): string[] | undefined {
  for (const s of r.steps) {
    const notes = (s.output?.notes ?? []) as Array<{ code?: string; files?: string[]; waiting?: number }>;
    // Only when it left payments: a run with nothing to book says it is done, not why it waits.
    const n = Array.isArray(notes) ? notes.find((x) => x.code === 'bookingWaits' && (x.waiting ?? 0) > 0) : undefined;
    if (n) return n.files ?? [];
  }
  return undefined;
}
/** Why a run that booked nothing left its payment, by the step's `why` (#428): «0 Buchungen gebucht» never stands without it. */
const LEFT: Record<string, 'marks.left.waitsForReceipt' | 'marks.left.waitsForOutlays' | 'marks.left.receiptUnread' | 'marks.left.vatNotRead'> = {
  waitsForReceipt: 'marks.left.waitsForReceipt', waitsForOutlays: 'marks.left.waitsForOutlays', receiptUnread: 'marks.left.receiptUnread', vatNotRead: 'marks.left.vatNotRead',
};

/** What a run started by a button did, in one line (r4c-34): booked, waiting for whom and why, or stuck. */
function runResultText(w: WorkflowDecl, r: RunDetail): string {
  const workflow = textIn(w.label, language());
  const res = runResult(w, r);
  switch (res.kind) {
    case 'done': return [t('marks.done', { workflow, n: res.entries }), ...(res.left && LEFT[res.left] ? [t(LEFT[res.left])] : []), ...(res.held ?? []).map((h) => `${t('reconcile.heldRun', { n: h.n, account: h.account })}.`)].join(' ');
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

/**
 * «Automatisch buchen» for every open payment at once (Automatisierung's list, r3-noai-22): the server
 * books only what a rule of the firm or code decides, asks no model, and counts every payment it left
 * with why (POST /api/rules/book-open). The line says each group in its own words.
 */
export async function bookOpenAndSay(workflowName: string): Promise<{ text: string; waits?: string[] }> {
  const n = await api.bookOpen();
  // «Buchen» waits for «Einschalten» (#413): nothing booked, the one sentence says why.
  if (n.waits) return { text: bookingWaitsText(n.waits), waits: n.waits };
  return { text: bookOpenLine(n, workflowName) };
}

function bookOpenLine(n: Omit<BookOpen, 'waits'>, workflowName: string): string {
  const { max, ...counts } = n;
  if (!Object.values(counts).some(Boolean)) return t('marks.all.none', { workflow: workflowName });
  const parts = [
    t('marks.all.booked', { n: n.booked }),
    n.model ? t('marks.all.model', { n: n.model }) : '',
    n.receipt ? t('marks.all.receipt', { n: n.receipt }) : '',
    n.outlays ? t('marks.all.outlays', { n: n.outlays }) : '',
    n.question ? t('marks.all.question', { n: n.question }) : '',
    n.unread ? t('marks.all.unread', { n: n.unread }) : '',
    n.deleted ? t('marks.all.deleted', { n: n.deleted }) : '',
    n.reconcile ? t('marks.all.reconcile', { n: n.reconcile }) : '',
    n.busy ? t('marks.all.busy', { n: n.busy }) : '',
    n.notBooked ? t('marks.all.notBooked', { n: n.notBooked }) : '',
    n.later ? t('marks.all.later', { n: n.later, max }) : '',
  ].filter(Boolean);
  return `${workflowName}: ${parts.join(' · ')}.`;
}

/**
 * The buttons a workflow declares for one object. `confirm`: a sentence the first click shows with
 * «Trotzdem buchen» instead of starting (a payment whose booking she deleted on purpose).
 */
export function WorkflowButtons({ kind, id, facts = [], nav, canEdit, confirm }: { kind: ItemKind; id: string; facts?: ItemFact[]; nav: Nav; canEdit: boolean; confirm?: string }) {
  const { view } = useAutomation();
  const copy = useHandover()?.durchsicht;
  // What the last click came to, beside the button as well as in the toast: a toast is gone in
  // seconds and easily missed (r4c-34, r5h-20: «Automatisch buchen» without Claude seemed to do nothing).
  const [said, setSaid] = useState<{ item: string; text: string; go?: Location; waits?: boolean }>();
  const [asking, setAsking] = useState<{ item: string; workflow: WorkflowDecl }>();
  if (!view) return null;
  const buttons = buttonsFor(view.workflows, kind, facts).filter((b) => b.runnable);
  if (!buttons.length) return null;
  const say = (text: string, go?: Location) => { setSaid({ item: id, text, ...(go ? { go } : {}) }); nav.toast(text); };
  // «Buchen» waits for «Einschalten» (#413): the one sentence, with «Einschalten» beside the button.
  const sayWaits = (files: readonly string[]) => { setSaid({ item: id, text: bookingWaitsText(files), waits: true }); nav.toast(bookingWaitsText(files)); };
  // The button says what came of it, not only that something started: a run without the AI may only wait for a person.
  async function start(workflow: WorkflowDecl) {
    const name = textIn(workflow.label, language());
    say(t('marks.started', { workflow: name }));
    try {
      const r = await automationCommand({ kind: 'start', workflow: workflow.id, item: { kind, id } });
      if (!r.ok) {
        // A refusal in words, never a code or a version hash (r6h-24): what waits, and where to act.
        if (r.refusal === 'not-approved' && workflow.id === BOOKING_WORKFLOW) sayWaits(bookingWaitsOf(automationNow()) ?? []);
        else if (r.refusal === 'not-approved') say(t('marks.waitsSwitchOn', { workflow: name }), { route: { area: 'automation', view: 'workflow', workflow: workflow.id, tab: 'graph' }, query: {} });
        else say(t('marks.refused', { workflow: name, why: commandRefusalText(r) }));
        return;
      }
      if (!r.run) return;
      const run = await rested(r.run);
      // An inbox run whose book step waited for «Einschalten» says so, not «fertig».
      const waited = bookingWaitsNote(run);
      if (waited) sayWaits(waited);
      else say(runResultText(workflow, run));
      nav.refresh();
    } catch (e) { say(errorText(e)); }
  }
  return (
    <span className="wfbuttons">
      {said?.item === id && said.waits ? <BookingWaits files={bookingWaitsOf(view) ?? []} go={(route) => nav.go({ route, query: {} })} onOn={() => nav.refresh()} /> : said?.item === id && (
        <span className="wfsaid" role="status" data-testid="workflow-said">
          {said.text}
          {said.go ? <> <button type="button" className="linkbtn" onClick={() => nav.go(said.go!)}>{t('marks.goSwitchOn')}</button></> : null}
        </span>
      )}
      {confirm && asking?.item === id ? (
        <span className="wfsaid" role="status" data-testid="workflow-confirm">
          {confirm}{' '}
          <button type="button" className="linkbtn" data-act="book-anyway" onClick={() => { const w = asking.workflow; setAsking(undefined); void start(w); }}>{t('marks.bookAnyway')}</button>
        </span>
      ) : null}
      {buttons.map(({ workflow, label, ai }) => {
        const open = view.runs.find((r) => r.workflow === workflow.id && r.item.id === id && OPEN.has(r.status));
        if (open) {
          return (
            <button key={workflow.id} type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: open.id }, query: {} })}>
              {t('marks.runOpen', { workflow: textIn(workflow.label, language()), status: t(`automation.status.${open.status}` as 'automation.status.done') })}
            </button>
          );
        }
        // On a Durchsicht copy filing is the sharer's (docs/specs/e2e-and-fiduciary.md B4): said, not offered.
        if (copy && (workflow.id === 'vat-filing' || workflow.id === 'year-close')) return <span key={workflow.id} className="m" data-testid="files-sharer">{t('durchsicht.files', { name: copy.sharer.name })}</span>;
        return (
          <button key={workflow.id} type="button" className="btn" disabled={!canEdit} data-tip={ai ? t('automation.ai') : undefined}
            onClick={() => { if (confirm) setAsking({ item: id, workflow }); else void start(workflow); }}>
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
