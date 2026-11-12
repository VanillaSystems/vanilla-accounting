/**
 * «Was ist noch offen?» as a card (#342): where the oldest period not filed stands, drawn by code
 * from the books (src/app/areas/automation/open-period.ts), each line a link to where it is settled.
 * The AI sidebar shows it before the first message of a conversation, with or without an AI, and
 * under an answer that names it (the change `openPeriod`); the model only adds words.
 */
import { useMemo } from 'react';
import { t, language } from '../i18n/index.js';
import { formatDate } from '../lib/utils.js';
import { periodName } from '../lib/period-label.js';
import { hrefOf } from '../shell/history.js';
import type { Location } from '../shell/route.js';
import { useQuestions } from '../questions/store.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { useAutomation } from '../automation/store.js';
import { receiptDay } from '../automation/home.js';
import { orderPagesNow } from '../lib/order-pages.js';
import { at } from '../areas/receipts/view.js';
import { readsInWords } from '../areas/automation/words.js';
import { nothingOpen, openLines, openPeriodState, type OpenLine, type OpenPeriodState } from '../areas/automation/open-period.js';
import { chargesVat, filing } from '../../engines/index.js';
import { localToday } from '../../accounting/periods.js';
import { fillTask, textIn } from '../../workflows/model.js';
import type { Index } from '../../types/index.js';

const TASKS: Location = { route: { area: 'automation', view: 'tasks' }, query: {} };

/** Where a line leads: the first object of what it counts, in the period that holds it. */
function goOf(l: OpenLine): Location {
  switch (l.kind) {
    case 'unbooked': return at({ area: 'bank', payment: l.first.ref }, l.first.date);
    case 'questions': case 'moreTasks': return TASKS;
    case 'evidence': return at({ area: 'journal', id: l.first.id }, l.first.date);
    // The day the list filed the receipt under (its own, else the day it came in), as the review's list does.
    case 'unlinked': return at({ area: 'receipts', id: l.first.id }, receiptDay(l.first));
    case 'task': return { route: { area: 'automation', view: 'tasks', run: l.task.run }, query: {} };
  }
}

function textOf(l: OpenLine): string {
  switch (l.kind) {
    case 'unbooked': return t('openPeriod.unbooked', { n: l.n });
    case 'questions': return t('openPeriod.questions', { n: l.n });
    case 'evidence': return t('issues.evidenceTitle', { n: l.n });
    case 'unlinked': return t('openPeriod.unlinked', { n: l.n });
    case 'task': return fillTask(textIn(l.task.title, language()), l.task.item, readsInWords(l.task.reads));
    case 'moreTasks': return t('openPeriod.moreTasks', { n: l.n });
  }
}

/** The period's return in one fact: filed, running until a day, or due on one. A firm that files no return has no due day. */
function filingText(s: OpenPeriodState): string {
  const f = s.filing;
  if (f.kind === 'filed') return t('openPeriod.filed');
  if (f.kind === 'running') return t('openPeriod.running', { date: formatDate(f.ends) });
  // Over before the books begin (periods.ts beforeBooks, #345): neither due nor overdue here.
  if (f.kind === 'before') return t('automation.home.s.before');
  return f.due ? t(f.overdue ? 'openPeriod.overdue' : 'openPeriod.due', { date: formatDate(f.due) }) : t('openPeriod.over');
}

export function OpenPeriodCard({ books, onGo }: { books: Index; onGo(loc: Location): void }) {
  // The stores' own arrays, the same object until a store reads anew (an empty default made here would be a new one on every render).
  const questions = useQuestions().view?.questions;
  const tasks = useAutomation().view?.tasks;
  const accounts = useWorkspace()?.bankAccounts;
  const pages = orderPagesNow();
  const today = localToday();
  // The sidebar renders again with every word of a streaming answer: the state is computed once per change of what it reads.
  const { s, lines } = useMemo(() => {
    const s = openPeriodState(books, questions ?? [], tasks ?? [], accounts ?? [], { today, vatRegistered: chargesVat(), length: filing().length, dueDays: filing().dueDays }, pages);
    return { s, lines: openLines(s) };
  }, [books, questions, tasks, accounts, pages, today]);
  const link = (to: Location, text: string) => (
    <a className="linkbtn" href={hrefOf(to)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; e.preventDefault(); onGo(to); }}>{text}</a>
  );
  return (
    <section className="openp" data-testid="open-period" aria-label={t('openPeriod.title', { period: periodName(s.period) })}>
      <h3>{t('openPeriod.title', { period: periodName(s.period) })}</h3>
      <p className="m">{filingText(s)}</p>
      {nothingOpen(s) ? <p data-testid="open-period-none">{t('openPeriod.none', { period: periodName(s.period) })}</p> : (
        <ul>
          {lines.map((l, i) => (
            <li key={i} data-line={l.kind}>
              {link(goOf(l), textOf(l))}
              {l.kind === 'unbooked' && l.waiting ? <small data-held="receipt">{t('openPeriod.waiting', { n: l.waiting })}</small> : null}
              {l.kind === 'unbooked' && l.unread ? <small data-held="unread">{t('openPeriod.unread', { n: l.unread })}</small> : null}
              {l.kind === 'task' && l.task.overdue ? <small>{t('automation.overdue')}</small> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
