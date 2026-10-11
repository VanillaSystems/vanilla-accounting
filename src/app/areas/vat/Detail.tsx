/**
 * One Ziffer: its figure, what it means, how it differs from the filed return, and either the sum
 * it is made of or the entries behind it, grouped by VAT code. The 0535 pseudo-Ziffer shows the
 * Korrekturabrechnung with its correction cases.
 */
import { Fragment, useMemo } from 'react';
import type { CorrectionCase, JournalEntry } from '../../../types/index.js';
import {
  caseEffect, figuresFromBooks, reconcileCases, roundCHF, vatLine, type ReturnFigures,
} from '../../../accounting/index.js';
import { derivePeriod } from '../../../accounting/periods.js';
import type { RouteOf } from '../../shell/route.js';
import { useWorkspace } from '../../hooks/use-workspace.js';
import { periodName } from '../../lib/period-label.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { AreaProps, Nav } from '../index.js';
import { FORM_0535, SUMS, byCode, correctedPeriod, filedDiff, formAmount, rateOf, type VatReturn } from './model.js';
import { effectLines, formSections } from './form0535.js';
import { CodeLink, Go, codeName, entryAt } from './links.js';
import { correctionDiff, signed, useReturn, zifferLabel } from './view.js';

type Props = AreaProps<RouteOf<'vat'>>;

export function Detail(props: Props) {
  const { route } = props;
  const { v, filed } = useReturn(props);
  if (route.ziffer === FORM_0535) {
    return filed ? <Correction {...props} v={v} filed={filed} /> : <div className="detail-empty"><div>{t('vat.noFiledReturn', { period: periodName(v.period) })}</div></div>;
  }
  const z = v.report.ziffern.find((x) => x.number === route.ziffer);
  if (!z) return <div className="detail-empty"><div>{t('vat.chooseZiffer')}</div></div>;
  return <Ziffer {...props} v={v} filed={filed} n={z.number} amount={z.amount} />;
}

/** What a Ziffer is, in one sentence. */
function explanation(v: VatReturn, n: string): string {
  const r = rateOf(v, n);
  if (r) return t(r.row.kind === 'supply' ? 'vat.xSupply' : 'vat.xAcquisition', { rate: r.row.rate });
  if (n in SUMS || n === '200') return t(`vat.x${n}` as 'vat.x289');
  return t(`vat.z${n}` as 'vat.z200');
}

function Ziffer({ v, filed, n, amount, nav, period }: Props & { v: VatReturn; filed?: ReturnFigures; n: string; amount: number }) {
  const r = rateOf(v, n);
  const lines = v.lines[n] ?? [];
  const adjustments = v.adjustments.filter((a) => a.ziffer === n);
  const was = filedDiff(v, filed, n);
  const now = formAmount(v, n);
  const corrections = n in SUMS ? v.corrections.length : lines.filter((l) => l.entry.corrects).length;
  const select = (x: string) => nav.select({ area: 'vat', ziffer: x });
  const supply = r?.row.kind === 'supply';
  const gross = Number(n) < 300 || supply;

  return (
    <div className="detail-in" key={`${v.key}:${n}`}>
      <div className="head">
        <h2 className="who">{zifferLabel(v, n)}<small>{t('vat.zifferOf', { n, period: periodName(v.period) })}</small></h2>
        <div className="amount"><small>CHF</small>{fmt(r ? r.tax : amount)}</div>
      </div>
      <div className="facts">
        {r && (
          <>
            <span title={t(supply ? 'vat.turnoverGrossTip' : 'vat.acquisitionNetTip')}>{t(supply ? 'vat.factTurnover' : 'vat.factAcquisition', { amount: fmt(supply ? r.base + r.tax : r.base) })}</span>
            <span>{t('vat.factRate', { rate: r.row.rate })}</span>
            <span>{t('vat.factTax', { amount: fmt(r.tax) })}</span>
          </>
        )}
        {lines.length > 0 && <span>{t('common.entryCount', { n: lines.length })}</span>}
      </div>
      <p className="zexpl">{explanation(v, n)}</p>
      {was != null && (
        <div className="notice warn">
          <span className="dot" aria-hidden="true" />
          <span>
            {t('vat.filedWas', { was: fmt(was), now: fmt(now) })}{' '}
            {corrections > 0 ? (
              <>{t('vat.diffFromCorrections', { diff: signed(roundCHF(now - was)), n: corrections })} <a href="#" onClick={(e) => { e.preventDefault(); select(FORM_0535); }}>{t('vat.open0535')}</a></>
            ) : t('vat.diffRounding')}
          </span>
        </div>
      )}
      {n in SUMS ? (
        <div className="formula">
          {SUMS[n].map((part) => {
            const minus = part.startsWith('-');
            const x = part.replace('-', '');
            const a = formAmount(v, x);
            if (SUMS[n].length > 4 && !a) return null;
            return (
              <button key={x} type="button" onClick={() => select(x)}>
                <span className="op">{minus ? '−' : '+'}</span><span className="mono zn">{x}</span><span>{zifferLabel(v, x)}</span><span className="mono">{fmt(rateOf(v, x)?.tax ?? a)}</span>
              </button>
            );
          })}
          <div className="eq"><span className="op">=</span><span className="mono zn">{n}</span><span>{zifferLabel(v, n)}</span><span className="mono">{fmt(amount)}</span></div>
        </div>
      ) : lines.length || adjustments.length ? (
        <div className="vlines">
          <div className="vh"><span>{t('col.date')}</span><span>{t('vat.colEntry')}</span><span className="r">{gross ? t('col.amount') : t('vat.colBase')}</span><span className="r">{t('vat.colTax')}</span></div>
          {byCode(lines).map(([code, ls]) => (
            <Fragment key={code}>
              <div className="vc-h">
                <CodeLink code={code} nav={nav} />
                <span>{codeName(code)}</span>
                <span className="r mono">{fmt(sum(ls.map((l) => (gross ? l.gross : l.base))))}</span>
                <span className="r mono">{fmt(sum(ls.map((l) => l.tax)))}</span>
              </div>
              {ls.map((l) => (
                <Go key={l.entry.id} to={entryAt(l.entry, period)} nav={nav} className="vl">
                  <span className="mono d">{formatDate(l.date)}</span>
                  <span className="tt">{l.description || l.ref}{l.entry.corrects && <em> {t('vat.correctionOf', { period: periodName(correctedPeriod(l.entry.corrects)) })}</em>}</span>
                  <span className="r mono">{fmt(gross ? l.gross : l.base)}</span>
                  <span className="r mono">{fmt(l.tax)}</span>
                </Go>
              ))}
            </Fragment>
          ))}
          {adjustments.map((a) => (
            <div key={a.id} className="vl adj">
              <span className="mono d">{a.period}</span>
              <span className="tt">{t('vat.adjustmentOf', { reason: a.reason })}</span>
              <span />
              <span className="r mono">{fmt(a.amount)}</span>
            </div>
          ))}
        </div>
      ) : <p className="m">{t('vat.noEntries')}</p>}
    </div>
  );
}

