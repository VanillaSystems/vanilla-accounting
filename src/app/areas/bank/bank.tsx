/**
 * Kontoauszüge: each bank account's monthly statements of a period, by account or by month, a
 * month without its statement shown as missing; the statement on the right with its balance
 * check, the PDF with the chosen payment's line marked, and its payments beside it.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Index } from '../../../types/index.js';
import { localToday, booksOpenPeriod, type Period } from '../../../accounting/periods.js';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { moveKey } from '../../shell/keyboard.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { monthName, periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem, PaletteItem } from '../index.js';
import { I } from '../receipts/icons.js';
import { Kbd } from '../receipts/commands.js';
import { at } from '../receipts/view.js';
import { badgeCount, matches, payHaystack, payText, signed, troubled, type Bank, type Check, type Statement, type StatementFile } from './model.js';
import { bankFor, listed, setUi, toggleGroup, ui, useUi } from './state.js';
import { importStatements, statementAdd } from './actions.js';
import { Detail, statementName } from './Detail.js';
import { StatementReads } from './PdfFacts.js';
import { useSelectionFollowsRows } from '../../hooks/use-selection-follows-rows.js';
import './bank.css';
import { filing } from '../../../engines/index.js';
import { useAutomation } from '../../automation/store.js';
import { bookingRun } from '../../../workflows/processing.js';

type Props = AreaProps<RouteOf<'bank'>>;

/** The words of the receipts linked to each payment, for search. */
function receiptWords(books: Index): Map<string, string> {
  const byId = new Map(books.receipts.map((r) => [r.id, `${r.description ?? ''} ${r.filename}`]));
  const out = new Map<string, string>();
  for (const m of books.mappings) out.set(m.transactionRef, `${out.get(m.transactionRef) ?? ''} ${byId.get(m.receiptId) ?? ''}`);
  return out;
}

interface Row { s: Statement; c?: Check; n: number; open: number; hits: number }

function rowsOf(b: Bank, books: Index, period: Period, q: string | undefined): Row[] {
  const words = receiptWords(books);
  return b.statements(period.from, period.to).flatMap((s) => {
    const pays = b.payments(s);
    const hits = q ? pays.filter((p) => matches(payHaystack(p, words.get(p.ref) ?? ''), q)).length : 0;
    const named = !!q && matches(`${s.account.label} ${statementName(s)} ${t('bank.statement')}`.toLowerCase(), q);
    if (q && !named && !hits) return [];
    return [{ s, c: s.file ? b.check(s) : undefined, n: pays.length, open: pays.filter(b.needsReceipt).length, hits }];
  });
}

/** The statement files of the period, each whole (#208): those whose name, account or movements the search finds. */
function fileRowsOf(b: Bank, books: Index, period: Period, q: string | undefined): StatementFile[] {
  const words = receiptWords(books);
  return b.files(period.from, period.to).filter((f) => !q || matches(`${f.account.label} ${f.file.filename}`.toLowerCase(), q)
    || f.payments.some((p) => matches(payHaystack(p, words.get(p.ref) ?? ''), q)));
}

