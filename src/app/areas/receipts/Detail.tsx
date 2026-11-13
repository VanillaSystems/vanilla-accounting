/**
 * One receipt: who and what, the amount, one line of facts, its payment (or the suggestion, or
 * what is missing), the paper, and in the margin Zahlung, Angaben and Datei.
 */
import type { OrderPage } from '../../../booking/order-pages.js';
import type { VatCorrection } from '../../../booking/vat-corrections.js';
import { byStatement } from '../../../workspace/money-accounts.js';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PaymentBooking } from '../journal/PaymentBooking.js';
import { EvidenceFix, evidenceText } from '../journal/Detail.js';
import { journalOf } from '../journal/model.js';
import type { BankTransaction, InboxFile, JournalEntry, Receipt } from '../../../types/index.js';
import { filingKeyOf, parsePeriod, parseSwissDate, localToday } from '../../../accounting/periods.js';
import { VAT_READ_TRIES, vatGivenUp } from '../../../accounting/receipt-due.js';
import type { RouteOf } from '../../shell/route.js';
import { periodName } from '../../lib/period-label.js';
import { sources, api } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { useBookedFields } from '../../lib/booked-fields.js';
import { useFx } from '../../hooks/use-fx.js';
import { language, t } from '../../i18n/index.js';
import { useAutomation } from '../../automation/store.js';
import { startIntake, useIntakeRunning } from '../../automation/intake.js';
import { textIn, type RunSummary } from '../../../workflows/model.js';
import { ICONS } from '../icons.js';
import type { AreaProps } from '../index.js';
import { balanceSheetOf, cardLineOf, cardLineOffers, cardStatementOf, ownAmount, chfOf, linkFit, markLabel, vatMisfit, type Ledger, type ReceiptView, vatChipOf } from './model.js';
import { waitsForReading } from '../../../parsers/receipt-text.js';
import { setUi, useUi, type Section } from './state.js';
import { amountOf, at, balanceSheetLine, bankOf, cardLineText, cardStatementLine, dayText, ledgerFor, listed, noneText, txLine } from './view.js';
import { Kbd, accept, runAct } from './commands.js';
import { correctionPeriodName } from '../journal/commands.js';
import { QuestionsOn } from '../../questions/Questions.js';
import { bookVatCorrection, correctFiled, deleteReceipt, linkCardLine, linkPayment, unpointFiled, readAgain, saveFields, undoPrivate, unlinkPayment, type Field } from './actions.js';
import { LinkDialog } from './LinkDialog.js';
import { FindPair, NearList, madeBy } from './FindPair.js';
import { offersInBooks } from '../../../intake/near-pairs.js';
import { ByHand, VatFields } from './VatFields.js';
import { TwinNotice } from './TwinNotice.js';
import { ReportCorrections } from './ReportCorrections.js';
import { ReportHeld } from './ReportHeld.js';
import { Paper } from './Paper.js';
import { SkipOffer } from './SkipOffer.js';
import { RunHistory } from '../../history/RunHistory.js';
import { I } from './icons.js';
import { ActionsMenu } from '../../selection/ActionsMenu.js';
import { ownerPays, readsPaidPrivately, receiptActions } from './actions-menu.js';
import { useAiOff } from '../../ai/ai-off.js';
import { useAiState, useNoAi } from '../../ai/no-ai.js';
import { baseCurrency, chargesVat, filing, withoutInputTax } from '../../../engines/index.js';
import { processingText } from '../../automation/processing.js';
import { INTAKE_WORKFLOW, inProcess, type Processing } from '../../../workflows/processing.js';
import { refusalText } from '../../automation/refusal.js';

type Props = AreaProps<RouteOf<'receipts'>>;

export function Detail(props: Props) {
  const { route, books } = props;
  const s = useUi();
  // The runs' state is part of the ledger (what they still work on, #218): a poll that moved them shows here.
  useAutomation();
  const l = ledgerFor(books);
  const v = route.id ? l.byId.get(route.id) : undefined;
  const pending = route.id && !v ? s.inbox.find((f) => f.id === route.id) : undefined;
  if (pending) return <PendingDetail file={pending} nav={props.nav} proc={l.processing.get(pending.id)} />;
  if (!v) return <div className="detail-empty"><div>{route.id ? t('receipts.gone') : ''}</div></div>;
  return <ReceiptDetail key={v.r.id} {...props} v={v} l={l} />;
}

function PendingDetail({ file, nav, proc }: { file: InboxFile; nav: Props['nav']; proc?: Processing }) {
  const s = useUi();
  const running = useIntakeRunning();
  const { view } = useAutomation();
  const failed = file.failed;
  return (
    <div className="detail-in">
      <div className="head"><h2 className="who">{failed ? file.filename : <span className="shimmer" style={{ width: 260, height: 18 }} />}<small data-testid="pending-processing">{failed ? t('receipts.readFailedDetail') : inProcess(proc) ? processingText(proc, view) : t('receipts.readingDetail')}</small></h2></div>
      <div className="facts"><span>{file.filename}</span></div>
      {failed && (
        <div className="notice warn" data-testid="read-failed">
          {I.dot}<span>{failed.error}</span>
          <a href="#" onClick={(e) => { e.preventDefault(); nav.go({ route: { area: 'automation', view: 'run', run: failed.run }, query: {} }); }}>{t('receipts.readFailedRun')}</a>
          <button type="button" className="btn ghost" disabled={running} onClick={() => void startIntake()}>{running ? t('intake.running') : t('receipts.readAgainNow')}</button>
        </div>
      )}
      <div className="body">
        <div className="desk"><div className="paper real"><Paper key={file.id} src={api.inboxFile(file.id)} /></div></div>
        <aside className="margin" aria-label={t('receipts.details')}>
          <div className="note">{failed ? t('receipts.readFailedTip') : t('receipts.readingTip')}</div>
        </aside>
      </div>
      {s.overlay === 'quick' && <Quick src={api.inboxFile(file.id)} file={file.filename} />}
    </div>
  );
}

