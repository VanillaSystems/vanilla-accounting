/**
 * MWST-Codes: the app's catalogue by family, with how often the period uses each code; the code
 * explained on the right: when to use it, when not, what its amount is, its Ziffern, an example
 * from the casebook, the rules that choose it and the period's entries that carry it.
 */
import { Fragment, useEffect, useMemo } from 'react';
import { vatCodes, lookupVatCode } from '../../../accounting/vat-codes.js';
import type { RouteOf } from '../../shell/route.js';
import { ListHead } from '../../shell/ListHead.js';
import { moveKey } from '../../shell/keyboard.js';
import { periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { ICONS } from '../icons.js';
import type { Area, AreaProps, LegendItem } from '../index.js';
import { I } from '../receipts/icons.js';
import { Kbd } from '../receipts/commands.js';
import { codeGroups, splitCodes, vatStats, type CodeRow } from './model.js';
import { codesUi, setCodesUi, toggleFamily, useCodesUi } from './state.js';
import { amountText, codeText, kindName, rateName, rateOf, showOnly, VatCards, zifferName } from './vat-card.js';

type Props = AreaProps<RouteOf<'codes'>>;

const kindWhen = (r: CodeRow) => t(`vatCodes.kind.${r.entry.kind}.when`);
const searchText = (r: CodeRow) => [r.entry.bananaText, kindName(r.entry), kindWhen(r)].join(' ');

/** The codes as last shown, in ↑↓ order. */
const listed: { codes: string[] } = { codes: [] };

function List(props: Props) {
  const { route, query, period, books, nav, canEdit } = props;
  const s = useCodesUi();
  const stats = useMemo(() => vatStats(books.journalEntries ?? [], period), [books, period]);
  const groups = useMemo(() => codeGroups(stats, searchText, query.q, s.usedOnly), [stats, query.q, s.usedOnly]);
  const used = stats.filter((x) => lookupVatCode(x.code)).length;
  listed.codes = groups.filter((g) => !s.collapsed.has(g.family)).flatMap((g) => g.rows.map((r) => r.code));

  useEffect(() => {
    if (!route.code && listed.codes[0]) nav.select({ area: 'codes', code: listed.codes[0] });
    const family = route.code && lookupVatCode(route.code)?.entry.family;
    if (family && s.collapsed.has(family)) toggleFamily(family, true);
  }, [route.code, listed.codes[0]]);

  return (
    <div className="page">
      <ListHead period={period} books={books} canEdit={canEdit}>
        <div className="counts" role="tablist" aria-label={t('codes.filters')}>
          <button type="button" role="tab" aria-selected={!s.usedOnly} className={s.usedOnly ? '' : 'on'} onClick={() => setCodesUi({ usedOnly: false })}><span className="n">{vatCodes().length}</span>{t('codes.all')}</button>
          <button type="button" role="tab" aria-selected={s.usedOnly} className={s.usedOnly ? 'on' : ''} onClick={() => setCodesUi({ usedOnly: true })}><span className="n">{used}</span>{t('codes.used')}</button>
          <label className="search">
            {ICONS.search}
            <span className="sr">{t('codes.searchLabel')}</span>
            <input
              type="search"
              placeholder={t('shell.search')}
              value={query.q ?? ''}
              className={query.q ? 'has' : ''}
              autoComplete="off"
              onChange={(e) => nav.setQuery({ q: e.target.value || undefined })}
              onKeyDown={(e) => { if (e.key === 'Escape') nav.setQuery({ q: undefined }); }}
            />
            <Kbd keys={['/']} tip={t('codes.searchTip')} />
          </label>
        </div>
      </ListHead>
      {groups.length === 0 ? (
        <div className="empty"><h2>{t('vatCodes.noMatch')}</h2></div>
      ) : (
        <div className="rows" role="listbox" aria-label={t('area.codes')}>
          {groups.map((g) => {
            const shut = s.collapsed.has(g.family);
            return (
              <Fragment key={g.family}>
                <button type="button" className={`group${shut ? ' shut' : ''}`} aria-expanded={!shut} title={shut ? t('receipts.expand') : t('receipts.collapse')} onClick={() => toggleFamily(g.family)}>
                  <span>{I.gch}{g.family} · {t(`vatCodes.family.${g.family}`)}</span><span className="mono">{g.rows.length}</span>
                </button>
                {!shut && g.rows.map((r) => {
                  const sel = r.code === route.code;
                  return (
                    <div key={r.code} className={`row code${sel ? ' sel' : ''}${r.n ? '' : ' unused'}`} role="option" aria-selected={sel} tabIndex={sel ? 0 : -1} data-code={r.code} onClick={() => nav.select({ area: 'codes', code: r.code })}>
                      <span className="d mono">{r.code}</span>
                      <span className="t">{r.entry.bananaText ?? kindName(r.entry)}</span>
                      <span className="a mono">{r.n || ''}</span>
                    </div>
                  );
                })}
              </Fragment>
            );
          })}
        </div>
      )}
      <VatCards {...(props as AreaProps)} />
    </div>
  );
}

const SHOWN_ENTRIES = 12;

function Detail(props: Props) {
  const { route, books, period, nav } = props;
  const found = route.code ? lookupVatCode(route.code) : null;
  const entries = useMemo(() => (books.journalEntries ?? []).filter((e) => e.vatCode === route.code && e.date >= period.from && e.date <= period.to)
    .sort((a, b) => b.date.localeCompare(a.date)), [books, period, route.code]);
  if (!route.code || !found) return <div className="detail-empty"><div>{route.code ? t('vatCodes.unknown') : t('vatCodes.select')}</div></div>;
  const { entry: e, negative } = found;
  const code = route.code;
  const goCode = (c: string) => nav.select({ area: 'codes', code: c });

  return (
    <div className="detail-in doc" data-for={code}>
      <div className="head">
        <h2 className="who">{kindName(e)}<small>{e.family} · {t(`vatCodes.family.${e.family}`)}</small></h2>
        <div className="amount"><small>{e.rate ? t('journal.field.vatCode') : ''}</small>{code}</div>
      </div>
      <div className="facts">
        <span>{e.bananaText ?? t('vatCodes.notInBanana')}</span>
        <span>{rateOf(e)}{rateName(e) && ` ${rateName(e)}`}</span>
        {e.superseded && <span className="nov">{t('vatCodes.superseded')}</span>}
      </div>
      {negative && <div className="notice">{t('vatCodes.negative', { code: e.code })}</div>}
      <div className="docbody">
        <section><h3>{t('vatCodes.when')}</h3><p>{t(`vatCodes.kind.${e.kind}.when`)}</p></section>
        <section>
          <h3>{t('vatCodes.notWhen')}</h3>
          <p>{splitCodes(t(`vatCodes.kind.${e.kind}.notWhen`)).map((part, i) => part.code
            ? <button key={i} type="button" className="clink mono" data-vat={part.code} onClick={() => goCode(part.code!)}>{part.text}</button>
            : <Fragment key={i}>{part.text}</Fragment>)}</p>
        </section>
        {!!e.rate && <section><h3>{t('codes.amount')}</h3><p>{amountText(e)}</p></section>}
        <section>
          <h3>{t('vatCodes.ziffern')}</h3>
          {e.ziffern?.length
            ? <dl className="zf">{e.ziffern.map((z) => <Fragment key={z.ziffer}><dt className="mono">{z.ziffer}</dt><dd>{zifferName(z.ziffer)}</dd></Fragment>)}</dl>
            : <p>{e.ziffern === null ? t('vatCodes.notDeclared') : t('vatCodes.noZiffer')}</p>}
          {e.ziffern === null && e.bananaZiffern.length > 0 && <p className="m">{t('vatCodes.bananaZiffern', { ziffern: e.bananaZiffern.join(', ') })}</p>}
        </section>
        {e.examples.length > 0 && (
          <section>
            <h3>{t('vatCodes.example')}</h3>
            {e.examples.slice(0, 3).map((x) => (
              <div key={`${x.caseId}-${x.description}`} className="ex">
                <div className="ext">{x.title}</div>
                <div className="exl mono"><span>{x.debit || '–'} / {x.credit || '–'}</span><span>{x.vatCode}</span><span>{x.currency ?? 'CHF'} {fmt(x.amount)}</span></div>
                <div className="exd">{x.description}</div>
              </div>
            ))}
          </section>
        )}
        {e.rules.length > 0 && <section><h3>{t('vatCodes.rules')}</h3><p className="mono rl">{e.rules.join(' · ')}</p></section>}
        <section>
          <h3>{t('vatCodes.entries', { code })} · {periodName(period)}</h3>
          {entries.length ? (
            <>
              <div className="cj">
                {entries.slice(0, SHOWN_ENTRIES).map((x) => (
                  <button key={x.id} type="button" className="tx go" onClick={() => nav.go({ route: { area: 'journal', id: x.id }, query: { period: props.query.period } })}>
                    <span className="d">{formatDate(x.date)} · {x.accountDebit || '–'} / {x.accountCredit || '–'}</span>
                    <span className="am">{x.exchangeCurrency && x.exchangeCurrency !== 'CHF' ? `${x.exchangeCurrency} ` : ''}{fmt(x.amount)}</span>
                    <span className="tt">{x.description}</span>
                  </button>
                ))}
              </div>
              {entries.length > SHOWN_ENTRIES && <button type="button" className="more" onClick={() => showOnly(props as AreaProps, code)}>{t('codes.allEntries', { n: entries.length })}</button>}
            </>
          ) : <p className="m">{t('codes.noEntries', { code, period: periodName(period) })}</p>}
        </section>
        <p className="src-note">{t('codes.source')}</p>
      </div>
    </div>
  );
}

const legend = (): LegendItem[] => [
  [['↑', '↓'], t('codes.keyCode'), t('codes.keyCodeTip')],
  [['↵'], t('codes.keyEntries'), t('codes.showTip')],
  [['/'], t('keys.search'), t('codes.searchTip')],
  [['⌘', 'K'], t('keys.all'), t('keys.allTip')],
];

export const codes: Area<RouteOf<'codes'>> = {
  id: 'codes',
  label: () => t('area.codes'),
  dockAs: 'vat',
  List,
  Detail,
  legend,
  title: (r) => r.code,
  palette: ({ nav, query }) => vatCodes().map((c) => ({
    label: `${c.code} · ${codeText(c.code)}`,
    side: rateOf(c),
    run: () => nav.go({ route: { area: 'codes', code: c.code }, query: { period: query.period } }),
  })),
  keys(e, p) {
    if (codesUi().histogram) {
      if (e.key !== 'Escape') return false;
      setCodesUi({ histogram: false });
      return true;
    }
    const d = moveKey(e);
    if (d) {
      const i = p.route.code ? listed.codes.indexOf(p.route.code) : -1;
      const next = listed.codes[Math.min(listed.codes.length - 1, Math.max(0, i + d))];
      if (next) p.nav.select({ area: 'codes', code: next });
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === 'Enter' && p.route.code) { showOnly(p as AreaProps, p.route.code); return true; }
    if (e.key === 'Escape' && p.query.q) { p.nav.setQuery({ q: undefined }); return true; }
    return false;
  },
};