function List(props: Props) {
  const { route, query, period, books, nav, canEdit } = props;
  const s = useUi();
  const ws = useWorkspace();
  const b = bankFor(books, ws?.bankAccounts);
  const rows = useMemo(() => rowsOf(b, books, period, query.q), [b, books, period, query.q]);
  const byMonth = s.groupBy === 'monat';
  const byFile = s.groupBy === 'datei';
  const fileRows = useMemo(() => (byFile ? fileRowsOf(b, books, period, query.q) : []), [byFile, b, books, period, query.q]);
  const fileGroups = b.accounts.map((a) => ({ key: `bankf:${a.account}`, label: a.label, files: fileRows.filter((f) => f.account === a) })).filter((g) => g.files.length);
  const groups = byMonth
    ? [...rows.reduce((m, r) => m.set(r.s.to.slice(0, 7), [...(m.get(r.s.to.slice(0, 7)) ?? []), r]), new Map<string, Row[]>())]
        .sort((x, y) => y[0].localeCompare(x[0]))
        .map(([ym, rs]) => ({ key: `bankm:${ym}`, label: monthName(`${ym}-01`), rows: rs, side: t('bank.nOfM', { n: rs.filter((r) => r.s.file).length, m: rs.length }) }))
    : b.accounts.map((a) => {
        const rs = rows.filter((r) => r.s.account === a);
        const last = rs.find((r) => r.c?.close != null);
        return { key: `bank:${a.account}`, label: a.label, rows: rs, side: last ? `${a.currency} ${fmt(last.c!.close!)}` : '' };
      }).filter((g) => g.rows.length);
  const keys = byFile ? fileGroups.filter((g) => !s.collapsed.has(g.key)).flatMap((g) => g.files.map((f) => f.key))
    : groups.filter((g) => !s.collapsed.has(g.key)).flatMap((g) => g.rows.map((r) => r.s.key));
  listed.keys = keys;

  const files = rows.filter((r) => r.s.file).length;
  const missing = rows.filter((r) => r.s.missing).length;
  const without = rows.filter((r) => !r.s.file && !r.s.running && !r.s.missing).length;
  const gaps = rows.filter((r) => r.c?.gap).length;
  const bad = rows.filter((r) => r.c && troubled(b, r.s)).length - gaps;
  const strays = useMemo(() => b.strays(period.from, period.to), [b, period.from, period.to]);
  const open = (d: string) => !b.closedThrough || d > b.closedThrough;
  const booking = !!bookingRun(useAutomation().view?.runs ?? []);
  const unbooked = useMemo(() => books.transactions.filter((x) => x.date >= period.from && x.date <= period.to && open(x.date) && b.unbooked(x) && !!b.statementOf(x))
    .sort((x, y) => x.date.localeCompare(y.date)), [b, books, period.from, period.to]);

  // /payments/<ref> resolves to its statement, or its entry when paid privately; a list with nothing selected selects its
  // first row. A link to what the books do not hold (yet: they reload after an import) keeps its place with a notice.
  const [notice, setNotice] = useState('');
  const seen = useRef<string>();
  useEffect(() => {
    if (!ws) return;
    // A file's link shows the files; a statement's or payment's link the statements.
    if (route.file && !byFile) { setUi({ groupBy: 'datei' }); return; }
    if ((route.statement || route.payment) && byFile) { setUi({ groupBy: 'konto' }); return; }
    const here = JSON.stringify([route, query.period?.token, byFile]);
    if (seen.current === here) return;
    if (route.file) {
      const f = b.fileByKey(route.file);
      if (!f) { setNotice(t('bank.fileGone', { key: route.file })); return; }
      seen.current = here;
      setNotice('');
      if (!query.period && (f.file.toDate < period.from || f.file.fromDate > period.to)) nav.go(at(route, f.file.fromDate));
      return;
    }
    if (route.payment && !route.statement) {
      const tx = b.txByRef.get(route.payment);
      const st = tx && b.statementOf(tx);
      if (st && tx) { seen.current = here; nav.go(at({ area: 'bank', statement: st.key, payment: tx.ref }, tx.date, query.period)); return; }
      const entry = b.entriesOf(route.payment)[0];
      if (entry) { seen.current = here; nav.go(at({ area: 'journal', id: entry.id }, entry.date)); return; }
      setNotice(tx ? t('bank.privateNotice') : t('bank.paymentGone', { ref: route.payment }));
      return;
    }
    if (route.statement) {
      const st = b.byKey(route.statement);
      if (!st) { setNotice(t('bank.statementGone', { key: route.statement })); return; }
      seen.current = here;
      setNotice('');
      if (!query.period && (st.to < period.from || st.from > period.to)) nav.go(at(route, st.from));
      return;
    }
    seen.current = here;
    setNotice('');
    if (keys[0]) nav.select(byFile ? { area: 'bank', file: keys[0] } : { area: 'bank', statement: keys[0] });
  }, [ws, JSON.stringify(route), query.period?.token, keys[0], b, byFile]);

  const select = (key: string) => nav.select(byFile ? { area: 'bank', file: key } : { area: 'bank', statement: key });
  // A file's link to another period keeps its file while the period follows it.
  const linked = route.file ? b.fileByKey(route.file) : undefined;
  const elsewhere = !!linked && (linked.file.toDate < period.from || linked.file.fromDate > period.to);
  useSelectionFollowsRows(byFile ? route.file : route.statement, keys, select, elsewhere);

  return (
    <div className="page">
      <ListHead period={period} books={books} canEdit={canEdit}>
        <div className="counts stc">
          <span>{t('bank.nStatements', { n: files })}</span>
          {missing > 0 && <span className="warn" data-testid="missing-count">{I.dot}{t('bank.nMissing', { n: missing })}</span>}
          {without > 0 && <span data-testid="without-count" data-tip={t('bank.withoutTip')}>{t('bank.nWithout', { n: without })}</span>}
          {gaps > 0 && <span className="warn" data-testid="gap-count">{I.dot}{t('bank.nGaps', { n: gaps })}</span>}
          {bad > 0
            ? <span className="warn">{I.dot}{t('bank.nDiffer', { n: bad })}</span>
            : files > 0 && !gaps && !strays.length && <span className="ok" data-tip={t('bank.balancesOkTip')}>{I.check}{t('bank.balancesOk')}</span>}
          {unbooked.length > 0 && (
            // While the inbox's run is open, it books them (#218): a fact, not yet the person's to do.
            <button type="button" className={`${booking ? 'm' : 'warn'} golink`} data-testid="unbooked-count" data-booking={booking ? 'yes' : undefined} data-tip={t(booking ? 'bank.bookingTip' : 'bank.unbookedTip')} onClick={() => nav.go(at({ area: 'bank', payment: unbooked[0].ref }, unbooked[0].date, query.period))}>
              {booking ? <span className="spin small" aria-hidden="true" /> : I.dot}{t(booking ? 'bank.nBooking' : 'bank.nUnbooked', { n: unbooked.length })}
            </button>
          )}
          <span className="seg gb" role="tablist" aria-label={t('bank.groupBy')}>
            {(['konto', 'monat', 'datei'] as const).map((g) => (
              <button key={g} type="button" role="tab" aria-selected={s.groupBy === g} className={s.groupBy === g ? 'on' : ''} data-bg={g} onClick={() => {
                // Into or out of the files the selection goes: a statement is no file, a file no statement.
                if ((g === 'datei') !== byFile) nav.select({ area: 'bank' });
                setUi({ groupBy: g });
              }}>
                {t(g === 'konto' ? 'bank.byAccount' : g === 'monat' ? 'bank.byMonth' : 'bank.byFile')}
              </button>
            ))}
          </span>
          <label className="search">
            {ICONS.search}
            <span className="sr">{t('bank.searchLabel')}</span>
            <input
              type="search"
              placeholder={t('shell.search')}
              value={query.q ?? ''}
              className={query.q ? 'has' : ''}
              autoComplete="off"
              onChange={(e) => nav.setQuery({ q: e.target.value || undefined })}
              onKeyDown={(e) => { if (e.key === 'Escape') nav.setQuery({ q: undefined }); }}
            />
            <Kbd keys={['/']} tip={t('bank.searchTip')} />
          </label>
        </div>
      </ListHead>
      {notice && <div className="notice" role="status">{notice}</div>}
      {ws ? <StatementReads nav={nav} canEdit={canEdit} version={books} /> : null}
      {strays.length > 0 && (
        <div className="notice warn strays" data-testid="bank-strays">
          <span>{t('bank.strays', { n: strays.length })}</span>
          {strays.map((e) => (
            <button key={e.id} type="button" className="golink" onClick={() => nav.go(at({ area: 'journal', id: e.id }, e.date))}>
              <span className="mono">{formatDate(e.date)}</span> {e.accountDebit || '–'} / {e.accountCredit || '–'} <span className="mono">{fmt(e.amount)}</span> {e.description}
            </button>
          ))}
        </div>
      )}

      {!ws ? null : byFile ? (fileGroups.length === 0 ? (
        <div className="empty"><h2>{query.q ? t('bank.nothingFound') : t('bank.filesEmpty', { period: periodName(period) })}</h2></div>
      ) : (
        <div className="rows" role="listbox" aria-label={t('area.bank')}>
          {fileGroups.map((g) => {
            const shut = s.collapsed.has(g.key);
            return (
              <Fragment key={g.key}>
                <button type="button" className={`group${shut ? ' shut' : ''}`} aria-expanded={!shut} data-tip={shut ? t('receipts.expand') : t('receipts.collapse')} onClick={() => toggleGroup(g.key)}>
                  <span>{I.gch}{g.label}</span><span className="mono">{g.files.length}</span>
                </button>
                {!shut && g.files.map((f) => <FileRow key={f.key} f={f} sel={f.key === route.file} onSelect={select} />)}
              </Fragment>
            );
          })}
        </div>
      )) : rows.length === 0 ? (
        <div className="empty">
          <h2>{query.q ? t('bank.nothingFound') : t('bank.emptyTitle', { period: periodName(period) })}</h2>
          <p>{t('bank.emptyText')}</p>
          {canEdit && !query.q && (
            <button type="button" className="well" style={{ width: '100%' }} onClick={() => statementAdd.run(props as AreaProps)}>
              <span><b>{t('bank.well')}</b>{t('bank.wellAny')}</span>
            </button>
          )}
        </div>
      ) : (
        <div className="rows" role="listbox" aria-label={t('area.bank')}>
          {groups.map((g) => {
            const shut = s.collapsed.has(g.key);
            return (
              <Fragment key={g.key}>
                <button type="button" className={`group${shut ? ' shut' : ''}`} aria-expanded={!shut} data-tip={shut ? t('receipts.expand') : t('receipts.collapse')} onClick={() => toggleGroup(g.key)}>
                  <span>{I.gch}{g.label}</span><span className="mono">{g.side}</span>
                </button>
                {!shut && g.rows.map((r, i) => (
                  <StatementRow key={r.s.key} r={r} byMonth={byMonth} same={i > 0 && g.rows[i - 1].s.to === r.s.to} sel={r.s.key === route.statement} searching={!!query.q} bad={troubled(b, r.s)} onSelect={select} />
                ))}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatementRow({ r, byMonth, same, sel, searching, bad, onSelect }: { r: Row; byMonth: boolean; same: boolean; sel: boolean; searching: boolean; bad: boolean; onSelect(key: string): void }) {
  const { s } = r;
  const count = searching && r.hits ? t('bank.nHits', { n: r.hits }) : t('bank.nPayments', { n: r.n });
  const sub = !s.file ? t(s.receipts ? 'bank.receiptStatement' : s.running ? 'bank.running' : s.missing ? 'bank.missing' : 'bank.without')
    : s.part ? `${t('bank.fromExport')} · ${count}` : s.export ? `${count} · ${t('bank.inExport')}` : count;
  return (
    <div className={`row${sel ? ' sel' : ''}${s.missing ? ' missing' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-stmt={s.key} onClick={() => onSelect(s.key)}>
      <span className="d mono">{same ? <span className="sr">{formatDate(s.to)}</span> : <><span className="dl">{formatDate(s.to)}</span><span className="ds">{formatDate(s.to).slice(0, 6)}</span></>}</span>
      <span className="t">{bad && I.dot}{byMonth ? s.account.label : statementName(s)} <small>{sub}{r.open > 0 && <> · <span className="wn">{t('bank.nWithoutReceipt', { n: r.open })}</span></>}</small></span>
      <span className="a mono">{r.c?.close != null ? fmt(r.c.close) : ''}</span>
    </div>
  );
}

/** One statement file whole: its last day, its name and days, how many movements it holds, its closing balance. */
function FileRow({ f, sel, onSelect }: { f: StatementFile; sel: boolean; onSelect(key: string): void }) {
  return (
    <div className={`row${sel ? ' sel' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-file={f.key} onClick={() => onSelect(f.key)}>
      <span className="d mono"><span className="dl">{formatDate(f.file.toDate)}</span><span className="ds">{formatDate(f.file.toDate).slice(0, 6)}</span></span>
      <span className="t">{f.file.filename} <small>{formatDate(f.file.fromDate)} – {formatDate(f.file.toDate)} · {t('bank.nPayments', { n: f.payments.length })}</small></span>
      <span className="a mono">{f.closing ? fmt(f.closing.amount) : ''}</span>
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('bank.keyStatement'), t('bank.keyStatementTip')],
  [['␣'], t('bank.keyLarge'), t('bank.keyLargeTip')],
  [['D'], t('bank.keyDownload'), t('bank.keyDownloadTip')],
  [['N'], t('keys.new'), t('bank.addTitle')],
  [['⌘', '⇧'], t('keys.pick'), t('keys.pickTip')],
  [['A'], t('keys.actions'), t('keys.actionsTip')],
  [['/'], t('keys.search'), t('bank.searchTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

function palette({ books, nav, period }: AreaProps): PaletteItem[] {
  const b = bankFor(books);
  const open = booksOpenPeriod(books, localToday(), filing().length);
  const statements = b.statements('0000-01-01', localToday()).filter((s) => s.file || s.from >= open.from).map((s) => ({
    label: `${t('bank.statementOf', { name: statementName(s) })} · ${s.account.label}`,
    side: t(s.file ? 'bank.statement' : s.missing ? 'bank.missing' : 'bank.without'),
    run: () => nav.go(at({ area: 'bank', statement: s.key }, s.from, period)),
  }));
  const payments = [...b.txByRef.values()].filter((tx) => b.statementOf(tx)).sort((x, y) => y.date.localeCompare(x.date)).map((tx) => ({
    label: payText(tx).name,
    side: `${formatDate(tx.date)}  ${tx.currency} ${fmt(signed(tx))}`,
    run: () => nav.go(at({ area: 'bank', statement: b.statementOf(tx)!.key, payment: tx.ref }, tx.date, period)),
  }));
  return [...statements, ...payments];
}

export const bank: Area<RouteOf<'bank'>> = {
  id: 'bank',
  periodRows: true,
  selects: 'payment',
  label: () => t('area.bank'),
  dock: {
    key: 'k',
    icon: ICONS.bank,
    tip: () => t('area.bank.tip'),
    badge: (books) => badgeCount(bankFor(books), booksOpenPeriod(books, localToday(), filing().length).from, localToday()),
  },
  List,
  Detail,
  add: statementAdd,
  drop: { text: () => t('bank.dropText'), formats: () => t('bank.dropFormats'), run: (files, { nav }) => importStatements(files, nav) },
  legend,
  palette,
  title: (r, books) => {
    const b = bankFor(books);
    const tx = r.payment ? b.txByRef.get(r.payment) : undefined;
    if (tx) return payText(tx).name;
    const f = r.file ? b.fileByKey(r.file) : undefined;
    if (f) return `${f.file.filename} · ${f.account.label}`;
    const s = r.statement ? b.byKey(r.statement) : undefined;
    return s && `${statementName(s)} · ${s.account.label}`;
  },
  keys(e, p) {
    const s = ui();
    if (s.overlay === 'quick') {
      if (e.key === ' ' || e.key === 'Escape') setUi({ overlay: null });
      return !e.metaKey && !e.ctrlKey;
    }
    const d = moveKey(e);
    if (d) {
      const byFile = ui().groupBy === 'datei';
      const here = byFile ? p.route.file : p.route.statement;
      const i = here ? listed.keys.indexOf(here) : -1;
      const next = listed.keys[Math.min(listed.keys.length - 1, Math.max(0, i + d))];
      if (next) p.nav.select(byFile ? { area: 'bank', file: next } : { area: 'bank', statement: next });
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case ' ': {
        if (!document.querySelector('.detail .paper.stmt')) return false;
        setUi({ overlay: 'quick' });
        return true;
      }
      case 'd': case 'D': {
        const a = document.querySelector<HTMLAnchorElement>('.detail a.dl');
        a?.click();
        return !!a;
      }
      case 'Escape':
        if (p.route.payment && p.route.statement) { p.nav.select({ area: 'bank', statement: p.route.statement }); return true; }
        if (p.query.q) { p.nav.setQuery({ q: undefined }); return true; }
        return false;
    }
    return false;
  },
};
