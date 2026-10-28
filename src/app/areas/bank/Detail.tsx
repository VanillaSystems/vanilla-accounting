/**
 * One statement: the bank's balances and whether its payments add up to them, the ledger's
 * balance beside the bank's, the PDF with the chosen payment's line marked, and in the margin its
 * payments, the exchange rates its foreign entries were booked at, and its file. A month without
 * its statement shows where to add it.
 */
import { byStatement, madeByHand } from '../../../workspace/money-accounts.js';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BankTransaction } from '../../../types/index.js';
import type { PayoutWaitView } from '../../../types/drop.js';
import { ratesUsed } from '../../../accounting/fx-conversion.js';
import type { RouteOf } from '../../shell/route.js';
import { api, sources } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { monthName } from '../../lib/period-label.js';
import { useFx } from '../../hooks/use-fx.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { checkText } from '../../lib/fx-text.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { I } from '../receipts/icons.js';
import { isCamt, matches, payHaystack, payText, signed, type Bank, type Statement } from './model.js';
import { bankFor, setUi, useUi, type Section } from './state.js';
import { importStatements, linkReceiptSet, pickStatements, removeStatement, setNote, setNoReceipt } from './actions.js';
import type { ReceiptSet, SetCut } from '../../../intake/receipt-sets.js';
import { at } from '../receipts/view.js';
import { FindPair, madeBy } from '../receipts/FindPair.js';
import { StatementPaper, type Mark } from './StatementPaper.js';
import { Parts } from './Parts.js';
import { FileDetail } from './FileDetail.js';
import { RunHistory } from '../../history/RunHistory.js';
import { baseCurrency } from '../../../engines/index.js';
import { localToday } from '../../../accounting/periods.js';
import { linkedOf, receiptState, type Linked } from '../../../accounting/receipt-due.js';
import { WorkflowButtons } from '../../automation/marks.js';
import { useAutomation } from '../../automation/store.js';
import { processingText } from '../../automation/processing.js';
import { bookingRun, type Processing } from '../../../workflows/processing.js';
import { AskAi } from '../../assistant/AskAi.js';
import { salesWithoutVat } from '../../../accounting/sales-without-vat.js';
import { intakeAdd } from '../receipts/intake.js';
import { PaymentBooking } from '../journal/PaymentBooking.js';
import { useInvoices } from '../invoices/data.js';
import { linkableInvoices } from '../invoices/model.js';
import { confirmPayment } from '../invoices/actions.js';
import { openAmount } from '../../../invoices/rules.js';
import { QuestionsOn } from '../../questions/Questions.js';
import { bookDiffParts, missingOpenings } from '../../../accounting/opening-balance.js';
import { GroupedOffer } from '../company/RulesSection.js';
import { Pick } from '../../selection/Pick.js';
import { ActionsMenu } from '../../selection/ActionsMenu.js';
import { paymentActions } from './actions-menu.js';
import { NoMovements, PdfQuestion, UnmatchedNotice, pdfOf, statementActions } from './PdfQuestion.js';
import { SelectionView } from '../../selection/SelectionView.js';
import { paymentRows } from '../../selection/rows.js';
import { clickRow, useSelection, useShown } from '../../selection/store.js';

type Props = AreaProps<RouteOf<'bank'>>;

/** "September 2026" for a calendar month, else its days. */
export const statementName = (s: Statement) =>
  s.from.slice(8) === '01' && s.to.slice(0, 7) === s.from.slice(0, 7) && Number(s.to.slice(8)) >= 28 ? monthName(s.from) : `${formatDate(s.from)} – ${formatDate(s.to)}`;

export function Detail(props: Props) {
  const ws = useWorkspace();
  const b = bankFor(props.books, ws?.bankAccounts);
  if (props.route.file) {
    const f = b.fileByKey(props.route.file);
    return f ? <FileDetail key={f.key} f={f} nav={props.nav} /> : <div className="detail-empty"><div>{!ws ? '' : t('bank.fileGone', { key: props.route.file })}</div></div>;
  }
  const s = props.route.statement ? b.byKey(props.route.statement) : undefined;
  if (!s) return <div className="detail-empty"><div>{!ws ? '' : props.route.statement ? t('bank.statementGone', { key: props.route.statement }) : t('bank.noneChosen')}</div></div>;
  return <StatementDetail key={s.key} {...props} b={b} s={s} />;
}

