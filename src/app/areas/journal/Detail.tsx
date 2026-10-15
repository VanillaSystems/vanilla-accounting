/**
 * One entry: its text and amount (with how a foreign amount became CHF), the Buchungssatz with
 * each account's name and the VAT code explained, its payment and receipt, the receipt itself, and
 * in the margin the other entries of the same payment, the entry's form and where it came from.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { localToday, parsePeriod, periodContaining } from '../../../accounting/periods.js';
import { codeForRate, lookupVatCode, parseRate, vatCodes } from '../../../accounting/vat-codes.js';
import type { BankTransaction } from '../../../types/index.js';
import type { RouteOf } from '../../shell/route.js';
import { getAccountMap } from '../../lib/accounts.js';
import { sources } from '../../lib/api.js';
import { checkText } from '../../lib/fx-text.js';
import { periodName, monthName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { useFx } from '../../hooks/use-fx.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { AreaProps } from '../index.js';
import { Paper } from '../receipts/Paper.js';
import { I } from '../receipts/icons.js';
import { at, bankOf, amountOf } from '../receipts/view.js';
import { explain, codeText } from '../codes/vat-card.js';
import type { EntryView, Journal } from './model.js';
import { selectNew, setUi, useUi, type Section } from './state.js';
import { journalFor, openPeriod, runAct, splitReceipt } from './commands.js';
import { reclassify, saveEntry, type Field } from './actions.js';
import { RunLink } from '../../automation/marks.js';
import { AskAi } from '../../assistant/AskAi.js';
import { AccountField } from './AccountField.js';
import { StatementPaper } from '../bank/StatementPaper.js';
import { bankFor } from '../bank/state.js';
import { isCamt } from '../bank/model.js';
import { vat, baseCurrency } from '../../../engines/index.js';

type Props = AreaProps<RouteOf<'journal'>>;

export function Detail(props: Props) {
  const { route, books } = props;
  const j = journalFor(books);
  const v = route.id ? j.byId.get(route.id) : undefined;
  if (!v) return <div className="detail-empty"><div>{route.id ? t('journal.gone') : t('journal.noneSelected')}</div></div>;
  return <EntryDetail key={v.e.id} {...props} v={v} j={j} />;
}

const quarterName = (date: string) => { const p = parsePeriod(periodContaining(date), localToday()); return p ? periodName(p) : date; };
const filedName = (quarter: string) => { const p = parsePeriod(quarter, localToday()); return p ? periodName(p) : quarter; };

function EntryDetail(props: Props & { v: EntryView; j: Journal }) {
  const { v, j, nav, canEdit } = props;
  const { e, tx } = v;
  const fx = useFx().convert(e);
  const acName = getAccountMap();
  const found = e.vatCode ? lookupVatCode(e.vatCode) : null;
  const tax = vat().vatLine(e)?.tax;
  const cur = e.exchangeCurrency || baseCurrency();
  const edit = canEdit && !v.locked && e.origin !== 'year-close';
  const siblings = (j.byRef.get(e.transactionRef) ?? []).filter((x) => x !== v);
  const receipt = v.receipts[0];
  const open = openPeriod(props.books);

  return (
    <div className="detail-in" data-for={e.id}>
      <div className="head">
        <h2 className="who">{v.title}<small>{v.sub}</small></h2>
        <div className="amount">
          <small>{cur}</small>{fmt(e.amount)}
          {fx && <span className="fx" title={checkText(fx)}>{t('journal.fxLine', { chf: fmt(fx.chf), rate: String(fx.rate ?? '—') })}</span>}
        </div>
      </div>

      <div className="satz" role="table" aria-label={t('journal.satz')}>
        <div role="row"><span className="k">{t('journal.field.accountDebit')}</span><span className="mono n">{e.accountDebit || '–'}</span><span className="nm">{acName[e.accountDebit] ?? (e.accountDebit ? '' : t('journal.noCounter'))}</span></div>
        <div role="row"><span className="k">{t('journal.field.accountCredit')}</span><span className="mono n">{e.accountCredit || '–'}</span><span className="nm">{acName[e.accountCredit] ?? (e.accountCredit ? '' : t('journal.noCounter'))}</span></div>
        <div role="row">
          <span className="k">{t('journal.field.vatCode')}</span>
          <span className="mono n">{e.vatCode ? <button type="button" className="vlink" data-vat={e.vatCode} title={t('codes.explainCode', { code: e.vatCode })} onClick={() => explain(props, e.vatCode!)}>{e.vatCode}</button> : '–'}</span>
          <span className="nm">
            {e.vatCode
              ? <>{found?.negative && <span className="m">{t('journal.reversed')} · </span>}{codeText(e.vatCode)}{!!tax && found?.entry.amountIs !== 'tax' && <span className="mono m"> · {t('journal.vatIncluded', { tax: fmt(Math.abs(tax)) })}</span>}</>
              : t('journal.noVat')}
          </span>
        </div>
        {fx && fx.check.kind !== 'estv' && <div role="row"><span className="k" /><span /><span className="nm warn">{checkText(fx)}</span></div>}
      </div>

      <div className="status jst">
        {tx
          ? <span className="linked">{I.check}<button type="button" className="golink" data-testid="go-payment" title={t('journal.openPaymentKey')} onClick={() => nav.go(at({ area: 'bank', payment: tx.ref }, tx.date))}>{t('journal.payment')} <span className="mono">{formatDate(tx.date)}</span> · {bankOf(tx)} · <span className="mono">{amountOf(tx)}</span> <span className="arr">{t('journal.toStatement')}</span></button></span>
          : <span className="notice" style={{ margin: 0 }}>{e.corrects ? t('journal.correctionNoPayment', { date: formatDate(e.date), quarter: filedName(e.corrects) }) : t('journal.manualNoPayment')}</span>}
        {v.receipts.length > 0
          ? <span className="linked">{I.check}{t('journal.receipt')} {v.receipts.map((r, i) => { const [who, what] = splitReceipt(r); return <span key={r.id}>{i > 0 && ' · '}<button type="button" className="golink" data-testid="go-receipt" title={t('journal.openReceiptKey')} onClick={() => nav.go(at({ area: 'receipts', id: r.id }, r.date))}>{who}{what && <span className="m"> {what}</span>}</button></span>; })}</span>
          : v.missing && <span className="notice warn" style={{ margin: 0 }}>{I.dot}{t('journal.noReceipt')}</span>}
      </div>

      {e.corrects
        ? <div className="notice">{ICONS.lock}<span>{t('journal.correctsNotice', { filed: filedName(e.corrects), declared: quarterName(e.date) })}</span></div>
        : v.locked && (
          <div className="notice">
            {ICONS.lock}<span>{t('journal.lockedNotice', { period: quarterName(e.date) })}</span>
            {canEdit && open && <a href="#" onClick={(ev) => { ev.preventDefault(); runAct(props, 'correct'); }}>{t('journal.correctIn', { period: periodName(open) })}</a>}
          </div>
        )}

      <div className="body">
        <div className="desk">
          {receipt ? (
            <div className="paper real" role="button" tabIndex={0} aria-label={t('journal.openReceipt')} onClick={() => nav.go(at({ area: 'receipts', id: receipt.id }, receipt.date))}>
              <Paper key={receipt.id} src={sources.receipt(receipt.id)} />
              <a className="dl float" href={sources.receipt(receipt.id)} download={receipt.filename} title={t('receipts.downloadTitle', { file: receipt.filename })} onClick={(ev) => ev.stopPropagation()}>{I.dl}<span>{t('receipts.download')}</span></a>
            </div>
          ) : tx ? (
            <Excerpt {...props} tx={tx} />
          ) : (
            <div className="src">{t('journal.noDocument')}</div>
          )}
        </div>
        <aside className="margin" aria-label={t('journal.details')}>
          {siblings.length > 0 && (
            <Sec k="teile" val={t('journal.nEntries', { n: siblings.length + 1 })}>
              {siblings.map((x) => (
                <div key={x.e.id} className="tx go" onClick={() => nav.select({ area: 'journal', id: x.e.id })}>
                  <span className="d">{x.e.accountDebit || '–'} / {x.e.accountCredit || '–'} · {x.e.vatCode || t('journal.noVat')}</span>
                  <span className="am">{fmt(x.e.amount)}</span>
                  <span className="tt">{x.e.description}</span>
                </div>
              ))}
            </Sec>
          )}
          <EntryForm {...props} edit={edit} />
          <Sec k="herkunft" val={t(`journal.origin.${e.origin ?? 'other'}`)}>
            <dl className="kv">
              <dt>{t('journal.entryId')}</dt><dd className="mono" style={{ fontSize: 11.5 }}>{e.id}</dd>
              <dt>{t('journal.ref')}</dt><dd className="mono" style={{ fontSize: 11.5 }}>{e.transactionRef}</dd>
              <dt>{t('journal.booked')}</dt><dd>{t(`journal.originText.${e.origin ?? 'other'}`)}</dd>
              {e.run ? <><dt>{t('journal.run')}</dt><dd><RunLink run={e.run} nav={nav} /></dd></> : null}
            </dl>
            <AskAi context={{ kind: 'entry', id: e.id, label: e.description ?? e.id }} />
            {edit && (
              <div className="dangers">
                {tx && <button type="button" title={t('journal.reclassifyTip')} onClick={() => reclassify(nav, tx.ref, (j.byRef.get(tx.ref) ?? []).map((x) => x.e)).then((es) => es?.[0] && selectNew(nav, es[0].id))}>{t('journal.reclassify')}</button>}
                <button type="button" className="del" onClick={() => runAct(props, 'del')}>{t('common.delete')}</button>
              </div>
            )}
          </Sec>
        </aside>
      </div>
    </div>
  );
}

function Sec({ k, val, children }: { k: Section; val: ReactNode; children: ReactNode }) {
  const s = useUi();
  const open = s.open[k];
  return (
    <div className={`sec${open ? ' open' : ''}`} data-sec={k}>
      <button type="button" className="sum" aria-expanded={open} onClick={() => setUi({ open: { ...s.open, [k]: !open } })}>
        {I.chev}<span className="lbl">{t(`journal.sec.${k}`)}</span><span className="val">{val}</span>
      </button>
      <div className="in"><div><div className="pad">{children}</div></div></div>
    </div>
  );
}

const parseAmount = (s: string) => { const n = Number(s.replace(/['’\s]/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

function EntryForm(props: Props & { v: EntryView; edit: boolean }) {
  const { v, nav, edit } = props;
  const { e } = v;
  const s = useUi();
  const form = useRef<HTMLFormElement>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const wrong = useRef(false);

  useEffect(() => {
    if (!s.open.buchung || !s.focus) return;
    form.current?.querySelector<HTMLInputElement>(`[name="${s.focus}"]`)?.focus();
    setUi({ focus: undefined });
  }, [s.open.buchung, s.focus]);

  const field = (name: Field) => form.current?.querySelector<HTMLInputElement>(`[name="${name}"]`) ?? null;

  // The form keeps what is typed while a field is left: a saved entry only rewrites the fields not being edited.
  useEffect(() => {
    if (wrong.current) return;
    const values: Record<Field, string> = { accountDebit: e.accountDebit, accountCredit: e.accountCredit, vatCode: e.vatCode ?? '', amount: fmt(e.amount), description: e.description ?? '' };
    for (const [name, value] of Object.entries(values) as [Field, string][]) {
      const el = field(name);
      if (el && el !== document.activeElement && el.value !== value) el.value = value;
    }
  }, [e.accountDebit, e.accountCredit, e.vatCode, e.amount, e.description]);

  /** A code as typed, or the code a typed rate stands for on these accounts. */
  function vatCodeOf(typed: string, debit: string, credit: string): { code: string; fromRate?: number } | null {
    if (!typed || lookupVatCode(typed)) return { code: typed };
    const r = parseRate(typed);
    const code = r && codeForRate(r.rate, debit, credit, r.negative);
    return code ? { code, fromRate: r!.rate } : null;
  }

  function fail(message: string) { wrong.current = true; setErr(message); setNote(''); nav.dismissToast(); }

  function save() {
    if (!edit || !form.current) return;
    const f = Object.fromEntries(new FormData(form.current)) as Record<Field, string>;
    const accounts = getAccountMap();
    const next = { accountDebit: f.accountDebit.trim(), accountCredit: f.accountCredit.trim(), vatCode: f.vatCode.trim(), description: f.description.trim(), amount: parseAmount(f.amount) };
    const unknown = [next.accountDebit, next.accountCredit].find((n) => n && !accounts[n]);
    if (unknown) return fail(t('journal.errAccount', { account: unknown }));
    if (!next.accountDebit && !next.accountCredit) return fail(t('journal.errNoAccount'));
    const vatCode = vatCodeOf(next.vatCode, next.accountDebit, next.accountCredit);
    if (!vatCode) return fail(parseRate(next.vatCode) ? t('journal.errVatRate', { rate: next.vatCode }) : t('journal.errVat', { code: next.vatCode }));
    if (!next.amount) return fail(t('journal.errAmount'));
    wrong.current = false;
    setErr('');
    next.vatCode = vatCode.code;
    if (vatCode.fromRate !== undefined) {
      const el = field('vatCode'); if (el) el.value = vatCode.code;
      setNote(t('journal.vatFromRate', { rate: String(vatCode.fromRate), code: vatCode.code, text: lookupVatCode(vatCode.code)?.entry.bananaText ?? '' }));
    }
    const el = field('amount'); if (el) el.value = fmt(next.amount);
    const changed = (['accountDebit', 'accountCredit', 'vatCode', 'amount', 'description'] as Field[]).filter((k) => next[k] !== ((k === 'vatCode' || k === 'description' ? e[k] ?? '' : e[k])));
    if (!changed.length) return;
    saveEntry(nav, e, Object.fromEntries(changed.map((k) => [k, next[k]])), changed);
  }

  return (
    <Sec k="buchung" val={edit ? t('journal.editable') : t('journal.readOnly')}>
      <form
        ref={form}
        className="form"
        autoComplete="off"
        onSubmit={(ev) => { ev.preventDefault(); save(); }}
        onBlur={save}
        onKeyDown={(ev) => { if (ev.key === 'Enter' && !ev.defaultPrevented) { ev.preventDefault(); save(); } }}
      >
        <div className="two">
          <AccountField name="accountDebit" label={t('journal.field.accountDebit')} defaultValue={e.accountDebit} readOnly={!edit} onPick={save} />
          <AccountField name="accountCredit" label={t('journal.field.accountCredit')} defaultValue={e.accountCredit} readOnly={!edit} onPick={save} />
        </div>
        <div className="two">
          <label>{t('journal.field.vatCode')}<input className="mono" name="vatCode" defaultValue={e.vatCode ?? ''} readOnly={!edit} list="vat-codes" placeholder={edit ? t('journal.vatPlaceholder') : undefined} /></label>
          <label>{t('journal.amountIn', { currency: e.exchangeCurrency || baseCurrency() })}<input className="mono" name="amount" defaultValue={fmt(e.amount)} readOnly={!edit} style={{ textAlign: 'right' }} /></label>
        </div>
        <label>{t('journal.field.description')}<input name="description" defaultValue={e.description ?? ''} readOnly={!edit} /></label>
        <VatCodeList />
        <div className="err" role="alert">{err}</div>
        {note && <div className="fhint" data-testid="vat-from-rate">{note}</div>}
        {edit && <div className="fhint">{t('journal.saveHint')}</div>}
      </form>
    </Sec>
  );
}

