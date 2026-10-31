/**
 * What the inbox's run is doing with a receipt, a dropped file or the open payments, in words
 * (#218): the step it is on («Wird gelesen …», «Sucht die Zahlung …»), how many files go before it
 * while it waits, or that the run stopped. Belege, the drop dialog and Bank say it the same way.
 */
import { language, t } from '../i18n/index.js';
import { textIn, type AutomationView } from '../../workflows/model.js';
import { INTAKE_STEPS, INTAKE_WORKFLOW, type Processing } from '../../workflows/processing.js';

const known = (step: string): step is typeof INTAKE_STEPS[number] => (INTAKE_STEPS as readonly string[]).includes(step);

/** A step of the inbox run by its label, for a step the app does not know by id (a company's own). */
function stepLabel(step: string, view: Pick<AutomationView, 'workflows'> | undefined): string {
  const s = view?.workflows.find((w) => w.id === INTAKE_WORKFLOW)?.steps.find((x) => x.id === step);
  return s ? textIn(s.label, language()) : step;
}

/** The run's state in one line: the step it works on, what it waits for, or that it stopped. */
export function processingText(p: Processing, view?: Pick<AutomationView, 'workflows'>): string {
  switch (p.kind) {
    case 'running': return known(p.step) ? t(`processing.step.${p.step}`) : t('processing.stepOther', { step: stepLabel(p.step, view) });
    case 'queued':
      if (p.ahead > 0) return t('processing.ahead', { n: p.ahead });
      return p.reason ? t(`automation.queuedBecause.${p.reason}`) : t('processing.queued');
    case 'stuck': return p.step ? t('processing.stuckAt', { step: stepLabel(p.step, view) }) : t('processing.stuck');
  }
}