/** An amount with its direction: money in gets a +. */
const Amount = ({ tx }: { tx: BankTransaction }) => {
  const n = signed(tx);
  return n > 0 ? <span className="inc">+{fmt(n)}</span> : <>{fmt(-n)}</>;
};

/**
 * The books off the bank's closing balance: a missing opening balance is named as on the Bilanz,
 * with the way to enter it, and only what it leaves unexplained is blamed on a payment (r4c-33).
 */
function BookDiff({ books, nav, diff, s }: Props & { diff: number; s: Statement }) {
  const ws = useWorkspace();
  const { opening: missing, rest } = bookDiffParts(diff, ws ? missingOpenings(books, ws.bankAccounts, s.to.slice(0, 4)).find((m) => m.account === s.account.account) : undefined);
  return (
    <div className="status">
      {missing ? (
        <span className="notice warn" style={{ margin: 0 }} data-testid="opening-missing">{I.dot}
          {t('reports.openingMissing', { account: `${missing.account} ${missing.label}`, year: missing.year, amount: fmt(missing.amount) })}{' '}
          {missing.canType && <a href="#" onClick={(e) => { e.preventDefault(); nav.go({ route: { area: 'company', section: 'opening' }, query: {} }); }}>{t('reports.openingSet')}</a>}
        </span>
      ) : null}
      {rest ? <span className="notice warn" style={{ margin: 0 }}>{I.dot}{t('bank.bookDiff', { diff: fmt(rest) })}</span> : null}
    </div>
  );
}