/** The period a locked receipt belongs to: that of its first payment or entry in a filed period. */
function lockedPeriod(v: ReceiptView, l: Ledger): string {
  const dates = v.links.flatMap((ref) => [l.txByRef.get(ref)?.date, ...(l.entriesByRef.get(ref) ?? []).map((e) => e.date)]);
  return filedPeriodName(dates.find((x) => x && l.closedThrough && x <= l.closedThrough) ?? l.closedThrough ?? '');
}

/** The receipt pays a payment of a filed quarter: no link is made; its tax is a correction in the open quarter, booked from that payment's entry. */
function FiledPaymentNotice({ l, nav, books, canEdit, payment, open, receipt, corrected }: Props & { l: Ledger; payment: string; open: string; receipt: string; corrected: boolean }) {
  const tx = l.txByRef.get(payment);
  const entry = l.entriesByRef.get(payment)?.[0];
  if (!tx) return null;
  const go = entry ? at({ area: 'journal', id: entry.id }, entry.date) : at({ area: 'bank', payment }, tx.date);
  // A firm without input tax has none to enter: the receipt only says where its payment is.
  const noInputTax = withoutInputTax();
  const said = { date: formatDate(tx.date), period: filedPeriodName(tx.date), open };
  return (
    <div className="notice" data-testid="filed-payment">
      {ICONS.lock}<span>{noInputTax ? t(`receipts.filedPaymentNoInputTax.${noInputTax}`, said) : t(corrected ? 'receipts.filedPaymentCorrected' : 'receipts.filedPaymentNotice', said)}</span>
      <a href="#" onClick={(e) => { e.preventDefault(); nav.go(go); }}>{t('receipts.filedPaymentOpen')}</a>
      {canEdit && entry && open && !noInputTax && !corrected && <a href="#" data-testid="filed-correct" onClick={(e) => { e.preventDefault(); correctFiled(nav, books, l, payment, receipt); }}>{t('receipts.correctIn', { period: open })}</a>}
      {canEdit && !corrected && <button type="button" className="quiet" data-testid="filed-unpoint" data-tip={t('pair.unpointTip')} onClick={() => void unpointFiled(nav, receipt, payment, `${formatDate(tx.date)} ${amountOf(tx)}`)}>{t('pair.unlink')}</button>}
    </div>
  );
}

/** The name of the filing period a date lies in: its quarter, or its half year on the net tax rate method. */
function filedPeriodName(d: string): string {
  const p = parsePeriod(filingKeyOf(d, filing().length), localToday());
  return p ? periodName(p) : d;
}

