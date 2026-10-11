/**
 * Kontoauszüge: each bank account's monthly statements of a period, by account or by month, a
 * month without its statement shown as missing; the statement on the right with its balance
 * check, the PDF with the chosen payment's line marked, and its payments beside it.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Index } from '../../../types/index.js';
import { localToday, openQuarter, type Period } from '../../../accounting/periods.js';
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
import { badgeCount, matches, payHaystack, payText, signed, troubled, type Bank, type Check, type Statement } from './model.js';
import { bankFor, listed, setUi, toggleGroup, ui, useUi } from './state.js';
import { importStatements, statementAdd } from './actions.js';
import { Detail, statementName } from './Detail.js';
import { useSelectionFollowsRows } from '../../hooks/use-selection-follows-rows.js';
import './bank.css';

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

function List(props: Props) {
  const { route, query, period, books, nav, canEdit } = props;
  const s = useUi();
  const ws = useWorkspace();
  const b = bankFor(books, ws?.bankAccounts);
  const rows = useMemo(() => rowsOf(b, books, period, query.q), [b, books, period, query.q]);
  const byMonth = s.groupBy === 'monat';
  const groups = byMonth
    ? [...rows.reduce((m, r) => m.set(r.s.to.slice(0, 7), [...(m.get(r.s.to.slice(0, 7)) ?? []), r]), new Map<string, Row[]>())]
        .sort((x, y) => y[0].localeCompare(x[0]))
        .map(([ym, rs]) => ({ key: `bankm:${ym}`, label: monthName(`${ym}-01`), rows: rs, side: t('bank.nOfM', { n: rs.filter((r) => r.s.file).length, m: rs.length }) }))
    : b.accounts.map((a) => {
        const rs = rows.filter((r) => r.s.account === a);
        const last = rs.find((r) => r.c?.close != null);
        return { key: `bank:${a.account}`, label: a.label, rows: rs, side: last ? `${a.currency} ${fmt(last.c!.close!)}` : '' };
      }).filter((g) => g.rows.length);
  const keys = groups.filter((g) => !s.collapsed.has(g.key)).flatMap((g) => g.rows.map((r) => r.s.key));
  listed.keys = keys;

  const files = rows.filter((r) => r.s.file).length;
  const missing = rows.filter((r) => !r.s.file && !r.s.running).length;
  const bad = rows.filter((r) => r.c && troubled(b, r.s)).length;

  // /payments/<ref> resolves to its statement, or its entry when paid privately; a list with nothing selected selects its
  // first row. A link to what the books do not hold (yet: they reload after an import) keeps its place with a notice.
  const [notice, setNotice] = useState('');
  const seen = useRef<string>();
  useEffect(() => {
    if (!ws) return;
    const here = JSON.stringify([route, query.period?.token]);
    if (seen.current === here) return;
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
    if (keys[0]) nav.select({ area: 'bank', statement: keys[0] });
  }, [ws, JSON.stringify(route), query.period?.token, keys[0], b]);

  const select = (key: string) => nav.select({ area: 'bank', statement: key });
  useSelectionFollowsRows(route.statement, keys, select, books);

  return (
    <div className="page">
      <ListHead period={period} books={books} canEdit={canEdit}>
        <div className="counts stc">
          <span>{t('bank.nStatements', { n: files })}</span>
          {missing > 0 && <span className="warn">{I.dot}{t('bank.nMissing', { n: missing })}</span>}
          {bad > 0
            ? <span className="warn">{I.dot}{t('bank.nDiffer', { n: bad })}</span>
            : files > 0 && <span className="ok" title={t('bank.balancesOkTip')}>{I.check}{t('bank.balancesOk')}</span>}
          <span className="seg gb" role="tablist" aria-label={t('bank.groupBy')}>
            {(['konto', 'monat'] as const).map((g) => (
              <button key={g} type="button" role="tab" aria-selected={s.groupBy === g} className={s.groupBy === g ? 'on' : ''} data-bg={g} onClick={() => setUi({ groupBy: g })}>
                {t(g === 'konto' ? 'bank.byAccount' : 'bank.byMonth')}
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

      {!ws ? null : rows.length === 0 ? (
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
                <button type="button" className={`group${shut ? ' shut' : ''}`} aria-expanded={!shut} title={shut ? t('receipts.expand') : t('receipts.collapse')} onClick={() => toggleGroup(g.key)}>
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
  const sub = !s.file ? t(s.running ? 'bank.running' : 'bank.missing') : searching && r.hits ? t('bank.nHits', { n: r.hits }) : t('bank.nPayments', { n: r.n });
  return (
    <div className={`row${sel ? ' sel' : ''}${!s.file && !s.running ? ' missing' : ''}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-stmt={s.key} onClick={() => onSelect(s.key)}>
      <span className="d mono">{same ? <span className="sr">{formatDate(s.to)}</span> : formatDate(s.to)}</span>
      <span className="t">{bad && I.dot}{byMonth ? s.account.label : statementName(s)} <small>{sub}{r.open > 0 && <> · <span className="wn">{t('bank.nWithoutReceipt', { n: r.open })}</span></>}</small></span>
      <span className="a mono">{r.c?.close != null ? fmt(r.c.close) : ''}</span>
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('bank.keyStatement'), t('bank.keyStatementTip')],
  [['␣'], t('bank.keyLarge'), t('bank.keyLargeTip')],
  [['D'], t('bank.keyDownload'), t('bank.keyDownloadTip')],
  [['N'], t('keys.new'), t('bank.addTitle')],
  [['/'], t('keys.search'), t('bank.searchTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

function palette({ books, nav, period }: AreaProps): PaletteItem[] {
  const b = bankFor(books);
  const open = openQuarter(books.config?.closedThrough, localToday());
  const statements = b.statements('0000-01-01', localToday()).filter((s) => s.file || s.from >= open.from).map((s) => ({
    label: `${t('bank.statementOf', { name: statementName(s) })} · ${s.account.label}`,
    side: s.file ? t('bank.statement') : t('bank.missing'),
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
  label: () => t('area.bank'),
  dock: {
    key: 'k',
    icon: ICONS.bank,
    tip: () => t('area.bank.tip'),
    badge: (books) => badgeCount(bankFor(books), openQuarter(books.config?.closedThrough, localToday()).from, localToday()),
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
      const i = p.route.statement ? listed.keys.indexOf(p.route.statement) : -1;
      const next = listed.keys[Math.min(listed.keys.length - 1, Math.max(0, i + d))];
      if (next) p.nav.select({ area: 'bank', statement: next });
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