function StatementDetail(props: Props & { b: Bank; s: Statement }) {
  const { b, s, route, query, nav, canEdit } = props;
  const ui = useUi();
  const [page, setPage] = useState('');
  const all = b.payments(s);
  const [onlyUnbooked, setOnlyUnbooked] = useState(false);
  const booking = !!bookingRun(useAutomation().view?.runs ?? []);
  const nUnbooked = all.filter(b.unbooked).length;
  const pays = onlyUnbooked && nUnbooked ? all.filter(b.unbooked) : all;
  const tx = route.payment ? all.find((p) => p.ref === route.payment) : undefined;
  const c = s.file ? b.check(s) : undefined;
  const closed = !!b.closedThrough && s.to <= b.closedThrough;
  const file = s.file && sources.statement(s.file.bank, s.file.filename);
  const camt = !!s.file && isCamt(s.file);
  const src = camt ? undefined : file;
  // A month with no paper of its own (none, or the bank's XML) shows the statement filed among the receipts.
  const filedPaper = !src && s.receipts?.[0];
  const wise = s.account.statements === 'wise';
  const mark: Mark | undefined = tx && { tx, fee: b.feeOf(tx.ref), wise };
  const choose = (ref: string | undefined) => nav.select({ area: 'bank', statement: s.key, ...(ref && { payment: ref }) });
  const words = useMemo(() => {
    const byId = new Map(props.books.receipts.map((r) => [r.id, `${r.description ?? ''} ${r.filename}`]));
    return (ref: string) => b.receiptsOf(ref).map((id) => byId.get(id) ?? '').join(' ');
  }, [props.books, b]);
  // The payments shown: the search dims the others, so ⌘A and a ⇧-range take only the hits (#216).
  const hits = pays.filter((p) => !query.q || matches(payHaystack(p, words(p.ref)), query.q));
  const picked = useSelection('payment');
  useShown('payment', hits.map((p) => p.ref));
  const pickedRefs = new Set(picked?.ids);
  // A statement PDF's question kept in the books (#254), and a PDF that brought no movement.
  const pdf = pdfOf(s);
  const ask = pdf ? props.books.statementAsks?.find((a) => a.file === pdf) : undefined;
  const edit = canEdit && !closed;
  // The movements read from PDFs that this bank export or CSV does not hold (#254): it lists them nowhere else.
  const own = s.file ? `${s.file.bank}/${s.file.filename}` : undefined;
  const unmatched = own ? props.books.transactions.filter((t) => t.unmatched?.by === own && t.ref !== tx?.ref) : [];

  return (
    <div className="detail-in" data-for={s.key}>
      <div className="head">
        <h2 className="who">{t('bank.statementOf', { name: statementName(s) })}<small>{s.account.label} · {formatDate(s.from)} – {formatDate(s.to)}</small></h2>
        {c?.close != null && <div className="amount"><small>{s.account.currency}</small>{fmt(c.close)}</div>}
      </div>
      {c && (
        <div className="facts">
          <span data-tip={t('bank.openTip')}>{t('bank.open', { amount: c.open == null ? '?' : fmt(c.open) })}</span>
          <span data-tip={t('bank.incTip')}>+ {fmt(c.inc)}</span>
          <span data-tip={t('bank.outTip')}>− {fmt(c.out)}</span>
          <span data-tip={t('bank.closeTip')}>{t('bank.close', { amount: c.close == null ? '?' : fmt(c.close) })}</span>
          <span data-tip={t('bank.bookTip')} className={c.bookDiff ? 'nov' : undefined}>{t('bank.book', { amount: fmt(c.book) })}</span>
        </div>
      )}
      <div className="status">
        {!s.file ? (
          s.running
            ? <span className="notice" style={{ margin: 0 }}>{t('bank.runningNotice')}</span>
            : s.missing
              ? <span className="notice warn" style={{ margin: 0 }} data-testid="missing-notice">{I.dot}{t('bank.missingNotice')}</span>
              : <span className="notice" style={{ margin: 0 }} data-testid="without-notice">{t('bank.withoutNotice', { amount: `${s.account.currency} ${fmt(b.check(s).book)}` })}</span>
        ) : pdf && !all.length && !ask ? (
          <NoMovements s={s} nav={nav} edit={edit} />
        ) : c!.gap ? (
          <span className="notice warn" style={{ margin: 0 }} data-testid="statement-gap">{I.dot}{t('bank.gap', { from: formatDate(c!.gap.from), to: formatDate(c!.gap.to), bank: fmt(c!.gap.bank), open: fmt(c!.gap.open), diff: fmt(c!.gap.diff) })}</span>
        ) : c!.ok ? (
          <span className="linked">{I.check}{t('bank.checkOk', { n: c!.n })}</span>
        ) : c!.diff == null ? (
          <span className="notice" style={{ margin: 0 }}>{c!.close == null ? t('bank.noClose') : t('bank.noOpen')}</span>
        ) : (
          <span className="notice warn" style={{ margin: 0 }}>{I.dot}{t('bank.checkDiff', { diff: fmt(c!.diff) })}</span>
        )}
      </div>
      {s.receipts?.map((x) => (
        <div key={x.id} className="status">
          <button type="button" className="golink" data-testid="statement-receipt" onClick={() => nav.go(at({ area: 'receipts', id: x.id }, x.to, query.period))}>
            {t('bank.receiptStatementLink', { filename: x.filename })} <span className="arr">→</span>
          </button>
        </div>
      ))}
      {c?.bookDiff && !c.gap ? <BookDiff {...props} diff={c.bookDiff} s={s} /> : null}
      {ask ? <PdfQuestion key={ask.file} ask={ask} nav={nav} edit={edit} /> : null}
      {tx?.unmatched ? <UnmatchedNotice key={`u-${tx.ref}`} tx={tx} nav={nav} edit={edit} /> : null}
      {unmatched.map((u) => <UnmatchedNotice key={`u-${u.ref}`} tx={u} nav={nav} edit={edit} named />)}

      <div className="body">
        <div className="desk">
          {picked ? <PickedPayments {...props} ids={picked.ids} /> : <>
          {(file || tx) && (
            <div className="src paybar">
              <span><PayBar {...props} tx={tx} closed={closed} onClear={() => choose(undefined)} /></span>
              {tx && !closed ? <WorkflowButtons kind="transaction" id={tx.ref} facts={[b.unbooked(tx) ? 'unbooked' : 'booked']} nav={nav} canEdit={canEdit} /> : null}
              {tx ? <ActionsMenu set={paymentActions(props as AreaProps, b, tx, closed)} /> : <ActionsMenu set={statementActions(nav, s, ask, edit)} />}
              {tx ? <AskAi context={{ kind: 'payment', id: tx.ref, label: tx.description ?? tx.ref }} /> : null}
              {src && <span className="pgno">{page}</span>}
              {file && <a className="dl inline" href={file} download={s.file!.filename} data-tip={t('bank.downloadTitle', { file: s.file!.filename })}>{I.dl}<span>{t('receipts.download')}</span></a>}
            </div>
          )}
          {tx && canEdit && !closed && tx.amount && b.unbooked(tx) ? <PaymentBooking key={tx.ref} books={props.books} nav={nav} payment={tx.ref} /> : null}
          {tx ? <QuestionsOn key={`q-${tx.ref}`} on={{ kind: 'payment', id: tx.ref }} also={[...b.receiptsOf(tx.ref).map((id) => ({ kind: 'receipt' as const, id })), ...b.entriesOf(tx.ref).map((e) => ({ kind: 'entry' as const, id: e.id }))]} nav={nav} canEdit={canEdit} books={props.books} /> : null}
          {tx ? <RunHistory key={`h-${tx.ref}`} on={{ kind: 'payment', id: tx.ref }} books={props.books} nav={nav} period={query.period} /> : null}
          {src ? (
            <div className="paper real stmt" role="button" tabIndex={0} aria-label={t('bank.openLarge')} onClick={() => setUi({ overlay: 'quick' })}>
              <StatementPaper src={src} mark={mark} onPage={setPage} scroller={(el) => el.closest('.detail')} />
            </div>
          ) : (
            <>
              {camt && <div className="notice" data-testid="camt-notice">{t('bank.camtNotice', { from: formatDate(s.file!.fromDate), to: formatDate(s.file!.toDate) })}</div>}
              {filedPaper && (
                <div className="paper real stmt" data-testid="statement-receipt-paper">
                  <StatementPaper key={filedPaper.id} src={sources.receipt(filedPaper.id)} scroller={(el) => el.closest('.detail')} />
                </div>
              )}
              {!camt && !s.running && s.account.statements && canEdit && !closed ? (
                <button type="button" className="well" style={{ width: '100%', maxWidth: 640 }} onClick={() => pickStatements((files) => importStatements(files, nav, { account: s.account, month: s.from.slice(0, 7) }))}>
                  <span><b>{t('bank.well')}</b>{t('bank.wellFor', { bank: s.account.bank })}</span>
                </button>
              ) : null}
            </>
          )}
          </>}
        </div>
        <aside className="margin" aria-label={t('receipts.details')}>
          {pays.length > 0 && (
            <Sec k="zahlungen" label={t('bank.sec.zahlungen')} val={String(pays.length)}>
              {nUnbooked > 0 && (
                <button type="button" className={`linkbtn zfilter${onlyUnbooked ? ' on' : ''}`} aria-pressed={onlyUnbooked} data-testid="only-unbooked" onClick={() => setOnlyUnbooked(!onlyUnbooked)}>
                  {onlyUnbooked ? t('bank.showAllPayments', { n: all.length }) : t('bank.onlyUnbooked', { n: nUnbooked })}
                </button>
              )}
              <div className={`paylist${picked ? ' picking' : ''}`} role="listbox" aria-multiselectable="true" aria-label={t('bank.paymentsOf')}>
                {pays.map((p) => {
                  const hit = hits.includes(p);
                  const on = !picked && p.ref === tx?.ref;
                  const isPicked = pickedRefs.has(p.ref);
                  return (
                    <button key={p.ref} type="button" className={`pay${on ? ' on' : ''}${isPicked ? ' picked' : ''}${hit ? '' : ' dim'}`} role="option" aria-selected={on || isPicked} data-pay={p.ref}
                      onClick={(e) => clickRow(e, 'payment', p.ref, tx?.ref, (ref) => choose(ref === tx?.ref ? undefined : ref), nav.toast)}>
                      <Pick kind="payment" id={p.ref} on={isPicked} label={payText(p).name} toast={nav.toast} />
                      <span className="d">{p.date.slice(8)}.{p.date.slice(5, 7)}.</span>
                      <span className="t">{b.needsReceipt(p) && I.dot}{payText(p).name}{b.unbooked(p) && (booking && !p.waitsForPerson
                        ? <span className="nb m" data-testid="booking-mark" data-tip={t('bank.bookingTip')}>{t('bank.bookingMark')}</span>
                        : <span className="nb" data-tip={t('bank.notBooked')}>{t('bank.unbookedMark')}</span>)}
                        {madeByHand(p) && <span className="hm" data-testid="by-hand" data-tip={t(byStatement(p) ? 'bank.byHandConfirmedTip' : 'bank.byHandTip')}>{t(byStatement(p) ? 'bank.byHandConfirmed' : 'bank.byHand')}</span>}</span>
                      <span className="a"><Amount tx={p} /></span>
                    </button>
                  );
                })}
              </div>
            </Sec>
          )}
          {s.account.currency !== baseCurrency() && <Rates b={b} pays={all} />}
          {s.file && (
            <Sec k="datei" label={t('bank.sec.datei')} val="">
              <dl className="kv">
                <dt>{t('bank.statement')}</dt><dd className="mono" style={{ fontSize: 11.5 }} data-tip={s.file.filename}>{s.file.filename}</dd>
                <dt>{t('bank.account')}</dt><dd className="mono">{s.account.account}</dd>
              </dl>
              {canEdit && !closed ? <button type="button" className="linkbtn" data-testid="remove-statement" data-tip={t('bank.removeStatementTip')} onClick={() => void removeStatement(nav, s)}>{t('bank.removeStatement')}</button> : null}
            </Sec>
          )}
        </aside>
      </div>
      {ui.overlay === 'quick' && src && <Quick src={src} file={s.file!.filename} mark={mark} />}
    </div>
  );
}