function ReceiptDetail(props: Props & { v: ReceiptView; l: Ledger }) {
  const { v, l, nav, canEdit } = props;
  const { r } = v;
  const s = useUi();
  const { rates } = useFx();
  const edit = canEdit && !v.locked;
  const cur = r.currency || baseCurrency();
  const firstTx = v.links.map((ref) => l.txByRef.get(ref)).find(Boolean);
  const rate = cur !== baseCurrency() && firstTx && rates?.on(cur, firstTx.date);
  const vat = r.hasSwissVat ? (r.vatSummary ?? []).filter((g) => g.ratePercent > 0 && g.vat) : [];
  const misfit = vatMisfit(r);
  const src = sources.receipt(r.id);
  const open = parsePeriod(l.openFrom.slice(0, 4) + '-Q' + Math.ceil(Number(l.openFrom.slice(5, 7)) / 3), localToday());
  const aiOff = useAiOff();
  const noAi = useNoAi();
  const { view } = useAutomation();
  // A run of the inbox still works on it (#218): what it does instead of what is missing; a run that stopped says so.
  const proc = l.processing.get(r.id);
  // A card statement taken as a receipt (#401): what the app did with it.
  const card = cardStatementOf(r, props.books);
  const sheet = balanceSheetOf(r, props.books, localToday());
  const busy = inProcess(proc) && !v.none;
  const unread = !v.date || r.amount == null || vatChipOf(r.hasSwissVat, withoutInputTax()) === 'unread';

  return (
    <div className="detail-in" data-for={r.id} data-processing={busy ? proc.kind : proc?.kind === 'stuck' ? 'stuck' : undefined}>
      <div className="head">
        <h2 className="who">{v.vendor}<small>{v.desc}</small></h2>
        {ownAmount(r) != null && (
          <div className="amount">
            <small>{cur}</small>{fmt(r.amount!)}
            {rate && <span className="fx">{t('receipts.fxLine', { amount: fmt(Math.abs(r.amount!) * rate.rate), date: formatDate(rate.validOn) })}</span>}
          </div>
        )}
      </div>
      {busy && (
        <div className="facts">
          {v.date && <span data-tip={t('receipts.factDate')}>{formatDate(v.date)}</span>}
          {r.amount != null && <span data-tip={t('receipts.factAmount')}>{cur} {fmt(r.amount)}</span>}
          {vat.map((g) => <span key={g.ratePercent} data-tip={t('receipts.factVat', { rate: g.ratePercent, tax: fmt(g.vat) })}>{t('receipts.vatLine', { rate: g.ratePercent, tax: fmt(g.vat) })}</span>)}
          {unread && <span className="proc" data-testid="facts-working" data-tip={t('processing.tip')}><span className="spin small" aria-hidden="true" />{t('processing.field')}</span>}
        </div>
      )}
      {!v.none && !busy && (
        <div className="facts">
          {v.date ? <span data-tip={t('receipts.factDate')}>{formatDate(v.date)}</span>
            : <button type="button" className="miss" disabled={!canEdit} data-tip={t('receipts.addDate')} onClick={() => runAct(props, 'edit')}>{t('receipts.dateMissing')}</button>}
          {r.amount != null ? <span data-tip={t('receipts.factAmount')}>{cur} {fmt(r.amount)}</span>
            : <button type="button" className="miss" disabled={!edit} data-tip={t('receipts.addAmount')} onClick={() => runAct(props, 'edit')}>{t('receipts.amountMissing')}</button>}
          {vat.length
            ? vat.map((g) => <span key={g.ratePercent} data-tip={t('receipts.factVat', { rate: g.ratePercent, tax: fmt(g.vat) })}>{t('receipts.vatLine', { rate: g.ratePercent, tax: fmt(g.vat) })}</span>)
            : vatChipOf(r.hasSwissVat, withoutInputTax()) === 'unread' && vatGivenUp(r) ? <span className="nov" data-testid="vat-given-up" data-tip={t('receipts.vatGivenUpTip', { tries: VAT_READ_TRIES })}>{t('receipts.vatGivenUp', { tries: VAT_READ_TRIES })}</span>
            : vatChipOf(r.hasSwissVat, withoutInputTax()) === 'unread' ? <span className="nov" data-tip={t('receipts.vatUnreadTip')}>{t('receipts.vatUnread')}</span>
            : vatChipOf(r.hasSwissVat, withoutInputTax()) === 'none' ? <span className="nov" data-tip={t('receipts.noVatTip')}>{t('receipts.noVat')}</span>
            : null}
          {r.vatBy === 'human' && <ByHand />}
          {misfit !== undefined && <span className="misfit" data-testid="vat-misfit" data-tip={t('receipts.vatMisfitTip', { gross: `${cur} ${fmt(misfit)}`, amount: `${cur} ${fmt(r.amount!)}` })}>{t('receipts.vatMisfit')}</span>}
          {vat.length > 0 && (r.vatId
            ? <span data-tip={t('receipts.uidTip', { uid: r.vatId })}><span className="ok">✓</span> {t('receipts.uid')} <span className="mono">{r.vatId}</span></span>
            : <span className="nov" data-tip={t('receipts.noUidTip')}>{t('receipts.uidMissing')}</span>)}
        </div>
      )}
      <div className="actbar"><ActionsMenu set={receiptActions(props, v, l)} /></div>
      {v.locked && (
        <div className="notice">
          {ICONS.lock}<span>{t(chargesVat() ? 'receipts.lockedNotice' : 'receipts.lockedNoticeClosed', { period: lockedPeriod(v, l) })}</span>
          <a href="#" onClick={(e) => { e.preventDefault(); nav.go({ route: { area: 'journal' }, query: {} }); }}>{t('receipts.correctIn', { period: correctionPeriodName(props.books) })}</a>
        </div>
      )}
      {!v.locked && !v.links.some((ref) => l.txByRef.has(ref)) && r.filedPayment && <FiledPaymentNotice {...props} payment={r.filedPayment} open={open ? periodName(open) : ''} receipt={r.id} corrected={v.links.length > 0} />}
      {proc?.kind === 'stuck' && !v.none && !v.links.length && <StuckNotice proc={proc} nav={nav} view={view} />}
      {aiOff && !busy && !v.none && waitsForReading(r) && (
        <div className="notice aioffwait" data-testid="waits-ai-off">
          {I.dot}<span>{t('receipts.waitsAiOff')}</span>
          <a href="#" onClick={(e) => { e.preventDefault(); nav.go({ route: { area: 'company', section: 'ai' }, query: {} }); }}>{t('aiOff.toFirma')}</a>
        </div>
      )}
      {!aiOff && !busy && !v.none && waitsForReading(r) && (
        <div className="notice warn notread" data-testid="not-read">
          {I.dot}<span>{t(noAi ? 'receipts.notReadNoAi' : 'receipts.notReadFailed')}</span>
          {noAi ? <a href="#" data-act="ai-set-up" onClick={(e) => { e.preventDefault(); nav.go({ route: { area: 'company', section: 'ai' }, query: {} }); }}>{t('aiSetup.line.setUp')}</a> : null}
          {edit ? <a href="#" data-act="by-hand" onClick={(e) => { e.preventDefault(); runAct(props, 'edit'); }}>{t('aiSetup.line.byHand')}</a> : null}
        </div>
      )}
      <TwinNotice {...props} />
      {card && <div className="notice" data-testid="card-statement">{cardStatementLine(card)}</div>}
      {edit && !v.links.length && cardLineOffers(r, props.books).map((o) => (
        <div className="notice" key={`${o.payment}-${o.index}`} data-testid="card-line-offer">
          <span>{t('receipts.cardLine.fits', { line: cardLineText(o, l.txByRef.get(o.payment)?.currency ?? baseCurrency()) })}</span>
          <a href="#" onClick={(e) => { e.preventDefault(); void linkCardLine(nav, v, o.payment, o.index, o.line.merchant); }}>{t('receipts.cardLine.link')}</a>
        </div>
      ))}
      {r.report?.held?.length ? <ReportHeld receipt={r.id} report={r.report} canEdit={canEdit} closedThrough={props.books.config?.closedThrough} said={(message, ok) => { if (ok) nav.refresh(); nav.toast(message); }} /> : null}
      <ReportCorrections receipt={r.id} books={props.books} canEdit={canEdit} said={(message) => { nav.refresh(); nav.toast(message); }} />
      {sheet
        ? <div className="notice" data-testid="balance-sheet-notice">{balanceSheetLine(sheet)}{' '}
          {sheet.opens && <a href="#" data-testid="balance-sheet-to-opening" onClick={(e) => { e.preventDefault(); nav.go({ route: { area: 'company', section: 'opening' }, query: {} }); }}>{t('reports.openingSet')}</a>}</div>
        : v.none && v.r.kind === 'supporting'
        ? <div className="notice" data-testid="supporting-notice">{t('receipts.supportingNotice', { what: v.noneWhy ? t(`receipts.why.${v.noneWhy}`) : t('receipts.why.supporting') })} {canEdit && <a href="#" onClick={(e) => { e.preventDefault(); runAct(props, 'mark'); }}>{t(markLabel(r))}</a>}</div>
        : v.none
        ? <div className="notice">{v.noneWhy ? t('receipts.noneNoticeWhy', { why: noneText(v) }) : t('receipts.noneNotice')} {canEdit && <a href="#" onClick={(e) => { e.preventDefault(); runAct(props, 'mark'); }}>{t('receipts.isReceipt')}</a>}</div>
        : busy && !v.links.length ? <div className="status"><Working proc={proc} nav={nav} view={view} /></div>
        : v.twin?.relation === 'duplicate' && !v.links.length ? null : <div className="status"><Status {...props} /></div>}
      {canEdit && r.kind === 'noise' && r.kindBy === 'human' && <SkipOffer receipt={r.id} nav={nav} />}

      <div className="body">
        <div className="desk">
          <QuestionsOn key={`q-${r.id}`} on={{ kind: 'receipt', id: r.id }} also={props.books.mappings.filter((m) => m.receiptId === r.id).map((m) => ({ kind: 'payment' as const, id: m.transactionRef }))} nav={nav} canEdit={props.canEdit} books={props.books} />
          <div className="paper real" role="button" tabIndex={0} aria-label={t('receipts.previewLarge')} onClick={() => setUi({ overlay: 'quick' })}>
            <Paper key={src} src={src} />
            <a className="dl float" href={src} download={r.filename} data-tip={t('receipts.downloadTitle', { file: r.filename })} onClick={(e) => e.stopPropagation()}>{I.dl}<span>{t('receipts.download')}</span></a>
          </div>
        </div>
        <aside className="margin" aria-label={t('receipts.details')}>
          {!v.none && <Payments {...props} edit={edit} working={busy ? proc : undefined} />}
          {!v.none && <Angaben {...props} edit={edit} working={busy} />}
          <Datei {...props} edit={edit} />
          <RunHistory on={{ kind: 'receipt', id: r.id }} books={props.books} nav={nav} period={props.query.period} />
          {r.remarks && !s.open.angaben && <div className="note">{r.remarks}</div>}
        </aside>
      </div>

      {s.overlay === 'link' && edit && <LinkDialog {...props} onClose={() => setUi({ overlay: null })} />}
      {s.overlay === 'quick' && <Quick src={src} file={r.filename} />}
      {s.overlay === 'delete' && edit && <ConfirmDelete {...props} />}
    </div>
  );
}

