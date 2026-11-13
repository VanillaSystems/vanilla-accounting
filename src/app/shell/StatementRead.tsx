/**
 * A statement without a bank export in its drop row (#217): the movements as the model read them off the
 * PDF, scan or photo («aus PDF gelesen»), as a person types them, or as a bank CSV's columns give
 * them, each line correctable; the balance check reruns on every change (src/books/statement-check.ts),
 * and «Einlesen» imports it as an ISO 20022 statement only once it adds up. A PDF can instead be kept as the
 * month's statement («Als Monatsauszug behalten», as before #217): the way without AI, and the only
 * one when a bank export or bank CSV of its account covers all its days (#254; on some of them, those days
 * import only the payments the books hold). The same table answers a PDF's question kept in the books,
 * in Bank › Kontoauszüge (#254), and is a kept PDF's table, read or filled by hand, saved as what it gives
 * the books (`facts`, #243: its closing balance, its references). A bank CSV first asks which column holds
 * what; the answer is kept for that account's next CSV.
 */
import { useMemo, useState } from 'react';
import { t } from '../i18n/index.js';
import { fmt, formatDate } from '../lib/utils.js';
import { amountOf, checkStatement, hasBalances, isBlank, parsePdfTable, parseReadStatement } from '../../books/statement-check.js';
import type { DropAction, DropRow } from '../../types/drop.js';
import type { Route } from './route.js';
import type { BalanceGap, CsvColumns, PdfTable, StatementRead as Read } from '../../types/statement-read.js';

/** A line as typed: amounts stay text until the check reads them. */
interface Line { date: string; amount: string; counterparty: string; text: string; reference: string; page?: number; valueDate?: string; original?: { amount: number; currency: string }; payment?: string }
interface Draft {
  iban: string; currency: string; bankName?: string; owner?: string; period?: { from: string; to: string };
  opening: { date: string; amount: string }; closing: { date: string; amount: string };
  pages: { page: number; carriedIn: string; carriedOut: string }[];
  movements: Line[];
}

const money = (n: number | undefined) => (n === undefined ? '' : n.toFixed(2));

function draftOf(s: PdfTable): Draft {
  return {
    iban: s.iban ?? '', currency: s.currency, ...(s.bankName ? { bankName: s.bankName } : {}), ...(s.owner ? { owner: s.owner } : {}), ...(s.period ? { period: s.period } : {}),
    opening: { date: s.opening?.date ?? s.period?.from ?? '', amount: money(s.opening?.amount) }, closing: { date: s.closing?.date ?? s.period?.to ?? '', amount: money(s.closing?.amount) },
    pages: (s.pages ?? []).map((p) => ({ page: p.page, carriedIn: money(p.carriedIn), carriedOut: money(p.carriedOut) })),
    movements: s.movements.map((m) => ({ date: m.date, amount: money(m.amount), counterparty: m.counterparty ?? '', text: m.text ?? '', reference: m.reference ?? '', ...(m.page ? { page: m.page } : {}), ...(m.valueDate ? { valueDate: m.valueDate } : {}), ...(m.original ? { original: m.original } : {}), ...(m.payment ? { payment: m.payment } : {}) })),
  };
}

/** The draft as a statement (a kept PDF's table: its balances may be left empty), or undefined while a line lacks its day or amount (the parser's rule, here and on the server). */
const statementOf = (d: Draft, table: boolean): PdfTable | undefined => (table ? parsePdfTable : parseReadStatement)({ ...d, iban: d.iban || undefined, pages: d.pages.map((p) => ({ page: p.page, carriedIn: p.carriedIn || undefined, carriedOut: p.carriedOut || undefined })) });

function gapText(g: BalanceGap, currency: string): string {
  const vars = { gap: `${currency} ${fmt(g.gap)}`, expected: `${currency} ${fmt(g.expected)}`, found: `${currency} ${fmt(g.found)}`, page: g.page ?? '' };
  return t(`drop.read.gap.${g.where}`, vars);
}

/** What the table sends: the table corrected (with `import`: «Einlesen»), or «Als Monatsauszug behalten». */
export type ReadAction = Extract<DropAction, { kind: 'read' | 'keep' }>;

/** Why the table is to fill by hand, in words: what is off, and what is left to do. */
function whyText(read: Pick<Read, 'why' | 'error' | 'limit' | 'pages'>): string {
  if (read.why === 'failed') return read.error ? t('drop.read.why.failedCall', { error: read.error }) : t('drop.read.why.failed');
  return read.why ? t(`drop.read.why.${read.why}`, { limit: read.limit ?? '', pages: read.pages ?? '' }) : '';
}

/** What the table shows: a read or a question's table, or a kept PDF's table (`save`), whose balances may be missing. */
type Shown = Omit<Read, 'statement' | 'check'> & { statement: PdfTable };

/**
 * `pdf`: the table was read off a PDF, which may be kept as the statement instead; `asReceipt`: the
 * file may still be a receipt (the drop row); `save`: a kept PDF's table, saved as it is (no import),
 * its closing balance left empty when she types none.
 */
