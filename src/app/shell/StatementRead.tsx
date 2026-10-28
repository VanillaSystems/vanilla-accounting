/**
 * A statement without a bank export in its drop row (#217): the movements as the model read them off the
 * PDF, scan or photo («aus PDF gelesen»), as a person types them, or as a bank CSV's columns give
 * them, each line correctable; the balance check reruns on every change (src/books/statement-check.ts),
 * and «Einlesen» imports it as an ISO 20022 statement only once it adds up. A bank CSV first asks which column
 * holds what; the answer is kept for that account's next CSV.
 */
import { useMemo, useState } from 'react';
import { t } from '../i18n/index.js';
import { fmt } from '../lib/utils.js';
import { amountOf, checkStatement, parseReadStatement } from '../../books/statement-check.js';
import type { DropAction, DropRow } from '../../types/drop.js';
import type { BalanceGap, CsvColumns, ReadStatement } from '../../types/statement-read.js';

/** A line as typed: amounts stay text until the check reads them. */
interface Line { date: string; amount: string; counterparty: string; text: string; reference: string; page?: number; valueDate?: string }
interface Draft {
  iban: string; currency: string; bankName?: string; owner?: string; period?: { from: string; to: string };
  opening: { date: string; amount: string }; closing: { date: string; amount: string };
  pages: { page: number; carriedIn: string; carriedOut: string }[];
  movements: Line[];
}

const money = (n: number | undefined) => (n === undefined ? '' : n.toFixed(2));

function draftOf(s: ReadStatement): Draft {
  return {
    iban: s.iban ?? '', currency: s.currency, ...(s.bankName ? { bankName: s.bankName } : {}), ...(s.owner ? { owner: s.owner } : {}), ...(s.period ? { period: s.period } : {}),
    opening: { date: s.opening.date, amount: money(s.opening.amount) }, closing: { date: s.closing.date, amount: money(s.closing.amount) },
    pages: (s.pages ?? []).map((p) => ({ page: p.page, carriedIn: money(p.carriedIn), carriedOut: money(p.carriedOut) })),
    movements: s.movements.map((m) => ({ date: m.date, amount: money(m.amount), counterparty: m.counterparty ?? '', text: m.text ?? '', reference: m.reference ?? '', ...(m.page ? { page: m.page } : {}), ...(m.valueDate ? { valueDate: m.valueDate } : {}) })),
  };
}

/** The draft as a statement, or undefined while a line lacks its day or amount (the parser's rule, here and on the server). */
const statementOf = (d: Draft) => parseReadStatement({ ...d, iban: d.iban || undefined, pages: d.pages.map((p) => ({ page: p.page, carriedIn: p.carriedIn || undefined, carriedOut: p.carriedOut || undefined })) });

function gapText(g: BalanceGap, currency: string): string {
  const vars = { gap: `${currency} ${fmt(g.gap)}`, expected: `${currency} ${fmt(g.expected)}`, found: `${currency} ${fmt(g.found)}`, page: g.page ?? '' };
  return t(`drop.read.gap.${g.where}`, vars);
}

