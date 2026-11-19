/**
 * The Mahnlauf (docs/specs/invoicing.md 4.4.7, 4.8): a dialog, an action and not a place. On a
 * reference date it lists every Rechnung overdue then with its next Mahnstufe, fee and default
 * interest, or only the rows ticked in the table; it names what it leaves out and why, and the
 * limit per run when it is hit. The person unticks what she wants, «Senden» asks once, then each
 * Mahnung goes by e-mail where there is an address, else its PDF is downloaded; each is in the sent log.
 */
import { useEffect, useState } from 'react';
import { localToday } from '../../../accounting/periods.js';
import { sentPdfUrl, type Invoice } from '../../../invoices/model.js';
import type { LeftOutReason, RunItem, RunPlan } from '../../../invoices/dunning.js';
import type { RunOutcome } from '../../../invoices/service.js';
import { api, errorText, type InvoiceList } from '../../lib/api.js';
import { fmt, formatDate } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import type { Nav } from '../index.js';
import { hrefOf } from '../../shell/history.js';
import { AsyncButton } from '../../shell/AsyncButton.js';
import { download, invoiceAt } from './actions.js';
import { reloadInvoices } from './data.js';
import { Frame, close } from './frame.js';

const REASONS: readonly LeftOutReason[] = ['noReminders', 'comment', 'auto', 'lastLevel', 'notOverdue'];

/** Sums per currency: what is open with the fees and interest. */
function totalsOf(items: readonly RunItem[]): string {
  const by = new Map<string, number>();
  for (const i of items) by.set(i.currency, Math.round(((by.get(i.currency) ?? 0) + i.open + i.fee + i.interest) * 100) / 100);
  return [...by].map(([c, n]) => `${c} ${fmt(n)}`).join(' + ') || '–';
}

