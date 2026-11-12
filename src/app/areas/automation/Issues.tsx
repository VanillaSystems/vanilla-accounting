/**
 * The open issues of a period on Aufgaben (src/app/areas/automation/period-issues.ts): before the
 * return is filed, under «Abrechnung prüfen» (r4c-38), and the bookings that contradict their
 * receipts with their one click (r4c-31). Each issue links to where it is settled; none blocks.
 */
import { orderPagesNow } from '../../lib/order-pages.js';
import { FindPair } from '../receipts/FindPair.js';
import { t } from '../../i18n/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { useQuestions } from '../../questions/store.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { at, ledgerFor } from '../receipts/view.js';
import { openTwins } from '../receipts/model.js';
import { answerTwin } from '../receipts/actions.js';
import { EvidenceFix, evidenceText } from '../journal/Detail.js';
import { journalOf, unsettledAtFiling } from '../journal/model.js';
import { thresholdPassed } from '../vat/model.js';
import { baseCurrency, documents, filing, withoutInputTax } from '../../../engines/index.js';
import { missingAssessments, type MissingAssessment } from '../../../booking/customs-invoice.js';
import { filingKeyOf, localToday, openFilingPeriod, parsePeriod, type Period } from '../../../accounting/periods.js';
import type { WaitingPayment } from '../../../accounting/receipt-due.js';
import { payText, signed } from '../bank/model.js';
import { bookWithoutInputTax } from '../bank/actions.js';
import { UnreadRuleOffer, UnreadTask } from './UnreadReceipt.js';
import type { UnreadOffer } from '../../../saving/unread-rule.js';
import { useState } from 'react';
import { periodName } from '../../lib/period-label.js';
import { countIssues, periodIssues, unbookedOpen, type IssueCounts, type PeriodIssue } from './period-issues.js';
import { OPEN_ITEMS } from '../vat/model.js';
import { chargesVat } from '../../../engines/index.js';
import type { Location } from '../../shell/route.js';
import type { Nav } from '../index.js';
import type { Index, JournalEntry } from '../../../types/index.js';

function goOf(books: Index, i: PeriodIssue): Location | undefined {
  switch (i.kind) {
    case 'question': {
      const { kind, id } = i.q.on;
      return kind === 'payment' ? at({ area: 'bank', payment: id }, i.date) : kind === 'receipt' ? at({ area: 'receipts', id }, i.date) : at({ area: 'journal', id }, i.date);
    }
    case 'evidence': return at({ area: 'journal', id: i.entry.id }, i.entry.date);
    case 'unbooked': return at({ area: 'bank', payment: i.tx.ref }, i.tx.date);
    case 'unlinked': return books.receipts.some((r) => r.id === i.receipt.id) ? at({ area: 'receipts', id: i.receipt.id }, i.receipt.date) : undefined;
  }
}

function textOf(books: Index, i: PeriodIssue): string {
  switch (i.kind) {
    case 'question': {
      const tx = i.q.topic === 'saleVat' ? books.transactions.find((x) => x.ref === i.q.on.id) : undefined;
      return t('issues.question', { date: formatDate(i.date), text: tx ? `${tx.counterparty || tx.description} ${tx.currency} ${fmt(tx.amount)}` : i.q.text });
    }
    case 'evidence': return `${formatDate(i.entry.date)} ${i.entry.description ?? ''}: ${evidenceText(i.entry, i.check)}`;
    case 'unbooked': return t('issues.unbooked', { date: formatDate(i.tx.date), text: i.tx.counterparty || i.tx.description, amount: `${i.tx.currency} ${fmt(i.tx.amount)}` });
    case 'unlinked': return t('issues.unlinked', { date: formatDate(i.receipt.date ?? ''), text: i.receipt.description || i.receipt.filename });
  }
}

let lastIssues: { key: unknown[]; issues: PeriodIssue[] } | undefined;

/**
 * The open issues of the days `from`–`to` with what the page has loaded (questions, bank accounts,
 * order pages): the one source of the task's list and of the return page's line. Computed once per
 * books, questions and period: the return's list and its detail ask for the same and share it.
 */
export function usePeriodIssues(books: Index, from: string, to: string): PeriodIssue[] {
  const { questions } = useQuestions();
  const accounts = useWorkspace()?.bankAccounts;
  const key = [books, questions, accounts, orderPagesNow(), from, to, localToday()];
  if (!lastIssues || key.some((k, i) => k !== lastIssues!.key[i])) lastIssues = { key, issues: periodIssues(books, questions, from, to, accounts ?? [], orderPagesNow()) };
  return lastIssues.issues;
}

