/**
 * «Was ist noch offen?» as a card (#342): where the oldest period not filed stands, drawn by code
 * from the books (src/app/areas/automation/open-period.ts), each line a link to where it is settled.
 * Its counts and words are the return's page's (countIssues, issueWords), and a line about the return
 * leads to its list «Noch offen» (`/vat/open`). It says that nothing is open only when nothing waits
 * under Aufgaben either; else it names what waits elsewhere (UnbookedFact, the tasks).
 * The AI sidebar shows it before the first message of a conversation, with or without an AI, and
 * under an answer that names it (the change `openPeriod`); the model only adds words.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { t } from '../i18n/index.js';
import { formatDate } from '../lib/utils.js';
import { OPENING, TASKS, clearingAt, itemsOf, openList, receiptAt, type Items as ItemList, type Say } from './open-period-items.js';
import { periodName } from '../lib/period-label.js';
import { hrefOf } from '../shell/history.js';
import type { Location } from '../shell/route.js';
import { useQuestions } from '../questions/store.js';
import { useWorkspace } from '../hooks/use-workspace.js';
import { useAutomation } from '../automation/store.js';
import { orderPagesNow, outlayWaitsNow, providerIssuesNow, refusedWhy } from '../lib/order-pages.js';
import { at } from '../areas/receipts/view.js';
import { taskLine } from '../areas/automation/words.js';
import { elsewhereCount, elsewhereOf, nothingOpen, openLines, openPeriodState, type OpenLine, type OpenPeriodState, type PendingOffer } from '../areas/automation/open-period.js';

const NO_OFFERS: PendingOffer[] = [];
import { issueWords, UnbookedFact } from '../areas/automation/Issues.js';
import { chargesVat, filing } from '../../engines/index.js';
import { openCount } from '../../workflows/model.js';
import { processingOf } from '../../workflows/processing.js';
import { localToday } from '../../accounting/periods.js';
import type { Index } from '../../types/index.js';


/** Where a line leads: the first object of what it counts, in the period that holds it; the period's questions to the return's list of them. */
function goOf(l: OpenLine, s: OpenPeriodState, books: Index): Location {
  switch (l.kind) {
    case 'yours': return receiptAt(l.items[0].receipt, s, books);
    case 'unbooked': return at({ area: 'bank', payment: l.first.ref }, l.first.date);
    case 'questions': return openList(s) ?? TASKS;
    case 'moreTasks': return TASKS;
    case 'evidence': return at({ area: 'journal', id: l.first.id }, l.first.date);
    case 'withheld': return at({ area: 'bank', payment: l.first.tx.ref }, l.first.tx.date);
    // The day Belege lists the receipt under (#385 review), in the period the card is about.
    case 'unlinked': return receiptAt(l.first, s, books);
    case 'issued': return receiptAt(l.first, s, books);
    // The report's receipt names the held order and books it (#405); a missing bill to the return's list, which names it and drops it (#459).
    case 'held': { const r = books.receipts.find((x) => x.id === l.first.receipt); return r ? at({ area: 'receipts', id: r.id }, r.date) : openList(s) ?? TASKS; }
    case 'bills': return openList(s) ?? TASKS;
    case 'offers': return at({ area: 'bank', payment: l.first.ref }, l.first.date);
    case 'openings': return OPENING;
    case 'clearing': return clearingAt(l.first.account, s);
    case 'task': return { route: { area: 'automation', view: 'tasks', run: l.task.run }, query: {} };
  }
}