/** The codes a VAT field offers as you type. */
export function VatCodeList() {
  return <datalist id="vat-codes">{vatCodes().map((c) => <option key={c.code} value={c.code}>{c.bananaText ?? ''}</option>)}</datalist>;
}

/** No receipt: the strip of the payment's statement that shows it, as in Kontoauszüge. */
function Excerpt({ books, nav, tx }: Props & { tx: BankTransaction }) {
  const ws = useWorkspace();
  const [page, setPage] = useState('');
  const b = bankFor(books, ws?.bankAccounts);
  const s = b.statementOf(tx);
  const src = s?.file && !isCamt(s.file) && sources.statement(s.file.bank, s.file.filename);
  const toStatement = () => nav.go(at({ area: 'bank', payment: tx.ref }, tx.date));
  const link = <button type="button" title={t('journal.openPaymentKey')} onClick={toStatement}>{t('journal.statementOf', { month: monthName(tx.date) })}</button>;
  if (!src) return <div className="src">{t('journal.noReceiptSource')} {link}</div>;
  return (
    <>
      <div className="src">
        {t('journal.excerptFrom')} {link}
        <span className="pgno">{page}</span>
        <a className="dl inline" href={src} download={s.file!.filename} title={t('bank.downloadTitle', { file: s.file!.filename })}>{I.dl}<span>{t('receipts.download')}</span></a>
      </div>
      <div className="paper real stmt excerpt" role="button" tabIndex={0} aria-label={t('journal.openPaymentKey')} onClick={toStatement}>
        <StatementPaper src={src} mark={{ tx, fee: b.feeOf(tx.ref), wise: s.account.statements === 'wise' }} excerpt onPage={setPage} />
      </div>
    </>
  );
}
