/**
 * What a statement PDF kept as its statement gives the books (#243): its closing balance and the
 * references and foreign amounts its table adds to the bank export's payments, or, as a fact, why it
 * gives nothing yet. The table is the model's read or the person's own: «Von Hand erfassen» fills it
 * from the statement's payments without AI, «Korrigieren» corrects a read. Above the list, the PDFs
 * not read yet and the reading the person starts for them, N of M, cancellable.
 */
import { useEffect, useState } from 'react';
import type { BankTransaction } from '../../../types/index.js';
import type { PdfFactsView, StatementReadsView } from '../../../types/statement-read.js';
import { aiRefusedText, api, errorText } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { StatementRead } from '../../shell/StatementRead.js';
import type { Nav } from '../index.js';
import { tableOfPayments, type Check, type Statement } from './model.js';

/** A kept PDF's facts in its statement: what it gives the books, why it gives nothing yet, and the table to fill or correct. */
export function PdfFacts({ file, s, pays, check, edit, nav, version }: { file: string; s: Statement; pays: readonly BankTransaction[]; check: Pick<Check, 'close'> | undefined; edit: boolean; nav: Nav; version: unknown }) {
  const [view, setView] = useState<PdfFactsView>();
  const [open, setOpen] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { api.statementFacts(file).then(setView, () => setView(undefined)); }, [file, version]);
  if (!view || view.state === 'asked' || (view.state === 'filed' && !view.statement)) return null;
  const done = async (p: Promise<PdfFactsView>) => {
    setError(undefined);
    try { setView(await p); setOpen(false); setForgetting(false); nav.refresh(); } catch (e) { setError(errorText(e)); }
  };
  const table = view.statement ?? tableOfPayments(s, pays, check);
  const by = view.statement ? (view.by ?? 'model') : 'hand';
  const facts = view.statement ? [
    view.closing ? t('bank.facts.closing', { amount: `${s.account.currency} ${fmt(view.closing.amount)}`, date: formatDate(view.closing.date) })
      : view.bank ? t('bank.facts.bank', { amount: `${s.account.currency} ${fmt(view.bank.amount)}`, date: formatDate(view.bank.date) })
      : view.statement.closing === undefined ? t('bank.facts.noBalance')
      : view.adds ? '' : t('bank.facts.noClosing'),
    view.taken?.references ? t('bank.facts.references', { n: view.taken.references }) : '',
    view.taken?.originals ? t('bank.facts.originals', { n: view.taken.originals }) : '',
  ].filter(Boolean).join(' · ') : '';
  return (
    <div className="pdffacts" data-testid="pdf-facts" data-state={view.state}>
      <p className="notice" style={{ margin: 0 }}>
        {view.statement ? <>{t(view.state === 'hand' ? 'bank.facts.byHand' : 'bank.facts.byModel')}{facts ? `: ${facts}` : ''}</> : t(`bank.facts.${view.state}`)}
        {!view.statement && view.closing ? <span className="m" data-testid="pdf-facts-held"> {t('bank.facts.held', { amount: `${s.account.currency} ${fmt(view.closing.amount)}`, date: formatDate(view.closing.date) })}</span> : null}
        {view.error ? <span className="m" data-testid="pdf-facts-error"> {t('bank.facts.failed', { error: view.error })}</span> : null}
      </p>
      {view.ambiguous || view.unmatched ? (
        <p className="m" style={{ margin: 0 }} data-testid="pdf-facts-left">{t('bank.facts.left', { ambiguous: view.ambiguous ?? 0, unmatched: view.unmatched ?? 0 })}</p>
      ) : null}
      {edit ? (
        <div className="pdffacts-acts">
          <button type="button" className="linkbtn" data-testid="pdf-facts-edit" onClick={() => setOpen(!open)}>{t(view.statement ? 'bank.facts.correct' : 'bank.facts.byHandFill')}</button>
          {view.statement
            ? <button type="button" className="linkbtn" data-testid="pdf-facts-forget" aria-expanded={forgetting} onClick={() => setForgetting(!forgetting)}>{t('bank.facts.again')}</button>
            : view.state === 'notStatement' || view.state === 'pages' || view.state === 'unreadable'
              ? <button type="button" className="linkbtn" data-testid="pdf-facts-forget" onClick={() => void done(api.forgetStatementRead(file))}>{t('bank.facts.again')}</button> : null}
        </div>
      ) : null}
      {forgetting && edit && view.statement ? (
        <div className="notice warn" role="alertdialog" data-testid="pdf-facts-forget-confirm" style={{ margin: 0 }}>
          <span>{forgetText(view, s.account.currency)}</span>
          <span className="pdffacts-acts">
            <button type="button" className="btn ghost" onClick={() => setForgetting(false)}>{t('common.cancel')}</button>
            <button type="button" className="btn danger" data-testid="pdf-facts-forget-yes" onClick={() => void done(api.forgetStatementRead(file, true))}>{t('bank.facts.forget.yes')}</button>
          </span>
        </div>
      ) : null}
      {open && edit ? (
        <StatementRead key={`${by}-${table.movements.length}-${table.closing?.amount ?? ''}`} read={{ by, statement: table, known: [] }} pdf={false}
          save={(statement) => done(api.saveStatementFacts(file, statement))} go={(route) => nav.go({ route, query: {} })} />
      ) : null}
      {error ? <p className="notice warn" style={{ margin: 0 }} data-testid="pdf-facts-error-save">{error}</p> : null}
    </div>
  );
}