/** A count line in the words the return's page uses for it (issueWords). */
const NONE = { unbooked: 0, waitingReceipt: 0, waitingOutlays: 0 };
function textOf(l: OpenLine): string {
  switch (l.kind) {
    case 'yours': return issueWords({ ...NONE, own: l.n })[0];
    case 'unbooked': return issueWords({ unbooked: l.n, waitingReceipt: l.waiting, waitingOutlays: l.outlays })[0];
    case 'questions': return issueWords({ ...NONE, questions: l.n })[0];
    case 'evidence': return issueWords({ ...NONE, evidence: l.n })[0];
    case 'withheld': return issueWords({ ...NONE, withheld: l.n })[0];
    case 'unlinked': return issueWords({ ...NONE, unlinked: l.n })[0];
    case 'issued': return t('openPeriod.issuedLine', { n: l.n });
    case 'held': return issueWords({ ...NONE, held: l.n })[0];
    case 'bills': return issueWords({ ...NONE, bills: l.n })[0];
    case 'offers': return t('openPeriod.offers', { n: l.n });
    case 'openings': return t('openPeriod.openings', { n: l.n });
    case 'clearing': return t('openPeriod.clearing', { n: l.n });
    case 'task': return taskLine(l.task);
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
  const view = useAutomation().view;
  const tasks = view?.tasks;
  const ws = useWorkspace();
  const accounts = ws?.bankAccounts;
  // As Aufgaben reads it: the threshold task is there only for a firm the manifest says is not registered.
  const registered = ws?.company.vat.registered;
  const pages = orderPagesNow();
  const provider = providerIssuesNow();
  const today = localToday();
  // The setup's shares offered as rules and not answered yet (#428): the server reads them off the setup and the knowledge, once per books.
  const [offers, setOffers] = useState<PendingOffer[]>(NO_OFFERS);
  useEffect(() => {
    let live = true;
    api.setupOffers().then((r) => { if (live) setOffers(r.offers.length ? r.offers : NO_OFFERS); }, () => undefined);
    return () => { live = false; };
  }, [books]);
  const c = ws?.company;
  // The sidebar renders again with every word of a streaming answer: the state is computed once per change of what it reads.
  const { s, lines, other, unbookedElsewhere } = useMemo(() => {
    const s = openPeriodState(books, questions ?? [], tasks ?? [], accounts ?? [], { today, vatRegistered: chargesVat(), length: filing().length, dueDays: filing().dueDays, outlays: outlayWaitsNow(), ...(c ? { firm: { uid: c.uid, name: c.name, owner: c.owner } } : {}) }, pages, processingOf(view?.runs ?? [], books.receipts), provider, offers);
    const e = elsewhereOf(books, questions ?? [], tasks ?? [], accounts ?? [], s, filing().length, view ? openCount(view) - view.tasks.length : 0, registered, today);
    // UnbookedFact says the payments; the rest is counted as the tasks it is under Aufgaben.
    return { s, lines: openLines(s), other: elsewhereCount(e) - e.unbooked.length, unbookedElsewhere: e.unbooked.length };
  }, [books, questions, tasks, view, accounts, registered, pages, provider, today, c, offers]);
  const link = (to: Location, text: string) => (
    <a className="linkbtn" href={hrefOf(to)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; e.preventDefault(); onGo(to); }}>{text}</a>
  );
  return (
    <section className="openp" data-testid="open-period" aria-label={t('openPeriod.title', { period: periodName(s.period) })}>
      <h3>{t('openPeriod.title', { period: periodName(s.period) })}</h3>
      <p className="m">{openList(s) && s.filing.kind === 'due' ? link(openList(s)!, filingText(s)) : filingText(s)}</p>
      {nothingOpen(s) ? (
        <>
          <ElsewhereLines s={s} books={books} other={other} unbooked={unbookedElsewhere} onGo={onGo} link={link} />
          {/* The firm's own invoices that wait for their customer: a fact beside «nothing open», never work (#476, #436). */}
          {lines.filter((l) => l.kind === 'issued').map((l, i) => <p key={i} className="m" data-line="issued">{link(goOf(l, s, books), textOf(l))}<Items of={itemsOf(l, s, books, t as unknown as Say, refusedWhy)} link={link} /></p>)}
        </>
      ) : (
        <ul>
          {lines.map((l, i) => (
            <li key={i} data-line={l.kind}>
              {link(goOf(l, s, books), textOf(l))}
              {l.kind === 'unbooked' && l.unread ? <small data-held="unread">{t('openPeriod.unread', { n: l.unread })}</small> : null}
              {l.kind === 'task' && l.task.overdue ? <small>{t('automation.overdue')}</small> : null}
              <Items of={itemsOf(l, s, books, t as unknown as Say, refusedWhy)} link={link} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The objects of a line one by one, each a link; what is beyond them counted, with the way to all. */
function Items({ of, link }: { of: ItemList; link(to: Location, text: string): JSX.Element }) {
  if (!of.items.length) return null;
  return (
    <ul className="openp-items">
      {of.items.map((x) => <li key={x.key} data-item={x.key}>{link(x.go, x.text)}</li>)}
      {of.more && of.all ? <li data-more>{link(of.all, t('openPeriod.more', { n: of.more }))}</li> : null}
    </ul>
  );
}

/**
 * Nothing of the period is open: said so only when nothing waits under Aufgaben either. Payments of
 * later open days without a booking are #341's fact (UnbookedFact, unbookedOpen), the rest is counted
 * as the tasks it is, with the way to them.
 */
function ElsewhereLines({ s, books, other, unbooked, onGo, link }: { s: OpenPeriodState; books: Index; other: number; unbooked: number; onGo(loc: Location): void; link(to: Location, text: string): JSX.Element }) {
  if (!other && !unbooked) return <p data-testid="open-period-none">{t('openPeriod.none', { period: periodName(s.period) })}</p>;
  return (
    <>
      <p data-testid="open-period-none">{t('openPeriod.noneHere', { period: periodName(s.period) })}</p>
      <p data-testid="open-period-elsewhere">
        {unbooked ? <UnbookedFact books={books} nav={{ go: onGo }} /> : null}
        {other ? <>{unbooked ? ' ' : ''}{link(TASKS, t('automation.home.hero.waiting', { n: other }))}</> : null}
      </p>
    </>
  );
}
