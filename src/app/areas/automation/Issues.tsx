/**
 * The open issues of a period on Aufgaben (src/app/areas/automation/period-issues.ts): before the
 * return is filed, under «Abrechnung prüfen» (r4c-38), and the bookings that contradict their
 * receipts with their one click (r4c-31). Each issue links to where it is settled; none blocks.
 */
import { t } from '../../i18n/index.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { useQuestions } from '../../questions/store.js';
import { at } from '../receipts/view.js';
import { evidenceText, patchOf } from '../journal/Detail.js';
import { saveEntry } from '../journal/actions.js';
import { journalOf, unsettledAtFiling } from '../journal/model.js';
import { filing } from '../../../engines/index.js';
import { localToday, openFilingPeriod, parsePeriod } from '../../../accounting/periods.js';
import { periodName } from '../../lib/period-label.js';
import { periodIssues, type PeriodIssue } from './period-issues.js';
import type { Location } from '../../shell/route.js';
import type { Nav } from '../index.js';
import type { Index, JournalEntry } from '../../../types/index.js';
import type { EvidenceCheck } from '../../../accounting/evidence-check.js';

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

/** One click that books the entry as its receipts say: «Nach Beleg buchen» or «Ohne Beleg buchen». */
function EvidenceFix({ e, check, nav }: { e: JournalEntry; check: EvidenceCheck; nav: Nav }) {
  return (
    <button type="button" className="btn ghost" data-testid="evidence-book" onClick={() => void saveEntry(nav, e, patchOf(check), ['vatCode'])}>
      {t(check.kind === 'receiptShowsVat' ? 'journal.evidence.bookByReceipt' : 'journal.evidence.bookWithoutReceipt')}
    </button>
  );
}

/** «Noch offen in {period}»: under the return to review; it does not block the filing. */
export function PeriodIssues({ books, nav, from, to, period, canEdit }: { books: Index; nav: Nav; from: string; to: string; period: string; canEdit: boolean }) {
  const { questions } = useQuestions();
  const issues = periodIssues(books, questions, from, to);
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
