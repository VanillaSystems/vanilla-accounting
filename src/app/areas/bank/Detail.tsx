/**
 * One statement: the bank's balances and whether its payments add up to them, the ledger's
 * balance beside the bank's, the PDF with the chosen payment's line marked, and in the margin its
 * payments, the exchange rates its foreign entries were booked at, and its file. A month without
 * its statement shows where to add it.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { BankTransaction } from '../../../types/index.js';
import { ratesUsed } from '../../../accounting/fx-conversion.js';
import type { RouteOf } from '../../shell/route.js';
import { sources } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { monthName } from '../../lib/period-label.js';
import { useFx } from '../../hooks/use-fx.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { checkText } from '../../lib/fx-text.js';
import { t } from '../../i18n/index.js';
import type { AreaProps } from '../index.js';
import { I } from '../receipts/icons.js';
import { matches, payHaystack, payText, signed, type Bank, type Statement } from './model.js';
import { bankFor, setUi, useUi, type Section } from './state.js';
import { importStatements, pickStatements, setNote, setNoReceipt } from './actions.js';
import { at } from '../receipts/view.js';
import { StatementPaper, type Mark } from './StatementPaper.js';
import { baseCurrency } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'bank'>>;

/** "September 2026" for a calendar month, else its days. */
export const statementName = (s: Statement) =>
  s.from.slice(8) === '01' && s.to.slice(0, 7) === s.from.slice(0, 7) && Number(s.to.slice(8)) >= 28 ? monthName(s.from) : `${formatDate(s.from)} – ${formatDate(s.to)}`;

export function Detail(props: Props) {
  const ws = useWorkspace();
  const b = bankFor(props.books, ws?.bankAccounts);
  const s = props.route.statement ? b.byKey(props.route.statement) : undefined;
  if (!s) return <div className="detail-empty"><div>{!ws ? '' : props.route.statement ? t('bank.statementGone', { key: props.route.statement }) : t('bank.noneChosen')}</div></div>;
  return <StatementDetail key={s.key} {...props} b={b} s={s} />;
}

/** An amount with its direction: money in gets a +. */
const Amount = ({ tx }: { tx: BankTransaction }) => {
  const n = signed(tx);
  return n > 0 ? <span className="inc">+{fmt(n)}</span> : <>{fmt(-n)}</>;
};