/** The picked payments in place of the paper (#216): the list beside it stays, so more can be picked. */
function PickedPayments({ books, nav, canEdit, ids }: Props & { ids: readonly string[] }) {
  const { rates } = useFx();
  return <SelectionView kind="payment" rows={paymentRows(books, ids, rates)} books={books} nav={nav} canEdit={canEdit} />;
}

/** The chosen payment in one line: its receipt, its entry, what is missing; a hint while none is chosen. */
function PayBar(props: Props & { b: Bank; tx?: BankTransaction; closed: boolean; onClear(): void }) {
  const { b, tx, nav, canEdit, closed, onClear } = props;
  const vatRegistered = useWorkspace()?.company.vat.registered ?? true;
  if (!tx) return <span className="payhint">{t('bank.payHint')}</span>;
  const receipts = b.receiptsOf(tx.ref);
  const entries = b.entriesOf(tx.ref);
  const entry = entries[0];
  // Every line of a split, not only the first (r9k-6).
  const lines = entries.map((e) => `${e.accountDebit || '–'} / ${e.accountCredit || '–'}${entries.length > 1 ? ` ${fmt(e.amount)}` : ''}`).join(' + ');
  const fee = b.feeOf(tx.ref);
  const first = receipts[0] ? b.receiptOf(receipts[0]) : undefined;
  const edit = canEdit && !closed;
  const saleWithoutVat = salesWithoutVat({ ...props.books, transactions: [tx] }, vatRegistered).length > 0;
  return (
    <>
      <b className="mono">{formatDate(tx.date)}</b> {payText(tx).name}{payText(tx).note && <small> {payText(tx).note}</small>} <span className="mono"><Amount tx={tx} /></span>
      {fee && <> · {t('bank.fee', { amount: fmt(Math.abs(fee.amount)) })}</>}
      {receipts.length > 0 ? (
        <> · <button type="button" className="golink" data-testid="go-receipt" data-tip={t('bank.openReceipt')} onClick={() => nav.go(at({ area: 'receipts', id: receipts[0] }, first?.date ?? tx.date))}>
          {t('bank.receipt', { name: first?.name ?? receipts[0] })}{receipts.length > 1 && ` +${receipts.length - 1}`}
        </button>{receipts.length === 1 && madeByOf(props.books, receipts[0], tx.ref) ? <small className="madeby" data-testid="made-by"> {madeByOf(props.books, receipts[0], tx.ref)}</small> : null}</>
      ) : tx.inputTaxProof ? (
        <> · <span data-testid="input-tax-proof">{t('bank.inputTaxProof', { text: tx.inputTaxProof.text })}</span></>
      ) : saleWithoutVat ? (
        <> · <span className="wn" data-testid="sale-without-vat">{t('bank.saleNoVat')}</span>{edit && <>
          {' '}<button type="button" className="golink" data-tip={t('bank.uploadInvoiceTip')} onClick={() => intakeAdd.run(props)}>{t('bank.uploadInvoice')}</button>
          {' · '}<button type="button" className="golink" data-tip={t('bank.noVatTip')} onClick={() => setNoReceipt(nav, tx, true)}>{t('bank.noVat')}</button>
        </>}</>
      ) : b.needsReceipt(tx) ? (
        <> · <span className="wn">{t('bank.noReceipt')}</span>{edit && <> <button type="button" className="golink" onClick={() => setNoReceipt(nav, tx, true)}>{t('bank.noReceiptNeeded')}</button> · <FindPair key={tx.ref} on={{ payment: tx.ref }} books={props.books} nav={nav} compact /></>}</>
      ) : tx.noReceiptNeeded ? (
        <> · {t('bank.noReceiptNotNeeded')}{edit && <> <button type="button" className="golink" data-tip={t('bank.resetTip')} onClick={() => setNoReceipt(nav, tx, false)}>{t('bank.reset')}</button></>}</>
      ) : null}
      {entry ? (
        <> · <button type="button" className="golink" data-testid="go-entry" data-tip={t('bank.openEntry')} onClick={() => nav.go(at({ area: 'journal', id: entry.id }, entry.date))}>
          {t('bank.entries', { lines })}
        </button></>
      ) : tx.amount ? <> · <NotBooked tx={tx} linked={linkedOf(props.books.receipts.filter((r) => receipts.includes(r.id) && r.kind !== 'duplicate'))} />{edit && tx.direction === 'CRDT' ? <PayoutWait key={`pw-${tx.ref}`} books={props.books} tx={tx} /> : null}</> : null}
      {edit ? <ReceiptSetOffer key={`rs-${tx.ref}`} {...props} tx={tx} /> : null}
      {edit && receipts.length > 1 ? <GroupedOffer key={`go-${tx.ref}`} payment={tx.ref} onRules={() => nav.go({ route: { area: 'company', section: 'rules' }, query: {} })} /> : null}
      <Note key={tx.ref} tx={tx} nav={nav} edit={edit} />
      {edit && tx.direction === 'CRDT' ? <LinkInvoice key={`li-${tx.ref}`} tx={tx} nav={nav} /> : null}
      {' '}<button type="button" className="x" aria-label={t('bank.clear')} onClick={onClear}>×</button>
      <Parts tx={tx} />
    </>
  );
}