/** The counts in words, a part per kind that has any: «11 Zahlungen noch nicht gebucht (8 davon warten auf ihren Beleg)», «2 Fragen offen», … */
export function issueWords(c: Pick<IssueCounts, 'unbooked' | 'waitingReceipt'> & Partial<IssueCounts>): string[] {
  return [
    c.unbooked ? `${t('issues.n.unbooked', { n: c.unbooked })}${c.waitingReceipt ? ` (${t(c.waitingReceipt === c.unbooked ? 'issues.n.allWaitReceipt' : 'issues.n.waitReceipt', { n: c.waitingReceipt })})` : ''}` : '',
    c.questions ? t('issues.n.questions', { n: c.questions }) : '',
    c.unlinked ? t('issues.n.unlinked', { n: c.unlinked }) : '',
    c.evidence ? t('issues.evidenceTitle', { n: c.evidence }) : '',
  ].filter(Boolean);
}

/**
 * Said where the app would else say that nothing waits for the person (#341): no task is hers, yet
 * payments of a period not filed are not booked, most often because their receipt has not come. A
 * fact with its count and one link to them (`lead`, «Keine Aufgabe wartet auf dich», only when every one
 * of them waits for its receipt: the others are the person's work on Aufgaben): the list of the oldest such period (on the return's
 * page for a firm that files one, else among the payments). Nothing when every payment is booked.
 */
export function UnbookedFact({ books, nav, lead, className }: { books: Index; nav: Pick<Nav, 'go'>; lead?: string; className?: string }) {
  const open = unbookedOpen(books, useWorkspace()?.bankAccounts ?? []);
  if (!open.first) return null;
  const p = parsePeriod(filingKeyOf(open.first.date, filing().length), localToday());
  const to: Location = chargesVat() && p ? { route: { area: 'vat', ziffer: OPEN_ITEMS }, query: { period: p } } : at({ area: 'bank', payment: open.first.ref }, open.first.date);
  return (
    <span className={className} data-testid="unbooked-fact">
      {lead && open.unbooked === open.waitingReceipt ? `${lead} ` : ''}{issueWords(open).join('')}.{' '}
      <button type="button" className="golink" onClick={() => nav.go(to)}>{p ? t('issues.n.see', { period: periodName(p) }) : t('automation.home.open')}</button>
    </span>
  );
}

/**
 * What the shown period still holds open where no task waits (#362): its payments not booked and its
 * receipts without a payment, counted by periodIssues, the source of Belege's «Braucht dich» too, so
 * «Keine Aufgabe wartet auf dich» never stands alone beside receipts that need her. A period with
 * nothing open says what UnbookedFact says of the other open days.
 */
export function OpenFact({ books, nav, period, lead, className }: { books: Index; nav: Pick<Nav, 'go'>; period: Period; lead: string; className?: string }) {
  const c = countIssues(usePeriodIssues(books, period.from, period.to));
  if (!c.unbooked && !c.unlinked) return <UnbookedFact books={books} nav={nav} lead={lead} className={className} />;
  const to: Location = chargesVat() ? { route: { area: 'vat', ziffer: OPEN_ITEMS }, query: { period } } : { route: c.unbooked ? { area: 'bank' } : { area: 'receipts' }, query: { period } };
  return (
    <span className={className} data-testid="open-fact">
      {c.unbooked === c.waitingReceipt ? `${lead} ` : ''}{issueWords({ unbooked: c.unbooked, waitingReceipt: c.waitingReceipt, unlinked: c.unlinked }).join(', ')}.{' '}
      <button type="button" className="golink" onClick={() => nav.go(to)}>{t('issues.n.see', { period: periodName(period) })}</button>
    </span>
  );
}