function StatementDetail(props: Props & { b: Bank; s: Statement }) {
  const { b, s, route, query, nav, canEdit } = props;
  const ui = useUi();
  const [page, setPage] = useState('');
  const pays = b.payments(s);
  const tx = route.payment ? pays.find((p) => p.ref === route.payment) : undefined;
  const c = s.file ? b.check(s) : undefined;
  const closed = !!b.closedThrough && s.to <= b.closedThrough;
  const src = s.file && sources.statement(s.file.bank, s.file.filename);
  const wise = s.account.statements === 'wise';
  const mark: Mark | undefined = tx && { tx, fee: b.feeOf(tx.ref), wise };
  const choose = (ref: string | undefined) => nav.select({ area: 'bank', statement: s.key, ...(ref && { payment: ref }) });
  const words = useMemo(() => {
    const byId = new Map(props.books.receipts.map((r) => [r.id, `${r.description ?? ''} ${r.filename}`]));
    return (ref: string) => b.receiptsOf(ref).map((id) => byId.get(id) ?? '').join(' ');
  }, [props.books, b]);

  return (
    <div className="detail-in" data-for={s.key}>
      <div className="head">
        <h2 className="who">{t('bank.statementOf', { name: statementName(s) })}<small>{s.account.label} · {formatDate(s.from)} – {formatDate(s.to)}</small></h2>
        {c?.close != null && <div className="amount"><small>{s.account.currency}</small>{fmt(c.close)}</div>}
      </div>
      {c && (
        <div className="facts">
          <span title={t('bank.openTip')}>{t('bank.open', { amount: c.open == null ? '?' : fmt(c.open) })}</span>
          <span title={t('bank.incTip')}>+ {fmt(c.inc)}</span>
          <span title={t('bank.outTip')}>− {fmt(c.out)}</span>
          <span title={t('bank.closeTip')}>{t('bank.close', { amount: c.close == null ? '?' : fmt(c.close) })}</span>
          <span title={t('bank.bookTip')} className={c.bookDiff ? 'nov' : undefined}>{t('bank.book', { amount: fmt(c.book) })}</span>
        </div>
      )}
      <div className="status">
        {!s.file ? (
          s.running
            ? <span className="notice" style={{ margin: 0 }}>{t('bank.runningNotice')}</span>
            : <span className="notice warn" style={{ margin: 0 }}>{I.dot}{t('bank.missingNotice')}</span>
        ) : c!.ok ? (
          <span className="linked">{I.check}{t('bank.checkOk', { n: c!.n })}</span>
        ) : c!.diff == null ? (
          <span className="notice" style={{ margin: 0 }}>{c!.close == null ? t('bank.noClose') : t('bank.noOpen')}</span>
        ) : (
          <span className="notice warn" style={{ margin: 0 }}>{I.dot}{t('bank.checkDiff', { diff: fmt(c!.diff) })}</span>
        )}
      </div>
      {c?.bookDiff ? (
        <div className="status"><span className="notice warn" style={{ margin: 0 }}>{I.dot}{t('bank.bookDiff', { diff: fmt(c.bookDiff) })}</span></div>
      ) : null}

      <div className="body">
        <div className="desk">
          {(src || tx) && (
            <div className="src paybar">
              <span><PayBar {...props} tx={tx} closed={closed} onClear={() => choose(undefined)} /></span>
              {src && <span className="pgno">{page}</span>}
              {src && <a className="dl inline" href={src} download={s.file!.filename} title={t('bank.downloadTitle', { file: s.file!.filename })}>{I.dl}<span>{t('receipts.download')}</span></a>}
            </div>
          )}
          {src ? (
            <div className="paper real stmt" role="button" tabIndex={0} aria-label={t('bank.openLarge')} onClick={() => setUi({ overlay: 'quick' })}>
              <StatementPaper src={src} mark={mark} onPage={setPage} scroller={(el) => el.closest('.detail')} />
            </div>
          ) : !s.running && canEdit && !closed ? (
            <button type="button" className="well" style={{ width: '100%', maxWidth: 640 }} onClick={() => pickStatements((files) => importStatements(files, nav, { account: s.account, month: s.from.slice(0, 7) }))}>
              <span><b>{t('bank.well')}</b>{t('bank.wellFor', { bank: s.account.bank })}</span>
            </button>
          ) : null}
        </div>
        <aside className="margin" aria-label={t('receipts.details')}>
          {pays.length > 0 && (
            <Sec k="zahlungen" label={t('bank.sec.zahlungen')} val={String(pays.length)}>
              <div className="paylist" role="listbox" aria-label={t('bank.paymentsOf')}>
                {pays.map((p) => {
                  const hit = !query.q || matches(payHaystack(p, words(p.ref)), query.q);
                  const on = p.ref === tx?.ref;
                  return (
                    <button key={p.ref} type="button" className={`pay${on ? ' on' : ''}${hit ? '' : ' dim'}`} role="option" aria-selected={on} data-pay={p.ref} onClick={() => choose(on ? undefined : p.ref)}>
                      <span className="d">{p.date.slice(8)}.{p.date.slice(5, 7)}.</span>
                      <span className="t">{b.needsReceipt(p) && I.dot}{payText(p).name}</span>
                      <span className="a"><Amount tx={p} /></span>
                    </button>
                  );
                })}
              </div>
            </Sec>
          )}
          {s.account.currency !== baseCurrency() && <Rates b={b} pays={pays} />}
          {s.file && (
            <Sec k="datei" label={t('bank.sec.datei')} val="">
              <dl className="kv">
                <dt>{t('bank.statement')}</dt><dd className="mono" style={{ fontSize: 11.5 }} title={s.file.filename}>{s.file.filename}</dd>
                <dt>{t('bank.account')}</dt><dd className="mono">{s.account.account}</dd>
              </dl>
            </Sec>
          )}
        </aside>
      </div>
      {ui.overlay === 'quick' && src && <Quick src={src} file={s.file!.filename} mark={mark} />}
    </div>
  );
}