/** Who made the link of a receipt and a payment, said plainly (#187). */
const madeByOf = (books: Props['books'], receipt: string, payment: string): string | undefined => {
  const m = books.mappings.find((x) => x.receiptId === receipt && x.transactionRef === payment);
  return m && madeBy(m);
};

/** At most this many sets are offered on one payment. */
const SETS_SHOWN = 3;

/**
 * Receipts that add up to the payment, or nearly (#27): code proposes them, the person links them in
 * one click. Several sets that fit are each offered with their receipts named, so the person picks.
 */
function ReceiptSetOffer({ books, b, tx, nav }: Props & { b: Bank; tx: BankTransaction }) {
  // The server proposes: it knows the batch payers of the business files and the official daily rates (GET /api/transactions/:ref/receipt-sets).
  // Keyed by the payment (key={`rs-${tx.ref}`}): another payment starts empty, never with this one's sets to link.
  const [found, setFound] = useState<{ sets: ReceiptSet[]; cut?: SetCut }>({ sets: [] });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.receiptSets(tx.ref).then((x) => { if (live) { setFound(x); setFailed(false); } }, () => { if (live) { setFound({ sets: [] }); setFailed(true); } });
    return () => { live = false; };
  }, [books, tx.ref]);
  if (failed) return <> · <span className="m" data-testid="receipt-set-failed">{t('bank.receiptSet.failed')}</span></>;
  const { sets: offers, cut } = found;
  // Where code stopped looking is said, never cut silently: the person may find a set among the others.
  const told = cut ? <span key="cut"> · <span className="m" data-testid="receipt-set-cut">{t(cut.limit === 'run' ? 'bank.receiptSet.cutRun' : 'bank.receiptSet.cut', { near: cut.near, tried: cut.tried })}</span></span> : null;
  const more = offers.length > SETS_SHOWN ? <span key="more"> · <span className="m">{t('bank.receiptSet.more', { shown: SETS_SHOWN, n: offers.length })}</span></span> : null;
  return [...offers.slice(0, SETS_SHOWN).map((s) => {
    const names = s.receipts.map((id) => b.receiptOf(id)?.name ?? id).join(', ');
    const vars = { n: s.receipts.length, sum: `${s.currency} ${fmt(s.sum)}`, paid: `${s.currency} ${fmt(s.paid)}` };
    return (
      <span key={s.receipts.join()}> · <span className="m" data-testid="receipt-set" data-tip={names}>{t(s.exact ? 'bank.receiptSet.exact' : s.rounding ? 'bank.receiptSet.rounding' : 'bank.receiptSet.close', vars)}{offers.length > 1 ? ` (${names})` : ''}</span>
        {' '}<button type="button" className="golink" data-act="link-receipt-set" data-tip={names} onClick={() => void linkReceiptSet(nav, s)}>{t('bank.receiptSet.link')}</button></span>
    );
  }), more, told];
}