export function DunningDialog({ d, nav, ids }: { d: InvoiceList; nav: Nav; ids?: string[] }) {
  const [date, setDate] = useState(localToday());
  const [plan, setPlan] = useState<RunPlan>();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const [done, setDone] = useState<RunOutcome>();
  useEffect(() => {
    let live = true;
    // A Rechnung that never went out is flagged and left unticked: a reminder of a bill the customer never got.
    api.dunningPlan(date, ids).then((p) => { if (live) { setPlan(p); setOff(new Set(p.items.filter((i) => i.unsent).map((i) => i.invoiceId))); } }, (e) => nav.toast(errorText(e)));
    return () => { live = false; };
  }, [date, ids?.join(',')]);

  const link = (inv: Pick<RunItem, 'invoiceId' | 'number'>) => {
    const doc = d.invoices.find((x) => x.id === inv.invoiceId) as Invoice | undefined;
    if (!doc) return inv.number;
    const at = invoiceAt(doc);
    return <a href={hrefOf(at)} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); close(); nav.go(at); }}>{inv.number}</a>;
  };

  if (done) return <Done d={d} done={done} link={link} />;
  const take = plan?.items.filter((i) => !off.has(i.invoiceId)) ?? [];
  const mailed = take.filter((i) => i.to).length;
  const send = async () => {
    try {
      const out = await api.runDunning(date, take.map((i) => i.invoiceId));
      // What goes without an e-mail is downloaded at once: the download is its entry in the sent log.
      for (const s of out.sent.filter((x) => x.channel === 'download')) download(sentPdfUrl(s.sentId), `${s.title} ${s.number}.pdf`);
      await reloadInvoices();
      setDone(out);
    } catch (e) {
      nav.toast(errorText(e));
    }
  };
  const foot = asking ? (
    <>
      <button type="button" className="btn ghost" onClick={() => setAsking(false)}>{t('dunning.back')}</button>
      <AsyncButton type="button" className="btn primary" data-act="dunning-confirm" onClick={send}>{t('dunning.confirmOk', { n: take.length })}</AsyncButton>
    </>
  ) : (
    <>
      <button type="button" className="btn ghost" onClick={close}>{t('common.cancel')}</button>
      <button type="button" className="btn primary" data-act="dunning-send" disabled={!take.length} onClick={() => setAsking(true)}>{t('dunning.send', { n: take.length })}</button>
    </>
  );
  return (
    <Frame label={t('dunning.title')} title={ids ? t('dunning.ticked', { n: ids.length }) : t('dunning.all')} foot={foot} className="idunning">
      <div className="ibody lkf">
        <label className="lkr"><span>{t('dunning.date')}</span><input name="date" type="date" value={date} disabled={asking} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
        {asking ? (
          <p className="notice" data-testid="dunning-ask">{t('dunning.confirm', { n: take.length, mailed, downloaded: take.length - mailed, total: totalsOf(take) })}</p>
        ) : !plan ? null : (
          <>
            {plan.items.length === 0 ? <p className="m" data-testid="dunning-none">{t('dunning.none', { date: formatDate(date) })}</p> : (
              <div className="ivdunwrap">
                <table className="ivdun" data-testid="dunning-list">
                  <thead><tr><th /><th>{t('sales.col.number')}</th><th>{t('sales.col.contact')}</th><th>{t('sales.col.level')}</th><th>{t('dunning.col.since')}</th><th className="num">{t('sales.col.open')}</th><th className="num">{t('invoices.fee')}</th><th className="num">{t('invoices.interest')}</th><th>{t('dunning.col.channel')}</th></tr></thead>
                  <tbody>
                    {plan.items.map((i) => (
                      <tr key={i.invoiceId} data-id={i.invoiceId}>
                        <td><input type="checkbox" aria-label={t('sales.bulk.tick', { what: i.number })} checked={!off.has(i.invoiceId)} onChange={() => setOff((s) => { const n = new Set(s); if (n.has(i.invoiceId)) n.delete(i.invoiceId); else n.add(i.invoiceId); return n; })} /></td>
                        <td className="mono">{link(i)}</td>
                        <td>{i.customerName}{i.unsent ? <small className="warn" data-testid="dunning-unsent"> · {t('dunning.unsent')}</small> : null}</td>
                        <td>{i.title}{i.draft ? <small className="m"> · {t('dunning.written')}</small> : null}</td>
                        <td>{t('dunning.since', { date: formatDate(i.dueSince), n: i.days })}</td>
                        <td className="num mono">{i.currency} {fmt(i.open)}</td>
                        <td className="num mono">{i.fee ? fmt(i.fee) : '–'}</td>
                        <td className="num mono">{i.interest ? fmt(i.interest) : '–'}</td>
                        <td className="m">{i.to ? t('dunning.byMail', { to: i.to }) : t('dunning.byDownload')}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td /><td colSpan={4}>{t('dunning.totals', { n: take.length })}</td><td colSpan={4} className="num mono">{totalsOf(take)}</td></tr></tfoot>
                </table>
              </div>
            )}
            {plan.more > 0 && <p className="notice warn" role="note" data-testid="dunning-limit">{t('dunning.limit', { n: plan.items.length, more: plan.more, limit: plan.limit })}</p>}
            {plan.leftOut.length > 0 && (
              <div className="notice ivleft" role="note" data-testid="dunning-left-out">
                <span>
                  {REASONS.filter((r) => plan.leftOut.some((x) => x.reason === r)).map((r) => {
                    const xs = plan.leftOut.filter((x) => x.reason === r);
                    return <span key={r} className="l" data-reason={r}>{t(`dunning.left.${r}`, { n: xs.length, list: xs.map((x) => (x.date ? `${x.number} (${x.customerName}, ${formatDate(x.date)})` : `${x.number} (${x.customerName})`)).join(', ') })}</span>;
                  })}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </Frame>
  );
}

function Done({ done, link }: { d: InvoiceList; done: RunOutcome; link: (i: { invoiceId: string; number: string }) => React.ReactNode }) {
  const mailed = done.sent.filter((s) => s.channel === 'email');
  const downloaded = done.sent.filter((s) => s.channel === 'download');
  return (
    <Frame label={t('dunning.title')} title={t('dunning.done', { n: done.sent.length })} foot={<button type="button" className="btn primary" onClick={close}>{t('common.close')}</button>} className="idunning">
      <div className="ibody lkf" data-testid="dunning-done">
        {mailed.length > 0 && <p className="m">{t('dunning.doneMailed', { n: mailed.length })} {mailed.map((s, k) => <span key={s.sentId}>{k > 0 && ', '}{link(s)} → {s.to}</span>)}</p>}
        {downloaded.length > 0 && (
          <p className="m">{t('dunning.doneDownloaded', { n: downloaded.length })}{' '}
            {downloaded.map((s, k) => <span key={s.sentId}>{k > 0 && ', '}<a href={sentPdfUrl(s.sentId)} download={`${s.title} ${s.number}.pdf`}>{s.number}</a></span>)}
          </p>
        )}
        {done.failed.length > 0 && <p className="notice warn" role="note">{t('dunning.failed', { n: done.failed.length, list: done.failed.map((f) => `${f.number}: ${f.error}`).join('; ') })}</p>}
        <p className="m ivhint">{t('dunning.inLog')}</p>
      </div>
    </Frame>
  );
}