const sum = (xs: number[]) => roundCHF(xs.reduce((s, x) => s + x, 0));

/** Form 0535 of a filed quarter: bisher eingereicht against korrigiert, then why, case by case. */
function Correction({ books, nav, period, v, filed }: Props & { v: VatReturn; filed: ReturnFigures }) {
  const uid = useWorkspace()?.company.uid ?? '';
  const entries = books.journalEntries ?? [];
  const corrected = useMemo(() => figuresFromBooks(entries, filed.period, books.config?.vatAdjustments ?? []), [entries, filed.period, books.config?.vatAdjustments]);
  const cases = (books.config?.correctionCases ?? []).filter((c) => c.period === filed.period);
  const check = useMemo(() => reconcileCases(cases, entries, filed, corrected), [cases, entries, filed, corrected]);
  const { from, to } = derivePeriod(filed.period)!;
  const filedTax = (filed.ziffern['500'] ?? 0) - (filed.ziffern['510'] ?? 0);
  const diff = correctionDiff(books, filed);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((e): e is JournalEntry => !!e);

  const print = () => {
    const shut = [...document.querySelectorAll<HTMLDetailsElement>('.f0535 details:not([open])')];
    shut.forEach((d) => { d.open = true; });
    window.print();
    shut.forEach((d) => { d.open = false; });
  };

  return (
    <div className="detail-in f0535" key={`0535:${v.key}`}>
      <div className="head">
        <h2 className="who">{t('form0535.title')}<small>{t('vat.form0535Of', { period: periodName(v.period) })}</small></h2>
        <div className="amount"><small>CHF</small>{signed(diff)}</div>
      </div>
      <div className="facts">
        <span>{t('vat.factFiled', { amount: fmt(filedTax) })}</span>
        <span>{t('vat.factCorrected', { amount: fmt(corrected.payable) })}</span>
        <span>{t('common.entryCount', { n: v.corrections.length })}</span>
      </div>
      <div className="ldl"><button type="button" className="dl inline" onClick={print}>{t('vat.print')}</button></div>
      <dl className="kv2 fhead">
        <dt>{t('vat.uid')}</dt><dd className="mono">{uid}</dd>
        <dt>{t('vat.periodLabel')}</dt><dd className="mono">{filed.period} · {formatDate(from)}–{formatDate(to)}</dd>
        <dt>{t('form0535.declaredTax')}</dt><dd className="mono">CHF {fmt(filedTax)}</dd>
      </dl>
      <div className="ftable">
        <div className="fh"><span>{t('vat.colZiffer')}</span><span>{t('form0535.colLabel')}</span><span className="r">{t('form0535.colFiled')}</span><span className="r">{t('form0535.colCorrected')}</span><span className="r">{t('recon.colDifference')}</span></div>
        {formSections().map((s) => (
          <Fragment key={s.title}>
            <div className="fs">{s.title}</div>
            {s.lines.map((line) => {
              const before = line.value(filed);
              const after = line.value(corrected);
              if (line.optional && before === 0 && after === 0) return null;
              const d = roundCHF(after - before);
              const cells = (
                <>
                  <span className="mono zn">{line.ziffer}</span>
                  <span className="tt">{line.label}</span>
                  <span className="r mono">{dash(before)}</span>
                  <span className="r mono b">{dash(after)}</span>
                  <span className="r mono">{d === 0 ? '—' : signed(d)}</span>
                </>
              );
              const cls = `fl${d !== 0 ? ' chg' : ''}${line.total ? ' tot' : ''}`;
              return line.total
                ? <div key={line.label} className={cls} data-ziffer={line.ziffer}>{cells}</div>
                : <button key={line.label} type="button" className={cls} data-ziffer={line.ziffer} onClick={() => nav.select({ area: 'vat', ziffer: line.ziffer })}>{cells}</button>;
            })}
          </Fragment>
        ))}
      </div>
      <p className="zexpl">{t('form0535.explanation', { period: filed.period })}</p>

      <h3 className="fcases">{t('vat.casesTitle', { n: cases.length })}</h3>
      {check.unexplained.length === 0 && check.orphans.length === 0 ? (
        <div className="notice" data-reconciliation="ok">{t('cases.reconciled', { n: cases.length })}</div>
      ) : (
        <div className="notice warn" data-reconciliation="unexplained">
          <span className="dot" aria-hidden="true" />
          <span>
            {check.unexplained.map((u) => (
              <span key={u.ziffer} className="block">{t('cases.unexplainedLine', { ziffer: u.ziffer, difference: signed(u.difference), explained: signed(u.explained), open: signed(roundCHF(u.difference - u.explained)) })}</span>
            ))}
            {check.orphans.length > 0 && <span className="block">{t('cases.orphans', { n: check.orphans.length })}: {check.orphans.map((e) => e.id).join(', ')}</span>}
          </span>
        </div>
      )}
      {cases.map((c) => <Case key={c.id} c={c} entries={entries} books={books} nav={nav} period={period} pick={pick} />)}
    </div>
  );
}