/** An incoming payment linked to one of the open invoices of its currency, from the payment's side (r9c-3): the named invoice first. */
function LinkInvoice({ tx, nav }: { tx: BankTransaction; nav: Props['nav'] }) {
  const inv = useInvoices();
  const [pick, setPick] = useState('');
  const invoices = inv.state === 'ready' ? inv.data.invoices : [];
  const open = useMemo(() => linkableInvoices(invoices, tx), [invoices, tx]);
  if (!open.length) return null;
  const chosen = open.find((i) => i.id === pick) ?? open[0];
  return (
    <> · <span className="linkinv" data-testid="link-invoice">
      <label>{t('bank.linkInvoice')}{' '}
        <select value={chosen.id} onChange={(e) => setPick(e.target.value)}>
          {open.map((i) => <option key={i.id} value={i.id}>{i.number} · {i.customer.name} · {i.currency} {fmt(openAmount(i, invoices))}</option>)}
        </select>
      </label>
      {' '}<button type="button" className="golink" onClick={() => void confirmPayment(nav, chosen, tx.ref)}>{t('invoices.linkPayment')}</button>
    </span></>
  );
}

/** The payment's note, written in place: ↵ or leaving the field saves, Esc cancels. */
function Note({ tx, nav, edit }: { tx: BankTransaction; nav: Props['nav']; edit: boolean }) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  if (editing) {
    const done = (text: string) => { setEditing(false); if (!cancelled.current) void setNote(nav, tx, text.trim()); };
    return <> · <input className="note" autoFocus defaultValue={tx.remarks ?? ''} aria-label={t('bank.remarks')} data-tip={t('bank.noteTip')}
      onFocus={() => { cancelled.current = false; }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelled.current = true; setEditing(false); } }}
      onBlur={(e) => done(e.currentTarget.value)} /></>;
  }
  if (!edit) return tx.remarks ? <> · <span data-tip={t('bank.remarks')}>{tx.remarks}</span></> : null;
  return <> · <button type="button" className={tx.remarks ? 'golink' : 'golink addnote'} data-testid="payment-note" data-tip={t('bank.noteTip')} onClick={() => setEditing(true)}>{tx.remarks || t('bank.addNote')}</button></>;
}