/** The chosen payment in one line: its receipt, its entry, what is missing; a hint while none is chosen. */
function PayBar({ b, tx, nav, canEdit, closed, onClear }: Props & { b: Bank; tx?: BankTransaction; closed: boolean; onClear(): void }) {
  if (!tx) return <span className="payhint">{t('bank.payHint')}</span>;
  const receipts = b.receiptsOf(tx.ref);
  const entry = b.entriesOf(tx.ref)[0];
  const fee = b.feeOf(tx.ref);
  const first = receipts[0] ? b.receiptOf(receipts[0]) : undefined;
  const edit = canEdit && !closed;
  return (
    <>
      <b className="mono">{formatDate(tx.date)}</b> {payText(tx).name}{payText(tx).note && <small> {payText(tx).note}</small>} <span className="mono"><Amount tx={tx} /></span>
      {fee && <> · {t('bank.fee', { amount: fmt(Math.abs(fee.amount)) })}</>}
      {receipts.length > 0 ? (
        <> · <button type="button" className="golink" data-testid="go-receipt" title={t('bank.openReceipt')} onClick={() => nav.go(at({ area: 'receipts', id: receipts[0] }, first?.date ?? tx.date))}>
          {t('bank.receipt', { name: first?.name ?? receipts[0] })}{receipts.length > 1 && ` +${receipts.length - 1}`}
        </button></>
      ) : b.needsReceipt(tx) ? (
        <> · <span className="wn">{t('bank.noReceipt')}</span>{edit && <> <button type="button" className="golink" onClick={() => setNoReceipt(nav, tx, true)}>{t('bank.noReceiptNeeded')}</button></>}</>
      ) : tx.noReceiptNeeded ? (
        <> · {t('bank.noReceiptNotNeeded')}{edit && <> <button type="button" className="golink" title={t('bank.resetTip')} onClick={() => setNoReceipt(nav, tx, false)}>{t('bank.reset')}</button></>}</>
      ) : null}
      {entry ? (
        <> · <button type="button" className="golink" data-testid="go-entry" title={t('bank.openEntry')} onClick={() => nav.go(at({ area: 'journal', id: entry.id }, entry.date))}>
          {t('bank.entry', { debit: entry.accountDebit || '–', credit: entry.accountCredit || '–' })}
        </button></>
      ) : tx.amount ? <> · <span className="wn">{t('bank.notBooked')}</span></> : null}
      <Note key={tx.ref} tx={tx} nav={nav} edit={edit} />
      {' '}<button type="button" className="x" title={t('bank.clear')} aria-label={t('bank.clear')} onClick={onClear}>×</button>
    </>
  );
}

/** The payment's note, written in place: ↵ or leaving the field saves, Esc cancels. */
function Note({ tx, nav, edit }: { tx: BankTransaction; nav: Props['nav']; edit: boolean }) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  if (editing) {
    const done = (text: string) => { setEditing(false); if (!cancelled.current) void setNote(nav, tx, text.trim()); };
    return <> · <input className="note" autoFocus defaultValue={tx.remarks ?? ''} aria-label={t('bank.remarks')} title={t('bank.noteTip')}
      onFocus={() => { cancelled.current = false; }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelled.current = true; setEditing(false); } }}
      onBlur={(e) => done(e.currentTarget.value)} /></>;
  }
  if (!edit) return tx.remarks ? <> · <span title={t('bank.remarks')}>{tx.remarks}</span></> : null;
  return <> · <button type="button" className={tx.remarks ? 'golink' : 'golink addnote'} data-testid="payment-note" title={t('bank.noteTip')} onClick={() => setEditing(true)}>{tx.remarks || t('bank.addNote')}</button></>;
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
            <dd className="mono" title={checkText(u.entries[0].conversion)}>
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