export function StatementRead({ r, act }: { r: DropRow; act(action: DropAction): Promise<unknown> }) {
  const read = r.read!;
  const [draft, setDraft] = useState(() => draftOf(read.statement));
  const [busy, setBusy] = useState(false);
  const statement = useMemo(() => statementOf(draft), [draft]);
  const check = statement ? checkStatement(statement) : undefined;
  const known = useMemo(() => {
    // A line the books hold: the server's marks by day and amount, each taken once; a line changed since is no longer one.
    const pool = read.known.map((k) => `${k.date} ${k.amount.toFixed(2)}`);
    return draft.movements.map((m) => {
      const n = amountOf(m.amount);
      const i = n !== undefined ? pool.indexOf(`${m.date} ${n.toFixed(2)}`) : -1;
      if (i >= 0) pool.splice(i, 1);
      return i >= 0;
    });
  }, [draft.movements, read.known]);
  const line = (i: number, patch: Partial<Line>) => setDraft({ ...draft, movements: draft.movements.map((m, k) => (k === i ? { ...m, ...patch } : m)) });
  const add = () => setDraft({ ...draft, movements: [...draft.movements, { date: draft.movements.at(-1)?.date ?? draft.closing.date, amount: '', counterparty: '', text: '', reference: '' }] });
  const page = (n: number, patch: Partial<Draft['pages'][number]>) => setDraft({ ...draft, pages: draft.pages.map((p) => (p.page === n ? { ...p, ...patch } : p)) });
  const importIt = async () => {
    if (!statement) return;
    setBusy(true);
    try { await act({ kind: 'read', statement, import: true }); } finally { setBusy(false); }
  };
  const knownCount = known.filter(Boolean).length;
  return (
    <div className="dread" data-testid="drop-read">
      <div className="dread-hd">
        <span className={`dchip r-${read.by}`} data-testid="drop-read-by">{t(`drop.read.by.${read.by}`)}</span>
        {read.why ? <small>{t(`drop.read.why.${read.why}`, { limit: read.limit ?? '', pages: read.pages ?? '' })}</small> : null}
      </div>
      <div className="dread-facts">
        <label>{t('drop.read.iban')}<input className="iban" value={draft.iban} onChange={(e) => setDraft({ ...draft, iban: e.target.value })} /></label>
        <label>{t('drop.read.currency')}<input className="ccy" value={draft.currency} maxLength={3} onChange={(e) => setDraft({ ...draft, currency: e.target.value.toUpperCase() })} /></label>
        <label>{t('drop.read.opening')}
          <span><input type="date" value={draft.opening.date} onChange={(e) => setDraft({ ...draft, opening: { ...draft.opening, date: e.target.value } })} />
            <input className="amt" inputMode="decimal" value={draft.opening.amount} data-testid="drop-read-opening" onChange={(e) => setDraft({ ...draft, opening: { ...draft.opening, amount: e.target.value } })} /></span>
        </label>
        <label>{t('drop.read.closing')}
          <span><input type="date" value={draft.closing.date} onChange={(e) => setDraft({ ...draft, closing: { ...draft.closing, date: e.target.value } })} />
            <input className="amt" inputMode="decimal" value={draft.closing.amount} data-testid="drop-read-closing" onChange={(e) => setDraft({ ...draft, closing: { ...draft.closing, amount: e.target.value } })} /></span>
        </label>
      </div>
      <div className="dread-scroll">
        <table className="dread-t">
          <thead>
            <tr>
              <th>{t('drop.read.date')}</th><th className="amt">{t('drop.read.amount')}</th><th>{t('drop.read.counterparty')}</th><th>{t('drop.read.text')}</th><th>{t('drop.read.reference')}</th>
              {draft.pages.length ? <th>{t('drop.read.page')}</th> : null}<th />
            </tr>
          </thead>
          <tbody>
            {draft.movements.map((m, i) => (
              <tr key={i} className={known[i] ? 'known' : ''} data-testid="drop-read-line">
                <td><input type="date" value={m.date} aria-label={t('drop.read.date')} onChange={(e) => line(i, { date: e.target.value })} /></td>
                <td className="amt"><input className="amt" inputMode="decimal" value={m.amount} aria-label={t('drop.read.amount')} onChange={(e) => line(i, { amount: e.target.value })} /></td>
                <td><input value={m.counterparty} aria-label={t('drop.read.counterparty')} onChange={(e) => line(i, { counterparty: e.target.value })} /></td>
                <td><input value={m.text} aria-label={t('drop.read.text')} onChange={(e) => line(i, { text: e.target.value })} /></td>
                <td>{known[i] ? <span className="dknown" data-tip={t('drop.read.knownTip')}>{t('drop.read.known')}</span> : <input value={m.reference} aria-label={t('drop.read.reference')} onChange={(e) => line(i, { reference: e.target.value })} />}</td>
                {draft.pages.length ? <td className="pg mono">{m.page ?? ''}</td> : null}
                <td><button type="button" className="dx" aria-label={t('drop.read.removeLine')} onClick={() => setDraft({ ...draft, movements: draft.movements.filter((_, k) => k !== i) })}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!draft.movements.length ? <p className="m">{t('drop.read.noLines')}</p> : null}
      </div>
      <button type="button" className="linkbtn" data-testid="drop-read-add" onClick={add}>{t('drop.read.addLine')}</button>
      {draft.pages.length ? (
        <div className="dread-pages">
          <small>{t('drop.read.pages')}</small>
          {draft.pages.map((p) => (
            <label key={p.page}>{t('drop.read.pageN', { page: p.page })}
              <input className="amt" inputMode="decimal" value={p.carriedIn} aria-label={t('drop.read.carriedIn', { page: p.page })} placeholder={t('drop.read.in')} onChange={(e) => page(p.page, { carriedIn: e.target.value })} />
              <input className="amt" inputMode="decimal" value={p.carriedOut} aria-label={t('drop.read.carriedOut', { page: p.page })} placeholder={t('drop.read.out')} onChange={(e) => page(p.page, { carriedOut: e.target.value })} />
            </label>
          ))}
        </div>
      ) : null}
      <div className={`dread-check ${check?.ok ? 'ok' : 'gap'}`} data-testid="drop-read-check" data-ok={!!check?.ok}>
        {!statement ? t('drop.read.incomplete')
          : check!.ok ? t('drop.read.ok', { n: statement.movements.length, currency: statement.currency, closing: fmt(statement.closing.amount) })
          : check!.gaps.map((g, i) => <span key={i}>{gapText(g, statement.currency)}</span>)}
        {statement && knownCount ? <span className="m">{t('drop.read.knownCount', { n: knownCount })}</span> : null}
      </div>
      <div className="dread-acts">
        {r.kind === 'statement-pdf' ? <button type="button" className="linkbtn" onClick={() => void act({ kind: 'as', as: 'receipt' })}>{t('drop.isReceipt')}</button> : null}
        <button type="button" className="btn primary" data-testid="drop-read-import" disabled={!check?.ok || busy} data-tip={check?.ok ? undefined : t('drop.read.importBlocked')} onClick={() => void importIt()}>{t('drop.read.import')}</button>
      </div>
    </div>
  );
}

const FIELDS: (keyof CsvColumns)[] = ['date', 'valueDate', 'amount', 'debit', 'credit', 'counterparty', 'text', 'reference', 'balance'];

/** A bank CSV's columns: one select per field, its first rows below, and whose account it is. */
export function CsvColumnsForm({ r, act }: { r: DropRow; act(action: DropAction): Promise<unknown> }) {
  const csv = r.csv!;
  const [columns, setColumns] = useState<Partial<CsvColumns>>(csv.columns ?? {});
  const [account, setAccount] = useState(csv.account ?? (csv.accounts.length === 1 ? csv.accounts[0].account : ''));
  const ready = columns.date !== undefined && (columns.amount !== undefined || columns.debit !== undefined || columns.credit !== undefined) && !!account;
  return (
    <form className="dread dcsv" data-testid="drop-csv" onSubmit={(e) => { e.preventDefault(); if (ready) void act({ kind: 'csv', columns: columns as CsvColumns, account }); }}>
      <small>{t('drop.csv.ask', { rows: csv.rows })}</small>
      <div className="dcsv-map">
        <label>{t('drop.csv.account')}
          <select value={account} onChange={(e) => setAccount(e.target.value)} data-testid="drop-csv-account">
            <option value="">–</option>
            {csv.accounts.map((a) => <option key={a.account} value={a.account}>{a.label} {a.currency} · {a.account}</option>)}
          </select>
        </label>
        {FIELDS.map((f) => (
          <label key={f}>{t(`drop.csv.field.${f}`)}
            <select value={columns[f] ?? ''} data-field={f} onChange={(e) => setColumns({ ...columns, [f]: e.target.value === '' ? undefined : Number(e.target.value) })}>
              <option value="">–</option>
              {csv.header.map((h, i) => <option key={i} value={i}>{h || t('drop.csv.column', { n: i + 1 })}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="dread-scroll">
        <table className="dread-t">
          <thead><tr>{csv.header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{csv.sample.map((row, i) => <tr key={i}>{csv.header.map((_, k) => <td key={k}>{row[k] ?? ''}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {csv.rows > csv.sample.length ? <small className="m">{t('drop.csv.more', { shown: csv.sample.length, n: csv.rows })}</small> : null}
      {r.message ? <small className="dwhy">{r.message}</small> : null}
      <div className="dread-acts">
        <small className="m">{t('drop.csv.kept')}</small>
        <button type="submit" className="btn primary" data-testid="drop-csv-read" disabled={!ready}>{t('drop.csv.read')}</button>
      </div>
    </form>
  );
}