/** A booking without a payment in a toast (#89): its day, text and amount. */
const entryLine = (e: JournalEntry) => `${formatDate(e.date)} · ${e.description ?? e.transactionRef} · ${fmt(e.amount)}`;

/** A payment made by hand only this receipt holds: releasing it deletes the payment, as unlinking would leave it orphaned. */
const ownPrivate = (l: Ledger, tx: BankTransaction) => !byStatement(tx) && (l.receiptsByRef.get(tx.ref)?.length ?? 0) <= 1;

/** What the inbox's run is doing with the receipt now, in place of what it still lacks (#218): the person may still edit, and the run keeps what she enters. */
function Working({ proc, nav, view }: { proc: Processing; nav: Props['nav']; view: ReturnType<typeof useAutomation>['view'] }) {
  return (
    <span className="notice proc" style={{ margin: 0 }} data-testid="processing" data-tip={t('processing.tip')}>
      <span className="spin small" aria-hidden="true" />{processingText(proc, view)}
      {' '}<a href="#" onClick={(e) => { e.preventDefault(); nav.go({ route: { area: 'automation', view: 'run', run: proc.run }, query: {} }); }}>{t('processing.toRun')}</a>
    </span>
  );
}

/** The run that was working on the receipt stopped: the receipt needs the person, and the run says why (#218, #215). */
function StuckNotice({ proc, nav, view }: { proc: Extract<Processing, { kind: 'stuck' }>; nav: Props['nav']; view: ReturnType<typeof useAutomation>['view'] }) {
  const why = refusalText(proc.error, proc.why);
  return (
    <div className="notice warn" data-testid="processing-stuck">
      {I.dot}<span>{why ? t('processing.stuckWhy', { what: processingText(proc, view), why }) : processingText(proc, view)}</span>
      <a href="#" onClick={(e) => { e.preventDefault(); nav.go({ route: { area: 'automation', view: 'run', run: proc.run }, query: {} }); }}>{t('processing.toRun')}</a>
    </div>
  );
}

/**
 * An order page of the provider way (#253) needs no payment: its order waits for the provider's order
 * export, which the export holds back (to its receipt), or is booked from it (to the sale).
 */
function OrderPageNotice({ page, l, nav }: { page: OrderPage; l: Ledger; nav: Props['nav'] }) {
  const words = { provider: page.name, order: page.order };
  const { state } = page;
  const report = state.kind === 'held' ? l.byId.get(state.report) : undefined;
  const sale = state.kind === 'booked' ? l.entriesByRef.get(state.sale)?.[0] : undefined;
  return (
    <span className="notice" style={{ margin: 0 }} data-testid="order-page">
      {I.dot}{t(`receipts.orderPage.${state.kind}`, words)}
      {report && <> <button type="button" className="golink" onClick={() => nav.go(at({ area: 'receipts', id: report.r.id }, report.date))}>{t('receipts.orderPage.toReport')} <span className="arr">→</span></button></>}
      {sale && <> <button type="button" className="golink" onClick={() => nav.go(at({ area: 'journal', id: sale.id }, sale.date))}>{t('receipts.orderPage.toSale')} <span className="arr">→</span></button></>}
    </span>
  );
}

/**
 * A bill that proves a VAT-only correction (#190) needs no payment: its tax is booked once, on a
 * booking without a payment with a VAT-amount code. The notice names the booking that fits it, to
 * link, or says that it is still to be booked.
 */
function VatCorrectionNotice({ c, v, l, nav, canEdit }: { c: VatCorrection; v: ReceiptView; l: Ledger; nav: Props['nav']; canEdit: boolean }) {
  const entry = c.booking ? l.entriesByRef.get(c.booking)?.[0] : undefined;
  const vat = c.vat === undefined ? undefined : `${v.r.currency || baseCurrency()} ${fmt(Math.abs(c.vat))}`;
  // A copy of a bill whose input tax is booked (or is booked first, #458): never booked a second time; the notice leads to the original.
  const twin = c.twin ? l.byId.get(c.twin) : undefined;
  if (twin) return (
    <span className="notice" style={{ margin: 0 }} data-testid="vat-correction">
      {I.dot}{t('receipts.vatCorrection.twin', { business: c.name, name: twin.vendor || twin.r.filename })}
      {' '}<button type="button" className="golink" onClick={() => nav.go(at({ area: 'receipts', id: twin.r.id }, twin.date))}>{t('receipts.vatCorrection.toTwin')} <span className="arr">→</span></button>
    </span>
  );
  return (
    <span className="notice" style={{ margin: 0 }} data-testid="vat-correction">
      {I.dot}{t(entry ? 'receipts.vatCorrection.fits' : vat ? 'receipts.vatCorrection.book' : 'receipts.vatCorrection.noVat', { business: c.name, vat: vat ?? '', date: entry ? formatDate(entry.date) : '' })}
      {entry && <> <button type="button" className="golink" onClick={() => nav.go(at({ area: 'journal', id: entry.id }, entry.date))}>{t('receipts.vatCorrection.toEntry')} <span className="arr">→</span></button></>}
      {entry && canEdit && <> <button type="button" className="btn primary" data-testid="vat-correction-link" onClick={() => linkPayment(nav, v, entry.transactionRef, `${v.vendor} → ${formatDate(entry.date)} ${entry.description ?? ''}`.trim())}>{t('receipts.vatCorrection.link')}</button></>}
      {!entry && vat && canEdit && !v.locked && !withoutInputTax() && <> <button type="button" className="btn primary" data-testid="vat-correction-book" onClick={() => void bookVatCorrection(nav, v)}>{t('receipts.vatCorrection.bookIt')}</button></>}
    </span>
  );
}