function Sec({ k, label, val, children }: { k: Section; label: string; val: ReactNode; children: ReactNode }) {
  const s = useUi();
  const open = s.open[k];
  return (
    <div className={`sec${open ? ' open' : ''}`} data-sec={k}>
      <button type="button" className="sum" aria-expanded={open} onClick={() => setUi({ open: { ...s.open, [k]: !open } })}>
        {I.chev}<span className="lbl">{label}</span><span className="val">{val}</span>
      </button>
      <div className="in"><div><div className="pad">{children}</div></div></div>
    </div>
  );
}

/** The ESTV rates the statement's foreign entries were booked at (what Kontenabgleich listed per period). */
function Rates({ b, pays }: { b: Bank; pays: BankTransaction[] }) {
  const fx = useFx();
  const uses = useMemo(() => {
    if (!fx.rates) return [];
    const entries = pays.flatMap((p) => b.entriesOf(p.ref));
    return [...ratesUsed(entries, fx.paymentDate, fx.rates).values()].flat();
  }, [fx, pays, b]);
  if (!uses.length) return null;
  return (
    <Sec k="kurse" label={t('bank.sec.kurse')} val={String(uses.length)}>
      <dl className="kv rates">
        {uses.map((u) => (
          <div key={`${u.currency}|${u.date}|${u.rate}`} style={{ display: 'contents' }}>
            <dt className="mono">{formatDate(u.date)}</dt>
            <dd className="mono" data-tip={checkText(u.entries[0].conversion)}>
              {u.check.kind !== 'estv' && I.dot}{u.currency} {u.rate ?? '—'} <small>· {t('bank.nEntries', { n: u.entries.length })}</small>
            </dd>
          </div>
        ))}
      </dl>
    </Sec>
  );
}