/**
 * What «Neu lesen» takes away, said before it does: the table (hers or the model's) with the
 * references it gave the books. The closing balance it gave stays in the books until a new reading
 * gives one (forgetRead).
 */
function forgetText(view: PdfFactsView, currency: string): string {
  const what = t(view.state === 'hand' ? 'bank.facts.forget.hand' : 'bank.facts.forget.model', { n: view.taken?.references ?? 0 });
  const kept = view.closing ? ` ${t('bank.facts.forget.balance', { amount: `${currency} ${fmt(view.closing.amount)}`, date: formatDate(view.closing.date) })}` : '';
  return `${what}${kept}`;
}

/** Why the reading stopped or a file failed, in the person's words. */
const stoppedText = (job: NonNullable<StatementReadsView['job']>) => (job.stopped?.refusal ? aiRefusedText(job.stopped.refusal) : job.stopped?.error ?? job.error ?? '');

/**
 * The kept PDFs not read yet, as a fact with the way to read them: «N Kontoauszüge von der KI lesen
 * lassen?» (asked once for a backlog; the inbox run reads a month's worth by itself), the reading N of
 * M with «Abbrechen», and without AI which stay unread and that their balance and references can be
 * entered by hand on each.
 */
export function StatementReads({ nav, canEdit, version }: { nav: Nav; canEdit: boolean; version: unknown }) {
  const [view, setView] = useState<StatementReadsView>();
  const [error, setError] = useState<string>();
  useEffect(() => { api.statementReads().then(setView, () => setView(undefined)); }, [version]);
  const running = !!view?.job && !view.job.finished;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => api.statementReads().then((v) => {
      setView(v);
      if (v.job?.finished) nav.refresh();
    }, () => {}), 1500);
    return () => clearInterval(id);
  }, [running]);
  if (!view) return null;
  const act = async (p: Promise<StatementReadsView>) => {
    setError(undefined);
    try { setView(await p); } catch (e) { setError(errorText(e)); }
  };
  const n = view.unread.length;
  const job = view.job;
  if (!n && !running && !(job?.finished && (job.failed.length || job.stopped || job.error))) return null;
  return (
    <div className="notice stmreads" data-testid="statement-reads" data-ai={view.ai}>
      {running ? (
        <span data-testid="statement-reads-progress">
          <span className="spin small" aria-hidden="true" /> {t('bank.reads.progress', { n: Math.min(job!.done + 1, job!.total), m: job!.total })}
          {job!.cancelling ? <span className="m"> {t('bank.reads.cancelling')}</span>
            : canEdit ? <> <button type="button" className="linkbtn" data-testid="statement-reads-cancel" onClick={() => void act(api.cancelStatementReads())}>{t('bank.reads.cancel')}</button></> : null}
        </span>
      ) : view.ai === 'ready' ? (
        n ? (
          <span>
            {canEdit ? <button type="button" className="linkbtn" data-testid="statement-reads-start" onClick={() => void act(api.startStatementReads())}>{t('bank.reads.ask', { n })}</button> : t('bank.reads.unread', { n })}
            <span className="m"> {t('bank.reads.what', { limit: view.limit })}</span>
          </span>
        ) : null
      ) : (
        <span data-testid="statement-reads-noai">
          {t(`bank.reads.without.${view.ai}`, { n })} {t('bank.reads.byHand')}{' '}
          <button type="button" className="linkbtn" onClick={() => nav.go({ route: { area: 'company', section: 'ai' }, query: {} })}>{t('aiOff.toFirma')}</button>
        </span>
      )}
      {job?.finished && (job.stopped || job.error) ? <span className="warn" data-testid="statement-reads-stopped">{t('bank.reads.stopped', { n: job.read, m: job.total, why: stoppedText(job) })}</span> : null}
      {view.failures.length && !running ? <span className="m" data-testid="statement-reads-failed">{t('bank.reads.failed', { n: view.failures.length, why: view.failures[0].error })}</span> : null}
      {error ? <span className="warn">{error}</span> : null}
    </div>
  );
}