function Status(props: Props & { v: ReceiptView; l: Ledger }) {
  const { v, l, nav, canEdit } = props;
  const { rates } = useFx();
  const sug = listed.suggestions.get(v.r.id);
  const fit = linkFit(v, l, chfOf(rates));
  if (v.links.length) {
    const ref = v.links[0];
    const tx = l.txByRef.get(ref);
    const more = v.links.length > 1 && <span className="mono"> +{v.links.length - 1}</span>;
    const entry = (l.entriesByRef.get(ref) ?? [])[0];
    const link = props.books.mappings.find((m) => m.receiptId === v.r.id && m.transactionRef === ref);
    const by = link && madeBy(link);
    // The bill of one line of a card's settlement (#409): which line.
    const line = cardLineOf(v.r, props.books);
    if (!tx) {
      return (
        <>
          <span className="linked">{I.check}
            {entry
              ? <button type="button" className="golink" data-testid="go-entry" onClick={() => nav.go(at({ area: 'journal', id: entry.id }, entry.date))}>{t('receipts.bookedNoPayment', { date: formatDate(entry.date) })}{more} <span className="arr">→</span></button>
              : <span>{t('receipts.linkedNoPayment', { ref })}{more}</span>}
          </span>
          {canEdit && !v.locked && entry && <button type="button" className="quiet" onClick={() => unlinkPayment(nav, v, ref, entryLine(entry))}>{t('receipts.unlink')}</button>}
        </>
      );
    }
    // A booking the app keeps (a person's, or one older than its record of receipts) is not booked again when a receipt comes late: the contradiction and the click show here (F13).
    const contradicts = (journalOf(props.books).byRef.get(ref) ?? []).find((x) => x.evidence);
    return (
      <>
        <span className="linked">{I.check}
          <button type="button" className="golink" data-testid="go-payment" data-tip={t('receipts.openPayment')} onClick={() => nav.go(at({ area: 'bank', payment: tx.ref }, tx.date))}>
            {t('receipts.payment')} <span className="mono">{formatDate(tx.date)}</span> · {bankOf(tx)} · <span className="mono">{amountOf(tx)}</span>{more} <span className="arr">{t('receipts.toStatement')}</span>
          </button>
        </span>
        {by && <span className="madeby" data-testid="made-by">{by}</span>}
        {entry && <button type="button" className="golink jl" data-testid="go-entry" data-tip={t('receipts.openEntry')} onClick={() => nav.go(at({ area: 'journal', id: entry.id }, entry.date))}>{t('receipts.entry')}</button>}
        {canEdit && !v.locked && (ownPrivate(l, tx)
          ? <button type="button" className="quiet" data-tip={t('receipts.undoPrivateTip')} onClick={() => undoPrivate(nav, v, tx, txLine(tx))}>{t('receipts.undoPrivate')}</button>
          : <button type="button" className="quiet" onClick={() => unlinkPayment(nav, v, tx.ref, txLine(tx), link?.line)}>{t('receipts.unlink')}</button>)}
        {line && line.payment === tx.ref && <span className="fitnote note" data-testid="card-line">{t('receipts.cardLine.bill', { line: cardLineText(line, tx.currency) })}</span>}
        {tx.businessPart && <span className="fitnote note" data-testid="business-part">{t('receipts.businessPartNotice', { what: tx.businessPart.what || t('receipts.privatePartUnnamed'), amount: `${tx.currency} ${fmt(Math.abs(tx.amount))}`, total: `${v.r.currency || baseCurrency()} ${fmt(Math.abs(v.r.amount ?? 0))}` })}</span>}
        {fit?.kind === 'off' && <span className="fitnote warn" data-testid="fit-off">{t('receipts.fitOffNotice', { amount: `${fit.currency} ${fmt(Math.abs(fit.diff))}` })}</span>}
        {fit?.kind === 'skonto' && <span className="fitnote note" data-testid="fit-skonto">{t('receipts.fitSkontoNotice', { percent: fit.percent })}</span>}
        {contradicts && (
          <span className="fitnote warn" data-testid="evidence">
            {evidenceText(contradicts.e, contradicts.evidence!)}{canEdit && <> <EvidenceFix e={contradicts.e} check={contradicts.evidence!} nav={nav} /></>}
          </span>
        )}
      </>
    );
  }
  // A receipt of a filed payment: the notice above says where its tax goes, not «Noch keine Zahlung».
  if (v.locked || (v.r.filedPayment && l.txByRef.has(v.r.filedPayment))) return null;
  if (v.orderPage) return <OrderPageNotice page={v.orderPage} l={l} nav={nav} />;
  if (v.vatCorrection) return <VatCorrectionNotice c={v.vatCorrection} v={v} l={l} nav={nav} canEdit={canEdit} />;
  const owner = ownerPays();
  // Why it reads as paid privately (#402): its words, or the owner's card and the receipt that showed it.
  const read = readsPaidPrivately(v, l);
  if (sug && canEdit) {
    const why = [t('receipts.whySameAmount'), sug.days !== undefined && dayText(sug.days)].filter(Boolean).join(' · ');
    return (
      <div className="sug" role="group" aria-label={t('receipts.suggestion')}>
        {I.spark}
        <div className="txt">{t('receipts.fitsPayment')} <b className="mono">{formatDate(sug.tx.date)}</b> · {bankOf(sug.tx)} · <b className="mono">{amountOf(sug.tx)}</b><div className="why">{why}</div></div>
        <button type="button" className="btn primary" data-accept onClick={() => accept(props, v, sug)}>{t('receipts.accept')} <span className="k">↵</span></button>
        <button type="button" className="btn ghost" onClick={() => runAct(props, 'link')}>{t('receipts.other')}</button>
      </div>
    );
  }
  // What may fit but no rule links (#397): a rounded amount, an undated receipt, two candidates; with what differs, one click to link.
  const near = canEdit ? offersInBooks(props.books, { receipt: v.r.id }, l.firm) : [];
  if (near.length) {
    return (
      <div className="findpair" role="group" aria-label={t('near.maybe')} data-testid="near-receipt">
        {!v.date && <span className="notice warn" style={{ margin: 0 }} data-testid="near-no-date">{I.dot}{t('receipts.near.noDate')} <button type="button" className="mono" style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 3 }} onClick={() => runAct(props, 'edit')}>E</button></span>}
        <NearList offers={near} from="receipt" books={props.books} nav={nav} onPick={(o) => { const tx = l.txByRef.get(o.payment); void linkPayment(nav, v, o.payment, `${v.vendor} → ${tx ? txLine(tx) : o.payment}`); }} />
        <button type="button" className="golink" onClick={() => runAct(props, 'link')}>{t('receipts.other')}</button>
      </div>
    );
  }
  if (!v.date) {
    return <span className="notice warn" style={{ margin: 0 }}>{I.dot}{t('receipts.noDateWarn')} {canEdit && <button type="button" className="mono" style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 3 }} onClick={() => runAct(props, 'edit')}>E</button>}</span>;
  }
  return (
    <span className="notice warn" style={{ margin: 0 }}>
      {I.dot}{t('receipts.noPayment')}
      {canEdit && <> <button type="button" style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 3 }} onClick={() => runAct(props, 'link')}>{t('receipts.linkVerb')}</button> <Kbd keys={['L']} tip={t('receipts.keyLinkTip')} /></>}
      {canEdit && <> · <FindPair key={v.r.id} on={{ receipt: v.r.id }} books={props.books} nav={nav} /></>}
      {/* Its words say cash or private (#216): a proposal beside the fact; the receipt is unpaid in the books until it is booked. */}
      {read && <> · <span data-testid="paid-privately">{!owner ? t('receipts.paidPrivatelyNotice')
        : read.by === 'card' ? t('receipts.paidPrivatelyCard', { card: read.card, date: read.seen.date ? formatDate(read.seen.date) : read.seen.file, account: `${owner.account} ${owner.label}` })
          : t('receipts.paidPrivatelyOwner', { account: `${owner.account} ${owner.label}` })}</span></>}
    </span>
  );
}

