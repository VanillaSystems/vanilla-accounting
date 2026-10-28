/**
 * What a statement PDF asks in Kontoauszüge (#254): its question kept in the books (whether its
 * movements are read in), the table to check and «Einlesen» or «Als Monatsauszug behalten»; the
 * «Aktionen» of a PDF kept as the statement, «Bewegungen aus dem PDF einlesen» (the model, or the hand
 * form when the AI is off); a month whose PDF brought no movement, said as a fact; and a movement
 * read from a PDF that the account's camt.053 or CSV does not hold, kept or removed by the person.
 */
import { useState } from 'react';
import type { BankTransaction, StatementAsk } from '../../../types/index.js';
import { api, errorText } from '../../lib/api.js';
import { formatDate } from '../../lib/utils.js';
import { monthName } from '../../lib/period-label.js';
import { t } from '../../i18n/index.js';
import { StatementRead, type ReadAction } from '../../shell/StatementRead.js';
import type { ActionSet } from '../../selection/ActionsMenu.js';
import type { Nav } from '../index.js';
import { at } from '../receipts/view.js';
import { fileKey, type Statement } from './model.js';
import { forgetPages } from './StatementPaper.js';

/** The file of a statement's PDF in the books: `<bank>/<file name>`; none for a camt.053 or a month without a file. */
export const pdfOf = (s: Statement): string | undefined => (s.file && /\.pdf$/i.test(s.file.filename) ? `${s.file.bank}/${s.file.filename}` : undefined);

/** «Bewegungen aus dem PDF einlesen»: the PDF read now, its question kept in the books; the page then shows the table. */
export async function readPdf(nav: Nav, file: string): Promise<void> {
  try {
    await api.readStatementPdf(file);
  } catch (e) {
    nav.toast(errorText(e));
    return;
  }
  nav.refresh();
}

/** The «Aktionen» of a statement PDF kept as the statement: read its movements in. Only in the open period, for one who may edit. */
export function statementActions(nav: Nav, s: Statement, ask: StatementAsk | undefined, edit: boolean): ActionSet {
  const file = pdfOf(s);
  return { rest: file && edit && !ask ? [{ id: 'readPdf', label: t('statementActions.readPdf'), run: () => void readPdf(nav, file) }] : [] };
}

/** The PDF's question: the table as read or corrected, «Einlesen» or «Als Monatsauszug behalten». */
export function PdfQuestion({ ask, nav, edit }: { ask: StatementAsk; nav: Nav; edit: boolean }) {
  const [error, setError] = useState<string>();
  const act = async (a: ReadAction) => {
    setError(undefined);
    try {
      if (a.kind === 'keep') {
        await api.keepStatementPdf(ask.file);
        nav.toast(t('bank.pdfKept'));
      } else if (!a.import) {
        await api.correctStatementRead(ask.file, a.statement);
      } else {
        const done = await api.importStatementRead(ask.file, a.statement);
        forgetPages();
        nav.toast(t('bank.imported', { n: done.added }), () => void api.unreadStatement(done.file).then(() => { forgetPages(); nav.refresh(); }, (e) => nav.toast(errorText(e))));
        nav.refresh();
        nav.go(at({ area: 'bank', statement: fileKey(done.account, done.from ?? `${done.month}-01`, done.to) }, done.to));
        return;
      }
      nav.refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="pdfq" data-testid="pdf-question">
      <p className="notice" style={{ margin: 0 }}>{t('bank.pdfAsks', { since: formatDate(ask.since) })}</p>
      {edit ? <StatementRead key={`${ask.read.by}-${ask.read.statement.movements.length}-${ask.read.statement.closing.amount}`} read={ask.read} pdf act={act} go={(route) => nav.go({ route, query: {} })} /> : null}
      {error ? <p className="notice warn" style={{ margin: 0 }} data-testid="pdf-question-error">{error}</p> : null}
    </div>
  );
}

/** A month whose PDF brought no movement into the books: said as a fact, with the way to read them by hand. */
export function NoMovements({ s, nav, edit }: { s: Statement; nav: Nav; edit: boolean }) {
  const file = pdfOf(s);
  return (
    <span className="notice" style={{ margin: 0 }} data-testid="no-movements">
      {t('bank.noMovements', { month: monthName(s.from) })}{' '}
      {file && edit ? <button type="button" className="linkbtn" data-testid="no-movements-read" onClick={() => void readPdf(nav, file)}>{t('statementActions.readPdfShort')}</button> : null}
    </span>
  );
}

/** A movement read from a PDF that the account's camt.053 or CSV does not hold: «Behalten» or «Entfernen» (with its bookings). */
export function UnmatchedNotice({ tx, nav, edit }: { tx: BankTransaction; nav: Nav; edit: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = (call: () => Promise<unknown>) => {
    setBusy(true);
    call().then(() => nav.refresh(), (e) => nav.toast(errorText(e))).finally(() => setBusy(false));
  };
  return (
    <div className="status" data-testid="unmatched">
      <span className="notice warn" style={{ margin: 0 }}>
        {t('bank.unmatched', { file: tx.unmatched!.by.split('/').pop() ?? tx.unmatched!.by })}{' '}
        {edit ? (
          <>
            <button type="button" className="linkbtn" disabled={busy} data-testid="unmatched-keep" onClick={() => run(() => api.keepUnmatched(tx.ref))}>{t('bank.unmatchedKeep')}</button>{' '}
            <button type="button" className="linkbtn" disabled={busy} data-testid="unmatched-remove" data-tip={t('bank.unmatchedRemoveTip')} onClick={() => run(() => api.deleteTransaction(tx.ref))}>{t('bank.unmatchedRemove')}</button>
          </>
        ) : null}
      </span>
    </div>
  );
}