/** «Noch offen in {period}»: under the return to review. An open VAT question withholds «Freigegeben» (r8h-24); the rest does not block the filing. */
export function PeriodIssues({ books, nav, from, to, period, canEdit }: { books: Index; nav: Nav; from: string; to: string; period: string; canEdit: boolean }) {
  const issues = usePeriodIssues(books, from, to);
  if (!issues.length) return <p className="m" data-testid="period-issues-none">{t('issues.none', { period })}</p>;
  return (
    <section className="wfissues" data-testid="period-issues">
      <h3>{t('issues.title', { period, n: issues.length })}</h3>
      <p className="m">{t('issues.lead')}</p>
      <ul>
        {issues.map((i, k) => {
          const go = goOf(books, i);
          return (
            <li key={k} data-issue={i.kind}>
              {go ? <button type="button" className="linkbtn" onClick={() => nav.go(go)}>{textOf(books, i)}</button> : <span>{textOf(books, i)}</span>}
              {canEdit && i.kind === 'evidence' ? <EvidenceFix e={i.entry} check={i.check} nav={nav} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Bookings of the open period whose code contradicts their receipts, each with its one click (r4c-31). */
export function EvidenceTasks({ books, nav, canEdit }: { books: Index; nav: Nav; canEdit: boolean }) {
  const views = journalOf(books).views.filter((v) => v.evidence);
  if (!views.length) return null;
  return (
    <section className="wfissues" data-testid="evidence-tasks">
      <h3>{t('issues.evidenceTitle', { n: views.length })}</h3>
      <ul>
        {views.map((v) => (
          <li key={v.e.id}>
            <button type="button" className="linkbtn" onClick={() => nav.go(at({ area: 'journal', id: v.e.id }, v.e.date))}>{`${formatDate(v.e.date)} ${v.e.description ?? ''}: ${evidenceText(v.e, v.evidence!)}`}</button>
            {canEdit ? <EvidenceFix e={v.e} check={v.evidence!} nav={nav} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export { thresholdPassed } from '../vat/model.js';

/** A firm not registered whose year's turnover reached the threshold: what follows, and the VAT page it is read off (r5f-9). */
export function ThresholdTasks({ nav, passed }: { nav: Nav; passed: ReturnType<typeof thresholdPassed> }) {
  const money = (n: number) => `${baseCurrency()} ${fmt(n)}`;
  if (!passed.length) return null;
  return (
    <div className="wftasks" data-testid="threshold-tasks">
      {passed.map((w) => (
        <div key={w.year} className="wftask">
          <b>{t('automation.thresholdTitle', { year: w.year, threshold: money(w.threshold) })}</b>
          <span className="m">{t('vat.turnoverYear', { year: w.year })} · {money(w.turnover)}</span>
          <p>{t('vat.thresholdPassed', { threshold: money(w.threshold), next: String(Number(w.year) + 1) })}</p>
          <span className="wfactions">
            <button type="button" className="btn ghost" onClick={() => nav.go({ route: { area: 'vat' }, query: { period: parsePeriod(w.year, localToday()) ?? undefined } })}>{t('automation.thresholdOpen')}</button>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The payments that waited for their receipt until their return came near (issue #29), and those
 * whose receipt could not be read (issue #57, UnreadReceipt.tsx): now the person's, each with its ways out. The receipt linked books it with its VAT;
 * «Mit anderem Nachweis» opens the payment, where the person books it by hand with the rate and names the
 * documents that show the VAT (#134); «Ohne Vorsteuer buchen» books it at once with the zero code. An
 * Eigenbeleg (#8) is not built yet.
 */
export function ReceiptDueTasks({ items, nav, canEdit, books }: { items: readonly WaitingPayment[]; nav: Nav; canEdit: boolean; books: Index }) {
  // The rate answers given here, each with its «Immer so?» while the page stays open: the payment itself is booked and leaves the list.
  const [answered, setAnswered] = useState<Array<{ offer: UnreadOffer; rate: number }>>([]);
  if (!items.length && !answered.length) return null;
  const period = (date: string) => { const p = parsePeriod(filingKeyOf(date, filing().length), localToday()); return p ? periodName(p) : date; };
  return (
    <div className="wftasks" data-testid="receipt-due">
      {answered.map((a) => <UnreadRuleOffer key={a.offer.ref} offer={a.offer} rate={a.rate} nav={nav} />)}
      {items.map((item) => (item.kind === 'unread' ? (
        <UnreadTask key={item.tx.ref} item={item} nav={nav} canEdit={canEdit} onRate={(offer, rate) => setAnswered((was) => [...was.filter((x) => x.offer.ref !== offer.ref), { offer, rate }])} />
      ) : (
        <div key={item.tx.ref} className="wftask">
          <b>{t('receiptDue.title', { name: payText(item.tx).name, amount: `${item.tx.currency} ${fmt(signed(item.tx))}` })}</b>
          <span className="m">{formatDate(item.tx.date)} · {t('receiptDue.due', { period: period(item.tx.date), date: formatDate(item.due) })}</span>
          <p>{t('receiptDue.lead')}</p>
          <span className="wfactions">
            <button type="button" className="btn ghost" data-testid="receipt-due-find" onClick={() => nav.go(at({ area: 'bank', payment: item.tx.ref }, item.tx.date))}>{t('receiptDue.find')}</button>
            {canEdit ? <FindPair key={`find-${item.tx.ref}`} on={{ payment: item.tx.ref }} books={books} nav={nav} /> : null}
            {canEdit ? <button type="button" className="btn ghost" data-testid="receipt-due-proof" data-tip={t('receiptDue.otherProofTip')} onClick={() => nav.go(at({ area: 'bank', payment: item.tx.ref }, item.tx.date))}>{t('receiptDue.otherProof')}</button> : null}
            {canEdit ? <button type="button" className="btn" data-testid="receipt-due-book" onClick={() => void bookWithoutInputTax(nav, item.tx)}>{t('receiptDue.withoutInputTax')}</button> : null}
          </span>
        </div>
      )))}
    </div>
  );
}

/**
 * The bookings of the period filed last that contradicted their receipts and were not settled
 * before filing (r5h-33): they stay as filed, so each links to its booking, where the correction
 * in the open period is made. Gone once a correction names its payment.
 */
export function FiledEvidence({ books, nav }: { books: Index; nav: Nav }) {
  const u = unsettledAtFiling(journalOf(books), filing().length);
  if (!u?.items.length) return null;
  const name = (key: string) => { const p = parsePeriod(key, localToday()); return p ? periodName(p) : key; };
  const open = openFilingPeriod(books.config?.closedThrough, localToday(), filing().length);
  return (
    <section className="wfissues" data-testid="filed-evidence">
      <h3>{t('issues.filedTitle', { n: u.items.length, period: name(u.period) })}</h3>
      <p className="m">{t('issues.filedLead', { open: periodName(open) })}</p>
      <ul>
        {u.items.map(({ v, check }) => (
          <li key={v.e.id}>
            <button type="button" className="linkbtn" onClick={() => nav.go(at({ area: 'journal', id: v.e.id }, v.e.date))}>{`${formatDate(v.e.date)} ${v.e.description ?? ''}: ${evidenceText(v.e, check)}`}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The import VAT of the books whose deduction waits for the customs office's assessment (issue #227): none for a firm without input tax. */
export const assessmentsMissing = (books: Index): MissingAssessment[] => missingAssessments(books, documents().customs, !withoutInputTax());

/**
 * «Veranlagungsverfügung fehlt» (issue #227): import VAT booked without input tax because the
 * customs office's assessment is not linked, each with what the courier's invoice says is needed to
 * fetch it (the declaration number, the access code, the link). The assessment linked to the
 * payment brings the deduction on the next run (src/booking/customs-invoice.ts).
 */
export function AssessmentTasks({ books, nav }: { books: Index; nav: Nav }) {
  const items = assessmentsMissing(books);
  if (!items.length) return null;
  return (
    <section className="wfissues" data-testid="assessment-tasks">
      <h3>{t('issues.assessmentTitle', { n: items.length })}</h3>
      <p className="m">{t('issues.assessmentLead')}</p>
      <ul>
        {items.map((i) => (
          <li key={`${i.payment}-${i.receipt}-${i.amount}`}>
            <button type="button" className="linkbtn" onClick={() => nav.go(at({ area: 'bank', payment: i.payment }, i.date))}>{t('issues.assessment', { date: formatDate(i.date), file: i.file, amount: `${i.currency} ${fmt(i.amount)}` })}</button>
            <span className="m">
              {' · '}
              {[
                i.access.numbers.length ? t('issues.assessmentNumber', { numbers: i.access.numbers.join(', ') }) : undefined,
                i.access.code ? t('issues.assessmentCode', { code: i.access.code }) : undefined,
              ].filter(Boolean).join(' · ') || t('issues.assessmentWhere')}
            </span>
            {i.access.url ? <>{' '}<a className="golink" href={i.access.url} target="_blank" rel="noopener noreferrer">{t('issues.assessmentLink')}</a></> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Receipts that may be the copy of another, each with its two answers (r5h-34): asked on Aufgaben too, not only on the receipt. */
export function TwinTasks({ books, nav, canEdit }: { books: Index; nav: Nav; canEdit: boolean }) {
  const l = ledgerFor(books);
  const views = openTwins(l);
  if (!views.length) return null;
  return (
    <section className="wfissues" data-testid="twin-tasks">
      <h3>{t('issues.twinsTitle', { n: views.length })}</h3>
      <ul>
        {views.map((v) => {
          const other = l.byId.get(v.twin!.of)!;
          return (
            <li key={v.r.id}>
              <button type="button" className="linkbtn" onClick={() => nav.go(at({ area: 'receipts', id: v.r.id }, v.day))}>{t('issues.twin', { file: v.r.filename, of: other.r.filename, why: t(`drop.twin.why.${v.twin!.why}`) })}</button>
              {canEdit ? (
                <>
                  <button type="button" className="btn ghost" onClick={() => void answerTwin(nav, v, 'same', other.r.id, other.r.filename)}>{t('receipts.twin.same')}</button>
                  <button type="button" className="btn ghost" onClick={() => void answerTwin(nav, v, 'distinct', other.r.id, other.r.filename)}>{t('receipts.twin.distinct')}</button>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