function Sec({ k, val, children }: { k: Section; val: ReactNode; children: ReactNode }) {
  const s = useUi();
  const open = s.open[k];
  return (
    <div className={`sec${open ? ' open' : ''}`} data-sec={k}>
      <button type="button" className="sum" aria-expanded={open} onClick={() => setUi({ open: { ...s.open, [k]: !open } })}>
        {I.chev}<span className="lbl">{t(`receipts.sec.${k}`)}</span><span className="val">{val}</span>
      </button>
      <div className="in"><div><div className="pad">{children}</div></div></div>
    </div>
  );
}

function Payments(props: Props & { v: ReceiptView; l: Ledger; edit: boolean; working?: Processing }) {
  const { v, l, nav, edit, working } = props;
  // Her own private payment the inbox run books with the AI (#402): no form with an empty account while a run is under way; «Selbst buchen» opens it.
  const ai = useAiState();
  const runs = useAutomation().view?.runs ?? [];
  const underWay = runs.some((r) => r.workflow === INTAKE_WORKFLOW && r.mode === 'live' && (r.status === 'queued' || r.status === 'running'));
  const [byHand, setByHand] = useState<string>();
  const one = v.links.length === 1 ? (l.txByRef.get(v.links[0])?.date ?? l.entriesByRef.get(v.links[0])?.[0]?.date) : undefined;
  const val = !v.links.length ? '—' : v.links.length === 1 ? (one ? formatDate(one) : '?') : t('receipts.nPayments', { n: v.links.length });
  return (
    <Sec k="zahlung" val={val}>
      {v.links.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12.5, padding: '4px 0 2px' }}>{working ? processingText(working) : v.orderPage ? t('receipts.orderPage.none') : t('receipts.noPaymentLinked')}</div>}
      {v.links.map((ref) => {
        const tx = l.txByRef.get(ref);
        if (!tx) {
          const e = l.entriesByRef.get(ref)?.[0];
          return (
            <div key={ref} className={`tx${e ? ' go' : ''}`} onClick={() => e && nav.go(at({ area: 'journal', id: e.id }, e.date))}>
              <span className="d">{e ? `${formatDate(e.date)} · ${t('receipts.booking')}` : ref}</span>
              <span className="am">{e ? fmt(e.amount) : ''}</span>
              <span className="tt">{e?.description ?? t('receipts.noBankPayment')}</span>
              {edit && e && <button type="button" className="un" onClick={(ev) => { ev.stopPropagation(); unlinkPayment(nav, v, ref, entryLine(e)); }}>{t('receipts.unlinkCap')}</button>}
            </div>
          );
        }
        const book = edit && !v.locked && tx.amount && !(l.entriesByRef.get(ref) ?? []).length;
        const booking = book && ownPrivate(l, tx) && ai === 'ready' && underWay && byHand !== ref;
        return (
          <Fragment key={ref}>
          <div className="tx go" data-tip={t('receipts.openPayment')} onClick={() => nav.go(at({ area: 'bank', payment: tx.ref }, tx.date))}>
            <span className="d">{formatDate(tx.date)} · {bankOf(tx)}</span>
            <span className="am">{amountOf(tx)}</span>
            <span className="tt">{tx.description}</span>
            {edit && (ownPrivate(l, tx)
              ? <button type="button" className="un" data-tip={t('receipts.undoPrivateTip')} onClick={(e) => { e.stopPropagation(); undoPrivate(nav, v, tx, txLine(tx)); }}>{t('receipts.undoPrivate')}</button>
              : <button type="button" className="un" onClick={(e) => { e.stopPropagation(); unlinkPayment(nav, v, ref, txLine(tx), props.books.mappings.find((m) => m.receiptId === v.r.id && m.transactionRef === ref)?.line); }}>{t('receipts.unlinkCap')}</button>)}
          </div>
          {booking ? (
            <p className="m" data-testid="private-booking">
              <span className="spin small" aria-hidden="true" /> {t('receipts.privateBooking')}{' '}
              <button type="button" className="quiet" onClick={() => setByHand(ref)}>{t('receipts.privateByHand')}</button>
            </p>
          ) : book ? <PaymentBooking books={props.books} nav={nav} payment={ref} narrow /> : null}
          </Fragment>
        );
      })}
      {edit && !v.orderPage && (
        <button type="button" className="addlink" onClick={() => runAct(props, 'link')}>
          {I.plus}{v.links.length ? t('receipts.morePayment') : t('receipts.linkPayment')} <Kbd keys={['L']} tip={t('receipts.keyLinkTip')} />
        </button>
      )}
    </Sec>
  );
}

const CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP'];
const parseAmount = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

function Angaben(props: Props & { v: ReceiptView; edit: boolean; working: boolean }) {
  const { v, nav, edit, canEdit, working } = props;
  // While a run still reads the receipt, an empty field says so instead of asking to be filled (#218).
  const reading = working ? t('processing.field') : undefined;
  // A receipt of a filed period keeps its amount, VAT and file; its date and words may still change.
  const frozen = v.locked ? t('receipts.frozenField') : undefined;
  const { r } = v;
  const s = useUi();
  const form = useRef<HTMLFormElement>(null);
  const [err, setErr] = useState('');
  const currencies = useMemo(() => [...new Set([...CURRENCIES, r.currency || baseCurrency()])], [r.currency]);

  useEffect(() => {
    if (!s.open.angaben || !s.focus) return;
    form.current?.querySelector<HTMLInputElement>(`[name="${s.focus}"]`)?.focus();
    setUi({ focus: undefined });
  }, [s.open.angaben, s.focus]);

  function field(name: string): HTMLInputElement | null {
    return form.current?.querySelector<HTMLInputElement>(`[name="${name}"]`) ?? null;
  }

  useBookedFields(form, {
    filename: r.filename, date: r.date ? formatDate(r.date) : '', amount: r.amount == null ? '' : fmt(r.amount),
    description: r.description ?? '', remarks: r.remarks ?? '', currency: r.currency || baseCurrency(),
  });

  // Every field is saved on its own: one that is wrong is reported, the others still save.
  function save() {
    if (!canEdit || !form.current) return;
    const f = Object.fromEntries(new FormData(form.current)) as Record<string, string>;
    const date = f.date.trim() ? parseSwissDate(f.date) : null;
    const dateWrong = !!f.date.trim() && !date;
    const amount = f.amount.trim() ? parseAmount(f.amount) : null;
    const amountWrong = !!f.amount.trim() && amount == null;
    setErr(dateWrong ? t('receipts.errDate') : amountWrong ? t('receipts.errAmount') : '');
    if (dateWrong || amountWrong) nav.dismissToast();
    const changed: Field[] = [];
    const patch: Parameters<typeof saveFields>[2] = {};
    const filename = f.filename.trim() || r.filename;
    if (filename !== r.filename) { patch.filename = filename; changed.push('filename'); }
    if (!dateWrong && (date ?? undefined) !== r.date) { patch.date = date; changed.push('date'); }
    const cur = f.currency || r.currency || baseCurrency();
    if (!amountWrong && ((amount ?? undefined) !== r.amount || (amount != null && cur !== (r.currency || baseCurrency())))) {
      if (amount == null) patch.amount = null;
      else { patch.amount = amount; patch.currency = cur; }
      if ((amount ?? undefined) !== r.amount) changed.push('amount');
      if (amount != null && cur !== (r.currency || baseCurrency())) changed.push('currency');
    }
    if (f.description !== (r.description ?? '')) { patch.description = f.description; changed.push('description'); }
    if (f.remarks !== (r.remarks ?? '')) { patch.remarks = f.remarks; changed.push('remarks'); }
    if (date) { const el = field('date'); if (el) el.value = formatDate(date); }
    if (amount != null) { const el = field('amount'); if (el) el.value = fmt(amount); }
    if (changed.length) saveFields(nav, v, patch, changed);
  }

  return (
    <Sec k="angaben" val={edit ? t('receipts.editable') : canEdit ? t('receipts.partlyEditable') : t('receipts.readOnly')}>
      <form
        ref={form}
        className="form"
        autoComplete="off"
        onSubmit={(e) => { e.preventDefault(); save(); }}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') { e.preventDefault(); save(); } }}
      >
        <label>{t('receipts.field.filename')}<input className="mono" name="filename" defaultValue={r.filename} readOnly={!edit} data-tip={frozen} style={{ fontSize: 12 }} /></label>
        <label>{t('receipts.field.date')}<input className="mono" name="date" defaultValue={r.date ? formatDate(r.date) : ''} placeholder={reading ?? t('receipts.datePlaceholder')} readOnly={!canEdit} /></label>
        {r.dateSource === 'captured' && <div className="fhint">{t('receipts.dateCaptured')}</div>}
        <div className="two">
          <label>{t('receipts.field.currency')}<select name="currency" defaultValue={r.currency || baseCurrency()} disabled={!edit} data-tip={frozen}>{currencies.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label>{t('receipts.field.amount')}<input className="mono" name="amount" defaultValue={r.amount == null ? '' : fmt(r.amount)} readOnly={!edit} data-tip={frozen} placeholder={reading} style={{ textAlign: 'right' }} /></label>
        </div>
        {withoutInputTax() !== 'none' ? <VatFields v={v} nav={nav} edit={edit} title={frozen} /> : null}
        <label>{t('receipts.field.description')}<input name="description" defaultValue={r.description ?? ''} readOnly={!canEdit} placeholder={reading} /></label>
        <label>{t('receipts.field.remarks')}<textarea name="remarks" defaultValue={r.remarks ?? ''} readOnly={!canEdit} placeholder={t('receipts.remarksPlaceholder')} /></label>
        <div className="err" role="alert">{err}</div>
        {canEdit && <div className="fhint">{t('receipts.saveHint')}</div>}
      </form>
    </Sec>
  );
}

/**
 * The runs behind a receipt: the one that took it up (stamped on it, or, for a receipt taken up
 * before that, the run its file arrived with) and the ones that linked it to a payment.
 */
function runsOf(r: Receipt, books: Props['books'], view: ReturnType<typeof useAutomation>['view']): RunSummary[] {
  const ids = [
    r.run ?? view?.runs.find((x) => x.arrived?.some((a) => a.kind === 'receipt' && a.id === r.id))?.id,
    ...books.mappings.filter((m) => m.receiptId === r.id).map((m) => m.run),
  ].filter((id): id is string => !!id);
  return [...new Set(ids)].map((id) => view?.runs.find((x) => x.id === id)).filter((x): x is RunSummary => !!x);
}

function Datei(props: Props & { v: ReceiptView; edit: boolean }) {
  const { v, nav, edit, canEdit, books } = props;
  const { r } = v;
  const { view } = useAutomation();
  const runs = runsOf(r, books, view);
  const kb = `${Math.max(1, Math.round(r.fileSize / 1024))} KB`;
  const aiOff = useAiOff();
  const noAi = useNoAi();
  return (
    <Sec k="datei" val={kb}>
      <dl className="kv">
        <dt>{t('receipts.origin')}</dt><dd>{r.location === 'staged' ? t('receipts.originInbox') : t('receipts.originArchive')}</dd>
        {runs.length ? <><dt>{t('receipts.run')}</dt><dd>{runs.map((x) => {
          const w = view?.workflows.find((y) => y.id === x.workflow);
          return <button key={x.id} type="button" className="linkbtn" style={{ display: 'block', textAlign: 'left', padding: 0 }} onClick={() => nav.go({ route: { area: 'automation', view: 'run', run: x.id }, query: {} })}>{w ? textIn(w.label, language()) : x.workflow} · {formatDate(x.startedAt.slice(0, 10))} {new Date(x.startedAt).toTimeString().slice(0, 5)} →</button>;
        })}</dd></> : null}
        <dt>{t('receipts.file')}</dt><dd className="mono" style={{ fontSize: 11.5 }} data-tip={r.filename}>{r.filename}</dd>
        <dt>{t('receipts.size')}</dt><dd className="mono">{kb}</dd>
        <dt>{t('receipts.sha')}</dt><dd className="mono" style={{ fontSize: 11.5 }}>{r.id}…</dd>
      </dl>
      <div className="ocr" aria-label={t('receipts.text')}>{r.extractedText.slice(0, 1500) || t(waitsForReading(r) ? (noAi ? 'receipts.noTextNoAi' : 'receipts.noTextNotRead') : 'receipts.noText')}</div>
      {canEdit && (
        <div className="dangers">
          {v.none
            // A document beside an invoice has its action once, in its notice above (#398).
            ? r.kind === 'supporting' ? null : <button type="button" onClick={() => runAct(props, 'mark')}>{t('receipts.isReceipt')}</button>
            : <>
                {edit && <button type="button" disabled={aiOff} data-tip={t(aiOff ? 'receipts.readAgainOff' : 'receipts.readAgainTip')} onClick={() => readAgain(nav, v)}>{t('receipts.readAgain')}</button>}
                <button type="button" onClick={() => runAct(props, 'notreceipt')}>{t('receipts.notReceipt')}</button>
              </>}
          {edit && <button type="button" className="del" onClick={() => runAct(props, 'del')}>{t('common.delete')}</button>}
        </div>
      )}
    </Sec>
  );
}

function Quick({ src, file }: { src: string; file: string }) {
  // On the body, not in the detail: a column's animation or stacking never puts the dock or the bar above it (#387 review).
  return createPortal(
    <div className="quick" role="dialog" aria-label={t('receipts.previewOf', { file })} onClick={() => setUi({ overlay: null })}>
      <span className="cap mono" onClick={(e) => e.stopPropagation()}>
        {t('receipts.quickCap', { file })}
        <a className="dl inline" href={src} download={file}>{I.dl}<span>{t('receipts.download')}</span></a>
      </span>
      <div className="paper real" style={{ width: '70vw' }}><Paper key={src} src={src} maxWidth={1100} /></div>
    </div>,
    document.body,
  );
}

function ConfirmDelete({ v, l, nav }: Props & { v: ReceiptView; l: Ledger }) {
  const close = () => setUi({ overlay: null });
  // What happens to its payment: booked again without it, or a person's booking kept as it is (r4c-32).
  const entries = v.links.flatMap((ref) => l.entriesByRef.get(ref) ?? []);
  const text = !v.links.length ? 'receipts.deleteTextAlone' : entries.length && entries.every((e) => e.origin === 'manual') ? 'receipts.deleteTextKept' : 'receipts.deleteText';
  async function run() {
    close();
    const i = listed.ids.indexOf(v.r.id);
    const next = listed.ids[i + 1] ?? listed.ids[i - 1];
    if (await deleteReceipt(nav, v)) nav.select({ area: 'receipts', ...(next && { id: next }) });
  }
  return (
    <>
      <div className="scrim" style={{ background: 'color-mix(in srgb, var(--bg) 40%, transparent)' }} onClick={close} />
      <div className="palette confirm" role="alertdialog" aria-label={t('receipts.deleteTitle')}>
        <h2>{t('receipts.deleteTitle')}</h2>
        <p>{t(text)}</p>
        <div className="file">{v.r.filename}</div>
        <div className="acts">
          <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')} <span className="k">{t('receipts.escKey')}</span></button>
          <button type="button" className="btn danger" autoFocus onClick={run}>{t('common.delete')} <span className="k">↵</span></button>
        </div>
      </div>
    </>
  );
}