function Quick({ src, file, mark }: { src: string; file: string; mark?: Mark }) {
  const [page, setPage] = useState('');
  return (
    <div className="quick" role="dialog" aria-label={t('bank.previewOf', { file })} onClick={() => setUi({ overlay: null })}>
      <span className="cap mono" onClick={(e) => e.stopPropagation()}>
        {file}{page && ` · ${page}`} · {t('bank.quickClose')}
        <a className="dl inline" href={src} download={file}>{I.dl}<span>{t('receipts.download')}</span></a>
      </span>
      <div className="paper real stmt" style={{ width: '70vw', maxWidth: 'none' }}><StatementPaper src={src} mark={mark} onPage={setPage} scroller={(el) => el.closest('.quick')} /></div>
    </div>
  );
}

/**
 * A provider's payout the app does not book says why on the payment itself (#203): the company's
 * file lacks the clearing account or the cut-over day, or the payout lies before the cut-over day
 * beside sales a report booked already. The server knows the business files (GET /api/transactions/:ref/payout-wait).
 */
function PayoutWait({ books, tx }: { books: Props['books']; tx: BankTransaction }) {
  const [wait, setWait] = useState<PayoutWaitView | null>(null);
  useEffect(() => {
    let live = true;
    api.payoutWait(tx.ref).then((x) => { if (live) setWait(x.wait); }, () => { if (live) setWait(null); });
    return () => { live = false; };
  }, [books, tx.ref]);
  if (!wait) return null;
  return <> · <span className="wn" data-testid="payout-wait">{t(`bank.payoutWait.${wait.why}`, { provider: wait.provider, file: wait.file, since: wait.since ? formatDate(wait.since) : '' })}</span></>;
}

/** A payment without a booking: one that waits for its receipt says so as a fact, with its return's due day once it is the person's (issue #29); one whose receipt could not be read says that (issue #57). */
function NotBooked({ tx, linked }: { tx: BankTransaction; linked: Linked }) {
  const { view } = useAutomation();
  const run: Processing | undefined = tx.waitsForPerson ? undefined : bookingRun(view?.runs ?? []);
  // The inbox's run is open and books it (#218): what it does, not yet what the person should do.
  if (run) return <span className="m" data-testid="booking-now">{run.kind === 'running' ? processingText(run, view) : t('bank.bookingNow', { what: processingText(run, view) })}</span>;
  const wait = receiptState(tx, linked, false, localToday());
  if (!wait) return <span className="wn">{t('bank.notBooked')}</span>;
  if (wait.kind === 'unread') return <span className="wn" data-testid="waits-for-receipt">{t('bank.receiptUnread')}</span>;
  return <span className={wait.kind === 'asks' ? 'wn' : 'm'} data-testid="waits-for-receipt">{wait.kind === 'asks' ? t('bank.receiptDue', { date: formatDate(wait.due) }) : t('bank.waitsForReceipt')}</span>;
}