export function StatementRead({ read, pdf, act, go, asReceipt, columns, aside, save: saveTable }: {
  read: Shown; pdf: boolean; act?(action: ReadAction): Promise<unknown>; go(route: Route): void; asReceipt?: () => void;
  /** A CSV's table: its column question again (#425). */
  columns?: () => void;
  /** A CSV's table: the file out of the drop, nothing in the books (#425). */
  aside?: () => void;
  save?(table: PdfTable): Promise<unknown>;
}) {
  const facts = !!saveTable;
  const [draft, setDraft] = useState(() => draftOf(read.statement));
  const [busy, setBusy] = useState(false);
  const statement = useMemo(() => statementOf(draft, facts), [draft, facts]);
  const full = statement && hasBalances(statement) ? statement : undefined;
  // A table nobody filled checks nothing (#254): no «Geht auf», no «Einlesen».
  const blank = !!statement && isBlank(statement);
  const check = full && !blank ? checkStatement(full) : undefined;
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
    if (!full) return;
    setBusy(true);
    try { await act?.({ kind: 'read', statement: full, import: true }); } finally { setBusy(false); }
  };
  const knownCount = known.filter(Boolean).length;
  // Nothing to read in: a CSV beside a bank export, or a PDF whose every day a structured source covers.
  const stuck = !!read.covered && (read.by === 'csv' || !!read.whole);
  // A CSV that does not add up, or has nothing to read in, ends with a way out (#425): other columns, or the file set aside.
  const wayOut = read.by === 'csv' && !facts && (stuck || (!!check && !check.ok));
  const keep = async () => {
    setBusy(true);
    try { await act?.({ kind: 'keep', ...(full ? { statement: full } : {}) }); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!statement) return;
    setBusy(true);
    try { await saveTable?.(statement); } finally { setBusy(false); }
  };
  return (
    <div className="dread" data-testid="drop-read">
      <div className="dread-hd">
        <span className={`dchip r-${read.by}`} data-testid="drop-read-by">{t(`drop.read.by.${read.by}`)}</span>
        {read.why ? <small data-testid="drop-read-why" data-why={read.why}>{whyText(read)}</small> : null}
        {read.why === 'noAi' || read.why === 'noProvider' ? <button type="button" className="linkbtn" data-testid="drop-read-ai" onClick={() => go({ area: 'company', section: 'ai' })}>{t('aiOff.toFirma')}</button> : null}
      </div>
      {read.covered ? (
        <p className="dwhy" data-testid="drop-read-covered" data-whole={!!read.whole}>
          {t(read.by === 'csv' ? 'drop.read.covered' : read.whole ? 'drop.read.coveredAll' : 'drop.read.coveredSome', {
            days: read.covered.map((c) => t('drop.read.coveredDays', { file: c.file.split('/').pop() ?? c.file, from: formatDate(c.from), to: formatDate(c.to) })).join('; '),
            file: read.covered[0].file.split('/').pop() ?? read.covered[0].file, from: formatDate(read.covered[0].from), to: formatDate(read.covered[0].to),
          })}
        </p>
      ) : null}
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
                <td className="amt"><input className="amt" inputMode="decimal" value={m.amount} aria-label={t('drop.read.amount')} onChange={(e) => line(i, { amount: e.target.value })} />{m.original ? <small className="m mono">{m.original.currency} {fmt(m.original.amount)}</small> : null}</td>
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
      <div className={`dread-check ${check?.ok ? 'ok' : blank || (statement && !full) ? 'blank' : 'gap'}`} data-testid="drop-read-check" data-ok={!!check?.ok}>
        {!statement ? t('drop.read.incomplete')
          : blank ? t('drop.read.blank')
          : !full ? t('drop.read.noBalance')
          : check!.ok ? t('drop.read.ok', { n: full.movements.length, currency: full.currency, closing: fmt(full.closing.amount) })
          : check!.gaps.map((g, i) => <span key={i}>{gapText(g, statement.currency)}</span>)}
        {statement && knownCount ? <span className="m">{t('drop.read.knownCount', { n: knownCount })}</span> : null}
      </div>
      {wayOut && !stuck ? <p className="dwhy" data-testid="drop-read-wayout">{t('drop.read.csvGap')}</p> : null}
      {facts ? (
        <div className="dread-acts">
          <small className="m">{t('drop.read.factsSave')}</small>
          <button type="button" className="btn primary" data-testid="drop-read-save" disabled={!statement || blank || busy} onClick={() => void save()}>{t('common.save')}</button>
        </div>
      ) : <div className="dread-acts">
        {asReceipt ? <button type="button" className="linkbtn" onClick={asReceipt}>{t('drop.isReceipt')}</button> : null}
        {wayOut && columns && !stuck ? <button type="button" className="linkbtn" data-testid="drop-read-columns" disabled={busy} onClick={columns}>{t('drop.read.columns')}</button> : null}
        {wayOut && aside ? <button type="button" className={stuck ? 'btn primary' : 'btn'} data-testid="drop-read-aside" disabled={busy} onClick={aside}>{t('drop.read.aside')}</button> : null}
        {pdf ? <button type="button" className={stuck ? 'btn primary' : 'btn'} data-testid="drop-read-keep" disabled={busy} data-tip={t('drop.read.keepTip')} onClick={() => void keep()}>{t('drop.read.keep')}</button> : null}
        {stuck ? null : <button type="button" className="btn primary" data-testid="drop-read-import" disabled={!check?.ok || busy} data-tip={check?.ok ? undefined : t('drop.read.importBlocked')} onClick={() => void importIt()}>{t('drop.read.import')}</button>}
      </div>}
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