const dash = (n: number) => (n === 0 ? '—' : fmt(n));

function Case({ c, entries, books, nav, period, pick }: { c: CorrectionCase; entries: JournalEntry[]; books: Props['books']; nav: Nav; period: Props['period']; pick(ids: string[]): JournalEntry[] }) {
  const lines = effectLines(c.period, caseEffect(c, entries).contribution);
  const name = c.source?.startsWith('receipts/') ? c.source.slice('receipts/'.length) : undefined;
  const receipt = name ? books.receipts.find((r) => r.filename === name) : undefined;
  return (
    <details className="case" data-case={c.id}>
      <summary>
        <span className="tt">{c.title}</span>
        <span className="mono eff">
          {lines.length === 0 ? t('cases.noEffectShort') : lines.map((l) => <span key={l.label}>{l.tax ? t('cases.zifferTax', { ziffer: l.ziffer }) : l.ziffer} {signed(l.amount)}</span>)}
        </span>
      </summary>
      <dl className="kv2">
        <dt>{t('cases.wrong')}</dt><dd>{c.wrong}</dd>
        <dt>{t('cases.fix')}</dt><dd>{c.fix}</dd>
        {c.source && (
          <>
            <dt>{t('cases.source')}</dt>
            <dd className="mono">{receipt ? <Go to={{ route: { area: 'receipts', id: receipt.id }, query: {} }} nav={nav}>{c.source}</Go> : c.source}</dd>
          </>
        )}
      </dl>
      <Entries title={t('cases.before')} entries={pick(c.originalEntryIds)} nav={nav} period={period} />
      <Entries title={t('cases.correctionEntries')} entries={pick(c.correctionEntryIds)} nav={nav} period={period} />
      <div className="vlines">
        <div className="vh"><span>{t('vat.colZiffer')}</span><span>{c.correctionEntryIds.length ? t('cases.effect') : t('cases.effectRedeclared')}</span><span /><span className="r">CHF</span></div>
        {lines.length === 0 ? <p className="m">{t('cases.noEffect')}</p> : lines.map((l) => (
          <div key={l.label} className="vl"><span className="mono d">{l.ziffer}</span><span className="tt">{l.label}</span><span /><span className="r mono">{signed(l.amount)}</span></div>
        ))}
      </div>
    </details>
  );
}

function Entries({ title, entries, nav, period }: { title: string; entries: JournalEntry[]; nav: Nav; period: Props['period'] }) {
  if (!entries.length) return null;
  return (
    <div className="vlines">
      <div className="vh"><span>{t('col.date')}</span><span>{title}</span><span className="r">{t('col.amount')}</span><span className="r">{t('vat.colTax')}</span></div>
      {entries.map((e) => {
        const l = vatLine(e);
        return (
          <div key={e.id} className="vl">
            <span className="mono d">{formatDate(e.date)}</span>
            <span className="tt">{e.vatCode && <CodeLink code={e.vatCode} nav={nav} />} <Go to={entryAt(e, period)} nav={nav}>{e.description || e.id}</Go></span>
            <span className="r mono">{fmt(l?.gross ?? e.amount)}</span>
            <span className="r mono">{fmt(l?.tax ?? 0)}</span>
          </div>
        );
      })}
    </div>
  );
}
